"""生产环境配置护栏与全局错误包络。"""
import pytest

from app.config import Settings


def test_production_rejects_default_session_secret():
    """生产模式必须显式设置 session_secret。"""
    with pytest.raises(Exception):
        Settings(env="production", session_secret="dev-only-change-me")


def test_production_insecure_cookie_requires_explicit_confirmation():
    """生产 + HTTP（cookie_secure=false）必须显式 ALLOW_INSECURE_COOKIE=1：
    曾仅打 ERROR 日志即放行，存在"忘了配 HTTPS 就静默上线"的路径。"""
    with pytest.raises(Exception):
        Settings(env="production", session_secret="x" * 32)
    # 显式确认后允许（无域名/无证书的过渡期部署）
    s = Settings(env="production", session_secret="x" * 32, allow_insecure_cookie=True)
    assert s.cookie_secure is False
    # HTTPS 下无需确认
    ok = Settings(env="production", session_secret="x" * 32, cookie_secure=True)
    assert ok.cookie_secure is True


def test_development_allows_default_secret():
    Settings(env="development", session_secret="dev-only-change-me")


def test_unhandled_exception_envelope_unit():
    """未捕获异常必须输出统一错误包络（不泄露堆栈），而非裸文本 Internal Server Error。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.errors import install_error_handlers

    app = FastAPI()
    install_error_handlers(app)

    @app.get("/boom")
    def boom():
        raise RuntimeError("secret-stack-trace")

    client = TestClient(app, raise_server_exceptions=False)
    r = client.get("/boom")
    assert r.status_code == 500
    body = r.json()
    assert body["error"]["code"] == "internal_error"
    assert "secret-stack-trace" not in r.text
    assert "RuntimeError" not in r.text


def test_production_guardrails_case_and_whitespace_insensitive():
    """回归：ENV=Production（大小写/首尾空格）曾被精确比较放过，
    生产护栏（默认 secret / 非 secure cookie）静默失效。"""
    with pytest.raises(Exception):
        Settings(env="Production", session_secret="dev-only-change-me")
    with pytest.raises(Exception):
        Settings(env="  PRODUCTION ", session_secret="x" * 32)
    # 归一化后值本身也变小写
    s = Settings(env="Development", session_secret="dev-only-change-me")
    assert s.env == "development"
