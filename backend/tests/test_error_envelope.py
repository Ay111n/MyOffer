"""错误包络与认证边界测试。

不需要数据库：认证在触碰 DB 之前先校验 Cookie。
"""
from fastapi.testclient import TestClient

from app.main import app


def test_session_history_list_route_removed():
    r = TestClient(app).get("/api/v1/sessions")
    assert r.status_code == 405


def test_router_level_404_405_use_error_envelope():
    """回归：路由级 404（未知路径）/405（方法不符）由 starlette 基类抛出，
    处理器只注册 fastapi.HTTPException 时漏出 {"detail": ...} 裸格式，
    前端按 error.code 分支的统一契约失效。"""
    client = TestClient(app)
    r = client.get("/api/v1/nope")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "http_error"
    r = client.delete("/api/v1/meta")
    assert r.status_code == 405
    assert r.json()["error"]["code"] == "http_error"


def test_owned_routes_require_cookie():
    r = TestClient(app).get("/api/v1/sessions/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthenticated"


def test_validation_error_envelope():
    # POST sessions 无 Cookie 但也不需要认证；空 body 合法（title 可选）→ 需要数据库，故不在此测。
    # 这里测一个会触发 RequestValidationError 的请求：字段类型错误发生在认证之前。
    r = TestClient(app).post(
        "/api/v1/sessions", json={"title": 12345}
    )
    assert r.status_code == 422
    body = r.json()
    assert body["error"]["code"] == "validation_error"
    assert isinstance(body["error"]["details"]["field_errors"], list)
