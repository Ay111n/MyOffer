"""启动不变量校验。

validate_rules() 返回违规列表；loader 在加载后立即校验，
任何违规都让应用拒绝启动（fail-fast），与规则配置策略一致。
city_data_warnings() 返回非阻断的数据新旧度警告（loader 记日志）。

v0.7：校验六分区问题目录、报告引擎配置（维度/权重/税表/枚举映射
与字段选项的一致性）以及城市引擎数据。
"""
from __future__ import annotations

import re
from datetime import date

from app.rules_runtime.models import RuleSet

CORE_FIELDS = {"city", "monthly_base", "guaranteed_salary_months", "business_level",
               "entry_scope", "weekly_work_hours", "work_days_per_week"}

# 每个支持城市的报告引擎必需配置键（data/city_index.yaml cities 条目）。
# as_of：数据所属年月（YYYY-MM），缺失或格式非法即启动失败（数据可溯源是硬约束）。
# tier：城市线级标签（2025 第一财经榜单口径），/meta 下发供前端分组。
# rent_deduction_monthly：住房租金专项附加扣除档值（国发〔2018〕41号三档）。
REQUIRED_CITY_CONFIG_KEYS = {"tier_score", "as_of", "social_insurance", "base_bounds", "hf_bounds", "housing", "living", "tier", "rent_deduction_monthly"}

# 城市线级标签全集（city_index.yaml tier 键；/meta 原样下发）。
_CITY_TIER_LABELS = {"一线", "新一线", "二线", "三线", "四线", "五线"}

# 住房租金专项附加扣除月档值（国发〔2018〕41号）。
_RENT_DEDUCTION_TIERS = {800.0, 1100.0, 1500.0}

# 引擎实际消费的险种费率键（report.py _insurance_module）：
# personal 只读三险（医疗/养老/失业），employer 五险全读。
_REQUIRED_SI_RATE_KEYS = {
    "personal": {"medical", "pension", "unemployment"},
    "employer": {"medical", "pension", "unemployment", "maternity", "injury"},
}

# as_of 合法格式：YYYY-MM
_AS_OF_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")

# 数据新旧度警告阈值（月）：超过即提示复核，不阻断启动。
# 缴费年度数据每年 7 月前后更新，14 个月 ≈ 新年度公布后仍留 1-2 个月缓冲。
CITY_DATA_STALE_MONTHS = 14

# report.yaml 中映射到枚举字段的配置节：映射按字段名分键，
# 每个字段的映射必须覆盖该字段的全部选项（含 unclear），防止死档位。
ENUM_MAP_BINDINGS: dict[str, list[str]] = {
    "development.maps": [
        "business_level", "business_growth_expectation", "boss_resource_ability",
        "boss_ability", "boss_attitude", "communication_style",
    ],
    "stability.maps": ["kpi_pressure"],
    "health.maps": ["weekend_pattern", "travel_frequency", "expected_mental_state"],
}


def _field_option_values(spec: dict) -> set:
    return {o["value"] for o in spec.get("options", [])}


def _node(root: dict, dotted: str) -> dict:
    node: object = root
    for part in dotted.split("."):
        if not isinstance(node, dict):
            return {}
        node = node.get(part, {})
    return node if isinstance(node, dict) else {}


def _score_of(band: dict, key: str) -> float:
    return float(band[key])


def _check_min_bands(bands: list, name: str, issues: list[str], *,
                     score_key: str | None = "score") -> None:
    """_band_min 类分档表（引擎按 min 降序首中）：min 严格降序、末档 min=0、
    score 随 min 递减严格下降（更高门槛必须对应更高分）；
    score_key=None 时只查 min 序（如 grades 的 label 档）。"""
    prev_min: float | None = None
    prev_score: float | None = None
    for i, band in enumerate(bands):
        try:
            mn = float(band["min"])
        except (KeyError, TypeError, ValueError):
            issues.append(f"report.yaml {name}: band {i} missing/unparsable min")
            return
        if prev_min is not None and mn >= prev_min:
            issues.append(f"report.yaml {name}: min must be strictly descending at {mn}")
        if score_key is not None:
            try:
                sc = float(band[score_key])
            except (KeyError, TypeError, ValueError):
                issues.append(f"report.yaml {name}: band {i} missing/unparsable {score_key}")
                return
            if prev_score is not None and sc >= prev_score:
                issues.append(f"report.yaml {name}: {score_key} must be strictly descending at {sc}")
            prev_score = sc
        prev_min = mn
    if bands and float(bands[-1]["min"]) != 0.0:
        issues.append(f"report.yaml {name}: last band must have min: 0")


