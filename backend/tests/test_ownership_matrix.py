"""跨会话越权矩阵（审查缺口补齐：安全属性无回归锁）。

require_owned_session 的设计目标是「不匹配一律 404，不泄露存在性」；
本文件参数化所有会话级端点，锁死两个方向：
- 他人 cookie（合法身份但不拥有该会话）→ 404；
- 无 cookie → 401。
一次重构若把 404 改成 403/200，这里会先红。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

_FOREIGN_BODIES = {
    "POST": {"company": "x"},
    "PATCH": {"version": 1},
    "PUT": {"source": "manual", "version": 1,
            "weights": {"compensation": 1, "development": 1,
                        "stability": 1, "wellbeing": 1}},
    "PATCH_DD": {"status": "done"},
    "POST_ANSWERS": {"answers": [{"offer_id": None, "fields": []}]},
    "POST_TELEMETRY": {"events": [{"event_type": "step_enter",
                                   "payload": {"step": "s"}}]},
}

# (method, path_template, body_key)
_ENDPOINTS = [
    ("GET", "/api/v1/sessions/{sid}", None),
    ("DELETE", "/api/v1/sessions/{sid}", None),
    ("POST", "/api/v1/sessions/{sid}/offers", "POST"),
    ("GET", "/api/v1/sessions/{sid}/offers", None),
    ("PATCH", "/api/v1/sessions/{sid}/offers/{oid}", "PATCH"),
    ("DELETE", "/api/v1/sessions/{sid}/offers/{oid}", None),
    ("POST", "/api/v1/sessions/{sid}/offers/{oid}/reset", "PATCH"),
    ("GET", "/api/v1/sessions/{sid}/preferences", None),
    ("PUT", "/api/v1/sessions/{sid}/preferences", "PUT"),
    ("GET", "/api/v1/sessions/{sid}/questions", None),
    ("POST", "/api/v1/sessions/{sid}/questions/stop", None),
    ("POST", "/api/v1/sessions/{sid}/questions/resume", None),
    ("POST", "/api/v1/sessions/{sid}/questions/q_benefits/answers", "POST_ANSWERS"),
    ("GET", "/api/v1/sessions/{sid}/result", None),
    ("GET", "/api/v1/sessions/{sid}/results/history", None),
    ("GET", "/api/v1/sessions/{sid}/results/1", None),
    ("GET", "/api/v1/sessions/{sid}/due-diligence", None),
    ("PATCH", "/api/v1/sessions/{sid}/due-diligence/00000000-0000-0000-0000-0000000000dd",
     "PATCH_DD"),
    ("POST", "/api/v1/sessions/{sid}/telemetry", "POST_TELEMETRY"),
]


@pytest.fixture(scope="module")
def targets():
    """alice 的会话与 offer id（module 级：矩阵为只读/无副作用请求）。"""
    with TestClient(app) as client:
        r = client.post("/api/v1/sessions", json={"title": None})
        assert r.status_code == 201, r.text
        sid = r.json()["data"]["session_id"]
        offers = client.get(f"/api/v1/sessions/{sid}/offers").json()["data"]
        yield sid, offers[0]["offer_id"]


def test_foreign_cookie_gets_404_on_every_session_endpoint(targets):
    sid, oid = targets
    with TestClient(app) as mallory:
        # mallory 有自己的合法匿名身份 → 404 只能来自归属校验
        r = mallory.post("/api/v1/sessions", json={"title": None})
        assert r.status_code == 201, r.text
        for method, path, body_key in _ENDPOINTS:
            url = path.format(sid=sid, oid=oid)
            resp = mallory.request(
                method, url, json=_FOREIGN_BODIES.get(body_key or "", {}) or None)
            assert resp.status_code == 404, f"{method} {url} → {resp.status_code}"
            body = resp.json()
            assert body["error"]["code"] == "not_found", f"{method} {url} → {body}"


def test_missing_cookie_gets_401_on_read_endpoints(targets):
    sid, oid = targets
    with TestClient(app) as anonymous:  # 不创建会话 → 无 offer_sid cookie
        for method, path, body_key in _ENDPOINTS:
            if method not in ("GET", "POST"):
                continue
            url = path.format(sid=sid, oid=oid)
            resp = anonymous.request(
                method, url, json=_FOREIGN_BODIES.get(body_key or "", {}) or None)
            assert resp.status_code == 401, f"{method} {url} → {resp.status_code}"
            assert resp.json()["error"]["code"] == "unauthenticated"
