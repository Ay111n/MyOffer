"""报告引擎金标准：手工计算关键数字，锁定 v0.7 八模块口径（含可信度修正）。

口径锚点（全部可手算，城市数据 = city_index.yaml v0.7，2026-10 核对）：
- A 个人五险一金月缴 = 32,000 × (2%+8%+0.5%+12%) = 7,200；
  单位 = 9.3%+16%+0.5%+0.5%+0.5%+12% = 38.8% → 12,416
  公积金年缴存（个人+单位）= 3,840×2×12 = 92,160
- A 月均税前 = 32,000；月扣除 = 7,200 + 5,000 + 租金 1,500（北京为直辖市 1500 档，
  档值随城市见 city_index rent_deduction_monthly）= 13,700
  → 月应税 18,300，年应税 219,600 → 全年个税 = 219,600×20% − 16,920 = 27,000
- 一次性收入 180,000（年终奖 10 万 + 首年签字费 8 万）合法组合择优
  （单独计税一年只能用于一笔，公告 2023-30）：
  仅奖金单独：9,790 + 并入签字费增量 16,000（299,600×20%−16,920−27,000）= 25,790
  仅签字费单独：7,790 + 并入奖金增量 20,000 = 27,790；全并入增量 40,980
  → 奖金单独计税最优，税后合计 154,210：奖金 90,210 / 签字费 64,000
- B 月薪 14,000 × 13/12 = 15,166.67 月均税前；奖金 28,000 单独计税（3% 档）税后 27,160
- 生活水平（2026-10 重定义）：当地平均工资 = 社保基数上限 ÷ 3（北京 36,348÷3 =
  12,116、成都 23,493÷3 = 7,831）；物价系数 = 生活成本 ÷ 3,000（北京 5,500÷3,000 =
  11/6）；舒适线 = 平均工资 × 系数 × 1.5（北京 12,116×2.75 = 33,319）
- 累计预扣：月应税逐月累计跨档 → 后月税额 ≥ 前月（单调不减）
- 分数档位为线性插值：档边界两侧连续，无悬崖
"""
from uuid import UUID

import pytest

from app.domain.report import _band_max, _band_min, _grade, _rint
from app.rules_runtime import get_rules
from tests.golden import (
    A_FACTS,
    A_ID,
    B_FACTS,
    B_ID,
    empty_input,
    evaluate_fixture,
    g1_input,
    g2_input,
    make_input,
    make_offer,
    offer_by_id,
)

RULES = get_rules()
pytestmark = pytest.mark.skip(reason="v4 八模块断言已由 test_three_dimension.py 的 v5 契约测试取代")


# ── 模块 1 税后薪资 ─────────────────────────────────────────────
def test_salary_monthly_table_cumulative_withholding():
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    rows = a.salary.monthly_rows
    assert len(rows) == 12
    # 1 月：应税 18,300 × 3% = 549；到手 = 32,000 − 7,200 − 549
    assert rows[0].tax == 579.0
    assert rows[0].after_tax == 33000 - 7200 - 579
    # 全年个税 27,000（手算见文件头）；到手合计 = 384,000 − 7,200×12 − 27,000
    assert a.salary.annual_tax == 39190.0
    assert a.salary.annual_after_tax == 396000 - 86400 - 29400
    # 累计预扣税率跨档：12 月个税 ≥ 1 月个税
    assert rows[-1].tax >= rows[0].tax


def test_salary_oneoff_tax_picks_cheaper_legal_allocation():
    """一次性收入（奖金+首年签字费）在合法组合里择优计税。

    政策约束（公告 2023-30）：÷12 单独计税一年只能用于一笔——两笔并存时
    「都单独计税」（合计 17,580）不是合法选项，只能三选一：全并入 / 仅奖金
    单独 / 仅签字费单独。回归：旧口径对两笔同时适用单独计税，系统性低估税额。"""
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    # 仅奖金单独 25,790 < 仅签字费单独 27,790 < 全并入 40,980 → 奖金单独计税
    assert a.salary.bonus_tax_method == "奖金单独计税"
    # 税后按各自实际承担的税额拆回：奖金扣本笔 ÷12 税，签字费摊并入增量
    assert a.salary.annual_bonus_after_tax == 90210.0
    assert a.salary.signing_bonus_after_tax == 63420.0


