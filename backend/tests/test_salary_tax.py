"""个税口径回归：月度预扣与年度择优共用同一累计语义。

不变式：_monthly_rows 的全年个税 ≡ _cum_tax(12×(月薪−月扣除))——
月度累计应纳税所得额不做逐月截断（负差额跨月结转），年度择优公式
直接消费同一累计值；低收入时全年扣除余额可被奖金/入职收入使用。"""
from uuid import uuid4

import pytest

from app.domain.contracts import OfferInput, RawFactInput
from app.domain.report import _city_cfg, _cum_tax, _offer_context, _salary_module
from app.rules_runtime import get_rules


def _module(monthly_base: float, extra: dict | None = None):
    rules = get_rules()
    facts = {
        "city": "成都", "monthly_base": monthly_base, "guaranteed_salary_months": 12,
        # 双不缴：个人五险一金为 0，月扣除恰为起征点 5000，口径可手算
        "social_security_type": "none", "housing_fund_base_type": "none",
        **(extra or {}),
    }
    offer = OfferInput(
        offer_id=uuid4(), company="T", position="", display_order=1,
        facts={k: RawFactInput(field_key=k, value=v, status="known", source="offer_letter")
               for k, v in facts.items()},
    )
    city, ok = _city_cfg(rules, offer)
    return _salary_module(offer, rules, _offer_context(offer, rules, city, ok))


@pytest.mark.parametrize("base", [3000, 8000, 20000])
def test_withholding_annual_tax_equals_cumulative_formula(base):
    module = _module(base)
    taxable = 12.0 * (base - 5000.0)
    # 年度择优（无奖金时）与累计公式同源；月度表全年合计与其一致（逐月
    # round 的分位误差内），含扣除大于月薪的负差额月份
    assert module.annual_tax == pytest.approx(_cum_tax(taxable, _brackets()), abs=0.01)
    assert sum(row.tax for row in module.monthly_rows) == pytest.approx(module.annual_tax, abs=0.5)


def _brackets():
    return get_rules().report["tax"]["cumulative_brackets"]


def test_low_income_deduction_headroom_absorbs_bonus():
    """月薪 3000（低于起征点）+ 年终奖 3 万：全年扣除余额抵扣奖金并入计税。

    merged = _cum_tax(12×(3000−5000) + 30000) = _cum_tax(6000) = 180，
    低于单独计税 900 → 择优并入；若年度公式错误地截断负差额，
    merged 会变成 _cum_tax(30000)=900，本测试即红。"""
    module = _module(3000, {"annual_bonus_method": "amount", "annual_bonus_value": 30000})
    assert module.bonus_tax_method == "并入综合所得"
    assert module.income.bonus_net == pytest.approx(30000 - 180.0, abs=0.01)
