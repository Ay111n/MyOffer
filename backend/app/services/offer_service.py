"""Offer 与 RawFact 写入服务。

原则：
- offers 表只存身份字段（company/position，均选填——留空时按空位序号
  填默认值 公司1/2/3、岗位A/B/C）；其余全部事实走问题作答或 PATCH facts。
- PATCH facts 是全 API 唯一直接写事实的入口（问题作答端点除外）。
- 每个写操作 = 全局 DbGate → 写入 → evaluate → 快照 → commit。
"""
from __future__ import annotations

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models import DecisionSession, DueDiligenceItem, Offer, QuestionState, RawFact
from app.rules_runtime import RuleSet, ensure_rule_mirrors
from app.schemas import (
    DecisionEcho,
    DeletedResource,
    FactPatch,
    FactResource,
    OfferCreateRequest,
    OfferPatchRequest,
    OfferResetRequest,
    OfferResource,
)
from app.services.fact_validation import normalize_fact_value, validate_fact_value
from app.services.recompute import (
    evaluate_and_snapshot,
    latest_echo,
    reopen_completion,
    report_echo,
)

MAX_OFFERS = 3


def _conflict(code: str, message: str, details: dict | None = None) -> HTTPException:
    return HTTPException(status_code=409, detail={"code": code, "message": message, "details": details or {}})


def _unprocessable(code: str, message: str) -> HTTPException:
    return HTTPException(status_code=422, detail={"code": code, "message": message})


def _reliability_of(rules: RuleSet, field_key: str, source: str) -> float:
    score = rules.reliability.get("sources", {}).get(source)
    if score is None:
        raise _unprocessable("invalid_source", f"source '{source}' is not in reliability table")
    return rules.fact_reliability(field_key, source)


def _offer_resource(offer: Offer, facts: list[RawFact]) -> OfferResource:
    return OfferResource(
        offer_id=offer.id,
        display_order=offer.display_order,
        company=offer.company,
        position=offer.position,
        version=offer.version,
        facts={
            f.field_key: FactResource(
                value=f.value, status=f.status, source=f.source,
                reliability=float(f.reliability) if f.reliability is not None else None,
            )
            for f in facts
        },
    )


def _get_offer(db: Session, session: DecisionSession, oid: UUID) -> Offer:
    offer = db.get(Offer, oid)
    if offer is None or offer.session_id != session.id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Offer not found"})
    return offer


def _offer_facts(db: Session, offer_id: UUID) -> list[RawFact]:
    return list(db.scalars(select(RawFact).where(RawFact.offer_id == offer_id)).all())


def _next_slot(db: Session, session_id) -> int | None:
    """返回 1..MAX_OFFERS 中最小的空位序号；已满返回 None。

    删除后会压紧编号，因此新增候选项顺次成为 Offer B 或 Offer C。
    """
    used = set(
        db.scalars(
            select(Offer.display_order).where(Offer.session_id == session_id)
        ).all()
    )
    for slot in range(1, MAX_OFFERS + 1):
        if slot not in used:
            return slot
    return None


def create_offer(
    db: Session, session: DecisionSession, body: OfferCreateRequest, rules: RuleSet
) -> tuple[OfferResource, DecisionEcho]:
    ensure_rule_mirrors(db, rules)  # 惰性兜底：镜像缺失时 raw_facts FK 会失败

    slot = _next_slot(db, session.id)
    if slot is None:
        raise _conflict("offer_limit_reached", f"At most {MAX_OFFERS} offers per session")

    offer = Offer(
        session_id=session.id,
        display_order=slot,
        # v0.6：默认以 Offer A/B/C 指代候选项；公司岗位均为选填改名入口
        company=f"Offer {chr(64 + slot)}",
        position="",
    )
    db.add(offer)
    db.flush()

    reopen_completion(session)
    snapshot, seq = evaluate_and_snapshot(db, session, trigger_type="offer_created", rules=rules)
    db.commit()
    db.refresh(offer)
    return _offer_resource(offer, _offer_facts(db, offer.id)), report_echo(snapshot, seq)


def list_offers(db: Session, session: DecisionSession) -> list[OfferResource]:
    offers = db.scalars(
        select(Offer).where(Offer.session_id == session.id).order_by(Offer.display_order)
    ).all()
    return [_offer_resource(o, _offer_facts(db, o.id)) for o in offers]


def patch_offer(
    db: Session, session: DecisionSession, oid: UUID, body: OfferPatchRequest, rules: RuleSet
) -> tuple[OfferResource, DecisionEcho]:
    ensure_rule_mirrors(db, rules)  # 惰性兜底：镜像缺失时 raw_facts FK 会失败
    offer = _get_offer(db, session, oid)

    if offer.version != body.version:
        raise _conflict(
            "version_conflict",
            "Offer was modified by another client",
            {"current_version": offer.version},
        )

    existing = {f.field_key: f for f in _offer_facts(db, offer.id)}
    facts_changed = False
    for patch in body.facts:
        facts_changed = _apply_fact_patch(db, rules, offer, existing, patch) or facts_changed

    changed = facts_changed
    if changed:
        offer.version += 1
    else:
        # PATCH 只携带当前版本、没有实际变更时保持幂等：不新增快照，
        # 也不把用户已经查看过的结果错误地重新打开。
        db.commit()
        db.refresh(offer)
        return _offer_resource(offer, _offer_facts(db, offer.id)), latest_echo(db, session)

    reopen_completion(session)
    snapshot, seq = evaluate_and_snapshot(db, session, trigger_type="offer_updated", rules=rules)
    db.commit()
    db.refresh(offer)
    return _offer_resource(offer, _offer_facts(db, offer.id)), report_echo(snapshot, seq)