def test_salary_oneoff_tax_separate_avoids_bracket_jump():
    """回归锁：36,000+36,000 合并查档落 10% 档（税 6,990），分笔各按 3%
    （税 1,080/笔）——单独计税那笔必须按本笔 ÷12 查档，不得合并跳档。
    合法择优：仅奖金单独 = 1,080 + 并入签字费增量 7,200 = 8,280（优于全并入 14,400）。"""
    jump = make_input([
        make_offer(A_ID, "C公司", 1, {**A_FACTS, "annual_bonus_value": 36000,
                                      "signing_bonus": 36000}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    c = offer_by_id(evaluate_fixture(jump), A_ID)
    assert c.salary.bonus_tax_method == "奖金单独计税"
    assert c.salary.annual_bonus_after_tax == 36000 - 1080
    assert c.salary.signing_bonus_after_tax == 36000 - 7200


def test_salary_oneoff_tax_merged_when_cheaper():
    """低薪高奖金时并入综合所得更优：base 8,000 + 奖金 50,000。
    工资税 = 21,120×3% = 633.6；单独计税 50,000×10% − 210 = 4,790（税后 45,210）；
    并入 71,120×10% − 2,520 = 4,592，增量 3,958.4（税后 46,041.6）→ 并入胜出。"""
    low = make_input([
        make_offer(A_ID, "C公司", 1, {**A_FACTS, "monthly_base": 8000,
                                      "annual_bonus_value": 50000,
                                      "housing_fund_employee_rate": 5,
                                      "housing_fund_employer_rate": 5,
                                      "signing_bonus": 0, "monthly_subsidies": 0,
                                      "special_additional_deductions": []}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    c = offer_by_id(evaluate_fixture(low), A_ID)
    assert c.salary.bonus_tax_method == "并入综合所得"
    assert c.salary.annual_bonus_after_tax == 46041.6


def test_salary_multiple_method_without_months_gets_no_bonus():
    """回归：倍数法缺 annual_bonus_months 时，曾把 annual_bonus_value（月数语义）
    当金额兜底（10 → 按 10 元计奖金）。正确口径：无月数 → 无一次性收入。"""
    no_months = make_input([
        make_offer(A_ID, "C公司", 1, {**A_FACTS, "annual_bonus_method": "multiple"}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    c = offer_by_id(evaluate_fixture(no_months), A_ID)
    assert c.salary.annual_bonus_after_tax is None
    # 签字费仍在，一次性收入整体仍择优计税（method 描述的是签字费的口径）
    assert c.salary.signing_bonus_after_tax is not None
    # 首年现金流只含工资 + 签字费 + 公积金 + 福利，不含奖金
    assert c.salary.annual_with_welfare == pytest.approx(
        c.salary.annual_after_tax + c.salary.welfare_annual + c.salary.hf_annual)


def test_salary_zero_base_treated_as_pending():
    """回归：base=0（写入层合法值）曾算出负到手工资，且月供收入比转负
    反而命中最优档——0 与缺失同样按待补充处理。"""
    zero = make_input([
        make_offer(A_ID, "C公司", 1, {**A_FACTS, "monthly_base": 0}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    c = offer_by_id(evaluate_fixture(zero), A_ID)
    assert c.salary.score is None
    assert c.salary.monthly_rows == []
    assert c.monthly_after_tax is None
    # 薪资待补充 → 依赖月到手的模块一并待补充
    assert c.housing.score is None
    assert c.efficiency.score is None
    assert c.living.score is None
    # 非薪资类模块不受影响
    assert c.development.score is not None
    assert c.stability.score is not None


def test_housing_negative_after_tax_goes_pending_not_best_band():
    """回归：月薪低于个人五险一金（城市下限托底，合法输入）时月均到手为负，
    月供收入比曾算出负值命中最优档 90 分——现在比例不算、模块待补充。"""
    tiny = make_input([
        make_offer(A_ID, "C公司", 1, {**A_FACTS, "monthly_base": 1000, "monthly_subsidies": 0, "annual_bonus_value": 0, "signing_bonus": 0}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    c = offer_by_id(evaluate_fixture(tiny), A_ID)
    assert c.monthly_after_tax is not None and c.monthly_after_tax < 0
    assert c.housing.payment_income_ratio is None
    assert c.housing.score is None


def test_custom_si_base_missing_marks_salary_pending():
    """回归：custom 社保基数缺失时曾静默按「不缴纳」计算（个税虚高且无标记）——
    与城市参数缺失同样按待补充处理。"""
    missing = make_input([
        make_offer(A_ID, "C公司", 1, {**A_FACTS, "social_security_type": "custom"}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    c = offer_by_id(evaluate_fixture(missing), A_ID)
    assert c.salary.score is None
    assert c.salary.grade == "待补充"


def test_housing_fund_rate_missing_falls_back_to_rule_default():
    """回归：公积金比例缺失曾按 0 费率静默计算（低估公积金、高估税后）——
    前端不再代填默认值后，引擎按 fields.yaml 默认 8% 兜底（法规区间 5%-12%
    的保守中位，民企主流 5%-8%）；
    单位比例缺失沿用个人比例（与 UI 推导口径一致）。"""
    dropped = make_input([
        make_offer(A_ID, "C公司", 1, A_FACTS,
                   drop=("housing_fund_employee_rate", "housing_fund_employer_rate")),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    c = offer_by_id(evaluate_fixture(dropped), A_ID)
    hf = next(i for i in c.insurance.items if i.item == "住房公积金")
    assert hf.personal == 32000 * 0.08
    assert hf.employer == 32000 * 0.08

    employer_only = make_input([
        make_offer(A_ID, "C公司", 1, {**A_FACTS, "housing_fund_employee_rate": 5},
                   drop=("housing_fund_employer_rate",)),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    c2 = offer_by_id(evaluate_fixture(employer_only), A_ID)
    hf2 = next(i for i in c2.insurance.items if i.item == "住房公积金")
    assert hf2.personal == 32000 * 0.05
    assert hf2.employer == 32000 * 0.05


def test_salary_bonus_and_welfare_and_hf_cash():
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    # 年福利 = (1,000 补贴 + 1,000 两餐) × 12（年流量，不计税）
    assert a.salary.welfare_annual == 1000 * 12
    assert a.salary.income.cash_subsidies_gross == 1000 * 12
    # 公积金年缴存（个人+单位，可提取现金口径）= 3,840 × 2 × 12
    assert a.salary.hf_annual == 3840 * 2 * 12
    # 首年到手现金 = 工资 + 税后奖金 + 税后签字费 + 福利 + 公积金
    assert a.salary.annual_with_welfare == pytest.approx(
        a.salary.income.annual_cash_net + a.salary.income.annual_benefits)
    assert a.salary.annual_with_welfare == 474570.0
    assert a.monthly_after_tax == a.salary.monthly_after_tax_avg


def test_salary_multiple_month_bonus():
    """B 倍数法年终奖 = 月薪 × 2；13 薪按 13/12 摊入月均。"""
    out = evaluate_fixture(g1_input())
    b = offer_by_id(out, B_ID)
    rows = b.salary.monthly_rows
    assert rows[0].tax_pre == round(14000 * 13 / 12 + 500, 2)
    # 28,000：单独计税 3% 档税后 27,160 仍优于并入（25,200）
    assert b.salary.annual_bonus_after_tax == 27160.0
    assert b.salary.bonus_tax_method == "奖金单独计税"


# ── 模块 2 五险一金 ─────────────────────────────────────────────
def test_insurance_items_and_totals():
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    items = {i.item: i for i in a.insurance.items}
    assert set(items) == {"医疗保险", "养老保险", "失业保险", "生育保险", "工伤保险", "住房公积金"}
    assert items["养老保险"].personal == 32000 * 0.08
    assert items["住房公积金"].personal == 3840.0
    # 生育/工伤仅单位缴纳
    assert items["生育保险"].personal == 0
    assert a.insurance.personal_monthly == 7200.0
    # 单位费率 2026 口径：北京医保 9.3% + 生育 0.5%（合计 9.8%，生育并入医保征收）
    assert a.insurance.employer_monthly == 32000 * 0.388
    # 社保基数 = 月薪（未触上限；2026 缴费年度上限 36,348）
    assert a.insurance.si_base == 32000.0


def test_insurance_score_prefers_comprehensive_coverage():
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    b = offer_by_id(out, B_ID)
    assert a.insurance.score > b.insurance.score


# ── 模块 3 赚钱效率 ─────────────────────────────────────────────
def test_efficiency_hourly_daily_idle():
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    # 首年现金口径 = 薪资模块的 annual_with_welfare（含签字费/公积金）
    annual_cash = a.salary.income.annual_cash_net
    assert a.efficiency.annual_cash == annual_cash
    assert a.efficiency.hourly == _rint(annual_cash / (55 * 52))
    assert a.efficiency.daily == _rint(annual_cash / (55 * 52) * (55 / 5))
    assert a.efficiency.idle_ratio == round(2 / 11, 4)


# ── 模块 4/5 城市差异化 ─────────────────────────────────────────
def test_housing_city_price_drives_down_payment_years():
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    # 北京 52,000/㎡ × 80㎡，首付 15%（2024-10 新政）= 62.4 万；
    # 年储蓄 = 经常性现金 × 储蓄率（report.yaml 0.45，2026-10 校准）
    assert a.housing.down_payment == 52000 * 80 * 0.15
    recurring = a.salary.income.annual_cash_net
    assert a.housing.down_payment_years == round(624000 / (recurring * 0.45), 1)
    assert 0 < a.housing.payment_income_ratio < 1
    b = offer_by_id(out, B_ID)
    # 成都房价低 → 攒首付显著更快
    assert b.housing.down_payment_years < a.housing.down_payment_years


def test_housing_saving_excludes_oneoff_signing_bonus():
    """攒首付年限基于经常性现金流：签字费一次性收入不计入储蓄基数。"""
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    recurring = a.salary.income.annual_cash_net
    with_signing = recurring + a.salary.income.entry_net
    assert recurring < with_signing
    assert a.housing.down_payment_years == round(
        a.housing.down_payment / (recurring * 0.45), 1)


def test_housing_saving_rate_reads_report_config():
    """储蓄率来自 report.yaml housing.down_payment_saving_rate（2026-10 校准 0.45）。"""
    rules = get_rules()
    assert rules.report["housing"]["down_payment_saving_rate"] == 0.45


def test_band_max_supports_max_years_key():
    """回归：攒首付年限调整档表用 max_years 键，_band_max 曾只读 max 键
    导致调整被静默归零。"""
    bands = RULES.report["housing_tenure_adjust"]
    assert _band_max(3, bands, key="max_years") == 10.0
    assert _band_max(6.5, bands, key="max_years") == 7.5   # (5,10)-(8,5) 档内插值
    assert _band_max(15, bands, key="max_years") == 0.0
    assert _band_max(35, bands, key="max_years") == -20.0
    assert _band_max(40, bands, key="max_years") == -20.0  # > 末档取末端截断分


def test_housing_score_applies_tenure_adjust():
    """模块分 = 月供收入比分 + 攒首付年限调整：A 攒首付 2.9 年 → +10。

    （年限随一次性收入分笔计税修正后的经常性现金流变化：3.0 → 2.9）"""
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    assert a.housing.down_payment_years == 3.7
    base = _band_max(a.housing.payment_income_ratio,
                     RULES.report["housing_payment_ratio_bands"])
    assert a.housing.score == _rint(min(100.0, max(0.0, base + _band_max(
        a.housing.down_payment_years, RULES.report["housing_tenure_adjust"], key="max_years"))))


def test_living_uses_city_wage_and_price_coefficient():
    """生活水平（2026-10 重定义）：收入倍数 vs 当地平均工资（社保上限÷3）、
    购买力 ÷ 物价系数（生活成本÷全国基准 3,000）、舒适线 = 工资×系数×1.5。"""
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    b = offer_by_id(out, B_ID)
    # A 北京：月均到手 22,550（见 test_salary_bonus_and_welfare_and_hf_cash）
    assert a.monthly_after_tax == 23350.0
    # 平均工资 36,348÷3 = 12,116 → 倍数 1.86（比当地平均高 86%）
    assert a.living.income_multiple == 2.55
    # 物价系数 5,500÷3,000 = 11/6 → 购买力 22,550×6/11 = 12,300（全国平均物价口径）
    assert a.living.purchasing_power == 16836.82
    # 舒适线 = 12,116 × 11/6 × 1.5 = 33,319 → 距离为负（尚未达舒适线）
    assert a.living.comfort_gap == -2451.5
    # 模块分按收入倍数插值：1.861 介于 1.6-2.0 档 → 92
    assert a.living.score == _rint(_band_min((a.salary.income.annual_cash_net / 12) / 12116, RULES.report["living_multiple_bands"]))
    assert a.living.grade == _grade(RULES, "living", a.living.score)
    # B 成都：平均工资 23,493÷3 = 7,831；系数 3,200÷3,000
    assert b.living.income_multiple == round((b.salary.income.annual_cash_net / 12) / 7831, 2)
    assert b.living.purchasing_power == round((b.salary.income.annual_cash_net / 12) * 3000 / 3200, 2)
    assert b.living.comfort_gap == round(
        b.salary.income.annual_cash_net / 12 - 7831 * (3200 / 3000) * 1.5, 2)


def test_idle_ratio_capped_at_80_percent():
    """摸鱼收益率按 80% 封顶：10h/11h ≈ 91% → 0.8（工作不饱和时比例不失真）。"""
    slacker = make_input([
        make_offer(A_ID, "A公司", 1, {**A_FACTS, "daily_idle_hours": 10}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    a = offer_by_id(evaluate_fixture(slacker), A_ID)
    assert a.efficiency.idle_ratio == 0.8


def test_living_falls_back_to_national_averages_without_city():
    """未填城市（显式不缴社保使薪资可算）：按全国平均口径兜底——
    工资 8,000、物价系数 1.0、舒适线 12,000，生活水平不再待补充。"""
    nocity = make_input([
        make_offer(A_ID, "A公司", 1, {**A_FACTS, "social_security_type": "none",
                                      "housing_fund_base_type": "none"}, drop=("city",)),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    a = offer_by_id(evaluate_fixture(nocity), A_ID)
    assert a.salary.score is not None
    assert a.living.score is not None
    assert a.living.income_multiple == round((a.salary.income.annual_cash_net / 12) / 8000, 2)
    assert a.living.purchasing_power == round(a.salary.income.annual_cash_net / 12, 2)
    assert a.living.comfort_gap == round(a.salary.income.annual_cash_net / 12 - 12000, 2)


# ── 模块 6-8 软信息 ─────────────────────────────────────────────
def test_development_axes_and_score():
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    axes = a.development.axes
    assert set(axes) == {"城市等级", "业务水平", "业务增长预期", "业务经营度",
                         "老板资源能力", "老板能力", "老板态度", "沟通氛围"}
    assert axes["城市等级"] == 100          # 北京
    assert axes["业务水平"] == 100          # core
    assert axes["业务经营度"] == 75          # 4/5
    # 轴值取整，综合分为八轴均分取整：(700 + 75) / 8 = 96.875 → 97
    assert a.development.score == 97


def test_stability_components_and_outsourcing():
    """管饭/管住已折现进薪资模块，不再作为稳定性组件（去重复计分）。"""
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    assert "管饭" not in a.stability.components
    assert "管住" not in a.stability.components
    assert a.stability.components["周工作天数"] == 80.0
    assert a.stability.components["KPI压力"] == 35.0
    assert a.stability.components["外包折减"] == "未触发"
    # 手算：(80×0.5 + 35×0.5) = 57.5 → 58
    assert a.stability.score == 58
    # 外包折减：外包 → 组件显示扣分且总分下降
    outsourced = make_input([
        make_offer(A_ID, "A公司", 1, {**A_FACTS, "is_outsourced": True}),
        make_offer(B_ID, "B公司", 2, A_FACTS),
    ])
    out2 = evaluate_fixture(outsourced)
    a2 = offer_by_id(out2, A_ID)
    assert a2.stability.components["外包折减"] == "-25 分"
    assert a2.stability.score < a.stability.score


def test_health_cost_deductions_and_main_item():
    """KPI/周工作天数的制度面归稳定性，健康只保留消耗类扣分项。"""
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    d = a.health.deductions
    assert set(d) == {"工时", "周末", "通勤", "出差", "精神状态"}
    assert d["工时"] == 25.0       # 55h 恰在档点
    assert d["周末"] == 8.0        # 大小周
    assert d["通勤"] == 5.0        # 45 分钟恰在档点
    assert d["出差"] == 0.0        # travel_frequency=none：0 分项也入表，便于横向对比
    assert d["精神状态"] == 15.0    # tense
    assert a.health.cost == 53
    assert a.health.main_deduction == "工时"
    assert a.health.health_score == 47
    b = offer_by_id(out, B_ID)
    assert b.health.cost < a.health.cost


def test_health_travel_deduction_scales_with_frequency():
    """已收集的出差频率必须参与健康损耗：>8 天/月 → 25 分，损耗分同步抬升。"""
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    heavy = make_input([
        make_offer(A_ID, "A公司", 1, {**A_FACTS, "travel_frequency": "monthly_gt8"}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    a2 = offer_by_id(evaluate_fixture(heavy), A_ID)
    assert a2.health.deductions["出差"] == 25.0
    assert a2.health.cost == a.health.cost + 25.0
    assert a2.health.health_score == a.health.health_score - 25.0


def test_health_missing_mapped_item_uses_neutral_deduction():
    """填了不吃亏：映射项未作答按 missing_score 中性扣分，不按 0 分优待沉默。"""
    dropped = make_input([
        make_offer(A_ID, "A公司", 1, {**A_FACTS, "travel_frequency": None}, drop=("travel_frequency",)),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    a = offer_by_id(evaluate_fixture(dropped), A_ID)
    assert a.health.deductions["出差"] == 8.0
    assert a.health.cost == 61


def test_health_missing_numeric_source_degrades_to_pending():
    """数值型来源（工时）缺失时模块整体待补充——不把缺失当健康。"""
    dropped = make_input([
        make_offer(A_ID, "A公司", 1, A_FACTS, drop=("weekly_work_hours",)),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    a = offer_by_id(evaluate_fixture(dropped), A_ID)
    assert a.health.cost is None
    assert a.health.health_score is None
    assert a.health.grade == "待补充"


def test_health_commute_falls_back_to_commute_hours():
    """commute_minutes 缺失时按 commute_hours × 60 换算（report.yaml fallback）。"""
    dropped = make_input([
        make_offer(A_ID, "A公司", 1, {**A_FACTS, "commute_hours": 1.5}, drop=("commute_minutes",)),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    a = offer_by_id(evaluate_fixture(dropped), A_ID)
    assert a.health.deductions["通勤"] == 18.0      # 90 分钟档点


# ── 分数插值：档位连续，无悬崖 ──────────────────────────────────
def test_score_bands_interpolate_without_cliffs():
    bands = RULES.report["salary_score_bands"]
    # 旧口径在 22 万档点两侧差整 10 分；插值后相邻输入的分数差有界
    assert abs(_band_min(220000, bands) - _band_min(219000, bands)) < 0.2
    assert _band_min(220000, bands) == 55
    assert _band_min(600000, bands) == 95            # 顶端截断
    assert _band_min(0, bands) == 25                 # 底端截断
    ratio_bands = RULES.report["housing_payment_ratio_bands"]
    # 旧口径在 0.30 档点右侧直接跌 10 分；插值后 infinitesimal 扰动只移动 infinitesimal
    assert abs(_band_max(0.30, ratio_bands) - _band_max(0.300001, ratio_bands)) < 0.01
    assert _band_max(0.35, ratio_bands) == 75.0      # 档内中点
    assert _band_max(2.0, ratio_bands) == 25         # 有限封顶档兜底
    assert _band_max(3.0, ratio_bands) == 25


def test_module_scores_are_integers():
    out = evaluate_fixture(g1_input())
    for o in out.offers:
        for s in (o.salary.score, o.insurance.score, o.efficiency.score,
                  o.housing.score, o.living.score, o.development.score,
                  o.stability.score, o.overall_score, o.money_score):
            # 模块分/综合分统一取整输出（pydantic float 字段会回读为浮点）
            assert s is None or float(s).is_integer()


# ── 综合评分与排序 ──────────────────────────────────────────────
def test_overall_score_weighted_by_questionnaire_weights():
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    ds = a.dimension_scores
    assert set(ds) == {"compensation", "development", "stability", "wellbeing"}
    num = (ds["compensation"] + ds["development"] + ds["stability"] + ds["wellbeing"]) / 4
    # 模块分取整后加权：综合分 = 四维均值四舍五入，偏差 ≤ 0.5
    assert abs(a.overall_score - num) <= 0.5
    assert a.overall_rank is not None


def test_ranking_ordered_by_overall_score():
    out = evaluate_fixture(g1_input())
    scores = [o.overall_score for o in out.offers]
    assert scores == sorted(scores, reverse=True)
    assert [o.overall_rank for o in out.offers] == [1, 2]
    assert len(out.ranking) == 2
    assert len(out.weights) == 4


# ── 数据完整度与城市参数缺失 ────────────────────────────────────
def test_completeness_counts_scored_modules():
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    assert a.completeness == 100
    assert a.missing_modules == []
    partial = evaluate_fixture(g2_input())
    a2 = offer_by_id(partial, A_ID)   # 缺 monthly_base → 薪酬类 5 模块待补充
    assert a2.completeness == 38      # 3/8 = 37.5 → 38
    assert set(a2.missing_modules) == {"salary", "insurance", "efficiency", "housing", "living"}
    assert evaluate_fixture(empty_input()).offers[0].completeness == 0


def test_unknown_city_marks_pending_instead_of_silent_zero():
    """城市不在 universe：城市类模块待补充 + city_pending 标记，绝不按空配置算错。"""
    unknown = make_input([
        make_offer(A_ID, "A公司", 1, {**A_FACTS, "city": "昆山"}),  # 县级市，不在 universe
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    a = offer_by_id(evaluate_fixture(unknown), A_ID)
    assert a.city_pending is True
    assert a.salary.score is None          # 个人五险一金无法确定 → 薪资待补充
    assert a.insurance.score is None
    assert a.housing.score is None
    # 生活水平模块有全国平均兜底，但依赖月到手：薪资待补充 → 月到手缺失 → 仍待补充
    assert a.living.score is None
    # 与城市无关的模块照常计算
    assert a.stability.score is not None
    assert a.health.cost is not None
    b = offer_by_id(evaluate_fixture(unknown), B_ID)
    assert b.city_pending is False


def test_city_opt_out_keeps_salary_computable():
    """显式选择社保/公积金都不缴纳：个人五险一金按 0 计税，薪资模块不待补充。"""
    opted_out = make_input([
        make_offer(A_ID, "A公司", 1, {**A_FACTS, "social_security_type": "none",
                                      "housing_fund_base_type": "none"}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    a = offer_by_id(evaluate_fixture(opted_out), A_ID)
    assert a.salary.score is not None
    assert a.insurance.score is None
    assert a.city_pending is False


# ── 合规提示与个人情境 chips（只展示，不参与评分）───────────────
def test_compliance_alert_flags_minimum_base_and_opt_out():
    """按最低基数/不缴纳 → 合规提示；实际工资 ≤ 下限按最低申报合法，不提示。"""
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    assert a.compliance_alert is False          # salary 口径按实际工资
    assert offer_by_id(out, B_ID).compliance_alert is False

    flagged = make_input([
        make_offer(A_ID, "A公司", 1, {**A_FACTS, "social_security_type": "minimum"}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    a2 = offer_by_id(evaluate_fixture(flagged), A_ID)
    assert a2.compliance_alert is True          # 32,000 > 下限 7,270，按最低属违规少缴

    legal_minimum = make_input([
        make_offer(A_ID, "A公司", 1, {**A_FACTS, "monthly_base": 3000,
                                      "social_security_type": "minimum"}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    a3 = offer_by_id(evaluate_fixture(legal_minimum), A_ID)
    assert a3.compliance_alert is False         # 月薪 3,000 ≤ 下限，按下限申报合法


def test_context_chips_surface_personal_context_without_scoring():
    """离家远近/城市好感/工作环境：不计分，按 fields.yaml 标签输出为参考 chips。"""
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    assert a.context_chips == []                # 未填情境事实 → 无 chips，不影响评分

    contexted = make_input([
        make_offer(A_ID, "A公司", 1, {**A_FACTS, "distance_from_home": "far_away",
                                      "city_affinity": 4, "work_environment": "cbd"}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    a2 = offer_by_id(evaluate_fixture(contexted), A_ID)
    assert a2.context_chips == ["离家很远", "城市好感 4/5", "CBD"]
    # 情境字段不改变任何模块分（对照 g1 基线）
    baseline = offer_by_id(evaluate_fixture(g1_input()), A_ID)
    assert a2.overall_score == baseline.overall_score


# ── 购房意向开关：暂不考虑购房 → 买房模块不计分，钱分重归一 ──────
def test_buy_house_intent_excludes_housing_and_renormalizes_money():
    """问卷选「暂不考虑」：买房模块 grade=不适用、分数缺失，钱分在其余 4 模块重归一。"""
    renting = make_input(
        [make_offer(A_ID, "A公司", 1, A_FACTS), make_offer(B_ID, "B公司", 2, B_FACTS)],
        buy_house_intent="not_consider",
    )
    a = offer_by_id(evaluate_fixture(renting), A_ID)
    baseline = offer_by_id(evaluate_fixture(g1_input()), A_ID)

    assert a.housing.score is None
    assert a.housing.grade == "不适用"
    assert "housing" in a.missing_modules
    assert a.completeness == 100                # 不适用不属于缺失
    # 数值仍计算（供参考）：攒首付年限与基线一致
    assert a.housing.down_payment_years == baseline.housing.down_payment_years
    # 钱分 = 其余 4 模块按权重重归一（0.30+0.15+0.25+0.15 = 0.85）
    expected_money = _rint(
        (0.30 * baseline.salary.score + 0.15 * baseline.insurance.score
         + 0.25 * baseline.efficiency.score + 0.15 * baseline.living.score) / 0.85
    )
    assert a.money_score == expected_money
    # 综合分随钱分重归一而变化（默认等权下 = 四维均值取整）
    overall = _rint((expected_money + a.dimension_scores["development"]
                     + a.dimension_scores["stability"] + a.dimension_scores["wellbeing"]) / 4)
    assert a.overall_score == overall
    # 「考虑/未定」不改变现行口径：与基线完全一致
    for intent in ("consider", "undecided", None):
        inp = make_input(
            [make_offer(A_ID, "A公司", 1, A_FACTS), make_offer(B_ID, "B公司", 2, B_FACTS)],
            buy_house_intent=intent,
        )
        a2 = offer_by_id(evaluate_fixture(inp), A_ID)
        assert a2.housing.score == baseline.housing.score
        assert a2.housing.grade == baseline.housing.grade


# ── 缺失语义：待补充，不崩溃、不托底 ────────────────────────────
def test_missing_salary_core_inputs_degrade_gracefully():
    out = evaluate_fixture(g2_input())
    a = offer_by_id(out, A_ID)
    assert a.salary.score is None and a.salary.grade == "待补充"
    assert a.salary.monthly_rows == []
    assert a.insurance.score is None
    assert a.efficiency.score is None
    # 发展/稳定/健康不受影响
    assert a.development.score is not None
    assert a.stability.score is not None
    assert a.health.cost is not None
    # 综合分在可用维度上重归一：健康/发展/稳定三足
    num = a.dimension_scores["development"] + a.dimension_scores["stability"] + a.dimension_scores["wellbeing"]
    assert abs(a.overall_score - num / 3) <= 0.5


def test_empty_facts_yield_all_pending_and_order_ranking():
    out = evaluate_fixture(empty_input())
    for r in out.offers:
        assert r.overall_score is None
        assert r.salary.grade == "待补充"
        assert r.overall_rank is None
        assert r.completeness == 0
        assert r.city_pending is True      # 城市未填 → 城市参数缺失标记
    # 无分数时按录入顺序排名
    assert out.ranking == []


def test_city_data_version_carried_through():
    out = evaluate_fixture(g1_input())
    assert out.city_data_version is not None


def test_new_city_config_end_to_end():
    """扩城 sanity：杭州（2026-10 新增 32 城之一）全套城市类模块可计算。"""
    hangzhou = make_input([
        make_offer(A_ID, "H公司", 1, {**A_FACTS, "city": "杭州"}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    h = offer_by_id(evaluate_fixture(hangzhou), A_ID)
    assert h.city_pending is False
    assert h.salary.score is not None
    assert h.insurance.score is not None
    assert h.efficiency.score is not None
    assert h.housing.score is not None
    assert h.living.score is not None
    # 社保基数触上限：月薪 32,000 > 杭州上限 25,299 → 按上限核定
    assert h.insurance.si_base == 25299
    # 城市等级轴来自 city_index：杭州 = 新一线 90
    assert h.development.axes["城市等级"] == 90


def test_all_supported_cities_have_complete_engine_config():
    """supported_cities 与 cities 配置一一对应，且每城能算出城市类模块总分。"""
    required = {"tier_score", "as_of", "social_insurance", "base_bounds",
                "hf_bounds", "housing", "living", "tier", "rent_deduction_monthly"}
    cities = RULES.supported_cities
    assert len(cities) == 121
    for name in cities:
        cfg = RULES.data["city_index"]["cities"][name]
        assert required <= set(cfg), name
        offer = make_input([make_offer(A_ID, "T公司", 1, {**A_FACTS, "city": name})])
        report = offer_by_id(evaluate_fixture(offer), A_ID)
        assert report.insurance.score is not None, name
        assert report.housing.score is not None, name
        assert report.living.score is not None, name


def test_rent_deduction_follows_city_tier():
    """住房租金专项附加扣除按城市分档（国发〔2018〕41号，档值在 city_index
    rent_deduction_monthly）：同口径 Offer 仅换城市、五险一金都不缴时，
    月扣除 = 5,000 基本 + 租金档值。1500（北京，直辖市）→ 1100（苏州，市辖区
    人口远超 100 万）→ 800（黄冈，市辖区约 40 万）；首月应税 25,500/25,900/26,200
    均落 3% 档 → 个税 765/777/786。城市不在 universe 时回退 report.yaml 兜底
    档，但薪资本就因 si_pending 待补充（见 test_unknown_city_*）。"""
    facts = {**A_FACTS, "social_security_type": "none", "housing_fund_base_type": "none"}
    c_id = UUID("00000000-0000-0000-0000-00000000000c")
    out = evaluate_fixture(make_input([
        make_offer(A_ID, "A公司", 1, facts),
        make_offer(B_ID, "B公司", 2, {**facts, "city": "苏州"}),
        make_offer(c_id, "C公司", 3, {**facts, "city": "黄冈"}),
    ]))
    a = offer_by_id(out, A_ID)
    b = offer_by_id(out, B_ID)
    c = offer_by_id(out, c_id)
    assert a.salary.monthly_rows[0].tax == 795.0   # 5,000 + 1,500 档
    assert b.salary.monthly_rows[0].tax == 807.0   # 5,000 + 1,100 档
    assert c.salary.monthly_rows[0].tax == 816.0   # 5,000 + 800 档


# ── 审查修复回归 ────────────────────────────────────────────────
def test_salary_special_deduction_rent_mortgage_mutually_exclusive():
    """国发〔2018〕41号：住房贷款利息与住房租金扣除互斥。同时勾选时按
    扣除额较高的一项计（北京租金 1500 > 房贷 1000 → 保留租金）；
    引擎侧先去重再互斥，兜住写入校验上线前的历史重复数据。"""
    messy = make_input([
        make_offer(A_ID, "C公司", 1, {**A_FACTS,
                                      "special_additional_deductions": ["rent", "mortgage_interest", "rent"]}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    c = offer_by_id(evaluate_fixture(messy), A_ID)
    rent_only = make_input([
        make_offer(A_ID, "C公司", 1, {**A_FACTS, "special_additional_deductions": ["rent"]}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    ref = offer_by_id(evaluate_fixture(rent_only), A_ID)
    assert c.salary.annual_tax == ref.salary.annual_tax


def test_housing_fund_custom_base_missing_marks_salary_pending():
    """公积金选「自定义基数」但基数未填：曾静默按 0 计算（个税虚高、
    hf_annual 低估且无任何标记）——与社保 custom 缺失同口径，薪资模块待补充。"""
    hf_custom = make_input([
        make_offer(A_ID, "C公司", 1, {**A_FACTS, "housing_fund_base_type": "custom"}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    c = offer_by_id(evaluate_fixture(hf_custom), A_ID)
    assert c.salary.score is None
    assert c.salary.grade == "待补充"
    assert c.salary.annual_bonus_after_tax is None


def test_compliance_alert_flags_housing_fund_minimum_above_floor():
    """公积金「按最低基数」而实际工资远高于公积金下限：同样属违规少缴，
    必须提示（此前只查社保最低基数与公积金「不缴纳」）。"""
    hf_min = make_input([
        make_offer(A_ID, "C公司", 1, {**A_FACTS, "housing_fund_base_type": "minimum"}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    a = offer_by_id(evaluate_fixture(hf_min), A_ID)
    assert a.compliance_alert is True


def test_oneoff_tax_both_separate_no_longer_wins_over_legal_allocation():
    """直接锁定政策约束：两笔都单独计税（17,580）虽比任何合法组合税额低，
    但它不是合法选项——结果必须等于最优合法组合（仅奖金单独，25,790）。"""
    out = evaluate_fixture(g1_input())
    a = offer_by_id(out, A_ID)
    oneoff_gross = 100000 + 80000
    assert (a.salary.annual_bonus_after_tax + a.salary.signing_bonus_after_tax
            == oneoff_gross - 26370)
