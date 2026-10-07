"""Three-dimension, comparable Offer scoring."""
from __future__ import annotations

from app.domain.contracts import DecisionInput, OfferInput, OfferReport, RawFactInput, ReportOutputs
from app.domain.report import (
    _band_max,
    _band_min,
    _clamp,
    _compliance_alert,
    _fact,
    _housing_module,
    _interp,
    _num,
    _offer_context,
    _salary_module,
    _text,
)
from app.rules_runtime import RuleSet

CORE = ("city", "monthly_base", "guaranteed_salary_months", "business_level",
        "entry_scope", "weekly_work_hours", "work_days_per_week")
SUB_FORMULAS = {
    "economic.cash": "常规年度现金按现有个税与五险一金规则估算；未缴或按最低基数缴费时，评分采用按工资缴费的参考现金，实际到手另行展示。约定调薪只影响现金子分。",
    "economic.entry": "签字及安家费＋搬迁安置补助＋政府人才补贴；名义金额按0、1万、3万、6万、10万元档位插值。",
    "economic.probation": "少拿金额＝月薪×试用期月数×(1－工资比例)；子分＝限制在0–100的[100－少拿金额÷(3×月薪)×100]。",
    "economic.purchasing": "展示城市调整后月购买力；子分只计入城市生活成本造成的购买力档位变化，以50分为中性值，避免现金收入重复计分。",
    "economic.benefits": "单位公积金、餐宿和补充医疗年价值÷评分参考常规年度税后现金，按比例插值。",
    "economic.housing": "按城市参考房价、首付与贷款参数估算月供及攒首付年限。",
    "growth.opportunity": "业务范围为基础；共同可比的用户影响接触程度纳入后合成。",
    "growth.responsibility": "新人承担层级为基础；共同可比的自主程度纳入后合成。",
    "growth.skills": "对本轮可比的问题复杂度、技能通用性及岗位和目标匹配度取平均。",
    "growth.cultivation": "带教、反馈和明确提供的培训资源分别换算后取平均。",
    "growth.options": "内部流动、成果展示和 AI 工具条件分别换算后取平均。",
    "experience.time": "每周工时加上旺季增量和往返通勤；仅共同可比的实况加入。",
    "experience.rest": "每周工作天数决定基础休息分；明确提供的额外带薪假增加休息分。",
    "experience.boundary": "本轮可比的值班、下班后响应、周末加班和出差分别评分后取平均。",
    "experience.daily": "本轮可比的弹性、会议、团队及工作环境选项换算后取平均。",
}
OPTIONAL = ("commute_minutes", "travel_days_per_month", "peak_week_hours",
            "peak_weeks_year", "weekend_overtime_days_month")
ZERO_DEFAULTS = {"monthly_subsidies": 0, "meal_plan": "no_meals", "housing_support": "none",
                 "signing_bonus": 0, "annual_bonus_method": "none"}


def _common(offers: list[OfferInput], field: str) -> bool:
    return bool(offers) and all(_fact(o, field) is not None for o in offers)


def _core_known(offer: OfferInput, field: str) -> bool:
    value = _fact(offer, field)
    return value is not None and (field not in ("monthly_base", "guaranteed_salary_months", "weekly_work_hours", "work_days_per_week") or isinstance(value, (int, float)) and value > 0)


def _for_score(offer: OfferInput, common: dict[str, bool]) -> OfferInput:
    facts = {key: value for key, value in offer.facts.items()
             if key not in OPTIONAL or common[key]}
    for key, value in ZERO_DEFAULTS.items():
        if _fact(offer, key) is None:
            facts[key] = RawFactInput(field_key=key, value=value, status="known", source="assumption")
    return offer.model_copy(update={"facts": facts})


def _cash_reference_offer(offer: OfferInput) -> OfferInput:
    """评分时中和未缴/最低基数带来的到手现金增量；展示仍用原始缴费口径。"""
    facts = dict(offer.facts)
    for field in ("social_security_type", "housing_fund_base_type"):
        if _text(offer, field) in ("none", "minimum"):
            facts[field] = RawFactInput(field_key=field, value="salary", status="known", source="assumption")
    return offer.model_copy(update={"facts": facts})


