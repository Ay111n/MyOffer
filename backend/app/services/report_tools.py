"""独立试算与报告恢复。试算不写事实、偏好或快照；恢复只采用校验后的输入。"""
import math
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import delete

from app.domain.contracts import RawFactInput
from app.models import Offer, RawFact, UserPreference
from app.schemas import ParitySolution, ReportScenarioRequest, ReportScenarioSolveRequest
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
    if body.monthly_base is not None:
        updates["monthly_base"] = body.monthly_base
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


# ── 反解追平点 ─────────────────────────────────────────────────

_SOLVE_PRECISION = 1.0    # 二分收敛精度（元）
_SOLVE_STEP = 100.0       # 展示值向上取整到百元（谈判口径更可读）


def solve_parity(snapshot, body: ReportScenarioSolveRequest, rules) -> ParitySolution:
    """反解：目标 Offer 的月薪调到多少，展示综合分追平当前第一名。

    展示分对月薪近似单调不降（现金/购买力上升占主导；评分口径已中和
    少缴社保的现金增量），0.1 粒度的取整平台不影响 >= 判定下的二分。
    二分只保证找到「一个」追平点并在单调段内最小；展示值向上取整到
    百元确保按报出的数字谈不会少算。字段上界内仍追不平 → required=None。"""
    rows = snapshot.outputs.offers
    target = next((o for o in rows if o.offer_id == body.offer_id), None)
    if target is None:
        raise invalid("试算对象不在该报告中")
    scored = [o for o in rows if o.overall_score is not None]
    if len(scored) < 2 or target.overall_score is None:
        raise invalid("报告尚未形成完整排名，无法反解追平点")
    leader = max((o for o in scored if o.offer_id != target.offer_id),
                 key=lambda o: o.overall_score)
    leader_score = float(leader.overall_score)
    if float(target.overall_score) >= leader_score:
        raise invalid("该 Offer 已并列或领先，无需追平")

    src = next((o for o in snapshot.inputs.offers if o.offer_id == body.offer_id), None)
    base_fact = src.facts.get("monthly_base") if src is not None else None
    if base_fact is None or not isinstance(base_fact.value, (int, float)) or isinstance(base_fact.value, bool):
        raise invalid("该 Offer 尚无可用于反解的月薪数据")
    current = float(base_fact.value)

    def tied(value: float) -> bool:
        trial = scenario(snapshot, ReportScenarioRequest(
            snapshot_seq=body.snapshot_seq, offer_id=body.offer_id, monthly_base=value), rules)
        row = next(o for o in trial.outputs.offers if o.offer_id == body.offer_id)
        return float(row.overall_score) >= leader_score

    max_base = float((rules.fields.get("monthly_base") or {}).get("max") or 1_000_000)
    max_base = min(max_base, 1_000_000)  # 与请求 schema 守卫一致
    common = dict(lever="monthly_base", target_id=target.offer_id, leader_id=leader.offer_id,
                  leader_score=leader_score, target_current_score=float(target.overall_score),
                  current_value=current)
    if not tied(max_base):
        return ParitySolution(**common, required_value=None, delta=None)
    lo, hi = current, max_base
    while hi - lo > _SOLVE_PRECISION:
        mid = (lo + hi) / 2
        if tied(mid):
            hi = mid
        else:
            lo = mid
    required = min(max_base, math.ceil(hi / _SOLVE_STEP) * _SOLVE_STEP)
    return ParitySolution(**common, required_value=required, delta=round(required - current, 2))


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
