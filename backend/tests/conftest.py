"""全量套件共享夹具。

会话创建限流器（sessions._sessions_limiter）是模块级进程内单例，
所有 TestClient 共享同一个 30/分钟 窗口：全量套件在一次运行内的会话
创建数会超过它，尾部文件（telemetry）收到 429 → 夹具级隔离破坏。
每个测试前清空计数，保证测试间互不携带限流状态；限流行为本身由
test_rate_limit.py 用独立实例覆盖。
"""
import pytest

from app.api.routes import sessions


@pytest.fixture(autouse=True)
def _reset_session_rate_limiter():
    sessions._sessions_limiter._events.clear()
    yield
    sessions._sessions_limiter._events.clear()
