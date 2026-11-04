"""2026-11 城市参考数据：验证实际缴费边界及保留复核提示。"""

from datetime import date
from uuid import uuid4

import pytest

from app.domain.contracts import OfferInput, RawFactInput
from app.domain.report import _city_cfg, _insurance_module
from app.rules_runtime import get_rules
from app.rules_runtime.validate import stale_city_entries

JIANGSU_CITIES = (
    "南京", "苏州", "无锡", "常州", "镇江", "扬州", "泰州",
    "南通", "盐城", "徐州", "淮安", "连云港", "宿迁",
)


def insurance(city, salary, base_type="salary"):
    values = {
        "city": city, "monthly_base": salary,
        "social_security_type": base_type, "housing_fund_base_type": base_type,
        "housing_fund_employee_rate": 8, "housing_fund_employer_rate": 8,
    }
    offer = OfferInput(
        offer_id=uuid4(), company="Reference", position="", display_order=1,
        facts={key: RawFactInput(field_key=key, value=value, status="known", source="offer_letter")
               for key, value in values.items()},
    )
    rules = get_rules()
    cfg, ok = _city_cfg(rules, offer)
    assert ok
    return _insurance_module(offer, rules, cfg, ok)


@pytest.mark.parametrize("city", JIANGSU_CITIES)
def test_jiangsu_contributions_use_2026_provincial_bounds(city):
    high = insurance(city, 40000)
    low = insurance(city, 3000)
    assert high.si_base == 25127
    assert low.si_base == 5025
    for result in (high, low):
        pension = next(row for row in result.items if row.item == "养老保险")
        assert pension.personal == pytest.approx(result.si_base * 0.08, abs=0.005)
        assert pension.employer == pytest.approx(result.si_base * 0.16, abs=0.005)


def test_nantong_fund_caps_and_medical_total_do_not_double_count_maternity():
    high = insurance("南通", 40000)
    items = {row.item: row for row in high.items}
    assert high.hf_base == 34000
    assert items["住房公积金"].personal == 2720
    assert items["住房公积金"].employer == 2720
    assert items["医疗保险"].employer == pytest.approx(2010.16)
    assert items["生育保险"].employer == pytest.approx(251.27)
    assert items["医疗保险"].employer + items["生育保险"].employer == pytest.approx(25127 * 0.09)
    minimum = insurance("南通", 40000, "minimum")
    assert minimum.hf_base == 2660
    fund = next(row for row in minimum.items if row.item == "住房公积金")
    assert fund.personal == pytest.approx(212.80)
    assert fund.employer == pytest.approx(212.80)


def test_hengyang_old_fund_bounds_remain_flagged_until_new_notice_is_verified():
    high = insurance("衡阳", 40000)
    minimum = insurance("衡阳", 40000, "minimum")
    assert high.hf_base == 21142
    assert minimum.hf_base == 1700
    high_fund = next(row for row in high.items if row.item == "住房公积金")
    assert high_fund.personal == pytest.approx(1691.36)
    low_fund = next(row for row in minimum.items if row.item == "住房公积金")
    assert low_fund.personal == 136
    # 固定核查日，防止把 review 日期当成新数据适用日期而抹去提示。
    stale = stale_city_entries(get_rules(), today=date(2026, 11, 5))
    assert ("衡阳", "2024-01", 34) in stale
    assert ("南通", "2025-07", 16) in stale