def _mapped_values(offer: OfferInput, offers: list[OfferInput], cfg: dict,
                   fields: tuple[str, ...], positive: set[str] | None = None) -> list[float]:
    positive = positive or set()
    values = []
    for field in fields:
        mapping = cfg["extended_maps"][field]
        active = (any(mapping.get(_text(o, field), 0) > 0 for o in offers)
                  if field in positive else _common(offers, field))
        if active:
            value = mapping.get(_text(offer, field), 0 if field in positive else None)
            if value is not None:
                values.append(float(value))
    return values


def _weighted_categories(scores: dict[str, float], weights: dict[str, float]) -> tuple[float, dict[str, float]]:
    total = sum(weights[key] for key in scores)
    shares = {key: weights[key] / total for key in scores}
    return sum(scores[key] * shares[key] for key in scores), shares


def _growth(offer: OfferInput, offers: list[OfferInput], cfg: dict) -> tuple[float | None, dict[str, float], dict[str, float]]:
    scores: dict[str, float] = {}
    business = cfg["business_level"].get(_text(offer, "business_level"))
    responsibility = cfg["entry_scope"].get(_text(offer, "entry_scope"))
    if business is not None:
        impact = _mapped_values(offer, offers, cfg, ("user_impact_exposure",), {"user_impact_exposure"})
        scores["opportunity"] = (business + sum(impact)) / (1 + len(impact))
    if responsibility is not None:
        autonomy = _mapped_values(offer, offers, cfg, ("autonomy_level",))
        scores["responsibility"] = (responsibility + sum(autonomy)) / (1 + len(autonomy))
    skills = _mapped_values(offer, offers, cfg, ("problem_complexity_level", "skill_transferability",
                                                 "jd_match_level", "goal_skill_fit"))
    if skills:
        scores["skills"] = sum(skills) / len(skills)
    cultivation = []
    for field in ("mentorship", "feedback_cadence"):
        minimum = min(cfg[field].values())
        if any(cfg[field].get(_text(o, field), minimum) > minimum for o in offers):
            cultivation.append(cfg[field].get(_text(offer, field), minimum))
    if any((_num(o, "training_days_year") or 0) > 0 for o in offers):
        cultivation.append(min(100, (_num(offer, "training_days_year") or 0) * 10))
    if any((_num(o, "training_budget_year") or 0) > 0 for o in offers):
        cultivation.append(min(100, (_num(offer, "training_budget_year") or 0) / 50))
    if cultivation:
        scores["cultivation"] = sum(cultivation) / len(cultivation)
    options = _mapped_values(offer, offers, cfg, ("internal_mobility", "portfolio_permission", "ai_tool_access"),
                             {"internal_mobility", "portfolio_permission", "ai_tool_access"})
    if options:
        scores["options"] = sum(options) / len(options)
    if not scores:
        return None, {}, {}
    total, shares = _weighted_categories(scores, cfg["category_weights"])
    return total, scores, shares


