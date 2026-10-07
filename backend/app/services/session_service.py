"""Session 资源服务。"""
from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.api.deps import COOKIE_NAME, hash_token
from app.config import get_settings
from app.models import AuthSession, DecisionResult, DecisionSession, Offer, RawFact, User
from app.schemas import SessionResource
from app.services.retention import make_room, prune_state


def _now() -> datetime:
    return datetime.now(UTC)


def to_resource(db: Session, session: DecisionSession) -> SessionResource:
    resources = enrich(db, [session])
    return resources[0]


def enrich(db: Session, sessions: list[DecisionSession]) -> list[SessionResource]:
    """批量组装 SessionResource：附带最新快照的决策覆盖率与待确认事实数。"""
    sids = [s.id for s in sessions]
    offer_counts: dict[UUID, int] = {}
    for sid, cnt in db.execute(
        select(Offer.session_id, func.count())
        .where(Offer.session_id.in_(sids))
        .group_by(Offer.session_id)
    ).all():
        offer_counts[sid] = int(cnt)

    latest_seqs: dict[UUID, int] = {}
    for sid, seq in db.execute(
        select(DecisionResult.session_id, func.max(DecisionResult.seq))
        .where(DecisionResult.session_id.in_(sids))
        .group_by(DecisionResult.session_id)
    ).all():
        latest_seqs[sid] = int(seq)

    pending_counts: dict[UUID, int] = {}
    for sid, cnt in db.execute(
        select(Offer.session_id, func.count())
        .join(RawFact, RawFact.offer_id == Offer.id)
        .where(Offer.session_id.in_(sids), RawFact.status == "need_confirmation")
        .group_by(Offer.session_id)
    ).all():
        pending_counts[sid] = int(cnt)

    return [
        SessionResource(
            session_id=s.id,
            title=s.title,
            phase=s.phase,
            offer_count=offer_counts.get(s.id, 0),
            latest_snapshot_seq=latest_seqs.get(s.id),
            pending_confirmations=pending_counts.get(s.id, 0),
            created_at=s.created_at,
            updated_at=s.updated_at,
        )
        for s in sessions
    ]


def create_session(
    db: Session, title: str | None, user: User | None = None, *, commit: bool = True
) -> tuple[DecisionSession, str | None, int]:
    """创建当前唯一的临时比较；已有匿名身份会复用，并清掉该身份上次未完成的比较。
    首次访问时新建匿名 user + auth_session。返回 (session, cookie_token 或 None, ttl_seconds)。

    v0.6 两环节模型：会话创建即进入 completion 阶段，并自动落两张默认
    候选项（Offer A / Offer B，公司岗位留空可后续改名）；第三份由信息
    补全页按需添加。
    """
    settings = get_settings()
    ttl = timedelta(days=settings.session_ttl_days)

    if user is not None:
        token = None
        db.execute(delete(DecisionSession).where(DecisionSession.user_id == user.id))
    else:
        user, token, _ = ensure_identity(db)

    make_room(db, DecisionSession, settings.max_sessions, protected_user=user.id)
    session = DecisionSession(user_id=user.id, title=title, phase="completion")
    db.add(session)
    db.flush()  # 取回 session.id 供默认候选项外键使用
    for slot, letter in enumerate("AB", start=1):
        db.add(
            Offer(
                session_id=session.id,
                display_order=slot,
                company=f"Offer {letter}",
                position="",
            )
        )
    if commit:
        db.commit()
    else:
        db.flush()
    return session, token, int(ttl.total_seconds())


def ensure_identity(db: Session, user: User | None = None) -> tuple[User, str | None, int]:
    """模型配置和比较流程复用浏览器身份，配置页面不创建空比较。"""
    ttl = timedelta(days=get_settings().session_ttl_days)
    if user is not None:
        return user, None, int(ttl.total_seconds())
    prune_state(db)
    make_room(db, User, get_settings().max_identities)
    now = _now()
    user = User()
    db.add(user)
    db.flush()
    token = secrets.token_urlsafe(32)
    db.add(AuthSession(
        user_id=user.id, token_hash=hash_token(token), created_at=now,
        last_used_at=now, expires_at=now + ttl,
    ))
    return user, token, int(ttl.total_seconds())


def set_session_cookie(response, token: str, max_age_seconds: int) -> None:
    settings = get_settings()
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=max_age_seconds,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )


def delete_session(db: Session, session: DecisionSession) -> None:
    db.delete(session)  # 级联清除该次临时比较的候选项、事实与结果
    db.commit()
