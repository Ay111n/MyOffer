"""偏好 API 与快照存储回归（审查修复配套）。

覆盖：手动权重 NaN/Infinity 拒绝（曾毒化会话并 500 掉所有含权重的响应）、
快照保留窗口（曾随写入次数无界增长）、损坏快照的 4xx 包络（曾裸 500）。
"""
from __future__ import annotations

from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db.session import get_session_factory
from app.main import app
from app.models import DecisionResult
from app.services.recompute import SNAPSHOT_KEEP_PER_SESSION

WEIGHTS_A = {"economic": 0.4, "growth": 0.3, "experience": 0.3}
WEIGHTS_B = {"economic": 0.2, "growth": 0.3, "experience": 0.5}


def _client_with_session():
    with TestClient(app) as client:
        r = client.post("/api/v1/sessions", json={"title": None})
        assert r.status_code == 201, r.text
        return client, r.json()["data"]["session_id"]


def _put_weights(client, sid: str, version: int, weights: dict):
    return client.put(f"/api/v1/sessions/{sid}/preferences", json={
        "version": version, "source": "manual", "weights": weights,
    })


def _put_raw_weights(client, sid: str, compensation_literal: str):
    """httpx 的 json= 禁止 NaN/Infinity 字面量；恶意/畸形客户端可以原样发送，
    这里用原始 body 复现同一路径（服务端 json.loads 默认接受 NaN/Infinity）。"""
    body = (
        '{"version": 1, "source": "manual", "weights": {'
        '"economic": ' + compensation_literal + ', "growth": 0.3, '
        '"experience": 0.3}}'
    )
    return client.put(
        f"/api/v1/sessions/{sid}/preferences",
        content=body.encode(), headers={"Content-Type": "application/json"},
    )


def test_non_finite_manual_weights_rejected():
    """NaN/Infinity 能通过 pydantic float 与「<=0 / <0」比较（NaN 比较恒 False），
    一旦入库：JSON 序列化让所有含权重的响应 500，引擎指标被污染。必须 422。"""
    client, sid = _client_with_session()
    for literal in ("NaN", "Infinity", "-Infinity"):
        r = _put_raw_weights(client, sid, literal)
        assert r.status_code == 422, (literal, r.text)
        assert r.json()["error"]["code"] == "validation_error"
    # 会话未被毒化：合法写入仍然可用
    r = _put_weights(client, sid, 1, WEIGHTS_A)
    assert r.status_code == 200, r.text


def test_snapshot_retention_window():
    """每次写入都追加全量快照，长会话曾无界增长；保留窗口应把行数钉在
    SNAPSHOT_KEEP_PER_SESSION，且最新快照仍可读。"""
    client, sid = _client_with_session()
    version = 1
    for i in range(SNAPSHOT_KEEP_PER_SESSION + 6):
        r = _put_weights(client, sid, version, WEIGHTS_A if i % 2 == 0 else WEIGHTS_B)
        assert r.status_code == 200, r.text
        version = r.json()["data"]["version"]
    with get_session_factory()() as db:
        count = db.scalar(
            select(func.count()).select_from(DecisionResult)
            .where(DecisionResult.session_id == UUID(sid))
        )
    assert count == SNAPSHOT_KEEP_PER_SESSION
    r = client.get(f"/api/v1/sessions/{sid}/result")
    assert r.status_code == 200, r.text
    # 最新快照仍指向最后一次写入（KEEP+6 次全部落了快照）
    assert r.json()["data"]["snapshot_seq"] == SNAPSHOT_KEEP_PER_SESSION + 6


def _put_questionnaire(client, sid: str, version: int, buy_house_intent: str = "not_consider"):
    """完成整份问卷（权重题全部等价 + 校准 no_difference），购房意向可指定。"""
    meta = client.get("/api/v1/meta").json()["data"]["preference_questionnaire"]
    answers = []
    for q in meta["questions"]:
        if q["kind"] == "single":
            choice = buy_house_intent
        elif q["kind"] == "calibration":
            choice = "no_difference"
        else:
            choice = "equal"
        answers.append({"question_id": q["question_id"], "choice": choice})
    return client.put(f"/api/v1/sessions/{sid}/preferences", json={
        "version": version, "source": "questionnaire",
        "questionnaire_version": meta["version"], "answers": answers,
    })


def test_manual_weights_preserve_questionnaire_answers():
    """回归：manual 权重微调曾把已存的 answers/questionnaire_version 一并清空，
    recompute 从 answers 拆出的 buy_house_intent 随之变回 None——住房模块在
    用户选了「不考虑买房」后悄悄回到综合评分。手动微调必须沿用旧答案。"""
    client, sid = _client_with_session()
    r = _put_questionnaire(client, sid, 1, buy_house_intent="not_consider")
    assert r.status_code == 200, r.text
    q_version = r.json()["data"]["version"]

    r = _put_weights(client, sid, q_version, WEIGHTS_B)
    assert r.status_code == 200, r.text

    prefs = client.get(f"/api/v1/sessions/{sid}/preferences").json()["data"]
    assert prefs["version"] == q_version + 1
    assert prefs["source"] == "manual"
    assert prefs["questionnaire_version"] == "v2"
    buy = next(a for a in prefs["answers"] if a["question_id"] == "buy_house_intent")
    assert buy["choice"] == "not_consider"

    # 引擎侧同步生效：住房模块保持「不适用」（若答案被清空会回到待补充/评分）
    result = client.get(f"/api/v1/sessions/{sid}/result").json()["data"]
    assert result["weights"] == {k: pytest.approx(v) for k, v in WEIGHTS_B.items()}
    for offer in result["offers"]:
        assert offer["housing"]["grade"] == "不适用"


def test_corrupt_snapshot_returns_409_envelope():
    """payload 损坏（schema_version 合标但内容解析失败）必须 409 包络而非裸 500。"""
    client, sid = _client_with_session()
    r = _put_weights(client, sid, 1, WEIGHTS_A)
    assert r.status_code == 200, r.text
    with get_session_factory()() as db:
        row = db.scalars(
            select(DecisionResult).where(DecisionResult.session_id == UUID(sid))
            .order_by(DecisionResult.seq.desc())
        ).first()
        row.payload = {"schema_version": 5, "outputs": "not-a-mapping"}
        db.commit()
    r = client.get(f"/api/v1/sessions/{sid}/result")
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "snapshot_corrupt"
