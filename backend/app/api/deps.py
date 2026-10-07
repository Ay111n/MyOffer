"""认证与会话归属。

匿名 Session：Cookie offer_sid（httpOnly + Secure + SameSite=Lax）→
HMAC-SHA256 查 auth_sessions.token_hash → user。
Ownership 违反一律 404（掩盖他人会话的存在性），由本模块统一执行。
"""
from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.session import get_db
from app.models import AuthSession, DecisionSession, User

COOKIE_NAME = "offer_sid"


def hash_token(token: str) -> str:
    return hmac.new(get_settings().session_secret.encode("utf-8"),
                    token.encode("utf-8"), hashlib.sha256).hexdigest()


def _unauthenticated(message: str) -> HTTPException:
    return HTTPException(
        status_code=401,
        detail={"code": "unauthenticated", "message": message},
    )


def resolve_user(request: Request, db: Session) -> User:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise _unauthenticated("Missing session cookie")
    token_hash = hash_token(token)
    auth = db.execute(
        select(AuthSession).where(
            AuthSession.token_hash == token_hash,
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > datetime.now(UTC),
        )
    ).scalar_one_or_none()
    if auth is None:
        raise _unauthenticated("Invalid or expired session token")

    now = datetime.now(UTC)
    # StaticPool 共享连接，认证内部不能 commit，续期随请求一起提交或回滚。
    ttl = timedelta(days=get_settings().session_ttl_days)
    auth.expires_at = now + ttl
    auth.last_used_at = now
    request.state.renew_cookie = (token, int(ttl.total_seconds()))

    user = db.get(User, auth.user_id)
    if user is None:
        raise _unauthenticated("User no longer exists")
    user.updated_at = now
    return user


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    return resolve_user(request, db)


def get_optional_user(request: Request, db: Session = Depends(get_db)) -> User | None:
    """同 get_current_user，但无 cookie / token 失效时返回 None 而非 401。

    用于创建会话：已有身份则复用，首次访问才新建匿名身份。
    """
    try:
        return resolve_user(request, db)
    except HTTPException:
        return None


def require_owned_session(
    sid: UUID,
    request: Request,
    db: Session = Depends(get_db),
) -> DecisionSession:
    """校验 cookie 归属 + session 归属；任何不匹配 → 404（不泄露存在性）。"""
    user = resolve_user(request, db)
    session = db.get(DecisionSession, sid)
    if session is None or session.user_id != user.id:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "Session not found"},
        )
    session.updated_at = datetime.now(UTC)
    return session
