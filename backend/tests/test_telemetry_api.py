"""telemetry 端点测试。

覆盖：批量上报 / 白名单外事件与 payload 拒绝 / 认证边界 / 限流存在。
校验语义：结构性白名单保证不采集事实值与原文（长字符串、未知键、
未知类型全部 422）。
"""
from __future__ import annotations

from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import get_settings
from app.db.session import get_session_factory
from app.main import app
from app.models import TelemetryEvent


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(get_settings(), "telemetry_enabled", True)
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def sid(client):
    r = client.post("/api/v1/sessions", json={"title": "telemetry"})
    assert r.status_code == 201, r.text
    return r.json()["data"]["session_id"]


def _post(client, sid, events):
    return client.post(f"/api/v1/sessions/{sid}/telemetry", json={"events": events})


def test_batch_accepted_and_persisted(client, sid):
    r = _post(client, sid, [
        {"event_type": "step_enter", "payload": {"step": "completion"},
         "client_ts": "2026-09-06T10:00:00Z"},
        {"event_type": "question_answered",
         "payload": {"question_key": "q_income_base", "field_count": 3}},
        {"event_type": "answer_changed",
         "payload": {"question_key": "q_income_base", "field_keys": ["monthly_base"]}},
        {"event_type": "result_status",
         "payload": {"recommendation_status": "recommended",
                     "sufficiency_level": "sufficient", "coverage_tier": "formal",
                     "snapshot_seq": 3}},
    ])
    assert r.status_code == 200, r.text
    assert r.json()["data"]["accepted"] == 4

    with get_session_factory()() as db:
        rows = db.scalars(
            select(TelemetryEvent)
            .where(TelemetryEvent.session_id == UUID(sid))
            .order_by(TelemetryEvent.created_at)
        ).all()
    assert [e.event_type for e in rows] == [
        "step_enter", "question_answered", "answer_changed", "result_status",
    ]
    assert rows[0].payload == {"step": "completion"}
    assert rows[2].payload["field_keys"] == ["monthly_base"]


def test_unknown_event_type_rejected(client, sid):
    r = _post(client, sid, [{"event_type": "offer_text_dumped", "payload": {}}])
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


def test_unknown_payload_key_rejected(client, sid):
    r = _post(client, sid, [{
        "event_type": "step_enter",
        "payload": {"step": "compensation", "note": "用户原话……"},
    }])
    assert r.status_code == 422


def test_long_string_and_bad_types_rejected(client, sid):
    long_str = "x" * 200
    r = _post(client, sid, [{"event_type": "step_enter", "payload": {"step": long_str}}])
    assert r.status_code == 422
    r = _post(client, sid, [{"event_type": "step_enter", "payload": {"step": 3.14}}])
    assert r.status_code == 422
    r = _post(client, sid, [{"event_type": "answer_changed",
                             "payload": {"question_key": "q1_comp_structure",
                                         "field_keys": [long_str]}}])
    assert r.status_code == 422


def test_batch_too_large_rejected(client, sid):
    events = [{"event_type": "step_enter", "payload": {"step": "s"}}] * 51
    r = _post(client, sid, events)
    assert r.status_code == 422


def test_requires_owned_session(client):
    r = client.post(
        "/api/v1/sessions/00000000-0000-0000-0000-000000000000/telemetry",
        json={"events": [{"event_type": "step_enter", "payload": {"step": "s"}}]},
    )
    assert r.status_code in (401, 404)


def test_result_status_accepts_frontend_payload(client, sid):
    """前后端契约锁：前端 results 页实际发送的 result_status 键必须被白名单接受。

    回归：前端新增 ranking_top/offer_count 时后端白名单未同步 → 整批 422，
    结果页埋点 100% 丢失且静默。"""
    r = _post(client, sid, [
        {"event_type": "result_status",
         "payload": {"snapshot_seq": 1,
                     "ranking_top": "00000000-0000-0000-0000-00000000000a",
                     "offer_count": 2}},
    ])
    assert r.status_code == 200, r.text
    assert r.json()["data"]["accepted"] == 1


def test_retention_prunes_expired_events(client, sid):
    """事件为追加型数据且不随会话级联删除：超过保留期（24 小时）的事件在
    下一次批量写入时被节流清理，避免存储无界增长。"""
    from datetime import UTC, datetime, timedelta

    import app.services.telemetry_service as ts

    with get_session_factory()() as db:
        db.add(TelemetryEvent(
            session_id=UUID(sid), event_type="step_enter", payload={"step": "old"},
            created_at=datetime.now(UTC).replace(tzinfo=None) - timedelta(days=45),
        ))
        db.add(TelemetryEvent(
            session_id=UUID(sid), event_type="step_enter", payload={"step": "fresh"},
        ))
        db.commit()
    ts._last_prune_monotonic = 0.0  # 绕过时间窗节流，测试内强制执行
    r = _post(client, sid, [{"event_type": "step_enter", "payload": {"step": "new"}}])
    assert r.status_code == 200, r.text
    with get_session_factory()() as db:
        steps = [e.payload.get("step") for e in db.scalars(
            select(TelemetryEvent).where(TelemetryEvent.session_id == UUID(sid))
        ).all()]
    assert "old" not in steps
    assert "fresh" in steps and "new" in steps