def _check_max_bands(bands: list, name: str, issues: list[str], *,
                     key: str, score_key: str | None = None) -> None:
    """_band_max 类插值分档表：max 严格升序；末档允许有限数值封顶
    （插值口径要求有限端点，避免 ±∞ 悬崖），max=null 仅可作为末档兜底；
    提供 score_key 时要求 score 随档位严格下降（值越大分越低）。"""
    prev: float | None = None
    prev_score: float | None = None
    for i, band in enumerate(bands):
        upper = band.get(key)
        if upper is None:
            if i != len(bands) - 1:
                issues.append(f"report.yaml {name}: only the last band may have {key}: null")
            continue
        try:
            u = float(upper)
        except (TypeError, ValueError):
            issues.append(f"report.yaml {name}: band {i} unparsable {key}")
            return
        if prev is not None and u <= prev:
            issues.append(f"report.yaml {name}: {key} must be strictly ascending at {u}")
        if score_key is not None:
            try:
                sc = float(band[score_key])
            except (KeyError, TypeError, ValueError):
                issues.append(f"report.yaml {name}: band {i} missing/unparsable {score_key}")
                return
            if prev_score is not None and sc >= prev_score:
                issues.append(f"report.yaml {name}: {score_key} must be strictly descending at {sc}")
            prev_score = sc
        prev = u
    if not bands:
        issues.append(f"report.yaml {name}: empty bands")


def _check_numeric_band_scores(bands: list, name: str, issues: list[str], *,
                               lo: float = 0.0, hi: float = 100.0) -> None:
    """数值型档位分必须落在 [lo, hi]（模块分/扣分点的取值域）。"""
    for i, band in enumerate(bands):
        try:
            sc = float(band["score"])
        except (KeyError, TypeError, ValueError):
            issues.append(f"report.yaml {name}: band {i} missing/unparsable score")
            return
        if not lo <= sc <= hi:
            issues.append(f"report.yaml {name}: score {sc} outside [{lo}, {hi}]")


def _map_scores(mapping: dict, name: str, issues: list[str], *,
                lo: float = 0.0, hi: float = 100.0) -> None:
    for value_key, score in mapping.items():
        try:
            sc = float(score)
        except (TypeError, ValueError):
            issues.append(f"report.yaml {name}.{value_key}: unparsable score {score!r}")
            continue
        if not lo <= sc <= hi:
            issues.append(f"report.yaml {name}.{value_key}: score {sc} outside [{lo}, {hi}]")


