"""报告覆盖率与来源说明；不把来源可信度冒充事实为真的概率。"""
from app.domain.contracts import OfferInput, ReportQuality
from app.rules_runtime import RuleSet


def report_quality(offer: OfferInput, rules: RuleSet, module_coverage: int) -> ReportQuality:
    def known(key):
        fact = offer.facts.get(key)
        return fact.value if fact and fact.status == "known" else None

    # 实际参与报告的原子事实；时间输入已由表单换算为工时/分钟，避免重复计数。
    keys = ["city", "monthly_base", "guaranteed_salary_months", "annual_bonus_method",
            "signing_bonus", "monthly_subsidies", "meal_plan", "housing_support",
            "social_security_type", "housing_fund_base_type", "special_additional_deductions",
            "weekly_work_hours", "work_days_per_week", "daily_idle_hours", "commute_minutes",
            "weekend_pattern", "travel_frequency", "is_outsourced"]
    method = known("annual_bonus_method")
    if method in ("amount", "multiple"):
        keys.append("annual_bonus_value" if method == "amount" else "annual_bonus_months")
    for prefix, type_key, base_key in (
        ("social_security", "social_security_type", "social_security_base"),
        ("housing_fund", "housing_fund_base_type", "housing_fund_base"),
    ):
        if known(type_key) == "custom":
            keys.append(base_key)
        if prefix == "housing_fund" and known(type_key) != "none":
            keys += ["housing_fund_employee_rate", "housing_fund_employer_rate"]
    keys += [x["field"] for x in rules.report.get("development", {}).get("axes", [])]
    keys += [x["field"] for x in rules.report.get("stability", {}).get("components", [])]
    keys += [x["source"] for x in rules.report.get("health", {}).get("deductions", [])]
    keys = list(dict.fromkeys(keys))
    aliases = {"commute_minutes": ("commute_hours",)}
    missing, uncertain, counts = [], [], {}
    answered = 0
    for key in keys:
        fact = offer.facts.get(key)
        if fact is None or fact.status != "known":
            fact = next((offer.facts[a] for a in aliases.get(key, ())
                         if a in offer.facts and offer.facts[a].status == "known"), fact)
        if not fact or fact.status != "known" or fact.value is None:
            missing.append(key)
            if fact and fact.status in ("need_confirmation", "inferred"):
                uncertain.append(key)
            continue
        answered += 1
        counts[fact.source] = counts.get(fact.source, 0) + 1
        if fact.source in ("assumption", "anonymous_online") or (
            fact.reliability is not None and fact.reliability < 0.6
        ):
            uncertain.append(key)
    estimates = ["城市房价与生活成本采用参考数据；攒首付按参考储蓄率估算"]
    if known("housing_fund_base_type") != "none":
        if known("housing_fund_employee_rate") is None:
            estimates.append("个人公积金比例缺失，采用规则默认值")
        if known("housing_fund_employer_rate") is None:
            estimates.append("单位公积金比例缺失，沿用个人比例")
    if known("meal_plan") not in (None, "no_meals") or known("housing_support") == "dorm":
        estimates.append("餐食与住宿按参考替代成本折现，不作为现金到账")
    if any(x["source"] in missing and "missing_score" in x
           for x in rules.report.get("health", {}).get("deductions", [])):
        estimates.append("部分健康问卷未答，采用中性扣分")
    if known("city") is None:
        estimates.append("生活水平采用全国参考值")
    priority = [k for k in ["monthly_base", "city", "guaranteed_salary_months",
                            "annual_bonus_method", "annual_bonus_value", "annual_bonus_months",
                            "weekly_work_hours", "commute_minutes"] if k in missing or k in uncertain]
    priority = list(dict.fromkeys(priority + uncertain + missing))[:6]
    return ReportQuality(
        field_coverage=round(100 * answered / len(keys)) if keys else 0,
        answered_fields=answered, applicable_fields=len(keys), module_coverage=module_coverage,
        source_counts=counts, uncertain_fields=uncertain, missing_fields=missing,
        estimated_items=estimates, priority_fields=priority,
        provisional=bool(missing or uncertain or module_coverage < 100),
    )