def _apply_fact_patch(
    db: Session,
    rules: RuleSet,
    offer: Offer,
    existing: dict[str, RawFact],
    patch: FactPatch,
) -> bool:
    # 写入前规范化（城市名去「市」后缀等），再按字段注册表校验；
    # 直接 API 调用与人工录入共用这一条写入口径。
    value = normalize_fact_value(rules, patch.field_key, patch.value)
    validate_fact_value(rules, patch.field_key, value)
    # v0.2 产品减法：人工录入免填来源，统一 user_provided（显式携带则按传入值）
    source = patch.source or "user_provided"
    reliability = _reliability_of(rules, patch.field_key, source)
    row = existing.get(patch.field_key)
    if row is None:
        row = RawFact(
            offer_id=offer.id,
            field_key=patch.field_key,
            value=value,
            status="known",
            source=source,
            reliability=reliability,
            note=patch.note,
        )
        db.add(row)
        # 同一 PATCH 中重复同一 field_key 时，后续项应复用本次新增行，
        # 避免在事务提交时触发 raw_facts 的唯一约束。
        existing[patch.field_key] = row
        return True
    else:
        same = (
            row.status == "known"
            and row.value == value
            and row.source == source
            and (row.note or None) == (patch.note or None)
        )
        if same:
            return False
        row.value = value
        row.source = source
        row.status = "known"
        row.reliability = reliability
        row.note = patch.note
        row.version += 1
        return True


def delete_offer(
    db: Session, session: DecisionSession, oid: UUID, rules: RuleSet
) -> tuple[DeletedResource, DecisionEcho]:
    ensure_rule_mirrors(db, rules)  # 惰性兜底：镜像缺失时 raw_facts FK 会失败
    offer = _get_offer(db, session, oid)
    db.delete(offer)  # 级联删除事实与问题状态
    db.flush()
    remaining = db.scalars(
        select(Offer).where(Offer.session_id == session.id).order_by(Offer.display_order)
    ).all()
    for slot, survivor in enumerate(remaining, start=1):
        previous_slot = survivor.display_order
        if previous_slot == slot:
            continue
        # 只调整默认名称；公司/岗位、事实、草稿关联仍属于同一个 offer_id。
        if survivor.company == f"Offer {chr(64 + previous_slot)}":
            survivor.company = f"Offer {chr(64 + slot)}"
        survivor.display_order = slot
        survivor.version += 1
        # 从小到大逐个释放旧槽位，避免 ORM 按 UUID 批量更新时触发唯一约束。
        db.flush()
    reopen_completion(session)
    snapshot, seq = evaluate_and_snapshot(db, session, trigger_type="offer_updated", rules=rules)
    db.commit()
    return DeletedResource(), report_echo(snapshot, seq)


def reset_offer(
    db: Session, session: DecisionSession, oid: UUID, body: OfferResetRequest, rules: RuleSet
) -> tuple[OfferResource, DecisionEcho]:
    """清空一份 Offer 的身份、事实及作答，保留槽位和其他 Offer。"""
    offer = _get_offer(db, session, oid)
    if offer.version != body.version:
        raise _conflict("version_conflict", "Offer was modified by another client",
                        {"current_version": offer.version})

    default_company = f"Offer {chr(64 + offer.display_order)}"
    facts = _offer_facts(db, oid)
    states = db.scalars(select(QuestionState).where(
        QuestionState.session_id == session.id, QuestionState.offer_id == oid)).all()
    diligence = db.scalars(select(DueDiligenceItem).where(
        DueDiligenceItem.session_id == session.id, DueDiligenceItem.offer_id == oid)).all()
    if not (facts or states or diligence or offer.company != default_company or offer.position):
        db.commit()
        return _offer_resource(offer, []), latest_echo(db, session)

    db.execute(delete(RawFact).where(RawFact.offer_id == oid))
    db.execute(delete(QuestionState).where(
        QuestionState.session_id == session.id, QuestionState.offer_id == oid))
    db.execute(delete(DueDiligenceItem).where(
        DueDiligenceItem.session_id == session.id, DueDiligenceItem.offer_id == oid))
    offer.company = default_company
    offer.position = ""
    offer.version += 1
    reopen_completion(session)
    snapshot, seq = evaluate_and_snapshot(db, session, trigger_type="offer_updated", rules=rules)
    db.commit()
    db.refresh(offer)
    return _offer_resource(offer, []), report_echo(snapshot, seq)
