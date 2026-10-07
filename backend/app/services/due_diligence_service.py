"""尽调清单服务。

GET：open/done/dismissed 全量 + still_relevant（关联问题产出字段仍非 known → True）。
PATCH：仅更新状态——不触发 evaluate、不新增快照（不影响决策结果）。
"""
from __future__ import annotations

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import DecisionSession, DueDiligenceItem, Offer, RawFact
from app.rules_runtime import RuleSet
from app.schemas import DueDiligenceItem as DueDiligenceItemResource
from app.schemas import DueDiligenceResponse


def compute_still_relevant(
    rules: RuleSet,
    question_key: str | None,
    offer_id: UUID | None,
    fact_status_by_offer: dict[UUID, dict[str, str]],
) -> bool:
    """纯函数：关联问题的任一 output 字段仍非 known → 仍然相关。"""
    if not question_key or not offer_id:
        return True
    qdef = rules.questions.get("questions", {}).get(question_key)
    if not qdef:
        return True
    statuses = fact_status_by_offer.get(offer_id, {})
    for fk in qdef.get("outputs", []):
        if statuses.get(fk) != "known":
            return True
    return False


def _fact_status_map(db: Session, session: DecisionSession) -> dict[UUID, dict[str, str]]:
    offers = db.scalars(select(Offer).where(Offer.session_id == session.id)).all()
    result: dict[UUID, dict[str, str]] = {o.id: {} for o in offers}
    if offers:
        rows = db.scalars(
            select(RawFact).where(RawFact.offer_id.in_([o.id for o in offers]))
        ).all()
        for f in rows:
            result[f.offer_id][f.field_key] = f.status
    return result


def list_items(db: Session, session: DecisionSession, rules: RuleSet) -> DueDiligenceResponse:
    rows = db.scalars(
        select(DueDiligenceItem).where(DueDiligenceItem.session_id == session.id)
        .order_by(DueDiligenceItem.created_at)
    ).all()
    statuses = _fact_status_map(db, session)
    items = [
        DueDiligenceItemResource(
            id=r.id, offer_id=r.offer_id, question_key=r.question_key,
            content=r.content, suggested_source=r.suggested_source,
            status=r.status,  # type: ignore[arg-type]
            still_relevant=compute_still_relevant(rules, r.question_key, r.offer_id, statuses)
            if r.status == "open" else False,
        )
        for r in rows
    ]
    return DueDiligenceResponse(data={"items": items})


def update_status(
    db: Session, session: DecisionSession, item_id: UUID, status: str, rules: RuleSet,
) -> DueDiligenceItemResource:
    item = db.get(DueDiligenceItem, item_id)
    if item is None or item.session_id != session.id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Item not found"})
    item.status = status
    db.commit()
    db.refresh(item)
    # 与 GET 同口径：open → 按关联字段实时状态计算；非 open → False。
    # 曾硬编码 True，PATCH 后前端拿到的相关性与刷新后的 GET 不一致。
    fact_statuses = _fact_status_map(db, session) if item.status == "open" else {}
    return DueDiligenceItemResource(
        id=item.id, offer_id=item.offer_id, question_key=item.question_key,
        content=item.content, suggested_source=item.suggested_source,
        status=item.status,  # type: ignore[arg-type]
        still_relevant=compute_still_relevant(
            rules, item.question_key, item.offer_id, fact_statuses,
        )
        if item.status == "open" else False,
    )
