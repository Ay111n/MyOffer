"""独立试算与报告恢复。试算不写事实、偏好或快照；恢复只采用校验后的输入。"""
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import delete

from app.domain.contracts import RawFactInput
from app.models import Offer, RawFact, UserPreference
from app.schemas import ReportScenarioRequest
from app.services.fact_validation import normalize_fact_value, validate_fact_value
from app.services.pipeline import compute_snapshot
from app.services.preference_service import normalize_weights
from app.services.recompute import evaluate_and_snapshot


def invalid(message):
    return HTTPException(status_code=422, detail={"code": "validation_error", "message": message})


def scenario(snapshot, body: ReportScenarioRequest, rules):
    inp = snapshot.inputs.model_copy(deep=True)
    offer = next((o for o in inp.offers if o.offer_id == body.offer_id), None)
    if offer is None:
        raise invalid("试算对象不在该报告中")
    facts = dict(offer.facts)
    updates = {}
    if body.bonus_factor != 1:
        method = facts.get("annual_bonus_method")
        key = "annual_bonus_months" if method and method.value == "multiple" else "annual_bonus_value"
        fact = facts.get(key)
        if not fact or fact.status != "known" or not isinstance(fact.value, (float, int)):
            raise invalid("该 Offer 尚无可用于试算的奖金数据")
        updates[key] = fact.value * body.bonus_factor
    if body.weekly_work_hours is not None:
        updates["weekly_work_hours"] = body.weekly_work_hours
    if body.commute_minutes is not None:
        updates["commute_minutes"] = body.commute_minutes
    for key, value in updates.items():
        validate_fact_value(rules, key, value)
        facts[key] = RawFactInput(field_key=key, value=value, status="known", source="assumption", reliability=0.25)
    offers = [o.model_copy(update={"facts": facts}) if o.offer_id == offer.offer_id else o for o in inp.offers]
    preferences = inp.preferences
    if body.weights is not None:
        preferences = preferences.model_copy(update={"weights": normalize_weights(rules, body.weights)})
    return compute_snapshot(session_id=snapshot.session_id, trigger_type="scenario",
                            inp=inp.model_copy(update={"offers": offers, "preferences": preferences}), rules=rules)


def validate_restore(inp, rules):
    if not 1 <= len(inp.offers) <= 3:
        raise invalid("文件必须包含 1 至 3 份 Offer")
    if len({o.offer_id for o in inp.offers}) != len(inp.offers):
        raise invalid("报告中的 Offer 标识重复")
    normalize_weights(rules, inp.preferences.weights)
    if inp.preferences.buy_house_intent not in (None, "consider", "not_consider", "undecided"):
        raise invalid("购房意向无效")
    if len(inp.preferences.answers) > 40:
        raise invalid("偏好答案数量无效")
    for offer in inp.offers:
        if len(offer.company) > 200 or len(offer.position) > 200 or len(offer.facts) > 100:
            raise invalid("报告字段超出大小限制")
        for key, fact in offer.facts.items():
            if key != fact.field_key or key not in rules.fields or key == "meta":
                raise invalid("报告包含无法识别的字段")
            if fact.status in ("unknown", "not_applicable"):
                if fact.value is not None:
                    raise invalid("未知或不适用字段不能携带数值")
                continue
            if fact.source not in rules.sources:
                raise invalid("报告包含无法识别的事实来源")
            if fact.value is None and fact.status != "need_confirmation":
                raise invalid("已知字段缺少数值")
            if fact.value is not None:
                try:
                    validate_fact_value(rules, key, normalize_fact_value(rules, key, fact.value))
                except ValueError as exc:
                    raise invalid(str(exc)) from exc
    return inp


def restore_inputs(db, session, inp, rules):
    db.execute(delete(Offer).where(Offer.session_id == session.id))
    for order, original in enumerate(sorted(inp.offers, key=lambda o: o.display_order), 1):
        offer = Offer(id=uuid4(), session_id=session.id, display_order=order,
                      company=original.company, position=original.position)
        db.add(offer)
        db.flush()
        for key, fact in original.facts.items():
            empty = fact.status in ("unknown", "not_applicable")
            reliability = None if empty else rules.fact_reliability(key, fact.source)
            # 保留文件中更保守的来源评价，不能靠导入抬高可靠性。
            if reliability is not None and fact.reliability is not None:
                reliability = min(reliability, max(0.0, fact.reliability))
            db.add(RawFact(offer_id=offer.id, field_key=key, status=fact.status,
                           value=None if empty else normalize_fact_value(rules, key, fact.value),
                           source="not_applicable" if fact.status == "not_applicable" else "assumption" if empty else fact.source,
                           reliability=reliability, version=1))
    prefs = inp.preferences
    answers = [a for a in prefs.answers if a.get("question_id") != "buy_house_intent"]
    if prefs.buy_house_intent:
        answers.append({"question_id": "buy_house_intent", "choice": prefs.buy_house_intent})
    db.add(UserPreference(session_id=session.id, weights=normalize_weights(rules, prefs.weights),
                          source=prefs.source, questionnaire_version=prefs.questionnaire_version,
                          answers=answers, version=1))
    session.phase = "completion"
    snapshot, seq = evaluate_and_snapshot(db, session, "report_restore", rules)
    db.commit()
    return snapshot, seq
