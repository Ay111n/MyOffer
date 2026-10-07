"""有界的进程内状态；所有调用须持有请求全局闸门，调用方负责提交。"""
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, exists, func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import AuthSession, DecisionSession, User


def prune_state(db: Session) -> None:
    now = datetime.now(UTC)
    cutoff = now - timedelta(days=get_settings().session_ttl_days)
    db.execute(delete(DecisionSession).where(DecisionSession.updated_at < cutoff)
               .execution_options(synchronize_session="fetch"))
    db.execute(delete(AuthSession).where(
        (AuthSession.expires_at <= now) | AuthSession.revoked_at.isnot(None))
               .execution_options(synchronize_session="fetch"))
    db.execute(delete(User).where(~exists(
        select(AuthSession.id).where(AuthSession.user_id == User.id))))


def make_room(db: Session, model, limit: int, *, protected_user=None) -> None:
    count = db.scalar(select(func.count()).select_from(model))
    excess = count - limit + 1
    if excess <= 0:
        return
    candidates = select(model.id)
    if protected_user is not None:
        candidates = candidates.where(model.user_id != protected_user)
    oldest = candidates.order_by(model.updated_at, model.created_at, model.id).limit(excess)
    db.execute(delete(model).where(model.id.in_(oldest)))