def _try_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def validate_rules(rules: RuleSet) -> list[str]:
    v: list[str] = []
    field_keys = set(rules.fields) - {"meta"}
    questions: dict = rules.questions.get("questions", {})
    sources: dict = rules.reliability.get("sources", {})
    areas: dict = rules.question_areas()
    area_order: list = rules.question_area_order()
    question_order: list = rules.question_order()
    report = rules.report

    # ── 1. 问题目录与字段覆盖 ────────────────────────────────
    if not area_order:
        v.append("questions.yaml meta: missing area_order")
    if set(area_order) != set(areas):
        v.append(f"area_order {sorted(set(area_order) ^ set(areas))} disagrees with areas")
    for ak, a in areas.items():
        if a.get("round") not in (1, 2):
            v.append(f"area {ak}: round must be 1 or 2")
        if not a.get("label"):
            v.append(f"area {ak}: missing label")

    covered_fields: set[str] = set()
    for qk, q in questions.items():
        missing_out = set(q.get("outputs", [])) - field_keys
        if missing_out:
            v.append(f"question {qk}: outputs not in registry: {sorted(missing_out)}")
        if q.get("comparison_mode") == "per_session" and q.get("outputs"):
            # per_session 答案没有 offer 归属，而事实表 offer_id 非空：
            # 这种组合会在首次作答时 IntegrityError → 500，启动期直接拒绝
            v.append(f"question {qk}: per_session question must not declare outputs")
        missing_pre = set(q.get("prefill_from", [])) - field_keys
        if missing_pre:
            v.append(f"question {qk}: prefill_from not in registry: {sorted(missing_pre)}")
        if q.get("options_from"):
            spec = rules.fields.get(q["options_from"])
            if spec is None:
                v.append(f"question {qk}: options_from '{q['options_from']}' not in registry")
            elif spec.get("value_type") != "enum":
                v.append(f"question {qk}: options_from '{q['options_from']}' is not enum")
        section = q.get("section")
        if section not in areas:
            v.append(f"question {qk}: section '{section}' not in areas")
        for rs in q.get("recommended_sources", []):
            if rs not in sources:
                v.append(f"question {qk}: recommended_sources entry '{rs}' not in reliability.sources")
        covered_fields |= set(q.get("outputs", []))

    if set(question_order) != set(questions):
        v.append(f"question_order {sorted(set(question_order) ^ set(questions))} disagrees with questions")
    if len(question_order) != len(set(question_order)):
        v.append("question_order contains duplicates")

    unreachable_core = CORE_FIELDS - covered_fields
    if unreachable_core:
        v.append(f"core fields not collected by any question: {sorted(unreachable_core)}")

    # ── 2. reliability / 来源表 ──────────────────────────────
    for src, score in sources.items():
        if not 0.0 <= float(score) <= 1.0:
            v.append(f"reliability source {src}: score {score} outside [0,1]")

    categories = set(rules.fields.get("meta", {}).get("evidence_categories", []))
    if not categories:
        v.append("fields.yaml meta: missing evidence_categories list")
    applicable: dict[str, list[str]] = rules.fields.get("meta", {}).get("applicable_sources", {})
    field_categories: dict[str, str] = {}
    for fk, spec in rules.fields.items():
        if fk == "meta":
            continue
        cat = spec.get("evidence_category")
        if cat is None:
            v.append(f"field {fk}: missing evidence_category")
        elif cat not in categories:
            v.append(f"field {fk}: evidence_category '{cat}' not in meta.evidence_categories")
        else:
            field_categories[fk] = cat

    for cat, src_list in applicable.items():
        if cat not in categories:
            v.append(f"fields.yaml meta.applicable_sources: category '{cat}' not in meta.evidence_categories")
        for src in src_list:
            if src not in sources:
                v.append(f"fields.yaml meta.applicable_sources.{cat}: source '{src}' not in reliability.sources")

    applicability = rules.reliability.get("field_applicability", {})
    for cat, table in applicability.items():
        if cat not in categories:
            v.append(f"reliability field_applicability: category '{cat}' not in meta.evidence_categories")
        elif cat not in field_categories.values():
            v.append(f"reliability field_applicability: category '{cat}' not used by any field")
        for src, appl in table.items():
            if src not in sources:
                v.append(f"reliability field_applicability.{cat}.{src}: source '{src}' not in sources table")
            elif not 0.0 < float(appl) <= 1.0:
                v.append(f"reliability field_applicability.{cat}.{src}: {appl} outside (0,1]")
            elif src not in applicable.get(cat, []):
                v.append(
                    f"reliability field_applicability.{cat}.{src}: not in meta.applicable_sources.{cat} "
                    f"(系数对 UI 不可选的来源无意义)"
                )

    # ── 3. core 字段声明 ─────────────────────────────────────
    for key in CORE_FIELDS:
        spec = rules.fields.get(key)
        if spec is None or spec.get("required_level") != "core":
            v.append(f"core field '{key}' missing or not required_level=core")

    # ── 4. 报告引擎配置（report.yaml）────────────────────────
    dims = report.get("decision_dimensions", {})
    expected_dims = {"economic", "growth", "experience"}
    if set(dims) != expected_dims:
        v.append(f"report.yaml: decision_dimensions keys {sorted(dims)} != {sorted(expected_dims)}")
    for dk, d in dims.items():
        if not d.get("label"):
            v.append(f"report.yaml decision_dimensions.{dk}: missing label")
        if not d.get("modules"):
            v.append(f"report.yaml decision_dimensions.{dk}: missing modules")

    scoring = report.get("three_dimension_scoring", {})
    if set(scoring) != expected_dims:
        v.append("report.yaml: three_dimension_scoring must define economic/growth/experience")
    else:
        for kind in ("usual_weights", "buyer_weights"):
            weights = scoring["economic"].get(kind, {})
            expected = {"cash", "entry", "probation", "purchasing", "benefits"} | ({"housing"} if kind == "buyer_weights" else set())
            if set(weights) != expected or abs(sum(weights.values()) - 1) > 1e-9:
                v.append(f"report.yaml three_dimension_scoring.economic.{kind}: invalid weights")
        growth = scoring["growth"]
        growth_weights = growth.get("category_weights", {})
        if set(growth_weights) != {"opportunity", "responsibility", "skills", "cultivation", "options"} or abs(sum(growth_weights.values()) - 1) > 1e-9:
            v.append("report.yaml three_dimension_scoring.growth.category_weights: invalid weights")
        for key in ("business_level", "entry_scope", "mentorship", "feedback_cadence"):
            if set(growth.get(key, {})) != _field_option_values(rules.fields.get(key, {})):
                v.append(f"report.yaml three_dimension_scoring.growth.{key}: options mismatch")
        experience_bands = scoring["experience"].get("occupied_hours_bands", [])
        if [band.get("hours") for band in experience_bands] != [40, 45, 50, 55, 60, 70, 80]:
            v.append("report.yaml three_dimension_scoring.experience: invalid hour anchors")
        category_weights = scoring["experience"].get("category_weights", {})
        if set(category_weights) != {"time", "rest", "boundary", "daily"} or abs(sum(category_weights.values()) - 1) > 1e-9:
            v.append("report.yaml three_dimension_scoring.experience: invalid category weights")

    money_w = report.get("money_module_weights", {})
    salary_modules = set(dims.get("economic", {}).get("modules", []))
    if set(money_w) != salary_modules:
        v.append(f"report.yaml: money_module_weights keys {sorted(money_w)} != compensation modules {sorted(salary_modules)}")
    elif abs(sum(money_w.values()) - 1.0) > 1e-9:
        v.append(f"report.yaml: money_module_weights sum to {sum(money_w.values())}, expected 1.0")

    tax = report.get("tax", {})
    for table_key in ("cumulative_brackets", "bonus_monthly_brackets"):
        brackets = tax.get(table_key, [])
        if not brackets:
            v.append(f"report.yaml tax.{table_key}: missing brackets")
        prev: float | None = None
        for b in brackets:
            rate = _try_float(b.get("rate"))
            if rate is None or rate <= 0 or rate > 1:
                v.append(f"report.yaml tax.{table_key}: invalid rate {b.get('rate')!r}")
            upper = b.get("upper")
            if upper is not None:
                u = _try_float(upper)
                if u is None:
                    v.append(f"report.yaml tax.{table_key}: unparsable upper {upper!r}")
                elif prev is not None and u <= prev:
                    v.append(f"report.yaml tax.{table_key}: upper bounds not ascending at {u}")
                else:
                    prev = u
        if brackets and brackets[-1].get("upper") is not None:
            v.append(f"report.yaml tax.{table_key}: last bracket must have upper: null")

    # 政策时效登记：日期必须机器可读且 review_after ≤ expires_on，
    # 否则 policy_expiry_warnings 会静默跳过、注释里的到期日等于没人看。
    expiries = report.get("policy_expiries", {})
    if not isinstance(expiries, dict):
        v.append("report.yaml policy_expiries: must be a mapping")
        expiries = {}
    for pk, item in expiries.items():
        if not isinstance(item, dict):
            v.append(f"report.yaml policy_expiries.{pk}: must be a mapping")
            continue
        if not str(item.get("basis", "")).strip():
            v.append(f"report.yaml policy_expiries.{pk}: missing basis（政策文号依据）")
        review = _DATE_RE.match(str(item.get("review_after", "")).strip())
        if not review:
            v.append(f"report.yaml policy_expiries.{pk}: review_after must be YYYY-MM-DD")
            continue
        rv = date(*(int(g) for g in review.groups()))
        raw_expiry = str(item.get("expires_on", "")).strip()
        if raw_expiry:
            exp = _DATE_RE.match(raw_expiry)
            if not exp:
                v.append(f"report.yaml policy_expiries.{pk}: expires_on must be YYYY-MM-DD")
            elif date(*(int(g) for g in exp.groups())) < rv:
                v.append(f"report.yaml policy_expiries.{pk}: expires_on earlier than review_after")

    special = report.get("special_deduction_monthly", {})
    special_field = _field_option_values(rules.fields.get("special_additional_deductions", {}))
    if special_field and set(special) != special_field:
        v.append(f"report.yaml: special_deduction_monthly keys {sorted(special)} != field options {sorted(special_field)}")
    for dk, dv in special.items():
        fv = _try_float(dv)
        if fv is None or not 0.0 <= fv <= 10000.0:
            v.append(f"report.yaml: special_deduction_monthly.{dk}={dv!r} outside [0, 10000]")

    welfare = report.get("welfare", {})
    meal_field = _field_option_values(rules.fields.get("meal_plan", {}))
    meal_map = welfare.get("meal_monthly", {})
    if meal_field and set(meal_map) != meal_field:
        v.append(f"report.yaml: welfare.meal_monthly keys {sorted(meal_map)} != meal_plan options {sorted(meal_field)}")
    for mk, mv in meal_map.items():
        fv = _try_float(mv)
        if fv is None or fv < 0:
            v.append(f"report.yaml: welfare.meal_monthly.{mk}={mv!r} is negative or unparsable")
    dorm = _try_float(welfare.get("dorm_monthly", 0))
    if dorm is None or dorm < 0:
        v.append(f"report.yaml: welfare.dorm_monthly={welfare.get('dorm_monthly')!r} is negative or unparsable")

    housing_cfg = report.get("housing", {})
    if "down_payment_saving_rate" in housing_cfg:
        sr = _try_float(housing_cfg["down_payment_saving_rate"])
        if sr is None or not 0.0 < sr <= 1.0:
            v.append(f"report.yaml: housing.down_payment_saving_rate={sr} outside (0, 1]")

    living_cfg = report.get("living", {})
    if not living_cfg:
        v.append("report.yaml: missing living（模块 5 全国平均口径常量）")
    else:
        for const_key in ("national_avg_wage_month", "national_baseline_cost_month",
                          "comfort_wage_multiple"):
            val = _try_float(living_cfg.get(const_key))
            if val is None or val <= 0:
                v.append(f"report.yaml: living.{const_key}={living_cfg.get(const_key)!r} missing or non-positive")

    for key in ("salary_score_bands", "insurance_score_ratio_bands", "hourly_score_bands", "living_multiple_bands"):
        if not report.get(key):
            v.append(f"report.yaml: missing {key}")
        else:
            _check_min_bands(report[key], key, v)
    if not report.get("housing_payment_ratio_bands"):
        v.append("report.yaml: missing housing_payment_ratio_bands")
    else:
        _check_max_bands(report["housing_payment_ratio_bands"], "housing_payment_ratio_bands",
                         v, key="max", score_key="score")
    if not report.get("housing_tenure_adjust"):
        v.append("report.yaml: missing housing_tenure_adjust")
    else:
        _check_max_bands(report["housing_tenure_adjust"], "housing_tenure_adjust",
                         v, key="max_years", score_key="score")

    dev = report.get("development", {})
    if not dev.get("axes") or not dev.get("city_axis", {}).get("label"):
        v.append("report.yaml development: axes/city_axis incomplete")
    # city_axis 只声明展示 label：城市等级轴固定取 city_index 的 tier_score，
    # 未知键一律报错，防止「配置了但不生效」的死配置再次积累
    unknown_city_axis_keys = set(dev.get("city_axis", {})) - {"label"}
    if unknown_city_axis_keys:
        v.append(f"report.yaml development.city_axis: unknown keys {sorted(unknown_city_axis_keys)}"
                 "（城市等级轴固定取 city_index 的 tier_score，仅允许 label）")
    dev_labels = [str(a.get("label")) for a in dev.get("axes", []) if a.get("label")]
    if dev.get("city_axis", {}).get("label"):
        dev_labels.append(str(dev["city_axis"]["label"]))
    if len(dev_labels) != len(set(dev_labels)):
        v.append("report.yaml development: axis labels must be unique (雷达轴按 label 合并)")
    for axis in dev.get("axes", []):
        numeric = axis.get("numeric")
        if not numeric:
            continue
        try:
            lo, hi = float(numeric["min"]), float(numeric["max"])
        except (KeyError, TypeError, ValueError):
            v.append(f"report.yaml development: axis '{axis.get('field')}' numeric min/max unparsable")
            continue
        if lo >= hi:
            v.append(f"report.yaml development: axis '{axis.get('field')}' numeric min must be < max")
    for dotted, field_keys in ENUM_MAP_BINDINGS.items():
        map_root = _node(report, dotted)
        for field_key in field_keys:
            mapping = map_root.get(field_key, {})
            spec = rules.fields.get(field_key, {})
            options = _field_option_values(spec)
            if not options:
                v.append(f"report.yaml {dotted}: field '{field_key}' has no options")
            elif set(mapping) != options:
                v.append(f"report.yaml {dotted}.{field_key}: keys {sorted(mapping)} != field options {sorted(options)}")

    dev_map_fields = {a.get("field") for a in dev.get("axes", [])} - {None}
    numeric_fields = {a.get("field") for a in dev.get("axes", []) if a.get("numeric")}
    for fk in dev_map_fields - numeric_fields:
        if fk not in dev.get("maps", {}):
            v.append(f"report.yaml development.maps: missing mapping for axis field '{fk}'")

    stab = report.get("stability", {})
    if not stab.get("components"):
        v.append("report.yaml stability: missing components")
    stab_map_fields = {c.get("field") for c in stab.get("components", []) if not c.get("bands")} - {None}
    for fk in stab_map_fields:
        if fk not in stab.get("maps", {}):
            v.append(f"report.yaml stability.maps: missing mapping for component field '{fk}'")
    penalty = stab.get("outsourced_penalty")
    if penalty is not None:
        # 转换入 try：null/非数值字符串应记为校验违规（附定位），而非让校验器自身崩溃
        try:
            p = float(penalty)
        except (TypeError, ValueError):
            v.append(f"report.yaml stability: outsourced_penalty={penalty!r} is not a number")
        else:
            if not 0.0 <= p <= 100.0:
                v.append(f"report.yaml stability: outsourced_penalty={penalty} outside [0, 100]")
    for comp in stab.get("components", []):
        if comp.get("bands"):
            _check_numeric_band_scores(comp["bands"], f"stability component '{comp.get('key')}'", v)
    for fk, mapping in stab.get("maps", {}).items():
        _map_scores(mapping, f"stability.maps.{fk}", v)
    total_w = sum(float(c.get("weight", 0)) for c in stab.get("components", []))
    if stab.get("components") and abs(total_w - 1.0) > 1e-9:
        v.append(f"report.yaml stability: component weights sum to {total_w}, expected 1.0")

    health = report.get("health", {})
    if not health.get("deductions"):
        v.append("report.yaml health: missing deductions")
    health_map_fields = {d.get("source") for d in health.get("deductions", [])
                         if not d.get("bands")} - {None}
    for fk in health_map_fields:
        if fk not in health.get("maps", {}):
            v.append(f"report.yaml health.maps: missing mapping for deduction source '{fk}'")
    for item in health.get("deductions", []):
        if item.get("bands"):
            _check_numeric_band_scores(item["bands"], f"health deduction '{item.get('key')}'", v)
        # missing_score：映射项未作答时的中性扣分（填了不吃亏口径），必须在扣分值域内
        ms = item.get("missing_score")
        if ms is not None:
            try:
                ms_v = float(ms)
            except (TypeError, ValueError):
                v.append(f"report.yaml health deduction '{item.get('key')}': unparsable missing_score {ms!r}")
            else:
                if not 0.0 <= ms_v <= 100.0:
                    v.append(f"report.yaml health deduction '{item.get('key')}': missing_score {ms_v} outside [0, 100]")
    for fk, mapping in health.get("maps", {}).items():
        _map_scores(mapping, f"health.maps.{fk}", v)
    if health.get("grade_bands"):
        _check_max_bands(health["grade_bands"], "health.grade_bands", v, key="max")
        for band in health["grade_bands"]:
            if not band.get("label"):
                v.append("report.yaml health.grade_bands: band missing label")

    grades = report.get("grades", {})
    # health 等级走 health.grade_bands（损耗分越低越好，max 分档）
    for module in ("salary", "insurance", "efficiency", "housing", "living",
                   "development", "stability"):
        if module not in grades:
            v.append(f"report.yaml grades: missing module '{module}'")
            continue
        _check_min_bands(grades[module], f"grades.{module}", v, score_key=None)
        for band in grades[module]:
            if not band.get("label"):
                v.append(f"report.yaml grades.{module}: band missing label")
    if not health.get("grade_bands"):
        v.append("report.yaml health: missing grade_bands")

    # ── 5. preferences（默认权重与问卷契约）──────────────────
    default_weights = rules.default_weights()
    if set(default_weights) != set(dims):
        v.append(f"preferences.yaml: default_weights keys {sorted(default_weights)} != decision dimensions {sorted(dims)}")
    elif abs(sum(default_weights.values()) - 1.0) > 1e-9:
        v.append(f"preferences.yaml: default_weights sum to {sum(default_weights.values())}, expected 1.0")

    questionnaire = rules.preference_questionnaire()
    questionnaire_dims = questionnaire.get("dimensions") or {}
    questionnaire_questions = questionnaire.get("questions") or []
    if questionnaire.get("version") != "v2":
        v.append("preferences.yaml: questionnaire_v2.version must be 'v2'")
    if set(questionnaire_dims) != set(dims):
        v.append("preferences.yaml: questionnaire_v1 dimensions must match decision dimensions")
    if len(questionnaire_questions) != 4:
        v.append("preferences.yaml: questionnaire_v2 must contain exactly 4 questions")
    question_ids = [q.get("question_id") for q in questionnaire_questions]
    if len(question_ids) != len(set(question_ids)):
        v.append("preferences.yaml: questionnaire_v1 question IDs must be unique")
    expected_pairs = [("economic", "growth"), ("economic", "experience"),
                      ("growth", "experience")]
    pair_questions = questionnaire_questions[:3]
    actual_pairs = [
        (q.get("left_dimension"), q.get("right_dimension"))
        for q in pair_questions
    ]
    if actual_pairs != expected_pairs or any(q.get("kind") != "pairwise" for q in pair_questions):
        v.append("preferences.yaml: questionnaire_v2 first 3 questions must use the fixed pair order")
    if len(questionnaire_questions) == 4 and (
        questionnaire_questions[3].get("kind") != "single"
        or questionnaire_questions[3].get("question_id") != "buy_house_intent"
    ):
        v.append("preferences.yaml: questionnaire_v2 question 4 must be the buy_house_intent single question")
    for question in questionnaire_questions:
        options = question.get("options") or []
        values = [option.get("value") for option in options]
        if question.get("kind") == "single":
            # 情境题（购房意向）：三档固定取值，不参与权重积分
            if set(values) != {"consider", "not_consider", "undecided"} or len(values) != 3:
                v.append(
                    f"preferences.yaml: questionnaire single question {question.get('question_id')}"
                    " options must be consider/not_consider/undecided"
                )
        elif len(values) != 5 or len(values) != len(set(values)):
            v.append(
                f"preferences.yaml: questionnaire question {question.get('question_id')} must have 5 unique options"
            )

    # ── 6. 城市 universe（city_index.yaml 为唯一事实源）────────
    city_index = rules.data.get("city_index") or {}
    supported = city_index.get("supported_cities")
    if not isinstance(supported, list) or not supported:
        v.append("city_index.yaml: supported_cities must be a non-empty list")
    else:
        if len(set(supported)) != len(supported):
            v.append("city_index.yaml: supported_cities contains duplicates")
        cities = city_index.get("cities")
        if not isinstance(cities, dict):
            v.append("city_index.yaml: cities must be a mapping keyed by supported city")
        else:
            missing = sorted(set(supported) - set(cities))
            orphan = sorted(set(cities) - set(supported))
            if missing:
                v.append(f"city_index.yaml: supported cities missing engine config entries: {missing}")
            if orphan:
                v.append(f"city_index.yaml: city config entries not in supported_cities: {orphan}")
            for ck, cfg in cities.items():
                if not isinstance(cfg, dict):
                    continue
                miss_keys = REQUIRED_CITY_CONFIG_KEYS - set(cfg)
                if miss_keys:
                    v.append(
                        f"city_index.yaml: city {ck} missing required engine config keys: {sorted(miss_keys)}"
                    )
                    continue
                as_of = cfg.get("as_of")
                if not isinstance(as_of, str) or not _AS_OF_RE.match(as_of.strip()):
                    v.append(
                        f"city_index.yaml: city {ck} as_of={as_of!r} missing or malformed (expect YYYY-MM)"
                    )
                for side in ("personal", "employer"):
                    rates = (cfg.get("social_insurance") or {}).get(side, {})
                    # 引擎按险种键取费率，缺失键会被 rates.get(key, 0.0) 静默按
                    # 零费率计算——键完整性必须在此把关（当前数据齐全是数据正确，
                    # 不是机制保证）。
                    missing_rates = _REQUIRED_SI_RATE_KEYS[side] - set(rates)
                    if missing_rates:
                        v.append(
                            f"city_index.yaml: city {ck} social_insurance.{side} "
                            f"missing rate keys: {sorted(missing_rates)}"
                        )
                    for rk, rv in rates.items():
                        try:
                            rate = float(rv)
                        except (TypeError, ValueError):
                            v.append(
                                f"city_index.yaml: city {ck} social_insurance.{side}.{rk}={rv!r} is not a number"
                            )
                            continue
                        if not 0.0 < rate <= 0.3:
                            v.append(f"city_index.yaml: city {ck} social_insurance.{side}.{rk}={rv} outside (0, 0.3]")

                # 深度数值校验：配置值畸形（null/非数值）时记违规而非让校验器崩溃
                try:
                    tier = float(cfg.get("tier_score"))
                    if not 0.0 < tier <= 100.0:
                        v.append(f"city_index.yaml: city {ck} tier_score={tier} outside (0, 100]")

                    for bkey in ("base_bounds", "hf_bounds"):
                        bounds = cfg.get(bkey) or {}
                        lo, hi = float(bounds.get("min", 0.0)), float(bounds.get("max", 0.0))
                        if hi <= 0.0 or lo < 0.0 or lo > hi:
                            v.append(f"city_index.yaml: city {ck} {bkey} min/max invalid ({lo}, {hi})")

                    house = cfg.get("housing") or {}
                    if float(house.get("price_per_sqm", 0)) <= 0:
                        v.append(f"city_index.yaml: city {ck} housing.price_per_sqm must be positive")
                    if float(house.get("typical_area_sqm", 0)) <= 0:
                        v.append(f"city_index.yaml: city {ck} housing.typical_area_sqm must be positive")
                    dpr = float(house.get("down_payment_ratio", 0))
                    if not 0.0 < dpr < 1.0:
                        v.append(f"city_index.yaml: city {ck} housing.down_payment_ratio={dpr} outside (0, 1)")
                    rate = float(house.get("loan_annual_rate", 0))
                    if not 0.0 < rate <= 0.2:
                        v.append(f"city_index.yaml: city {ck} housing.loan_annual_rate={rate} outside (0, 0.2]")
                    if float(house.get("loan_years", 0)) < 1:
                        v.append(f"city_index.yaml: city {ck} housing.loan_years must be >= 1")

                    living = cfg.get("living") or {}
                    if float(living.get("baseline_cost_month", 0)) <= 0:
                        v.append(f"city_index.yaml: city {ck} living.baseline_cost_month must be positive"
                                 "（模块 5 物价系数锚点）")

                    tier_label = cfg.get("tier")
                    if tier_label not in _CITY_TIER_LABELS:
                        v.append(
                            f"city_index.yaml: city {ck} tier={tier_label!r} "
                            f"not in {sorted(_CITY_TIER_LABELS)}"
                        )
                    rent_tier = _try_float(cfg.get("rent_deduction_monthly"))
                    if rent_tier is None or rent_tier not in _RENT_DEDUCTION_TIERS:
                        v.append(
                            f"city_index.yaml: city {ck} rent_deduction_monthly="
                            f"{cfg.get('rent_deduction_monthly')!r} not in {sorted(_RENT_DEDUCTION_TIERS)}"
                        )
                except (TypeError, ValueError) as exc:
                    v.append(f"city_index.yaml: city {ck} engine config unparsable: {exc}")

    # allowed_from 白名单引用（字段）必须能解析到非空列表
    for fk, spec in rules.fields.items():
        if fk == "meta":
            continue
        ref = spec.get("allowed_from")
        if ref and not rules.reference_values(ref):
            v.append(f"field {fk}: allowed_from '{ref}' resolves to no values")

    return v


