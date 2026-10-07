from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# v0.7 决策维度（键与价值观问卷/report.yaml decision_dimensions 一致）；
# 历史快照中的维度字段声明为 str，旧 key 仍可加载回看。
DimensionKey = Literal["economic", "growth", "experience"]
DIMENSION_KEYS: tuple[str, ...] = ("economic", "growth", "experience")
# not_applicable：依赖字段判定不适用，不参与评分但会出现在事实表中
FactStatus = Literal["known","unknown","need_confirmation","not_applicable","inferred"]

class FrozenModel(BaseModel):
    model_config = ConfigDict(frozen=True)

class RawFactInput(FrozenModel):
    field_key: str; value: Any | None = None; status: FactStatus; source: str
    reliability: float | None = None; version: int = 1

class OfferInput(FrozenModel):
    offer_id: UUID; company: str; position: str; display_order: int
    facts: dict[str, RawFactInput] = Field(default_factory=dict)

class UserPreferenceInput(FrozenModel):
    """偏好权重及生成来源。

    source / answers 只用于解释与审计，不参与评分；buy_house_intent 是
    问卷尾部的用户级情境题（consider/not_consider/undecided）；
    未作答时默认按考虑买房计算。"""
    weights: dict[str, float] = Field(default_factory=dict)
    source: Literal["default", "questionnaire", "manual"] = "default"
    questionnaire_version: str | None = None
    answers: list[dict[str, str]] = Field(default_factory=list)
    buy_house_intent: str | None = "consider"

class DecisionInput(FrozenModel):
    offers: list[OfferInput]; preferences: UserPreferenceInput

# ── v0.7 八模块报告输出 ─────────────────────────────────────────
class MonthSalaryRow(FrozenModel):
    """每月到手工资表一行（累计预扣法）。"""
    month: int; tax_pre: float; tax: float; after_tax: float

class IncomeBreakdown(FrozenModel):
    entry_gross: float | None = None
    entry_net: float | None = None
    guaranteed_gross: float | None = None
    guaranteed_net: float | None = None
    bonus_gross: float | None = None
    bonus_net: float | None = None
    cash_subsidies_gross: float | None = None
    annual_cash_gross: float | None = None
    annual_cash_net: float | None = None
    hf_personal: float | None = None
    hf_employer: float | None = None
    in_kind: float | None = None
    annual_benefits: float | None = None
    recurring_total: float | None = None
    entry_tax_method: str = "并入综合所得，按入职年度与常规年度总税差估算"
    assumptions: list[str] = Field(default_factory=list)


class ReportQuality(FrozenModel):
    field_coverage: int = 0
    answered_fields: int = 0
    applicable_fields: int = 0
    module_coverage: int = 0
    source_counts: dict[str, int] = Field(default_factory=dict)
    uncertain_fields: list[str] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=list)
    estimated_items: list[str] = Field(default_factory=list)
    priority_fields: list[str] = Field(default_factory=list)
    provisional: bool = True


class SalaryModule(FrozenModel):
    """模块 1 税后薪资：12 个月明细 + 年度汇总。"""
    monthly_rows: list[MonthSalaryRow] = Field(default_factory=list)
    income: IncomeBreakdown = Field(default_factory=IncomeBreakdown)
    monthly_after_tax_avg: float | None = None   # 年平均每月到手
    annual_after_tax: float | None = None        # 全年到手合计（12 个月工资）
    annual_bonus_after_tax: float | None = None  # 年终奖税后（择优计税口径）
    bonus_tax_method: str | None = None          # 一次性收入计税口径：单独计税 / 并入综合所得
    signing_bonus_after_tax: float | None = None # 签字费税后估算（首年一次性收入口径）
    hf_annual: float | None = None               # 公积金年缴存（个人+单位，非现金到账）
    annual_tax: float | None = None              # 全年个税（工资部分）
    welfare_annual: float | None = None          # 年实物福利估值（餐食+宿舍）
    annual_with_welfare: float | None = None     # 常规年度现金+公积金+实物福利，不含入职收入
    score: float | None = None
    grade: str = "待补充"

class InsuranceItemRow(FrozenModel):
    item: str; personal: float = 0.0; employer: float = 0.0

class InsuranceModule(FrozenModel):
    """模块 2 五险一金：分项缴纳明细（个人 vs 单位）。"""
    si_base: float | None = None        # 社保缴费基数
    hf_base: float | None = None        # 公积金缴存基数
    items: list[InsuranceItemRow] = Field(default_factory=list)
    personal_monthly: float | None = None
    employer_monthly: float | None = None
    total_monthly: float | None = None
    score: float | None = None
    grade: str = "待补充"

class EfficiencyModule(FrozenModel):
    """模块 3 赚钱效率：时薪 / 日薪 / 摸鱼收益率。"""
    annual_cash: float | None = None    # 常规年度税后现金，不含公积金、实物福利和入职收入
    hourly: float | None = None
    daily: float | None = None
    idle_ratio: float | None = None     # 摸鱼收益率（0-1，每日摸鱼÷日均在岗，封顶 0.8）
    score: float | None = None
    grade: str = "待补充"

