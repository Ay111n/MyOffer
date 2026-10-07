import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from starlette.types import ASGIApp, Receive, Scope, Send

import app.models  # noqa: F401 - register ORM models before creating the volatile schema
from app.api.errors import install_error_handlers
from app.api.routes import (
    ai,
    due_diligence,
    meta,
    offers,
    preferences,
    questions,
    results,
    sessions,
    telemetry,
)
from app.config import get_settings
from app.db.base import Base
from app.db.gate import DbGate
from app.db.session import get_engine, get_session_factory
from app.rules_runtime import get_rules, sync_mirrors
from app.services import runtime_state
from app.services.ai_service import get_bridge
from app.services.retention import prune_state
from app.services.telemetry_service import _prune_expired

logger = logging.getLogger("offer.app")


class DbGateMiddleware:
    """把单进程内的请求处理串行化。

    所有比较状态存放在进程内 SQLite 的一条共享连接上（db/session.py 的
    StaticPool），而同步路由跑在 FastAPI 线程池里：并发请求会在同一条
    sqlite3 连接上交错执行，实测偶发 500（sqlite3.InterfaceError）、
    401 User no longer exists、404 Session not found 等幻读症状，
    前端随后误判会话失效并丢弃用户已填写的内容。

    DbGate 支持 TestClient/嵌入式客户端使用不同事件循环，按 FIFO 唤醒。
    """

    def __init__(self, app: ASGIApp, gate: DbGate) -> None:
        self.app = app
        self._gate = gate

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if scope.get("path") == "/healthz":
            # 健康检查不触碰进程内 SQLite：不入闸门。否则 AI 授权等待、
            # 慢客户端拖长响应等都会把 /healthz 一并堵死——外部监控会把
            # 「进程忙」误判为「进程死」而重启。
            await self.app(scope, receive, send)
            return
        try:
            await self._gate.acquire(get_settings().db_gate_timeout_seconds)
        except TimeoutError:
            await JSONResponse(status_code=503, headers={"Retry-After": "1"}, content={
                "error": {"code": "server_busy", "message": "服务繁忙，请稍后重试", "details": {}},
            })(scope, receive, send)
            return

        async def send_with_cookie(message):
            renewal = scope.get("state", {}).get("renew_cookie")
            if message["type"] == "http.response.start" and message["status"] < 400 and renewal:
                from app.services.session_service import set_session_cookie
                cookie = Response()
                set_session_cookie(cookie, *renewal)
                # 创建身份时路由可能已设置同一 Cookie，避免重复头。
                if not any(k == b"set-cookie" for k, _ in message.get("headers", [])):
                    message["headers"].extend((k, v) for k, v in cookie.raw_headers if k == b"set-cookie")
            await send(message)

        try:
            await self.app(scope, receive, send_with_cookie)
        finally:
            self._gate.release()


def _maintenance_once():
    with get_session_factory().begin() as db:
        prune_state(db)
        _prune_expired(db)


async def _maintenance(gate):
    while True:
        await asyncio.sleep(60)
        try:
            await gate.acquire(get_settings().db_gate_timeout_seconds)
        except TimeoutError:
            continue
        try:
            # 同步维护通常只需毫秒，直接执行避免取消线程时提前释放共享连接闸门。
            _maintenance_once()
        except SQLAlchemyError:
            logger.exception("memory state maintenance failed")
        finally:
            gate.release()


def _sync_rule_mirrors(rules) -> bool:
    """初始化进程内临时表，再从 YAML 装入规则目录。"""
    Base.metadata.create_all(bind=get_engine())
    with get_session_factory()() as db:
        report = sync_mirrors(db, rules)
        db.commit()
    logger.info(
        "memory rule mirrors ready: +fields=%d ~fields=%d -fields=%d; +questions=%d ~questions=%d -questions=%d",
        report.fields_inserted, report.fields_updated, report.fields_deactivated,
        report.questions_inserted, report.questions_updated, report.questions_deactivated,
    )
    return True


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logging.basicConfig(level=get_settings().log_level.upper(),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # 规则加载 fail-fast：不变量校验失败时应用拒绝启动。
    rules = get_rules()
    logger.info("rules loaded: version=%s", rules.version)
    runtime_state.rules_synced = _sync_rule_mirrors(rules)

    s = get_settings()
    if s.env == "production" and not s.cookie_secure:
        logger.error("env=production 但 cookie_secure=false —— 会话 Cookie 未经 TLS 保护")

    maintenance = asyncio.create_task(_maintenance(_app.state.db_gate))
    try:
        yield
    finally:
        maintenance.cancel()
        with suppress(asyncio.CancelledError):
            await maintenance
        get_bridge().close()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Offer Decision API",
        version="0.1.0",
        openapi_url="/api/v1/openapi.json",
        lifespan=lifespan,
    )
    s = get_settings()
    gate = DbGate()
    app.state.db_gate = gate
    app.add_middleware(DbGateMiddleware, gate=gate)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type"],
    )
    # CORS 最外层，让闸门的 503 也携带跨域头；预检无需访问共享数据库。
    api = "/api/v1"
    for r in [
        sessions.router, offers.router, preferences.router,
        questions.router, results.router, due_diligence.router,
        telemetry.router, meta.router, ai.router,
    ]:
        app.include_router(r, prefix=api)
    install_error_handlers(app)

    @app.get("/healthz", tags=["meta"])
    def healthz():
        # rules_synced=false 表示进程内规则镜像未就绪，写入接口暂不可用。
        return {"status": "ok", "rules_synced": runtime_state.rules_synced}

    @app.get("/readyz", tags=["meta"])
    def readyz():
        try:
            with get_session_factory()() as db:
                db.execute(text("SELECT 1"))
            database_ready = True
        except SQLAlchemyError:
            database_ready = False
        ready = database_ready and runtime_state.rules_synced
        return JSONResponse(status_code=200 if ready else 503, content={
            "status": "ok" if ready else "unavailable", "database_ready": database_ready,
            "rules_synced": runtime_state.rules_synced,
        })

    return app


app = create_app()