def _experience(offer: OfferInput, offers: list[OfferInput], common: dict[str, bool], cfg: dict) -> tuple[float | None, dict[str, float], dict[str, float], dict[str, float | None]]:
    weekly = _num(offer, "weekly_work_hours")
    days = _num(offer, "work_days_per_week")
    if weekly is None or days is None:
        return None, {}, {}, {}
    occupied = weekly
    peak_extra = None
    if common["peak_week_hours"] and common["peak_weeks_year"]:
        peak = _num(offer, "peak_week_hours") or 0
        peak_weeks = _num(offer, "peak_weeks_year") or 0
        peak_extra = max(0, peak - weekly) * peak_weeks / 52
        occupied += peak_extra
    commute_weekly = None
    if common["commute_minutes"]:
        remote = min(days, _num(offer, "remote_days_week") or 0) if any(_fact(o, "remote_days_week") is not None for o in offers) else 0
        commute_weekly = (_num(offer, "commute_minutes") or 0) * 2 * (days - remote) / 60
        occupied += commute_weekly
    occupied = max(0, occupied)
    points = [(float(band["hours"]), float(band["score"])) for band in cfg["occupied_hours_bands"]]
    time_score = _interp(occupied, points)
    leave_active = any((_num(o, "extra_paid_leave") or 0) > 0 for o in offers)
    leave_days = (_num(offer, "extra_paid_leave") or 0) if leave_active else None
    rest_score = _clamp(85 + (5 - days) * 35 + min(15, (leave_days or 0) * 3))
    boundary = _mapped_values(offer, offers, cfg, ("oncall_cadence", "after_hours_response"))
    if common["travel_days_per_month"]:
        boundary.append(_clamp(100 - min(60, (_num(offer, "travel_days_per_month") or 0) * 8)))
    if common["weekend_overtime_days_month"]:
        boundary.append(_clamp(100 - min(60, (_num(offer, "weekend_overtime_days_month") or 0) * 10)))
    daily = _mapped_values(offer, offers, cfg, ("flex_schedule", "meeting_load", "manager_support",
                                               "team_speakup", "work_meaning", "side_project_policy",
                                               "workspace_comfort", "performance_pressure"),
                           {"flex_schedule", "side_project_policy"})
    if not common["commute_minutes"] and any((_num(o, "remote_days_week") or 0) > 0 for o in offers):
        daily.append(min(100, (_num(offer, "remote_days_week") or 0) / max(days, 1) * 100))
    scores = {"time": time_score, "rest": rest_score}
    if boundary:
        scores["boundary"] = sum(boundary) / len(boundary)
    if daily:
        scores["daily"] = sum(daily) / len(daily)
    total, shares = _weighted_categories(scores, cfg["category_weights"])
    return total, scores, shares, {"occupied_weekly": occupied, "peak_extra_weekly": peak_extra,
                                   "commute_weekly": commute_weekly, "rest_days_weekly": 7 - days,
                                   "extra_leave_days": leave_days,
                                   "travel_days_annual": (_num(offer, "travel_days_per_month") or 0) * 12 if common["travel_days_per_month"] else None,
                                   "weekend_overtime_days_annual": (_num(offer, "weekend_overtime_days_month") or 0) * 12 if common["weekend_overtime_days_month"] else None}


