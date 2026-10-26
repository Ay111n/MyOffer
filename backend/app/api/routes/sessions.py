from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.api.deps import get_db, get_optional_user, require_owned_session
from app.config import get_settings
from app.models import User
from app.schemas import (
    DeletedResponse,
    ReportRestoreRequest,
    SessionCreateRequest,
    SessionResponse,
)
from app.services import session_service
from app.services.rate_limit import SlidingWindowLimiter, enforce_rate_limit

router = APIRouter(prefix="/sessions", tags=["sessions"])

# 单实例防护：匿名创建会话按 client IP 限流（多实例部署各实例独立计数）
_sessions_limiter = SlidingWindowLimiter(
    max_events=get_settings().rate_limit_sessions_per_minute, window_seconds=60.0,
)


@router.post("", response_model=SessionResponse, status_code=201)
def create_session(
    body: SessionCreateRequest | None = None,
    response: Response = None,
    request: Request = None,
    user: User | None = Depends(get_optional_user),
    db: Session = Depends(get_db),
):
    if request is not None and user is None:
        # 仅对新建匿名身份限流；已有 cookie 的请求不消耗配额
        enforce_rate_limit(_sessions_limiter, request.client.host if request.client else "unknown")
    # 已有浏览器身份则复用；首次访问才签发新 cookie。
    session, token, ttl = session_service.create_session(db, body.title if body else None, user)
    if token is not None:
        session_service.set_session_cookie(response, token, ttl)
    return SessionResponse(data=session_service.to_resource(db, session))


@router.get("/{sid}", response_model=SessionResponse)
def get_session(session=Depends(require_owned_session), db: Session = Depends(get_db)):
    return SessionResponse(data=session_service.to_resource(db, session))


@router.delete("/{sid}", response_model=DeletedResponse)
def delete_session(session=Depends(require_owned_session), db: Session = Depends(get_db)):
    session_service.delete_session(db, session)
    return DeletedResponse(data={"deleted": True})


@router.post("/restore", response_model=SessionResponse)
def restore_report(body: "ReportRestoreRequest", response: Response, request: Request,
                   user: User | None = Depends(get_optional_user), db: Session = Depends(get_db)):
    from app.rules_runtime import get_rules
    from app.services.report_tools import restore_inputs, validate_restore
    rules = get_rules()
    if body.format != "myoffer-input-v5" or body.schema_version != 5 or body.inputs is None:
        raise HTTPException(status_code=422, detail={"code": "unsupported_export",
                            "message": "旧版导出文件不兼容，请使用新版输入与偏好 JSON"})
    from app.domain.contracts import DecisionInput, OfferInput
    portable = body.inputs
    inp = validate_restore(DecisionInput(
        offers=[OfferInput(offer_id=offer.offer_id, display_order=offer.display_order,
                           # 归档携带的身份名；旧版归档无此二键（空名）兜底为槽位默认
                           company=offer.company.strip() or f"Offer {chr(65 + index)}",
                           position=offer.position.strip(), facts=offer.facts)
                for index, offer in enumerate(sorted(portable.offers, key=lambda item: item.display_order))],
        preferences=portable.preferences,
    ), rules)
    if user is None:
        enforce_rate_limit(_sessions_limiter, request.client.host if request.client else "unknown")
    session, token, ttl = session_service.create_session(db, "导入的对比报告", user, commit=False)
    restore_inputs(db, session, inp, rules)
    if token is not None:
        session_service.set_session_cookie(response, token, ttl)
    return SessionResponse(data=session_service.to_resource(db, session))
