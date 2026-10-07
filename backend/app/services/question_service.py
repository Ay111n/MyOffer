"""问题服务：按板块和轮次组织当前固定目录。

questions_catalog_payload：questions.yaml（areas + question_order）+ 当前事实
→ 前端可渲染结构。前端对题目定义零知识（prompt/选项/字段类型全部由后端下发）。

状态聚合规则（field-level 为唯一真相，question_state 只是提交摘要）：
  任何 output 有 known 事实        → answered
  无 known，但存在 need_confirmation → need_confirmation
  全部 output 事实均为 unknown      → unknown
  完全没有事实行                    → unanswered（"还没问到"）
"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import DecisionSession, Offer, RawFact
from app.rules_runtime import RuleSet
from app.schemas import (
    OfferQuestionState,
    QuestionArea,
    QuestionsCatalogData,
    RenderedQuestion,
    RenderField,
)


def aggregate_display_status(output_statuses: list[str | None]) -> str:
    """从 output 字段的事实状态聚合问题节点展示状态（not_applicable 视为已回答）。"""
    if not output_statuses:
        return "unanswered"
    if any(s in ("known", "not_applicable") for s in output_statuses):
        return "answered"
    if any(s == "need_confirmation" for s in output_statuses):
        return "need_confirmation"
    return "unknown"


def aggregate_answer_status(submitted_statuses: list[str]) -> str:
    """作答事务用：对本次提交的字段状态聚合 question_states.status。

    全部 unknown → unknown；存在 need_confirmation 且无 known → need_confirmation；
    not_applicable 视同 known（有效作答）；其他已提交情况 → answered。
    """
    if not submitted_statuses:
        raise ValueError("no submitted fields")
    if any(s in ("known", "not_applicable") for s in submitted_statuses):
        return "answered"
    if any(s == "need_confirmation" for s in submitted_statuses):
        return "need_confirmation"
    return "unknown"


def load_offers_data(db: Session, session: DecisionSession) -> list[dict[str, Any]]:
    """DB → hydration/作答共用的 offers 数据结构。"""
    offers = db.scalars(
        select(Offer).where(Offer.session_id == session.id).order_by(Offer.display_order)
    ).all()
    facts_by_offer: dict[UUID, dict[str, dict]] = {o.id: {} for o in offers}
    if offers:
        rows = db.scalars(
            select(RawFact).where(RawFact.offer_id.in_([o.id for o in offers]))
        ).all()
        for f in rows:
            facts_by_offer[f.offer_id][f.field_key] = {
                "value": f.value,
                "status": f.status,
                "source": f.source,
                "reliability": float(f.reliability) if f.reliability is not None else None,
            }
    return [{"offer_id": o.id, "facts": facts_by_offer[o.id]} for o in offers]


def hydrate_question(
    rules: RuleSet, qk: str, offers_data: list[dict[str, Any]]
) -> RenderedQuestion:
    questions = rules.questions.get("questions", {})
    qdef = questions[qk]
    outputs: list[str] = qdef.get("outputs", [])

    fields: list[RenderField] = []
    for fk in outputs:
        spec = rules.field(fk) or {}
        options = [
            {"value": o["value"], "label": o["label"]}
            for o in spec.get("options", [])
        ]
        allowed_from = spec.get("allowed_from")
        if not options and allowed_from:
            options = [
                {"value": value, "label": value}
                for value in rules.reference_values(str(allowed_from))
            ]
        fields.append(RenderField(
            field_key=fk,
            value_type=str(spec.get("value_type", "text")),
            evidence_category=spec.get("evidence_category"),
            allowed_sources=rules.applicable_sources(fk),
            options=options,
            default_value=spec.get("default_value"),
            ui_group=spec.get("ui_group"),
            ui_role=spec.get("ui_role"),
        ))

    prefill_from: list[str] = qdef.get("prefill_from", [])
    offers_state: dict[str, OfferQuestionState] = {}
    for od in offers_data:
        facts: dict[str, dict] = od["facts"]
        present = [facts[fk]["status"] for fk in outputs if fk in facts]
        status = aggregate_display_status(present)
        values = {fk: facts[fk]["value"] for fk in outputs
                  if fk in facts and facts[fk]["status"] == "known"}
        # 字段级事实状态：前端据此显示已回答（含 不知道/待确认）的字段
        statuses = {fk: str(facts[fk]["status"]) for fk in outputs if fk in facts}
        prefill = {}
        if status == "unanswered":
            prefill = {fk: facts[fk]["value"] for fk in prefill_from
                       if fk in facts and facts[fk]["status"] == "known"}
        offers_state[str(od["offer_id"])] = OfferQuestionState(
            status=status, values=values, statuses=statuses, prefill=prefill,
        )

    return RenderedQuestion(
        question_key=qk,
        section=qdef.get("section"),
        prompt=str(qdef.get("prompt", "")),
        comparison_mode=str(qdef.get("comparison_mode", "per_offer")),
        answer_type=str(qdef.get("answer_type", "enum")),
        unknown_allowed=True,
        fields=fields,
        recommended_sources=[str(s) for s in qdef.get("recommended_sources", [])],
        offers=offers_state,
    )


def questions_catalog_payload(
    rules: RuleSet, offers_data: list[dict[str, Any]], phase: str = "completion",
) -> QuestionsCatalogData:
    """按板块/轮次分组的问题目录：round 1 默认采集，round 2 由结果页引导进入。"""
    areas = rules.question_areas()
    area_order = rules.question_area_order()
    order = rules.question_order()
    grouped: dict[str, list[RenderedQuestion]] = {ak: [] for ak in area_order}
    for qk in order:
        qdef = rules.questions.get("questions", {}).get(qk)
        if qdef is None:
            continue
        section = str(qdef.get("section", ""))
        if section not in grouped:
            continue
        grouped[section].append(hydrate_question(rules, qk, offers_data))

    catalog = [
        QuestionArea(
            key=ak,
            label=str(areas[ak].get("label", ak)),
            round=int(areas[ak].get("round", 1)),
            description=str(areas[ak].get("description", "") or ""),
            questions=grouped[ak],
        )
        for ak in rules.question_area_order()
        if ak in areas
    ]
    # phase 取会话真实值：目录在 results 阶段（round 2 补充）同样可取，
    # 曾硬编码 "completion"，前端若依赖该字段会拿到过期阶段。
    return QuestionsCatalogData(phase=phase, areas=catalog)
