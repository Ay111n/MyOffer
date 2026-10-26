"""引擎属性测试（hypothesis）：锁死评分器的结构契约。

示例级回归锁的是具体案例；本文件锁的是「无论输入怎么变都成立的性质」，
调档位/映射时若破坏这些不变式会先在这里红：
1. 涨薪不降分（应届薪资域内，经济分与综合分皆然）
2. 加福利不降分
3. 退役字段（v0.8 遗留枚举）扰动不改任何分数与排名
4. 同输入同输出：evaluate 是纯函数，且不就地修改输入
5. 权重重归一：三维权重和为 1；每份 Offer 各维度的子份额和为 1
"""
from uuid import UUID

from hypothesis import given, settings
from hypothesis import strategies as st

from app.domain.contracts import DecisionInput, OfferInput, RawFactInput, UserPreferenceInput
from app.domain.evaluator import evaluate
from app.rules_runtime import get_rules

UUIDS = (UUID("00000000-0000-0000-0000-00000000000a"), UUID("00000000-0000-0000-0000-00000000000b"))

CITIES = ["北京", "成都", "上海", "杭州"]
BUSINESS = ["core", "important", "normal", "support", "edge"]
SCOPES = ["marginal_tasks", "assist_tasks", "small_feature", "own_module", "own_feature_end2end"]
MEALS = ["three_meals", "two_meals", "one_meal", "no_meals"]
# v0.8 退役后引擎不再消费的枚举字段（改值不得影响任何分数）
RETIRED_FIELDS = {
    "weekend_pattern": ["double_off", "big_small_week", "single_off", "irregular"],
    "kpi_pressure": ["no_kpi", "low", "medium", "high"],
    "expected_mental_state": ["happy", "relaxed", "calm", "tense", "unclear"],
}

fact_value = st.one_of(
    st.sampled_from(CITIES + BUSINESS + SCOPES + MEALS),
    st.integers(min_value=0, max_value=100_000),
)


@st.composite
def offer_facts(draw: st.DrawFn) -> dict:
    return {
        "city": draw(st.sampled_from(CITIES)),
        "monthly_base": draw(st.integers(min_value=5000, max_value=40000)),
        "guaranteed_salary_months": draw(st.integers(min_value=12, max_value=16)),
        "business_level": draw(st.sampled_from(BUSINESS)),
        "entry_scope": draw(st.sampled_from(SCOPES)),
        "weekly_work_hours": draw(st.integers(min_value=30, max_value=70)),
        "work_days_per_week": 5,
        "annual_bonus_method": draw(st.sampled_from(["none", "amount"])),
        "annual_bonus_value": draw(st.integers(min_value=0, max_value=80_000)),
        "signing_bonus": draw(st.integers(min_value=0, max_value=80_000)),
        "meal_plan": draw(st.sampled_from(MEALS)),
        "social_security_type": "salary",
        "housing_fund_base_type": "salary",
    }


def build(fa: dict, fb: dict, extra_a: dict | None = None) -> DecisionInput:
    def offer(order, facts):
        merged = {**facts, **(extra_a or {} if order == 1 else {})}
        return OfferInput(
            offer_id=UUIDS[order - 1], company=f"Offer {order}", position="",
            display_order=order,
            facts={k: RawFactInput(field_key=k, value=v, status="known", source="offer_letter")
                   for k, v in merged.items()},
        )

    return DecisionInput(
        offers=[offer(1, fa), offer(2, fb)],
        preferences=UserPreferenceInput(weights=get_rules().default_weights(),
                                        buy_house_intent="undecided"),
    )


def run(inp: DecisionInput):
    return evaluate(inp, get_rules())


COMMON = settings(max_examples=60, deadline=None)


@COMMON
@given(fa=offer_facts(), fb=offer_facts(), raise_by=st.integers(min_value=500, max_value=10_000))
def test_raising_salary_never_lowers_cash_subscore(fa, fb, raise_by):
    """现金子分按 band_min 单调插值：涨薪结构保证非降。"""
    before = run(build(fa, fb)).offers[0]
    after = run(build({**fa, "monthly_base": fa["monthly_base"] + raise_by}, fb)).offers[0]
    assert after.sub_scores["economic.cash"] >= before.sub_scores["economic.cash"] - 1e-9


@COMMON
@given(fa=offer_facts(), fb=offer_facts(), raise_by=st.integers(min_value=500, max_value=10_000))
def test_raising_salary_never_lowers_economic_score(fa, fb, raise_by):
    """经济总分对月薪单调不降。

    曾以 xfail 记录贵城市低薪段的反单调缺口（购买力子分「两档位插值之差」
    随收入加深惩罚）；2026-10 购买力改为纯城市固定分后与收入解耦，
    本不变式应当成立——若再红说明口径又引入了收入联动。"""
    before = run(build(fa, fb)).offers[0]
    after = run(build({**fa, "monthly_base": fa["monthly_base"] + raise_by}, fb)).offers[0]
    assert after.dimension_scores["economic"] >= before.dimension_scores["economic"] - 1e-2
    assert after.overall_score >= before.overall_score - 1e-2


@COMMON
@given(fa=offer_facts(), fb=offer_facts())
def test_adding_welfare_never_lowers_score(fa, fb):
    before = run(build(fa, fb)).offers[0]
    after = run(build({**fa, "meal_plan": "three_meals"}, fb)).offers[0]
    assert after.dimension_scores["economic"] >= before.dimension_scores["economic"] - 1e-2
    assert after.overall_score >= before.overall_score - 1e-2


@COMMON
@given(fa=offer_facts(), fb=offer_facts(), weekend=st.sampled_from(RETIRED_FIELDS["weekend_pattern"]),
       kpi=st.sampled_from(RETIRED_FIELDS["kpi_pressure"]),
       mental=st.sampled_from(RETIRED_FIELDS["expected_mental_state"]))
def test_retired_fields_do_not_affect_scores_or_ranking(fa, fb, weekend, kpi, mental):
    before = run(build(fa, fb))
    after = run(build(fa, fb, extra_a={"weekend_pattern": weekend, "kpi_pressure": kpi,
                                       "expected_mental_state": mental}))
    assert before.ranking == after.ranking
    assert before.weights == after.weights
    for b, a in zip(before.offers, after.offers, strict=True):
        assert b.dimension_scores == a.dimension_scores
        assert b.overall_score == a.overall_score


@COMMON
@given(fa=offer_facts(), fb=offer_facts())
def test_evaluate_is_pure_and_does_not_mutate_input(fa, fb):
    inp = build(fa, fb)
    frozen = inp.model_copy(deep=True)
    first = run(inp)
    second = run(inp)
    assert first == second
    assert inp == frozen


@COMMON
@given(fa=offer_facts(), fb=offer_facts())
def test_weights_and_subshares_renormalize_to_one(fa, fb):
    out = run(build(fa, fb))
    assert sum(out.weights.values()) == 1.0
    for row in out.offers:
        for dim in ("economic", "growth", "experience"):
            keys = [k for k in row.sub_details if k.startswith(f"{dim}.")]
            assert keys, f"{dim} 子分不应整体缺失"
            total = sum(row.sub_details[k]["weight"] for k in keys)
            assert abs(total - 1.0) < 1e-9, f"{dim} 子份额和 {total} ≠ 1"