def build_report(inp: DecisionInput, rules: RuleSet) -> ReportOutputs:
    offers = inp.offers
    common = {key: _common(offers, key) for key in OPTIONAL}
    weights = inp.preferences.weights or rules.default_weights()
    total_weight = sum(weights.get(k, 0) for k in ("economic", "growth", "experience"))
    weights = {k: weights.get(k, 0) / total_weight for k in ("economic", "growth", "experience")} if total_weight else rules.default_weights()
    complete = len(offers) in (2, 3) and all(all(_core_known(o, key) for key in CORE) for o in offers)
    buyer = inp.preferences.buy_house_intent not in ("not_consider", "undecided")
    scoring = rules.report["three_dimension_scoring"]
    rows: list[OfferReport] = []
    for offer in offers:
        scored = _for_score(offer, common)
        ctx = _offer_context(scored, rules)
        cash_offer = _cash_reference_offer(scored)
        cash_ctx = _offer_context(cash_offer, rules)
        salary = _salary_module(cash_offer, rules, cash_ctx)
        display_ctx = _offer_context(offer, rules)
        display_salary = _salary_module(offer, rules, display_ctx)
        net = salary.income.guaranteed_net
        display_net = display_salary.income.guaranteed_net
        bonus_net = salary.income.bonus_net or 0
        entry_income = sum(_num(scored, key) or 0 for key in
                           ("signing_bonus", "relocation_grant", "government_talent_subsidy"))
        gross_fixed = (_num(scored, "monthly_base") or 0) * (_num(scored, "guaranteed_salary_months") or 0)
        net_rate = min(1, max(0, net / gross_fixed)) if net is not None and gross_fixed else 0
        extra_recurring = (_num(scored, "overtime_comp_annual") or 0) * net_rate
        raise_rate = (_num(scored, "annual_raise_percent") or 0) / 100
        recurring_net = net + bonus_net + extra_recurring if net is not None else None
        display_recurring_net = (display_net + (display_salary.income.bonus_net or 0)
                                 + (_num(offer, "overtime_comp_annual") or 0)
                                 * min(1, max(0, display_net / gross_fixed))
                                 if display_net is not None and gross_fixed else None)
        probation_gross_loss = ((_num(scored, "monthly_base") or 0)
                                * min(12, _num(scored, "probation_months") or 0)
                                * (1 - min(100, _num(scored, "probation_pay_percent")
                                         if _num(scored, "probation_pay_percent") is not None else 100) / 100))
        three_year_net = (sum(net * (1 + raise_rate) ** year + bonus_net + extra_recurring
                              for year in range(3))
                          if net is not None else None)
        annual_equivalent = three_year_net / 3 if three_year_net is not None else None
        economic = None
        housing = _housing_module(scored, rules, ctx, net / 12 if net is not None else None,
                                  net, "consider" if buyer else "not_consider") if buyer else None
        purchasing = None
        display_purchasing = None
        benefit_score = None
        economic_scores: dict[str, float] = {}
        economic_shares: dict[str, float] = {}
        if net is not None and net > 0:
            cost = float(ctx.city.get("living", {}).get("baseline_cost_month", 0))
            national_cost = float(rules.report.get("living", {}).get("national_baseline_cost_month", 3000))
            purchasing = recurring_net / 12 / (cost / national_cost) if cost > 0 else None
            display_purchasing = (display_recurring_net / 12 / (cost / national_cost)
                                  if display_recurring_net is not None and cost > 0 else None)
            cash_score = _band_min(annual_equivalent, rules.report["salary_score_bands"])
            purchasing_score = (_clamp(50 + _band_min(purchasing / 8000, rules.report["living_multiple_bands"])
                                       - _band_min(recurring_net / 12 / 8000, rules.report["living_multiple_bands"]))
                                if purchasing is not None else None)
            in_kind = (ctx.welfare_annual or 0) + (_num(scored, "supplementary_medical_value") or 0)
            employer_fund = ctx.hf_employer_monthly * 12
            benefit_bands = [(float(band["ratio"]), float(band["score"])) for band in scoring["economic"]["benefits_bands"]]
            benefit_score = _interp((employer_fund + in_kind) / recurring_net, benefit_bands)
            economic_weights = scoring["economic"]["buyer_weights" if buyer else "usual_weights"]
            entry_points = [(float(band["amount"]), float(band["score"]))
                            for band in scoring["economic"]["entry_bands"]]
            entry_score = _interp(entry_income, entry_points)
            probation_score = _clamp(100 - probation_gross_loss / max(3 * (_num(scored, "monthly_base") or 1), 1) * 100)
            components = [("cash", cash_score, economic_weights["cash"]),
                          ("entry", entry_score, economic_weights["entry"]),
                          ("probation", probation_score, economic_weights["probation"]),
                          ("benefits", benefit_score, economic_weights["benefits"])]
            if purchasing_score is not None:
                components.append(("purchasing", purchasing_score, economic_weights["purchasing"]))
            if buyer and housing is not None and housing.payment_income_ratio is not None:
                housing_score = _band_max(housing.payment_income_ratio, rules.report["housing_payment_ratio_bands"])
                if housing.down_payment_years is not None:
                    housing_score += _band_max(housing.down_payment_years, rules.report["housing_tenure_adjust"], key="max_years")
                components.append(("housing", _clamp(housing_score), economic_weights["housing"]))
            total_component_weight = sum(weight for _, _, weight in components)
            economic_scores = {key: value for key, value, _ in components}
            economic_shares = {key: weight / total_component_weight for key, _, weight in components}
            economic = sum(economic_scores[key] * economic_shares[key] for key in economic_scores)
        growth, growth_scores, growth_shares = _growth(scored, offers, scoring["growth"])
        experience, experience_scores, experience_shares, experience_metrics = _experience(scored, offers, common, scoring["experience"])
        occupied = experience_metrics.get("occupied_weekly")
        subscores = {**{f"economic.{key}": value for key, value in economic_scores.items()},
                     **{f"growth.{key}": value for key, value in growth_scores.items()},
                     **{f"experience.{key}": value for key, value in experience_scores.items()}}
        details = {
            **{f"economic.{key}": {"weight": economic_shares[key], "contribution": value * economic_shares[key],
                                     "formula": SUB_FORMULAS[f"economic.{key}"]}
               for key, value in economic_scores.items()},
            **{f"growth.{key}": {"weight": growth_shares[key], "contribution": value * growth_shares[key],
                                   "formula": SUB_FORMULAS[f"growth.{key}"]}
               for key, value in growth_scores.items()},
            **{f"experience.{key}": {"weight": experience_shares[key], "contribution": value * experience_shares[key],
                                       "formula": SUB_FORMULAS[f"experience.{key}"]}
               for key, value in experience_scores.items()},
        }
        metrics = {
            "economic.fixed_net": display_salary.income.guaranteed_net,
            "economic.bonus_net": display_salary.income.bonus_net,
            "economic.recurring_net": display_recurring_net,
            "economic.scored_recurring_net": recurring_net if recurring_net != display_recurring_net else None,
            "economic.raise_rate": raise_rate,
            "economic.entry_income": entry_income,
            "economic.signing_bonus": _num(scored, "signing_bonus") or 0,
            "economic.relocation_grant": _num(scored, "relocation_grant") or 0,
            "economic.government_talent_subsidy": _num(scored, "government_talent_subsidy") or 0,
            "economic.probation_loss": probation_gross_loss,
            "economic.purchasing_monthly": display_purchasing if net is not None and net > 0 else None,
            "economic.scored_purchasing_monthly": purchasing if purchasing != display_purchasing else None,
            "economic.benefits_annual": ((ctx.hf_employer_monthly * 12) + (ctx.welfare_annual or 0)
                                         + (_num(scored, "supplementary_medical_value") or 0)),
            "economic.down_payment": housing.down_payment if housing else None,
            "economic.down_payment_years": housing.down_payment_years if housing else None,
            "economic.monthly_payment": housing.monthly_payment if housing else None,
            "economic.payment_income_ratio": housing.payment_income_ratio if housing else None,
            **{f"experience.{key}": value for key, value in experience_metrics.items()},
        }
        scores = {"economic": economic, "growth": growth, "experience": experience}
        overall_raw = sum(scores[k] * weights[k] for k in scores) if complete and all(v is not None for v in scores.values()) else None
        overall = round(overall_raw + 1e-9, 1) if overall_raw is not None else None
        missing = [key for key in CORE if not _core_known(offer, key)]
        rows.append(OfferReport(
            offer_id=offer.offer_id, company=f"Offer {chr(65 + offer.display_order - 1)}",
            position="", display_order=offer.display_order, city=_text(offer, "city"),
            monthly_after_tax=net / 12 if net is not None else None,
            overall_score=overall, dimension_scores=scores,
            effective_weights=weights,
            score_contributions={k: (scores[k] or 0) * weights[k] for k in scores},
            sub_scores=subscores, sub_metrics=metrics, sub_details=details,
            key_numbers={"annual_net": display_salary.income.guaranteed_net,
                         "scored_annual_net": net, "recurring_annual_net": recurring_net,
                         "entry_income_nominal": entry_income,
                         "probation_gross_loss": probation_gross_loss,
                         "annual_occupied_hours": occupied * 52 if occupied is not None else None,
                         "effective_hourly_net": recurring_net / (occupied * 52) if recurring_net is not None and occupied else None,
                         "purchasing_power_monthly": purchasing,
                         "benefit_score": benefit_score, "occupied_hours_weekly": occupied,
                         "city_cost_monthly": float(ctx.city.get("living", {}).get("baseline_cost_month", 0)) or None,
                         "house_price_sqm": float(ctx.city.get("housing", {}).get("price_per_sqm", 0)) or None,
                         "work_hours_weekly": _num(offer, "weekly_work_hours"),
                         "work_days_weekly": _num(offer, "work_days_per_week")},
            missing_core=missing,
            known_optional={key: _fact(offer, key) for key in OPTIONAL if _fact(offer, key) is not None},
            input_values={key: _fact(offer, key) for key in offer.facts if _fact(offer, key) is not None},
            compliance_alert=_compliance_alert(scored, ctx),
            city_data_as_of=ctx.city.get("as_of"),
            salary=display_salary, insurance=display_ctx.insurance,
            housing=housing or _housing_module(scored, rules, ctx, None, None, "not_consider"),
        ))
    ranked = sorted((row for row in rows if row.overall_score is not None),
                    key=lambda row: (-row.overall_score, row.display_order))
    ranks = {row.offer_id: 1 + sum(other.overall_score > row.overall_score for other in ranked) for row in ranked}
    rows = [row.model_copy(update={"overall_rank": ranks.get(row.offer_id)}) for row in rows]
    return ReportOutputs(weights=weights, ranking=[row.offer_id for row in ranked],
                         city_data_version=str(rules.data.get("city_index", {}).get("meta", {}).get("version", "")),
                         offers=rows)
