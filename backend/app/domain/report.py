"""报告引擎的共享基础件（v5）。

当前活跃引擎是 report_v5.build_report（evaluator 唯一入口）；本模块提供
它依赖的取值/分档工具与跨版本共用的模块计算：五险一金、税后薪资、买房、
合规提示与城市上下文。v0.8 八模块引擎已随三维评分改版退役（git 历史留档）。

关键口径（与 report.yaml 头注一致）：
- 分数档位按档内线性插值取分，输入小幅扰动不产生排名悬崖；
- 年终奖择优计税；入职收入并入综合所得，按年度总税差估算；
- 公积金缴存（个人+单位）单列为账户福利，不计入年度现金；
- 城市差异（费率/房价/生活成本）来自 data/city_index.yaml；城市未填或不在
  universe 时城市类输入按缺失处理，绝不按空配置静默算错。

纯函数：输入 OfferInput + RuleSet，输出模块结果。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from app.domain.contracts import (
    HousingModule,
    IncomeBreakdown,
    InsuranceItemRow,
    InsuranceModule,
    MonthSalaryRow,
    OfferInput,
    SalaryModule,
)
from app.rules_runtime import RuleSet

# ── 基础取值与分档工具 ──────────────────────────────────────────

def _fact(offer: OfferInput, key: str):
    """known 事实值；缺失/未确认/不适用 → None。"""
    f = offer.facts.get(key)
    if f is None or f.status != "known" or f.value is None:
        return None
    return f.value


def _num(offer: OfferInput, key: str) -> float | None:
    v = _fact(offer, key)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _text(offer: OfferInput, key: str) -> str | None:
    v = _fact(offer, key)
    return str(v) if isinstance(v, str) else None


def _rint(v: float) -> int:
    """四舍五入取整（half-up）。模块分/综合分的统一输出口径。"""
    return int(math.floor(v + 0.5))


def _interp(value: float, points: list[tuple[float, float]]) -> float:
    """分段线性插值：points 按 x 严格升序，两端截断。"""
    if value <= points[0][0]:
        return points[0][1]
    for (x0, s0), (x1, s1) in zip(points[:-1], points[1:], strict=True):
        if value <= x1:
            return s0 + (s1 - s0) * (value - x0) / (x1 - x0)
    return points[-1][1]


def _band_max(value: float, bands: list[dict], key: str = "max") -> float:
    """max 型插值分档（值越大分越低）：按上限键升序在相邻档间线性插值；
    上限为 null 的兜底档（旧配置）作为末端截断分。key 为上限字段名
    （月供收入比档表用 max，攒首付年限调整表用 max_years）。"""
    points = sorted((float(b[key]), float(b["score"]))
                    for b in bands if b.get(key) is not None)
    tail = next((float(b["score"]) for b in bands if b.get(key) is None), None)
    if not points:
        return tail if tail is not None else 0.0
    if value > points[-1][0]:
        return tail if tail is not None else points[-1][1]
    return _interp(value, points)


def _band_min(value: float, bands: list[dict]) -> float:
    """min 型插值分档（值越大分越高）：按 min 升序在相邻档间线性插值。"""
    points = sorted((float(b["min"]), float(b["score"])) for b in bands)
    return _interp(value, points)


def _grade(rules: RuleSet, module: str, score: float | None) -> str:
    if score is None:
        return "待补充"
    for band in rules.report.get("grades", {}).get(module, []):
        if score >= float(band["min"]):
            return str(band["label"])
    return "待补充"


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


# ── 城市 / 五险一金基数 ─────────────────────────────────────────

def _city_cfg(rules: RuleSet, offer: OfferInput) -> tuple[dict, bool]:
    """(城市配置, 城市参数是否可用)。城市未填或不在 universe → ({}, False)，
    上层据此把城市类模块标待补充，而不是按空配置静默算错。"""
    city = _text(offer, "city")
    cities = (rules.data.get("city_index") or {}).get("cities", {})
    cfg = cities.get(city) if city else None
    return (cfg or {}), cfg is not None


def _social_base(offer: OfferInput, city: dict) -> float | None:
    """社保缴费基数：按工资 / 最低基数 / 自定义 / 不缴纳。"""
    stype = _text(offer, "social_security_type")
    if stype == "none":
        return None
    bounds = city.get("base_bounds", {})
    lo, hi = float(bounds.get("min", 0.0)), float(bounds.get("max", 1e12))
    if stype == "minimum":
        return lo
    if stype == "custom":
        base = _num(offer, "social_security_base")
        return None if base is None else _clamp(base, lo, hi)
    base = _num(offer, "monthly_base")
    return None if base is None else _clamp(base, lo, hi)


def _hf_base(offer: OfferInput, city: dict) -> float | None:
    ftype = _text(offer, "housing_fund_base_type")
    if ftype == "none":
        return None
    bounds = city.get("hf_bounds", {})
    lo, hi = float(bounds.get("min", 0.0)), float(bounds.get("max", 1e12))
    if ftype == "minimum":
        return lo
    if ftype == "custom":
        base = _num(offer, "housing_fund_base")
        return None if base is None else _clamp(base, lo, hi)
    base = _num(offer, "monthly_base")
    return None if base is None else _clamp(base, lo, hi)


@dataclass(frozen=True)
class OfferContext:
    """单 Offer 的共享中间量（五险一金、城市配置、福利折现）。"""
    city: dict
    city_ok: bool          # 城市已填且在 universe 内
    si_pending: bool       # 用户要求缴社保/公积金但城市参数缺失 → 薪资模块待补充
    si_base: float | None
    hf_base: float | None
    insurance: InsuranceModule
    welfare_annual: float | None
    hf_personal_monthly: float
    hf_employer_monthly: float


def _insurance_module(offer: OfferInput, rules: RuleSet, city: dict,
                      city_ok: bool) -> InsuranceModule:
    si_base = _social_base(offer, city) if city_ok else None
    hf_base = _hf_base(offer, city) if city_ok else None
    rates = city.get("social_insurance", {})
    personal_rates = rates.get("personal", {})
    employer_rates = rates.get("employer", {})

    items: list[InsuranceItemRow] = []
    personal_total = employer_total = 0.0

    if si_base is not None:
        for key, label in (("medical", "医疗保险"), ("pension", "养老保险"),
                           ("unemployment", "失业保险")):
            p = si_base * float(personal_rates.get(key, 0.0))
            e = si_base * float(employer_rates.get(key, 0.0))
            items.append(InsuranceItemRow(item=label, personal=round(p, 2), employer=round(e, 2)))
            personal_total += p
            employer_total += e
        for key, label in (("maternity", "生育保险"), ("injury", "工伤保险")):
            e = si_base * float(employer_rates.get(key, 0.0))
            items.append(InsuranceItemRow(item=label, personal=0.0, employer=round(e, 2)))
            employer_total += e
    else:
        for _key, label in (("medical", "医疗保险"), ("pension", "养老保险"),
                            ("unemployment", "失业保险"), ("maternity", "生育保险"),
                            ("injury", "工伤保险")):
            items.append(InsuranceItemRow(item=label, personal=0.0, employer=0.0))

    hf_personal = hf_employer = 0.0
    if hf_base is not None:
        # 费率缺失的兜底口径（前端已不再代填默认值，留空 = 不提交）：
        # 个人比例按 fields.yaml default_value（8%，法规区间 5%-12% 的保守中位，
        # 民企主流 5%-8%，UI 占位符同源提示）估算；
        # 单位比例无独立默认，UI 由个人比例推导，此处沿用个人比例（最常见同比例口径）。
        # 曾按 0 费率静默计算：低估公积金、抬高税后，与「缺失不静默算错」矛盾。
        er_p = _num(offer, "housing_fund_employee_rate")
        if er_p is None:
            dv = (rules.fields.get("housing_fund_employee_rate") or {}).get("default_value")
            er_p = float(dv) if isinstance(dv, (int, float)) and not isinstance(dv, bool) else 0.0
        er_e = _num(offer, "housing_fund_employer_rate")
        if er_e is None:
            er_e = er_p
        hf_personal = hf_base * er_p / 100.0
        hf_employer = hf_base * er_e / 100.0
    items.append(InsuranceItemRow(item="住房公积金", personal=round(hf_personal, 2),
                                  employer=round(hf_employer, 2)))

    if si_base is None and hf_base is None:
        return InsuranceModule(si_base=None, hf_base=None, items=items,
                               personal_monthly=None, employer_monthly=None,
                               total_monthly=None, score=None, grade="待补充")

    return InsuranceModule(
        si_base=round(si_base, 2) if si_base is not None else None,
        hf_base=round(hf_base, 2) if hf_base is not None else None,
        items=items,
        personal_monthly=round(personal_total + hf_personal, 2),
        employer_monthly=round(employer_total + hf_employer, 2),
        total_monthly=round(personal_total + employer_total + hf_personal + hf_employer, 2),
    )


def _welfare_annual(offer: OfferInput, rules: RuleSet) -> float | None:
    """餐食与住宿的年度替代成本；现金补贴在工资中计税。"""
    w = rules.report.get("welfare", {})
    meal_map = w.get("meal_monthly", {})
    meal = float(meal_map.get(_text(offer, "meal_plan") or "", 0.0) or 0.0)
    dorm = float(w.get("dorm_monthly", 0.0)) if _text(offer, "housing_support") == "dorm" else 0.0
    monthly = meal + dorm
    if monthly <= 0:
        return None
    return round(monthly * 12.0, 2)


def _compliance_alert(offer: OfferInput, ctx: OfferContext) -> bool:
    """社保/公积金「按最低基数/不缴纳」的合规提示标记（只提示，不参与评分）。

    实际工资高于当地下限仍按最低基数申报属违规少缴；公积金缴存为法定义务，
    「按最低基数」对两类缴纳同样要查（社保比社保下限、公积金比公积金下限）。
    城市参数可用且月薪 ≤ 对应基数下限时按最低缴纳合法，不提示；城市参数
    缺失或月薪未知时无法排除违规，按「可能」提示。"""

    def _below_floor(ftype: str, bounds_key: str) -> bool:
        if ftype == "none":
            return True
        if ftype == "minimum":
            base = _num(offer, "monthly_base")
            lo = float((ctx.city.get(bounds_key) or {}).get("min", 0.0))
            if not (lo > 0 and ctx.city_ok and base is not None and base <= lo):
                return True
        return False

    return (_below_floor(_text(offer, "social_security_type"), "base_bounds")
            or _below_floor(_text(offer, "housing_fund_base_type"), "hf_bounds"))


def _offer_context(offer: OfferInput, rules: RuleSet,
                   city: dict | None = None, city_ok: bool | None = None) -> OfferContext:
    """city/city_ok 可由调用方传入：同一 Offer 的评分/现金参考/展示三个变体
    城市完全相同（城市字段不参与变体改写），共享一次查询避免重复解析。"""
    if city is None:
        city, city_ok = _city_cfg(rules, offer)
    insurance = _insurance_module(offer, rules, city, city_ok)
    hf = next((i for i in insurance.items if i.item == "住房公积金"), None)
    # 用户要求缴社保/公积金，但城市参数不可用 → 薪资模块无法扣个人五险一金，整体待补充；
    # 双双选择「不缴纳」是显式口径，不算缺失（个人五险一金按 0 计税）。
    opted_out = (_text(offer, "social_security_type") == "none"
                 and _text(offer, "housing_fund_base_type") == "none")
    # 自定义基数模式但基数未填：曾静默按「不缴纳」计算（个税虚高无标记）——
    # 与城市参数缺失同样按待补充处理。社保与公积金各自的 custom 模式都要查：
    # 公积金漏查会少扣个人缴存（个税虚高）且 hf_annual 被按 0 低估。
    si_custom_missing = (_text(offer, "social_security_type") == "custom"
                         and _num(offer, "social_security_base") is None)
    hf_custom_missing = (_text(offer, "housing_fund_base_type") == "custom"
                         and _num(offer, "housing_fund_base") is None)
    return OfferContext(
        city=city,
        city_ok=city_ok,
        si_pending=(not city_ok and not opted_out) or si_custom_missing or hf_custom_missing,
        si_base=insurance.si_base,
        hf_base=insurance.hf_base,
        insurance=insurance,
        welfare_annual=_welfare_annual(offer, rules),
        hf_personal_monthly=hf.personal if hf else 0.0,
        hf_employer_monthly=hf.employer if hf else 0.0,
    )


# ── 税收计算 ────────────────────────────────────────────────────

def _cum_tax(cum_taxable: float, brackets: list[dict]) -> float:
    for band in brackets:
        upper = band.get("upper")
        if upper is None or cum_taxable <= float(upper):
            return max(0.0, cum_taxable * float(band["rate"]) - float(band["quick"]))
    return 0.0


def _oneoff_tax_one(amount: float, brackets: list[dict]) -> float:
    """单笔一次性收入单独计税：本笔 ÷12 查月度档表，税 = 本笔 × 税率 − 速算。"""
    for band in brackets:
        upper = band.get("upper")
        if upper is None or amount / 12.0 <= float(upper):
            return max(0.0, amount * float(band["rate"]) - float(band["quick"]))
    return 0.0


def _monthly_rows(base: float, personal_deduction: float, monthly_deduction: float,
                  brackets: list[dict]) -> tuple[list[MonthSalaryRow], float]:
    """累计预扣法 12 个月明细；到手 = 税前 − 个税 − 个人五险一金。

    累计应纳税所得额跨月结转、不做逐月截断（负余额由后续月份吸收），
    与年度择优公式 12×(月薪−月扣除) 共用同一累计语义；税额非负由
    _cum_tax 的 max(0,·) 与月税增量兜底。月薪恒定时与逐月截断取值一致。

    返回 (rows, 全年个税)。"""
    rows: list[MonthSalaryRow] = []
    cum_taxable = 0.0
    cum_tax = 0.0
    for m in range(1, 13):
        cum_taxable += base - monthly_deduction
        tax_cum = _cum_tax(cum_taxable, brackets)
        tax_m = max(0.0, tax_cum - cum_tax)
        cum_tax = tax_cum
        rows.append(MonthSalaryRow(
            month=m, tax_pre=round(base, 2), tax=round(tax_m, 2),
            after_tax=round(base - personal_deduction - tax_m, 2),
        ))
    return rows, cum_tax


def _salary_module(offer: OfferInput, rules: RuleSet, ctx: OfferContext) -> SalaryModule:
    tax_cfg = rules.report.get("tax", {})
    base = _num(offer, "monthly_base")
    months = _num(offer, "guaranteed_salary_months")
    # 城市参数缺失但用户要求缴社保/公积金：个人五险一金无法确定，个税失真 → 整体待补充。
    # base/months 为 0 时社保基数会被城市下限托底，到手 = 工资 − 五险一金为负、
    # 月供收入比转负反而命中最优档——0 不是可计算口径，与缺失同样按待补充处理。
    if not base or not months or ctx.si_pending:
        return SalaryModule(welfare_annual=ctx.welfare_annual)

    special = dict(rules.report.get("special_deduction_monthly", {}))
    chosen = _fact(offer, "special_additional_deductions")
    # 住房租金扣除按城市分档（国发〔2018〕41号：直辖市/省会/计划单列市 1500、
    # 市辖区户籍人口超 100 万 1100、其余 800），档值在 city_index 每城
    # rent_deduction_monthly；universe 内城市由启动校验保证键存在，
    # 城市不在 universe 时保留 report.yaml 兜底值（此时薪资本就走待补充）。
    if "rent" in special:
        rent = ctx.city.get("rent_deduction_monthly")
        if rent is not None:
            special["rent"] = float(rent)
    chosen_keys = list(dict.fromkeys(
        k for k in (chosen or []) if isinstance(k, str)
    ))
    # 国发〔2018〕41号：住房贷款利息与住房租金扣除互斥，只能二选一。同时
    # 勾选时按对纳税人有利的口径保留扣除额较高的一项（与一次性计税同一
    # 「择优」原则）；写入校验已拒绝重复项，这里再去重一次兜住历史数据。
    if "rent" in chosen_keys and "mortgage_interest" in chosen_keys:
        drop = ("rent" if float(special.get("rent", 0.0))
                < float(special.get("mortgage_interest", 0.0))
                else "mortgage_interest")
        chosen_keys = [k for k in chosen_keys if k != drop]
    special_monthly = sum(float(special.get(k, 0.0)) for k in chosen_keys)
    standard = float(tax_cfg.get("standard_deduction_monthly", 5000))
    # 月薪按 guarantee months 摊入 12 个月（13/15/16 薪 → 月均税前）
    monthly_pre = base * months / 12.0 + (_num(offer, "monthly_subsidies") or 0.0)
    personal_si = ctx.insurance.personal_monthly or 0.0
    monthly_deduction = personal_si + standard + special_monthly
    rows, annual_tax = _monthly_rows(monthly_pre, personal_si, monthly_deduction,
                                     tax_cfg.get("cumulative_brackets", []))
    annual_after = sum(r.after_tax for r in rows)

    # 标准年度独立计算。入职现金按增加后的年度总税差分配，不改变标准年度奖金。
    method = _text(offer, "annual_bonus_method")
    value = _num(offer, "annual_bonus_value")
    amt = _num(offer, "annual_bonus_months")
    bonus = (value if method == "amount" else base * amt
             if method == "multiple" and amt is not None else 0.0 if method == "none" else None)
    bonus_gross = bonus or 0.0
    brackets = tax_cfg.get("cumulative_brackets", [])
    bonus_brackets = tax_cfg.get("bonus_monthly_brackets", [])
    # 保留全年扣除余额，低收入时由奖金/入职收入使用，不能提前截断为 0。
    # 与 _monthly_rows 同一累计口径：taxable 恰等于 12 个月的累计应纳税所得额。
    taxable = 12.0 * (monthly_pre - monthly_deduction)

    def annual_total_tax(entry: float) -> tuple[float, str]:
        merged = _cum_tax(taxable + bonus_gross + entry, brackets)
        if bonus_gross <= 0:
            return merged, "并入综合所得"
        separate = _cum_tax(taxable + entry, brackets) + _oneoff_tax_one(bonus_gross, bonus_brackets)
        return (separate, "奖金单独计税") if separate < merged else (merged, "并入综合所得")

    regular_tax, tax_method = annual_total_tax(0.0)
    bonus_after = round(bonus_gross - (regular_tax - annual_tax), 2) if bonus is not None else None
    signing = _num(offer, "signing_bonus")
    entry_tax, _ = annual_total_tax(signing or 0.0)
    signing_after = round(signing - (entry_tax - regular_tax), 2) if signing is not None else None
    annual_cash = round(annual_after + (bonus_after or 0.0), 2)
    hf_personal = round(ctx.hf_personal_monthly * 12, 2)
    hf_employer = round(ctx.hf_employer_monthly * 12, 2)
    hf_annual = hf_personal + hf_employer
    in_kind = ctx.welfare_annual or 0.0
    benefits = round(hf_annual + in_kind, 2)
    recurring_total = round(annual_cash + benefits, 2)
    income = IncomeBreakdown(
        entry_gross=signing, entry_net=signing_after,
        guaranteed_gross=round(monthly_pre * 12, 2), guaranteed_net=round(annual_after, 2),
        bonus_gross=bonus, bonus_net=bonus_after,
        cash_subsidies_gross=round((_num(offer, "monthly_subsidies") or 0.0) * 12, 2),
        annual_cash_gross=round(monthly_pre * 12 + bonus_gross, 2), annual_cash_net=annual_cash,
        hf_personal=hf_personal, hf_employer=hf_employer, in_kind=in_kind,
        annual_benefits=benefits, recurring_total=recurring_total,
        assumptions=["固定薪数与现金补贴按完整年度计算；现金补贴按工资薪金计税",
                     "年终奖按填写值估算，不视为保证收入；未填写时暂按 0 计算",
                     "个人公积金已从现金工资扣除，列入福利仅表示账户积累",
                     "餐食住宿为节省支出的参考估值，不代表现金到账"],
    )
    score = _rint(_band_min(recurring_total, rules.report.get(
        "salary_score_bands", [{"min": 0, "score": 25}])))
    return SalaryModule(
        income=income, monthly_rows=rows,
        monthly_after_tax_avg=round(annual_after / 12.0, 2),
        annual_after_tax=round(annual_after, 2), annual_bonus_after_tax=bonus_after,
        bonus_tax_method=tax_method if bonus_gross else None,
        signing_bonus_after_tax=signing_after, hf_annual=hf_annual,
        annual_tax=round(regular_tax, 2), welfare_annual=in_kind,
        annual_with_welfare=recurring_total, score=score, grade=_grade(rules, "salary", score),
    )


# ── 买房模块 ────────────────────────────────────────────────────

def _housing_module(
    offer: OfferInput, rules: RuleSet, ctx: OfferContext,
    monthly_after_tax: float | None, annual_cash: float | None,
    buy_intent: str | None = None,
) -> HousingModule:
    """buy_intent = 用户级购房意向（preferences 问卷）：「不考虑」时模块
    数值照算（参考），但 score=None、grade=不适用，钱分在其余模块重归一。"""
    h = ctx.city.get("housing", {})
    price = float(h.get("price_per_sqm", 0.0))
    area = float(h.get("typical_area_sqm", 80.0))
    house_total = down = payment = None
    dp_years = ratio = None
    if price > 0:
        house_total = price * area
        down = house_total * float(h.get("down_payment_ratio", 0.30))
        loan = house_total - down
        r = float(h.get("loan_annual_rate", 0.031)) / 12.0
        n = int(float(h.get("loan_years", 30)) * 12)
        if loan > 0 and r > 0 and n > 0:
            payment = loan * r * (1 + r) ** n / ((1 + r) ** n - 1)
        # 参考储蓄率：到手现金中的一定比例可用于攒首付（report.yaml housing 节）。
        # annual_cash 为经常性现金流（不含签字费一次性收入），避免高估 30 年储蓄能力
        saving_rate = float(rules.report.get("housing", {}).get("down_payment_saving_rate", 0.5))
        if annual_cash is not None and annual_cash > 0:
            dp_years = round(down / (annual_cash * saving_rate), 1)
        # 到手 ≤ 0（工资不抵个人五险一金，合法输入可构造）时比例无意义：
        # 曾算出负 ratio 命中最优档 90 分——改为不算比例，模块按待补充处理。
        if payment is not None and monthly_after_tax is not None and monthly_after_tax > 0:
            ratio = round(payment / monthly_after_tax, 4)

    score = None
    if ratio is not None:
        raw = _band_max(ratio, rules.report.get(
            "housing_payment_ratio_bands", [{"max": None, "score": 25}]))
        if dp_years is not None:
            raw += _band_max(dp_years, rules.report.get(
                "housing_tenure_adjust", [{"max_years": None, "score": 0}]),
                key="max_years")
        score = _rint(_clamp(raw))
    intent_excluded = buy_intent == "not_consider"
    if intent_excluded:
        score = None
    return HousingModule(
        house_total=round(house_total, 2) if house_total is not None else None,
        down_payment=round(down, 2) if down is not None else None,
        down_payment_years=dp_years,
        monthly_payment=round(payment, 2) if payment is not None else None,
        payment_income_ratio=ratio,
        welfare_annual=ctx.welfare_annual,
        signing_bonus=_num(offer, "signing_bonus"),
        score=score,
        grade="不适用" if intent_excluded else _grade(rules, "housing", score),
    )

