"""结果投影与洞察文案。

全部为纯函数：输入 DecisionSnapshot（+ rules），输出前端资源模型。
**禁止调用 evaluate** —— /result、/results/{seq} 只读快照。

洞察文案（insights）按模块模板确定性生成：跨 Offer 比较各模块关键数字，
缺失值的 Offer 不参与比较；可用数据 < 2 个 Offer 时输出信息不足提示。
"""
from __future__ import annotations

from app.domain.contracts import DecisionSnapshot, OfferReport
from app.rules_runtime import RuleSet
from app.schemas import (
    DevelopmentModuleView,
    EfficiencyModuleView,
    HealthModuleView,
    HistoryItem,
    HousingModuleView,
    InsuranceItemView,
    InsuranceModuleView,
    LivingModuleView,
    MonthSalaryRowView,
    OfferReportView,
    ResultView,
    SalaryModuleView,
    StabilityModuleView,
)
from app.services.sensitivity import compute_sensitivity

MODULE_TITLES: dict[str, str] = {
    "salary": "税后薪资",
    "insurance": "五险一金",
    "efficiency": "赚钱效率",
    "housing": "买房预期",
    "living": "生活水平",
    "development": "发展水平",
    "stability": "稳定性",
    "health": "健康损耗",
}

DIMENSION_LABELS: dict[str, str] = {"compensation": "钱", "development": "发展",
                                    "stability": "稳定", "wellbeing": "健康"}


def _offer(snapshot: DecisionSnapshot, oid) -> OfferReport | None:
    return next((o for o in snapshot.outputs.offers if o.offer_id == oid), None)


def _fmt_wan(v: float) -> str:
    if abs(v) >= 10000:
        return f"{v / 10000:.1f} 万"
    return f"{v:,.0f}"


def _pct(high: float, low: float) -> int:
    if low <= 0:
        return 0
    return round((high - low) / low * 100)


# ── 视图映射 ────────────────────────────────────────────────────

def _offer_view(r: OfferReport) -> OfferReportView:
    return OfferReportView(
        offer_id=r.offer_id, company=r.company, position=r.position,
        display_order=r.display_order,
        city=r.city, employment_label=r.employment_label,
        monthly_after_tax=r.monthly_after_tax,
        overall_score=r.overall_score, overall_rank=r.overall_rank,
        money_score=r.money_score, dimension_scores=dict(r.dimension_scores),
        completeness=r.completeness, missing_modules=list(r.missing_modules),
        quality=r.quality, effective_weights=r.effective_weights,
        score_contributions=r.score_contributions, city_data_as_of=r.city_data_as_of,
        key_numbers=r.key_numbers, sub_scores=r.sub_scores,
        sub_metrics=r.sub_metrics, sub_details=r.sub_details, missing_core=r.missing_core,
        known_optional=r.known_optional,
        input_values=r.input_values,
        city_pending=r.city_pending,
        compliance_alert=r.compliance_alert,
        context_chips=list(r.context_chips),
        salary=SalaryModuleView(
            income=r.salary.income,
            score=r.salary.score, grade=r.salary.grade,
            monthly_rows=[MonthSalaryRowView(month=m.month, tax_pre=m.tax_pre,
                                             tax=m.tax, after_tax=m.after_tax)
                          for m in r.salary.monthly_rows],
            monthly_after_tax_avg=r.salary.monthly_after_tax_avg,
            annual_after_tax=r.salary.annual_after_tax,
            annual_bonus_after_tax=r.salary.annual_bonus_after_tax,
            bonus_tax_method=r.salary.bonus_tax_method,
            signing_bonus_after_tax=r.salary.signing_bonus_after_tax,
            hf_annual=r.salary.hf_annual,
            annual_tax=r.salary.annual_tax,
            welfare_annual=r.salary.welfare_annual,
            annual_with_welfare=r.salary.annual_with_welfare,
        ),
        insurance=InsuranceModuleView(
            score=r.insurance.score, grade=r.insurance.grade,
            items=[InsuranceItemView(item=i.item, personal=i.personal, employer=i.employer)
                   for i in r.insurance.items],
            personal_monthly=r.insurance.personal_monthly,
            employer_monthly=r.insurance.employer_monthly,
            total_monthly=r.insurance.total_monthly,
        ),
        efficiency=EfficiencyModuleView(
            score=r.efficiency.score, grade=r.efficiency.grade,
            hourly=r.efficiency.hourly, daily=r.efficiency.daily,
            idle_ratio=r.efficiency.idle_ratio,
        ),
        housing=HousingModuleView(
            score=r.housing.score, grade=r.housing.grade,
            down_payment=r.housing.down_payment,
            down_payment_years=r.housing.down_payment_years,
            payment_income_ratio=r.housing.payment_income_ratio,
            monthly_payment=r.housing.monthly_payment,
            welfare_annual=r.housing.welfare_annual,
            signing_bonus=r.housing.signing_bonus,
        ),
        living=LivingModuleView(
            score=r.living.score, grade=r.living.grade,
            income_multiple=r.living.income_multiple,
            purchasing_power=r.living.purchasing_power,
            comfort_gap=r.living.comfort_gap,
        ),
        development=DevelopmentModuleView(
            score=r.development.score, grade=r.development.grade,
            axes=dict(r.development.axes),
        ),
        stability=StabilityModuleView(
            score=r.stability.score, grade=r.stability.grade,
            components=dict(r.stability.components),
        ),
        health=HealthModuleView(
            score=r.health.cost, grade=r.health.grade,
            cost=r.health.cost, deductions=dict(r.health.deductions),
            main_deduction=r.health.main_deduction,
            health_score=r.health.health_score,
        ),
    )


