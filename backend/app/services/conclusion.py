"""结果投影与洞察文案。

全部为纯函数：输入 DecisionSnapshot（+ rules），输出前端资源模型。
**禁止调用 evaluate** —— /result、/results/{seq} 只读快照。

v5 报告的洞察/结论文案由前端纯函数（lib/verdict.ts）基于下发的分数与
归因生成；本模块只做快照 → ResultView 的字段投影与 Top-2 归因摘要。
"""
from __future__ import annotations

from app.domain.contracts import DecisionSnapshot, OfferReport
from app.rules_runtime import RuleSet
from app.schemas import (
    HistoryItem,
    HousingModuleView,
    InsuranceItemView,
    InsuranceModuleView,
    MonthSalaryRowView,
    OfferReportView,
    ResultView,
    SalaryModuleView,
)
from app.services.sensitivity import compute_sensitivity

# ── 视图映射 ────────────────────────────────────────────────────

def _offer_view(r: OfferReport) -> OfferReportView:
    return OfferReportView(
        offer_id=r.offer_id, company=r.company, position=r.position,
        display_order=r.display_order,
        city=r.city,
        monthly_after_tax=r.monthly_after_tax,
        overall_score=r.overall_score, overall_rank=r.overall_rank,
        dimension_scores=dict(r.dimension_scores),
        effective_weights=r.effective_weights,
        score_contributions=r.score_contributions, city_data_as_of=r.city_data_as_of,
        key_numbers=r.key_numbers, sub_scores=r.sub_scores,
        sub_metrics=r.sub_metrics, sub_details=r.sub_details, missing_core=r.missing_core,
        known_optional=r.known_optional,
        input_values=r.input_values,
        compliance_alert=r.compliance_alert,
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
        housing=HousingModuleView(
            score=r.housing.score, grade=r.housing.grade,
            down_payment=r.housing.down_payment,
            down_payment_years=r.housing.down_payment_years,
            payment_income_ratio=r.housing.payment_income_ratio,
            monthly_payment=r.housing.monthly_payment,
            welfare_annual=r.housing.welfare_annual,
            signing_bonus=r.housing.signing_bonus,
        ),
    )


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
        insights={},
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
