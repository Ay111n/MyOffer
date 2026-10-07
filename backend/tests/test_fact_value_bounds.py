"""数值事实边界校验。

money/number/percent 事实必须为有限数且 >= 0（本域不存在合法负值），
Infinity/NaN 写 JSONB 会 500、负工资会算出负 ECV——这些都必须在入口拒绝。
"""
import pytest

from app.rules_runtime import get_rules
from app.services.fact_validation import validate_fact_value

RULES = get_rules()


@pytest.mark.parametrize("value", [-5000, -0.01])
def test_negative_money_rejected(value):
    with pytest.raises(ValueError) as ei:
        validate_fact_value(RULES, "monthly_base", value)
    assert ei.value.code == "out_of_range"


@pytest.mark.parametrize("value", [float("inf"), float("-inf"), float("nan")])
def test_non_finite_rejected(value):
    with pytest.raises(ValueError) as ei:
        validate_fact_value(RULES, "monthly_base", value)
    assert ei.value.code == "invalid_number"


@pytest.mark.parametrize("value", [10**400, -(10**400), 10**1000 + 1])
def test_huge_integer_rejected_as_invalid_number(value):
    """回归：超出 float 表示范围的整数曾在 _is_finite 放行后于边界比较处
    抛 OverflowError（ArithmeticError 而非 ValueError）→ 未捕获 500。
    必须与 inf/nan 同样按 invalid_number 转 422。"""
    with pytest.raises(ValueError) as ei:
        validate_fact_value(RULES, "monthly_base", value)
    assert ei.value.code == "invalid_number"


def test_zero_and_positive_accepted():
    with pytest.raises(ValueError):
        validate_fact_value(RULES, "monthly_base", 0)
    assert validate_fact_value(RULES, "monthly_base", 20000) is None


def test_declared_bounds_override_default():
    # commute_minutes 是 number：默认 >= 0，显式 max 由字段声明控制
    assert validate_fact_value(RULES, "commute_minutes", 45) is None
    with pytest.raises(ValueError):
        validate_fact_value(RULES, "commute_minutes", -1)


def test_need_confirmation_value_validated():
    """need_confirmation 的候选值走同一校验（此前任意 JSON 可直落库）。"""
    from app.schemas import AnswerItem, AnswerRequest, FieldAnswer
    from app.services.answer_service import validate_and_normalize
    from tests.golden import A_ID

    qdef = RULES.questions["questions"]["q_details"]
    body = AnswerRequest(answers=[AnswerItem(
        offer_id=A_ID,
        fields=[FieldAnswer(field_key="commute_minutes", status="need_confirmation", value=-5)],
    )])
    with pytest.raises(Exception):
        validate_and_normalize(RULES, qdef, body.answers, {A_ID})


@pytest.mark.parametrize("value", [{"a": 1}, ["x"], None])
def test_enum_unhashable_or_non_string_rejected_as_422_code(value):
    """回归：enum 字段收到 dict/list（JSON 合法、不可哈希）时曾抛 TypeError → 500，
    必须转为 invalid_option 的 422。"""
    with pytest.raises(ValueError) as ei:
        validate_fact_value(RULES, "meal_plan", value)
    assert ei.value.code == "invalid_option"


@pytest.mark.parametrize("value", ["two_meals", ["x", {"b": 2}], "not_an_option"])
def test_multi_enum_invalid_items_rejected_as_422_code(value):
    """回归：multi_enum 列表内的 dict 曾让成员检查抛 TypeError → 500。"""
    with pytest.raises(ValueError) as ei:
        validate_fact_value(RULES, "special_additional_deductions", value)
    assert ei.value.code == "invalid_option"


@pytest.mark.parametrize("field_key,boundary", [
    ("housing_fund_employee_rate", 12),
    ("housing_fund_employer_rate", 12),
    ("guaranteed_salary_months", 16),
    ("annual_bonus_months", 12),
    ("monthly_base", 1_000_000),
    ("weekly_work_hours", 168),
    ("commute_minutes", 240),
])
def test_salary_field_max_bounds_enforced(field_key, boundary):
    """回归：薪酬/工时类字段曾普遍无上限——公积金比例注释写了 12% 却可填 100，
    月薪可填 1e12 级输入。上限在边界值放行、越界拒绝（out_of_range）。"""
    assert validate_fact_value(RULES, field_key, boundary) is None
    with pytest.raises(ValueError) as ei:
        validate_fact_value(RULES, field_key, boundary * 2)
    assert ei.value.code == "out_of_range"


@pytest.mark.parametrize("value", [
    ["rent", "rent"],
    ["rent", "children_education", "rent"],
])
def test_multi_enum_duplicates_rejected(value):
    """回归：multi_enum 重复项曾通过校验，专项附加扣除按出现次数求和，
    ["rent","rent"] 会把租金扣除双倍计入税额。"""
    with pytest.raises(ValueError) as ei:
        validate_fact_value(RULES, "special_additional_deductions", value)
    assert ei.value.code == "duplicate_option"


def test_multi_enum_distinct_options_accepted():
    assert validate_fact_value(
        RULES, "special_additional_deductions", ["rent", "children_education"]
    ) is None