# ── 洞察模板 ────────────────────────────────────────────────────

def _comparison(offers, pick, label, unit="", lower=False, digits=0):
    vals = [(o, pick(o)) for o in offers if pick(o) is not None]
    if len(vals) < 2:
        names = "、".join(o.company for o, _ in vals)
        return f"{label}有效数据不足两份，暂不比较。" + (f"目前仅 {names} 可计算。" if names else "")
    displayed = [(o, round(v, digits)) for o, v in vals]
    target = (min if lower else max)(v for _, v in displayed)
    leaders = [o.company for o, v in displayed if v == target]
    scope = "参与比较：" + "、".join(o.company for o, _ in vals) + "。"
    if len(leaders) == len(vals):
        return f"{label}按展示精度持平（{target:,.{digits}f}{unit}）。{scope}"
    name = "、".join(leaders)
    suffix = "并列" if len(leaders) > 1 else ""
    direction = "最低" if lower else "最高"
    return f"{name} {label}{suffix}{direction}（{target:,.{digits}f}{unit}）。{scope}"


def _insight_salary(offers):
    return _comparison(offers, lambda o: o.salary.income.annual_cash_net, "常规年度税后现金", " 元")


def _insight_insurance(offers):
    return _comparison(offers, lambda o: o.insurance.total_monthly, "五险一金月缴合计", " 元")


def _insight_efficiency(offers):
    return _comparison(offers, lambda o: o.efficiency.hourly, "常规现金时薪", " 元")


def _insight_housing(offers):
    return _comparison(offers, lambda o: o.housing.down_payment_years, "攒首付年限", " 年", True, 1)


def _insight_living(offers):
    return _comparison(offers, lambda o: o.living.income_multiple, "收入倍数", " 倍", digits=2)


def _insight_development(offers):
    return _comparison(offers, lambda o: o.development.score, "发展评分", " 分")


def _insight_stability(offers):
    return _comparison(offers, lambda o: o.stability.score, "稳定评分", " 分")


def _insight_health(offers):
    return _comparison(offers, lambda o: o.health.cost, "健康损耗", " 分", True)


_INSIGHT_BUILDERS = {
    "salary": _insight_salary, "insurance": _insight_insurance,
    "efficiency": _insight_efficiency, "housing": _insight_housing,
    "living": _insight_living, "development": _insight_development,
    "stability": _insight_stability, "health": _insight_health,
}


def decision_summary(offers):
    labels = {"economic": "经济回报", "growth": "职业成长", "experience": "工作体验"}
    scored = sorted((o for o in offers if o.overall_score is not None),
                    key=lambda o: (-o.overall_score, o.display_order))
    if len(scored) < 2:
        return "补齐每份 Offer 的七项基本信息后显示综合排名。", {}, "", ""
    first, second = scored[:2]
    tied = [o.company for o in scored if o.overall_score == first.overall_score]
    summary = (f"{first.company} 当前领先。" if len(tied) == 1
               else f"{'、'.join(tied)} 综合分并列。")
    attribution = {k: first.score_contributions.get(k, 0) - second.score_contributions.get(k, 0)
                   for k in labels}
    if all(abs(value) < 0.05 for value in attribution.values()):
        return summary, attribution, "", "三维加权贡献相同。"
    best = max(attribution, key=attribution.get)
    worst = min(attribution, key=attribution.get)
    tradeoff = (f"主要优势是{labels[best]}（加权贡献 +{attribution[best]:.1f} 分）"
                + (f"；代价是{labels[worst]}（{attribution[worst]:.1f} 分）。"
                   if attribution[worst] < -0.05 else "。"))
    return summary, attribution, "", tradeoff


def build_result_view(snapshot: DecisionSnapshot, rules: RuleSet, seq: int) -> ResultView:
    outputs = snapshot.outputs
    offers = list(outputs.offers)
    insights = {}
    overall_scores = {
        str(r.offer_id): r.overall_score for r in offers if r.overall_score is not None
    }
    summary, attribution, comparison_note, tradeoff = decision_summary(offers)
    return ResultView(
        summary=summary, attribution=attribution, comparison_note=comparison_note, tradeoff=tradeoff,
        snapshot_seq=seq,
        computed_at=snapshot.computed_at,
        rule_version=snapshot.rule_version,
        trigger_type=snapshot.trigger_type,
        weights=dict(outputs.weights),
        ranking=list(outputs.ranking),
        overall_scores=overall_scores,
        city_data_version=outputs.city_data_version,
        offers=[_offer_view(r) for r in offers],
        insights=insights,
        sensitivity=compute_sensitivity(offers, dict(outputs.weights)),
    )


def build_history_item(seq: int, created_at, trigger_type: str, outputs: dict) -> HistoryItem:
    """轻量摘要：只投影报告头部，不携带 payload 全量。

    outputs 来自 SQL 层的 `payload->'outputs'` 投影——查询只返回结论所需
    字段，避免重复搬运整份快照。"""
    outputs = outputs or {}
    ranking: list[str] = outputs.get("ranking", [])
    top = ranking[0] if ranking else None
    top_score = None
    if top is not None:
        top_score = next(
            (o.get("overall_score") for o in outputs.get("offers", [])
             if o.get("offer_id") == top),
            None,
        )
    return HistoryItem(
        seq=seq, created_at=created_at, trigger_type=trigger_type,
        top_offer_id=top, top_score=top_score,
    )