_DATE_RE = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$")


def policy_expiry_warnings(rules: RuleSet, today: date | None = None) -> list[str]:
    """政策时效警告（非阻断，loader 启动时记日志）。

    report.yaml policy_expiries 登记有失效日的政策口径（如年终奖单独计税）。
    进入 review_after 起点即提醒复核，超过 expires_on 升级为「已失效」。
    只靠 YAML 注释记日期等于过期无人知晓——此处把日期提升为机器可读配置。"""
    today = today or date.today()
    items = rules.report.get("policy_expiries") or {}
    if not isinstance(items, dict):
        return []
    warnings: list[str] = []
    for name, item in items.items():
        if not isinstance(item, dict):
            continue
        expires = _DATE_RE.match(str(item.get("expires_on", "")).strip())
        review = _DATE_RE.match(str(item.get("review_after", "")).strip())
        if not review:
            continue  # 无复核窗口配置则静默跳过（格式问题由 validate_rules 拦截）
        review_date = date(int(review.group(1)), int(review.group(2)), int(review.group(3)))
        if today < review_date:
            continue
        basis = str(item.get("basis", "")).strip() or "未注明依据"
        impact = str(item.get("impact", "")).strip()
        if expires:
            exp = date(int(expires.group(1)), int(expires.group(2)), int(expires.group(3)))
            head = ("政策已失效" if today > exp else "政策临近失效")
            tail = f"，失效日 {exp.isoformat()}"
        else:
            head, tail = "政策需复核", ""
        suffix = f"——若已失效且未更新，后果：{impact}" if impact else ""
        warnings.append(f"{name}（{basis}）{head}{tail}{suffix}")
    return warnings


def city_data_warnings(rules: RuleSet, today: date | None = None) -> list[str]:
    """城市数据新旧度警告（非阻断，loader 启动时记日志）。

    as_of 超过 CITY_DATA_STALE_MONTHS 个月的城市提示复核——通常是新缴费年度
    基数已公布而本文件未跟进。缺 as_of 或格式非法的沉默跳过（硬约束由
    validate_rules 拦截）。"""
    today = today or date.today()
    cities = (rules.data.get("city_index") or {}).get("cities") or {}
    warnings: list[str] = []
    for ck, cfg in cities.items():
        if not isinstance(cfg, dict):
            continue
        match = _AS_OF_RE.match(str(cfg.get("as_of", "")).strip())
        if not match:
            continue
        year, month = int(match.group(1)), int(match.group(2))
        age_months = (today.year - year) * 12 + (today.month - month)
        if age_months > CITY_DATA_STALE_MONTHS:
            warnings.append(
                f"城市 {ck} 参考数据截至 {year}-{month:02d}（{age_months} 个月前），"
                f"超过 {CITY_DATA_STALE_MONTHS} 个月未更新，建议复核最新缴费年度基数与房价"
            )
    return warnings
