from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_optional_user
from app.api.routes.sessions import _sessions_limiter
from app.db.session import get_db
from app.models import User
from app.schemas.ai import (
    AiConfigResponse,
    AiJobResponse,
    AiKeyRequest,
    AiReplyRequest,
    AiSelection,
)
from app.services.ai_service import get_bridge
from app.services.rate_limit import SlidingWindowLimiter, enforce_rate_limit
from app.services.session_service import ensure_identity, set_session_cookie

router = APIRouter(prefix="/ai", tags=["ai"])
_ai_limiter = SlidingWindowLimiter(max_events=10, window_seconds=60)


@router.post("/bootstrap", response_model=AiConfigResponse)
def bootstrap(
    request: Request, response: Response,
    user: User | None = Depends(get_optional_user), db: Session = Depends(get_db),
):
    # Establish the same anonymous identity without creating/replacing a comparison.
    if user is None:
        enforce_rate_limit(_sessions_limiter, request.client.host if request.client else "unknown")
    # 先调桥再提交身份：ensure_identity 只 flush 不 commit，桥不可用抛 503 时
    # 请求级 Session 关闭即回滚；曾先 commit 后调桥，503 响应带不上 Set-Cookie，
    # 已落库的身份收不到凭证成为孤儿行。
    user, token, ttl = ensure_identity(db, user)
    data = get_bridge().call(str(user.id), "config")
    if token is not None:
        db.commit()
        set_session_cookie(response, token, ttl)
    return {"data": data}


@router.get("/config", response_model=AiConfigResponse)
def config(user: User = Depends(get_current_user)):
    return {"data": get_bridge().call(str(user.id), "config")}


@router.put("/providers/{provider}/key", response_model=AiConfigResponse)
def save_key(provider: str, body: AiKeyRequest, user: User = Depends(get_current_user)):
    return {"data": get_bridge().call(str(user.id), "key", {
        "provider": provider, "key": body.api_key.get_secret_value(),
    })}


@router.delete("/providers/{provider}", response_model=AiConfigResponse)
def disconnect(provider: str, user: User = Depends(get_current_user)):
    return {"data": get_bridge().call(str(user.id), "disconnect", {"provider": provider})}


@router.put("/selection", response_model=AiConfigResponse)
def select_model(body: AiSelection, user: User = Depends(get_current_user)):
    return {"data": get_bridge().call(str(user.id), "select", body.model_dump())}


@router.post("/providers/{provider}/login", response_model=AiJobResponse, status_code=202)
def login(provider: str, user: User = Depends(get_current_user)):
    enforce_rate_limit(_ai_limiter, str(user.id))
    return {"data": get_bridge().call(str(user.id), "login", {"provider": provider})}


@router.post("/test", response_model=AiJobResponse, status_code=202)
def test_connection(body: AiSelection, user: User = Depends(get_current_user)):
    enforce_rate_limit(_ai_limiter, str(user.id))
    return {"data": get_bridge().call(str(user.id), "test", body.model_dump())}


@router.get("/jobs/{job_id}", response_model=AiJobResponse)
def job_status(job_id: UUID, user: User = Depends(get_current_user)):
    return {"data": get_bridge().call(str(user.id), "job", {"id": str(job_id)})}


@router.post("/jobs/{job_id}/reply", response_model=AiJobResponse)
def reply(job_id: UUID, body: AiReplyRequest, user: User = Depends(get_current_user)):
    return {"data": get_bridge().call(str(user.id), "reply", {
        "id": str(job_id), "prompt_id": body.prompt_id, "value": body.value.get_secret_value(),
    })}


@router.delete("/jobs/{job_id}", response_model=AiJobResponse)
def cancel(job_id: UUID, user: User = Depends(get_current_user)):
    return {"data": get_bridge().call(str(user.id), "cancel", {"id": str(job_id)})}
