"""问题作答事务。

事务固定顺序：
  全局 DbGate → 校验 session/question/offer 归属 → 校验 field_key ∈ outputs →
  逐字段校验 status/value/source → 归一化 → no-op detection →
  upsert question_state → upsert raw_facts → need_confirmation → due diligence →
  evaluate → DecisionSnapshot insert → phase transition → commit

纯函数（validate_and_normalize / aggregate_answer_status / answers_changed）
与存储实现解耦，可独立金标准测试；事务体只做编排。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import DecisionSession, DueDiligenceItem, Offer, QuestionState, RawFact
from app.rules_runtime import RuleSet, ensure_rule_mirrors
from app.schemas import AnswerItem, AnswerRequest, FieldAnswer  # noqa: F401 (类型标注)
from app.services.fact_validation import normalize_fact_value, validate_fact_value
from app.services.question_service import aggregate_answer_status
from app.services.recompute import (
    evaluate_and_snapshot,
    latest_echo,
    reopen_completion,
    report_echo,
)


def _now():
    return datetime.now(UTC)


@dataclass
class NormalizedFact:
    field_key: str
    status: str                 # known / unknown / need_confirmation
    value: Any | None = None
    source: str | None = None
    note: str | None = None


@dataclass
class NormalizedAnswer:
    offer_id: UUID | None
    status: str                 # question_states.status 聚合摘要
    fields: list[NormalizedFact] = field(default_factory=list)


def _err(status: int, code: str, message: str, details: dict | None = None) -> HTTPException:
    return HTTPException(status_code=status,
                         detail={"code": code, "message": message, "details": details or {}})


def validate_and_normalize(
    rules: RuleSet,
    question_def: dict,
    answers: list[AnswerItem],
    session_offer_ids: set[UUID],
) -> list[NormalizedAnswer]:
    """纯函数：契约校验 + 归一化。所有拒绝路径都在这里。"""
    outputs = list(question_def.get("outputs", []))
    per_offer = question_def.get("comparison_mode", "per_offer") == "per_offer"
    normalized: list[NormalizedAnswer] = []

    if not answers:
        raise _err(422, "validation_error", "answers 不能为空")

    seen_targets: set[UUID | None] = set()
    for item in answers:
        # ── offer 归属（Q8）──────────────────────────────────
        if per_offer:
            if item.offer_id is None:
                raise _err(422, "validation_error", "per_offer 问题必须携带 offer_id")
            if item.offer_id not in session_offer_ids:
                raise _err(404, "not_found", "Offer not found")
        else:
            if item.offer_id is not None:
                raise _err(422, "validation_error", "per_session 问题不携带 offer_id")
        if item.offer_id in seen_targets:
            raise _err(422, "validation_error", "同一 Offer 在本题中重复提交")
        seen_targets.add(item.offer_id)

        if not item.fields:
            raise _err(422, "validation_error", "至少提交一个字段")

        nfields: list[NormalizedFact] = []
        seen_fields: set[str] = set()
        for fa in item.fields:
            # ── field_key ∈ question.outputs（Q7）────────────
            if fa.field_key not in outputs:
                raise _err(422, "validation_error", f"字段 {fa.field_key} 不属于本题 outputs",
                           {"field_errors": [{"path": fa.field_key, "code": "not_in_outputs",
                                              "message": "field not in question.outputs"}]})
            if fa.field_key in seen_fields:
                raise _err(422, "validation_error", f"字段 {fa.field_key} 重复提交")
            seen_fields.add(fa.field_key)

            # v0.2 产品减法：人工录入免填来源，统一记为 user_provided；
            # 调用方显式携带 source 时仍校验合法性，保证事实来源符合来源表。
            source = fa.source or "user_provided"
            if source not in rules.sources:
                raise _err(422, "validation_error", f"字段 {fa.field_key} 来源 '{source}' 不在来源表内",
                           {"field_errors": [{"path": fa.field_key, "code": "invalid_source",
                                              "message": f"unknown source '{source}'"}]})

            if fa.status == "known":
                if fa.value is None:
                    raise _err(422, "validation_error", f"字段 {fa.field_key} status=known 需要 value")
                value = normalize_fact_value(rules, fa.field_key, fa.value)
                try:
                    validate_fact_value(rules, fa.field_key, value)
                except ValueError as exc:
                    code = getattr(exc, "code", "invalid_value")
                    raise _err(422, "validation_error", str(exc),
                               {"field_errors": [{"path": fa.field_key, "code": code, "message": str(exc)}]})
                nfields.append(NormalizedFact(fa.field_key, "known", value, source, fa.note))
            elif fa.status == "unknown":
                if fa.value is not None:
                    raise _err(422, "validation_error", f"字段 {fa.field_key} status=unknown 不携带 value")
                nfields.append(NormalizedFact(fa.field_key, "unknown", None, None, fa.note))
            elif fa.status == "not_applicable":
                # 依赖字段不适用：无值无来源，不参与评分
                if fa.value is not None or fa.source:
                    raise _err(422, "validation_error", f"字段 {fa.field_key} status=not_applicable 不携带 value/source")
                nfields.append(NormalizedFact(fa.field_key, "not_applicable", None, None, fa.note))
            else:  # need_confirmation
                # 候选值与 known 走同一取值校验（此前任意 JSON 可直落库）。
                # value 可为 null（待确认、暂无候选值）：写路径与 DB 约束均支持，
                # 必须落库——静默丢弃会让用户输入无痕丢失，空提交还会 500。
                value: Any | None = None
                if fa.value is not None:
                    value = normalize_fact_value(rules, fa.field_key, fa.value)
                    try:
                        validate_fact_value(rules, fa.field_key, value)
                    except ValueError as exc:
                        code = getattr(exc, "code", "invalid_value")
                        raise _err(422, "validation_error", str(exc),
                                   {"field_errors": [{"path": fa.field_key, "code": code,
                                                      "message": str(exc)}]})
                nfields.append(NormalizedFact(fa.field_key, "need_confirmation", value, source, fa.note))

        normalized.append(NormalizedAnswer(
            offer_id=item.offer_id,
            status=aggregate_answer_status([f.status for f in nfields]),
            fields=nfields,
        ))
    return normalized


def _canon(v: Any) -> str:
    return json.dumps(v, sort_keys=True, ensure_ascii=False, default=str)


def _storage_source(status: str, source: str | None) -> str | None:
    """unknown/not_applicable 落库时 source 由 status 决定（写路径 :271/:281）。

    no-op 比较前先把归一化侧对齐到同一规范，否则「不知道」重放永远
    命中不了 no-op detection，每次都会新增快照。
    """
    if status == "unknown":
        return "assumption"
    if status == "not_applicable":
        return "not_applicable"
    return source or None


def answers_changed(
    existing_states: dict[UUID | None, tuple[str, Any]],
    existing_facts: dict[tuple[UUID | None, str], tuple[str, Any, str | None, str | None]],
    normalized: list[NormalizedAnswer],
) -> bool:
    """纯函数（修正 4）：提交内容与当前状态完全一致 → no-op。

    existing_states: (offer_id|None) → (status, answer payload)
    existing_facts:  (offer_id|None, field_key) → (status, value, source, note)
    """
    for ans in normalized:
        st = existing_states.get(ans.offer_id)
        if st is None or st[0] != ans.status:
            return True
        for f in ans.fields:
            cur = existing_facts.get((ans.offer_id, f.field_key))
            if cur is None:
                return True
            e_status, e_value, e_source, e_note = cur
            if e_status != f.status:
                return True
            if _canon(e_value) != _canon(f.value):
                return True
            if (e_source or None) != _storage_source(f.status, f.source):
                return True
            if (e_note or None) != (f.note or None):
                return True
    return False


def _load_question_state(
    db: Session, session, question_key: str, outputs: list[str], offer_ids: list,
) -> tuple[list, dict, list, dict]:
    """读取某题当前 QuestionState / RawFact，供 no-op 比较与增量更新定位。"""
    state_rows = db.scalars(
        select(QuestionState).where(
            QuestionState.session_id == session.id,
            QuestionState.question_key == question_key,
        )
    ).all()
    existing_states = {r.offer_id: (r.status, r.answer) for r in state_rows}
    fact_rows = (
        db.scalars(
            select(RawFact).where(
                RawFact.offer_id.in_(offer_ids),
                RawFact.field_key.in_(outputs),
            )
        ).all() if offer_ids else []
    )
    existing_facts = {
        (r.offer_id, r.field_key): (r.status, r.value, r.source, r.note) for r in fact_rows
    }
    return state_rows, existing_states, fact_rows, existing_facts


def _write_question_answers(
    db: Session, session, question_key: str, normalized: list[NormalizedAnswer],
    state_rows: list, fact_rows: list, rules: RuleSet,
) -> dict[str, str]:
    """写入单题的 states/facts/尽调项（不 evaluate、不 commit）。
    返回 offer_id 字符串 → 聚合状态。"""
    now_states: dict[str, str] = {}
    for ans in normalized:
        state_row = next((r for r in state_rows if r.offer_id == ans.offer_id), None)
        payload = {"fields": [
            {"field_key": f.field_key, "status": f.status, "value": f.value,
             "source": f.source, "note": f.note}
            for f in ans.fields
        ]}
        if state_row is None:
            db.add(QuestionState(
                session_id=session.id, question_key=question_key, offer_id=ans.offer_id,
                status=ans.status, answer=payload, answered_at=_now(),
            ))
        else:
            state_row.status = ans.status
            state_row.answer = payload
            state_row.answered_at = _now()
        now_states[str(ans.offer_id)] = ans.status

        for f in ans.fields:
            fact_row = next(
                (r for r in fact_rows if r.offer_id == ans.offer_id and r.field_key == f.field_key),
                None,
            )
            if f.status == "known":
                reliability = rules.fact_reliability(f.field_key, f.source)
                if fact_row is None:
                    db.add(RawFact(
                        offer_id=ans.offer_id, field_key=f.field_key, value=f.value,
                        status="known", source=f.source, reliability=reliability, note=f.note,
                        origin_question_key=question_key,
                    ))
                else:
                    fact_row.value = f.value
                    fact_row.status = "known"
                    fact_row.source = f.source
                    fact_row.reliability = reliability
                    fact_row.note = f.note
                    fact_row.origin_question_key = question_key
                    fact_row.version += 1
            elif f.status in ("unknown", "not_applicable"):
                # unknown=事实状态未知；not_applicable=依赖字段判定不适用；都不参与评分
                row_source = "assumption" if f.status == "unknown" else "not_applicable"
                if fact_row is None:
                    db.add(RawFact(
                        offer_id=ans.offer_id, field_key=f.field_key, value=None,
                        status=f.status, source=row_source, reliability=None,
                        note=f.note, origin_question_key=question_key,
                    ))
                else:
                    fact_row.value = None
                    fact_row.status = f.status
                    fact_row.source = row_source
                    fact_row.reliability = None
                    # note 必须随更新落库：no-op 检测把 note 纳入比较，
                    # 更新分支漏写会让相同提交永远判「有变化」，快照无限新增
                    fact_row.note = f.note
                    fact_row.origin_question_key = question_key
                    fact_row.version += 1
            else:  # need_confirmation
                reliability = rules.fact_reliability(f.field_key, f.source or "assumption")
                if fact_row is None:
                    db.add(RawFact(
                        offer_id=ans.offer_id, field_key=f.field_key, value=f.value,
                        status="need_confirmation", source=f.source or "assumption",
                        reliability=reliability, note=f.note, origin_question_key=question_key,
                    ))
                else:
                    fact_row.value = f.value
                    fact_row.status = "need_confirmation"
                    fact_row.source = f.source or "assumption"
                    fact_row.reliability = reliability
                    fact_row.note = f.note
                    fact_row.origin_question_key = question_key
                    fact_row.version += 1

        # need_confirmation → 尽调清单（每 Offer×问题最多一条 open 项）。
        # 匹配用 question_key 列本身（content 前缀匹配对格式变化脆弱）；
        # 已有 open 项时刷新 content——字段集变化后清单仍显示旧字段列表
        # 会误导用户去确认已经不再需要确认的内容。dismissed 行不动，
        # 变更后的重答会另开新 open 项（重新提醒是预期行为）。
        nc_fields = [f.field_key for f in ans.fields if f.status == "need_confirmation"]
        if nc_fields:
            existing_dd = db.scalars(
                select(DueDiligenceItem).where(
                    DueDiligenceItem.session_id == session.id,
                    DueDiligenceItem.question_key == question_key,
                    DueDiligenceItem.status == "open",
                )
            ).all()
            open_item = next(
                (d for d in existing_dd if d.offer_id == ans.offer_id), None
            )
            content = f"{question_key}：请确认 {', '.join(nc_fields)}"
            if open_item is None:
                db.add(DueDiligenceItem(
                    session_id=session.id, offer_id=ans.offer_id, question_key=question_key,
                    content=content,
                    suggested_source=None, status="open",
                ))
            else:
                open_item.content = content
    return now_states


def submit_answers(
    db: Session, session: DecisionSession, question_key: str, body, rules: RuleSet
) -> dict:
    """完整作答事务。返回 AnswerResponse 的组成部分（不包装 HTTP）。"""
    ensure_rule_mirrors(db, rules)  # 惰性兜底：镜像缺失时 raw_facts/question_states FK 会失败

    question_def = rules.questions.get("questions", {}).get(question_key)
    if question_def is None:
        raise _err(404, "not_found", f"Question '{question_key}' not found")
    outputs = list(question_def.get("outputs", []))

    session_offers = db.scalars(
        select(Offer).where(Offer.session_id == session.id)
    ).all()
    session_offer_ids = {o.id for o in session_offers}

    normalized = validate_and_normalize(rules, question_def, body.answers, session_offer_ids)

    # ── no-op detection（修正 4）────────────────────────────
    offer_ids = [oid for oid in session_offer_ids]
    state_rows, existing_states, fact_rows, existing_facts = _load_question_state(
        db, session, question_key, outputs, offer_ids)

    if not answers_changed(existing_states, existing_facts, normalized):
        db.commit()
        return {
            "data": {"question_key": question_key,
                     "states": {str(oid): st for oid, (st, _a) in existing_states.items()}},
            "decision": latest_echo(db, session),
        }

    # ── 写入 ───────────────────────────────────────────────
    now_states = _write_question_answers(db, session, question_key, normalized,
                                         state_rows, fact_rows, rules)

    # ── phase 迁移：results 阶段的作答意味着用户仍在补充信息，
    #    phase 回退 completion；再次点击「查看对比结果」才会回到 results。
    #    结论强度来自重算后的快照，与 phase 交互状态严格分离。────────
    reopen_completion(session)
    _snapshot, seq = evaluate_and_snapshot(db, session, trigger_type="question_answered", rules=rules)
    db.commit()
    return {
        "data": {"question_key": question_key, "states": now_states},
        "decision": report_echo(_snapshot, seq),
    }


def submit_answers_batch(db: Session, session: DecisionSession, items, rules: RuleSet) -> dict:
    """批量作答事务（「生成对比报告」路径）。

    与单题事务共享同一套校验 / no-op / 写入语义；差异只在重算次数：
    逐题校验+写入（同一事务），全部成功后只 evaluate 一次、只落一条快照。
    校验阶段先于任何写入，任一题失败即整批拒绝，天然原子；错误
    details 附 question_key 供前端把错误定位回具体题目。
    全部内容与现状一致（全 no-op）时不新增快照，复用最新 echo。
    """
    ensure_rule_mirrors(db, rules)

    session_offer_ids = {o.id for o in db.scalars(
        select(Offer).where(Offer.session_id == session.id)
    ).all()}

    prepared: list[tuple[str, dict, list[NormalizedAnswer]]] = []
    seen_questions: set[str] = set()
    for item in items:
        question_key = item.question_key
        question_def = rules.questions.get("questions", {}).get(question_key)
        if question_def is None:
            raise _err(404, "not_found", f"Question '{question_key}' not found",
                       {"question_key": question_key})
        if question_key in seen_questions:
            raise _err(422, "validation_error", f"问题 {question_key} 在批内重复提交",
                       {"question_key": question_key})
        seen_questions.add(question_key)
        try:
            normalized = validate_and_normalize(rules, question_def, item.answers, session_offer_ids)
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
            inner = detail.get("details")
            detail["details"] = {**(inner if isinstance(inner, dict) else {}),
                                 "question_key": question_key}
            exc.detail = detail
            raise
        prepared.append((question_key, question_def, normalized))

    questions: dict[str, dict[str, str]] = {}
    changed = False
    for question_key, question_def, normalized in prepared:
        outputs = list(question_def.get("outputs", []))
        state_rows, existing_states, fact_rows, existing_facts = _load_question_state(
            db, session, question_key, outputs, list(session_offer_ids))
        if not answers_changed(existing_states, existing_facts, normalized):
            questions[question_key] = {str(oid): st for oid, (st, _a) in existing_states.items()}
            continue
        questions[question_key] = _write_question_answers(
            db, session, question_key, normalized, state_rows, fact_rows, rules)
        changed = True

    if not changed:
        db.commit()
        return {"data": {"questions": questions}, "decision": latest_echo(db, session)}
    reopen_completion(session)
    _snapshot, seq = evaluate_and_snapshot(db, session, trigger_type="batch_answered", rules=rules)
    db.commit()
    return {"data": {"questions": questions}, "decision": report_echo(_snapshot, seq)}
