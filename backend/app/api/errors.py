"""统一错误包络。

HTTPException(detail=dict) → {"error": detail}
FactValidationError       → {"error": {"code": <校验码>, ...}}，422（事实值域不符，如城市 universe）
RequestValidationError   → {"error": {"code": "validation_error", ...}}
Exception（未捕获）       → {"error": {"code": "internal_error", ...}}，不泄露堆栈
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import OperationalError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.services.fact_validation import FactValidationError

logger = logging.getLogger("offer.errors")


def _error_body(code: str, message: str, details: dict | None = None) -> dict:
    return {"error": {"code": code, "message": message, "details": details or {}}}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(OperationalError)
    async def capacity_error_handler(_request: Request, exc: OperationalError):
        if getattr(exc.orig, "sqlite_errorcode", None) == 13:  # SQLITE_FULL
            logger.warning("memory database capacity reached")
            return JSONResponse(status_code=503, content=_error_body(
                "storage_capacity", "临时状态容量已满，请稍后重试"))
        logger.exception("database operation failed")
        return JSONResponse(status_code=500, content=_error_body(
            "internal_error", "服务器内部错误，请稍后重试"))
    @app.exception_handler(FactValidationError)
    async def fact_validation_exception_handler(_request: Request, exc: FactValidationError):
        # 事实取值违反字段注册表契约（越出白名单/类型不符）= 客户端输入问题。
        # answer_service 自行包装为 422；这里兜住 offer create/PATCH 等直调路径。
        return JSONResponse(status_code=422, content=_error_body(exc.code, exc.message))

    # 注册到 starlette 基类：路由级 404/405 抛的是基类而非 fastapi.HTTPException
    # （MRO 不含后者），只注册 fastapi 子类时这些错误会漏出 {"detail": ...} 裸格式。
    # 基类处理器按 MRO 同样覆盖 fastapi.HTTPException。
    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(_request: Request, exc: HTTPException):
        detail = exc.detail
        if isinstance(detail, dict) and "code" in detail:
            return JSONResponse(status_code=exc.status_code, content={"error": detail})
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_body("http_error", str(detail)),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(_request: Request, exc: RequestValidationError):
        field_errors = [
            {
                "path": ".".join(str(loc) for loc in err.get("loc", []) if loc != "body"),
                "code": err.get("type", "invalid"),
                "message": err.get("msg", ""),
            }
            for err in exc.errors()
        ]
        body = _error_body(
            "validation_error", "提交内容有误", {"field_errors": field_errors}
        )
        return JSONResponse(status_code=422, content=body)

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        # 兜底包络：任何未预期异常都返回统一 JSON（栈只进服务端日志）
        # %r：url.path 是百分号解码后的原文，可能含 \n 等控制字符（日志伪造），repr 转义
        logger.exception("unhandled error on %s %r", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content=_error_body("internal_error", "服务器内部错误，请稍后重试"),
        )
