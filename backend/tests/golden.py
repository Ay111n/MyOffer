"""报告引擎金标准夹具：手工构造、可手算的对照 Offer（v0.7 八模块口径）。

- A：北京大厂，高薪高强度（月薪 32,000 × 12 + 年终 10 万 + 签字费 8 万），
     时薪尚可但健康损耗高；
- B：成都稳定岗，低薪低强度，福利（宿舍）与生活成本低廉。

全部事实 source=user_provided（reliability=1.0），税/五险一金可手算：
  A 个人月缴 = 32,000 × (2% + 8% + 0.5% + 12%) = 7,200
  B 个人月缴 = 14,000 × (2% + 8% + 0.4% + 6%) = 2,296
年度现金补贴并入工资计税；年终奖在常规年度择优计税，签字费单列为入职收入。
公积金缴存与实物福利独立展示，时薪与购房储蓄只使用常规税后现金。
"""
from uuid import UUID

from app.domain.contracts import (
    DIMENSION_KEYS,
    DecisionInput,
    OfferInput,
    RawFactInput,
    UserPreferenceInput,
)
from app.rules_runtime import get_rules

A_ID = UUID("00000000-0000-0000-0000-00000000000a")
B_ID = UUID("00000000-0000-0000-0000-00000000000b")

A_FACTS = {
    "city": "北京", "monthly_base": 32000, "guaranteed_salary_months": 12,
    "annual_bonus_method": "amount", "annual_bonus_value": 100000,
    "social_security_type": "salary", "housing_fund_base_type": "salary",
    "housing_fund_employee_rate": 12, "housing_fund_employer_rate": 12,
    "monthly_subsidies": 1000,
    "meal_plan": "two_meals", "housing_support": "none", "signing_bonus": 80000,
    "weekly_work_hours": 55, "work_days_per_week": 5, "daily_idle_hours": 2,
    "weekend_pattern": "big_small_week", "commute_minutes": 45,
    "travel_frequency": "none",
    "kpi_pressure": "high", "expected_mental_state": "tense",
    "business_level": "core", "business_growth_expectation": "fast_growth",
    "business_affinity": 4, "boss_resource_ability": "high", "boss_ability": "high",
    "boss_attitude": "good", "communication_style": "conversational",
    "special_additional_deductions": ["rent"], "is_outsourced": False,
}

B_FACTS = {
    "city": "成都", "monthly_base": 14000, "guaranteed_salary_months": 13,
    "annual_bonus_method": "multiple", "annual_bonus_value": 2, "annual_bonus_months": 2,
    "social_security_type": "salary", "housing_fund_base_type": "salary",
    "housing_fund_employee_rate": 6, "housing_fund_employer_rate": 6,
    "monthly_subsidies": 500,
    "meal_plan": "no_meals", "housing_support": "dorm", "signing_bonus": 0,
    "weekly_work_hours": 40, "work_days_per_week": 5, "daily_idle_hours": 1,
    "weekend_pattern": "double_off", "commute_minutes": 20,
    "travel_frequency": "none",
    "kpi_pressure": "low", "expected_mental_state": "relaxed",
    "business_level": "normal", "business_growth_expectation": "steady_growth",
    "business_affinity": 3, "boss_resource_ability": "medium", "boss_ability": "medium",
    "boss_attitude": "average", "communication_style": "flattering",
    "is_outsourced": False,
}


def make_offer(oid: UUID, company: str, order: int, facts: dict, drop: tuple = ()) -> OfferInput:
    return OfferInput(
        offer_id=oid, company=company, position="工程师", display_order=order,
        facts={
            k: RawFactInput(field_key=k, value=v, status="known",
                            source="user_provided", reliability=1.0)
            for k, v in facts.items() if k not in drop
        },
    )


def make_input(
    offers: list[OfferInput],
    weights: dict | None = None,
    buy_house_intent: str | None = None,
) -> DecisionInput:
    w = weights or {k: 1 / 4 for k in DIMENSION_KEYS}
    return DecisionInput(
        offers=offers,
        preferences=UserPreferenceInput(weights=w, buy_house_intent=buy_house_intent),
    )


def g1_input() -> DecisionInput:
    """G1：完整对照（A 北京高薪高压 vs B 成都低薪稳定）。"""
    return make_input([
        make_offer(A_ID, "A公司", 1, A_FACTS),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])


def g2_input() -> DecisionInput:
    """G2：A 缺薪酬核心字段（monthly_base）——薪酬类模块全部待补充，
    综合 = 可用维度重归一，不因缺失崩溃。"""
    return make_input([
        make_offer(A_ID, "A公司", 1, A_FACTS, drop=("monthly_base",)),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])


def empty_input() -> DecisionInput:
    """G0：无任何事实——所有模块待补充，排名按录入顺序。"""
    return make_input([
        make_offer(A_ID, "A公司", 1, {}),
        make_offer(B_ID, "B公司", 2, {}),
    ])


def evaluate_fixture(inp: DecisionInput):
    from app.domain import evaluate

    return evaluate(inp, get_rules())


def offer_by_id(out, oid):
    return next(o for o in out.offers if o.offer_id == oid)