class HousingModule(FrozenModel):
    """模块 4 买房预期：攒首付年限 / 月供收入比。"""
    house_total: float | None = None
    down_payment: float | None = None
    down_payment_years: float | None = None
    monthly_payment: float | None = None
    payment_income_ratio: float | None = None
    welfare_annual: float | None = None   # 年补贴（购买力口径）
    signing_bonus: float | None = None    # 安家费（一次性）
    score: float | None = None
    grade: str = "待补充"

class LivingModule(FrozenModel):
    """模块 5 生活水平：收入倍数 / 实际购买力 / 舒适距离。"""
    income_multiple: float | None = None     # 月均到手 ÷ 当地平均工资（未识别城市按全国 8,000 兜底）
    purchasing_power: float | None = None    # 月均到手 ÷ 当地物价系数（折算成全国平均物价下的购买额）
    comfort_gap: float | None = None         # 月均到手 − 舒适线（平均工资×物价系数×1.5，可为负）
    score: float | None = None
    grade: str = "待补充"

class DevelopmentModule(FrozenModel):
    """模块 6 发展水平：八轴雷达 + 综合分。"""
    axes: dict[str, float] = Field(default_factory=dict)   # 轴中文标签 → 0-100
    score: float | None = None
    grade: str = "待补充"

class StabilityModule(FrozenModel):
    """模块 7 稳定性：组件维度分 + 外包折减 + 综合分。"""
    components: dict[str, float | str] = Field(default_factory=dict)  # 组件中文标签 → 分或「未触发」
    score: float | None = None
    grade: str = "待补充"

class HealthModule(FrozenModel):
    """模块 8 健康损耗：扣分制，分数越低越好。"""
    cost: float | None = None                 # 损耗分
    deductions: dict[str, float] = Field(default_factory=dict)  # 扣分项 → 扣分
    main_deduction: str | None = None         # 主要扣分项
    health_score: float | None = None         # 100 − 损耗分（进综合评分）
    grade: str = "待补充"

class OfferReport(FrozenModel):
    offer_id: UUID; company: str; position: str; display_order: int
    city: str | None = None              # 工作地点（排序卡片副标题）
    employment_label: str | None = None  # 工作性质中文标签（排序卡片副标题）
    monthly_after_tax: float | None = None    # 综合排序的展示数字：年平均每月到手
    overall_score: float | None = None
    overall_rank: int | None = None
    money_score: float | None = None          # 钱 = 模块 1-5 加权综合
    dimension_scores: dict[str, float | None] = Field(default_factory=dict)  # 维度键 → 分
    effective_weights: dict[str, float] = Field(default_factory=dict)
    score_contributions: dict[str, float] = Field(default_factory=dict)
    key_numbers: dict[str, float | None] = Field(default_factory=dict)
    sub_scores: dict[str, float] = Field(default_factory=dict)
    sub_metrics: dict[str, float | None] = Field(default_factory=dict)
    sub_details: dict[str, dict[str, Any]] = Field(default_factory=dict)
    missing_core: list[str] = Field(default_factory=list)
    known_optional: dict[str, Any] = Field(default_factory=dict)
    input_values: dict[str, Any] = Field(default_factory=dict)
    quality: ReportQuality = Field(default_factory=ReportQuality)
    city_data_as_of: str | None = None
    completeness: int = 0                     # 数据完整度（8 模块已得分占比，%）
    missing_modules: list[str] = Field(default_factory=list)  # 未得分模块键（salary/.../health）
    city_pending: bool = False                # 城市参数缺失/不在 universe（城市类模块待补充）
    compliance_alert: bool = False            # 社保/公积金按最低基数或不缴纳的合规提示（不参与评分）
    context_chips: list[str] = Field(default_factory=list)    # 不计分的个人情境参考（离家远近/城市好感/工作环境）
    salary: SalaryModule = Field(default_factory=SalaryModule)
    insurance: InsuranceModule = Field(default_factory=InsuranceModule)
    efficiency: EfficiencyModule = Field(default_factory=EfficiencyModule)
    housing: HousingModule = Field(default_factory=HousingModule)
    living: LivingModule = Field(default_factory=LivingModule)
    development: DevelopmentModule = Field(default_factory=DevelopmentModule)
    stability: StabilityModule = Field(default_factory=StabilityModule)
    health: HealthModule = Field(default_factory=HealthModule)

class ReportOutputs(FrozenModel):
    weights: dict[str, float] = Field(default_factory=dict)   # 决策维度权重（问卷产出）
    ranking: list[UUID] = Field(default_factory=list)         # 综合评分降序
    city_data_version: str | None = None                      # 城市参考数据版本（展示口径）
    offers: list[OfferReport] = Field(default_factory=list)

class DecisionSnapshot(FrozenModel):
    # v4 调整收入、评分与质量口径；旧 payload 由路由层显式拒绝。
    schema_version: Literal[5] = 5; session_id: UUID; computed_at: datetime; rule_version: str; trigger_type: str
    inputs: DecisionInput; outputs: ReportOutputs
    rules_digest: str = ""
