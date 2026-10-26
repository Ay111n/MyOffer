"""启动不变量校验测试（v5 三维报告引擎规则集）。"""
from datetime import date

from app.rules_runtime import get_rules
from app.rules_runtime.validate import policy_expiry_warnings, validate_rules


def test_startup_invariants_hold():
    assert validate_rules(get_rules()) == []


def test_frozen_counts():
    rules = get_rules()
    assert len(set(rules.fields) - {"meta"}) == 101
    assert len(rules.questions["questions"]) == 4
    assert len(rules.questions["meta"]["question_order"]) == 4
    assert sum(len(q["outputs"]) for q in rules.questions["questions"].values()) == 59
    assert not {"equity_type", "equity_grant_value", "equity_vesting_years"} & set(rules.fields)
    assert set(rules.report["decision_dimensions"]) == {"economic", "growth", "experience"}


def test_core_fields_registered_and_collectable():
    rules = get_rules()
    # outputs 是「字段由哪个问题采集」的唯一事实源；fields.yaml 曾另维护一份
    # questions 标注，无消费方且必然漂移（42 处失真后已整体移除），
    # 挂接检查直接对 outputs 断言。
    collected = {
        fk
        for q in rules.questions["questions"].values()
        for fk in q.get("outputs", [])
    }
    for key in ("city", "monthly_base", "guaranteed_salary_months", "business_level", "entry_scope", "weekly_work_hours", "work_days_per_week"):
        assert rules.fields[key]["required_level"] == "core"
        # v0.6：无独立 core 表单，核心字段必须由问题节点采集
        assert rules.fields[key]["collection"] == "initial_questions"
        assert key in collected, f"{key} 未被任何问题采集"


def test_decision_dimension_labels():
    labels = {d["label"] for d in get_rules().report["decision_dimensions"].values()}
    assert labels == {"经济回报", "职业成长", "工作体验"}


def test_entrepreneurial_options_are_string_enums():
    options = get_rules().fields["entrepreneurial"]["options"]
    assert {option["value"] for option in options} == {"yes", "no"}


def test_loader_fails_fast_on_broken_rules(tmp_path, monkeypatch):
    """故意破坏薪资分档顺序 → validate_rules 必须拒绝（fail-fast）。"""
    import shutil
    from pathlib import Path

    import yaml

    from app.config import get_settings

    src = Path(get_settings().rules_dir) if Path(get_settings().rules_dir).is_absolute() else Path(__file__).resolve().parents[1] / "app" / "rules"
    broken = tmp_path / "rules"
    shutil.copytree(src, broken)
    report = yaml.safe_load((broken / "report.yaml").read_text(encoding="utf-8"))
    bands = report["salary_score_bands"]
    bands[0], bands[1] = bands[1], bands[0]  # 破坏 min 降序
    (broken / "report.yaml").write_text(yaml.safe_dump(report, allow_unicode=True), encoding="utf-8")

    import app.rules_runtime.loader as loader

    rules = loader.RuleSet.load(broken)
    violations = loader.validate_rules(rules)
    assert any("salary_score_bands" in v for v in violations)


def test_evidence_category_coverage():
    """每个字段都声明 evidence_category，且取值在 meta 白名单内。"""
    rules = get_rules()
    categories = set(rules.fields["meta"]["evidence_categories"])
    for fk, spec in rules.fields.items():
        if fk == "meta":
            continue
        assert spec.get("evidence_category") in categories, f"field {fk} missing/invalid evidence_category"


def test_fact_reliability_applies_applicability():
    """可靠度 = 来源基础分 × 字段类别适配系数；未命中稀疏表时为基础分。"""
    rules = get_rules()
    base = float(rules.sources["self_experience"])
    # contractual_fact: self_experience 有 0.6 适配系数
    assert rules.fact_reliability("city", "self_experience") == round(base * 0.6, 2)
    # work_experience: self_experience 无适配系数 → 基础分
    assert rules.fact_reliability("weekly_work_hours", "self_experience") == base


def test_applicability_table_internal_consistency():
    """稀疏适配表引用的 category/source 都存在，系数在 (0,1]。"""
    rules = get_rules()
    categories = set(rules.fields["meta"]["evidence_categories"])
    used = {spec["evidence_category"] for fk, spec in rules.fields.items() if fk != "meta"}
    for cat, table in rules.field_applicability.items():
        assert cat in categories and cat in used
        for src, appl in table.items():
            assert src in rules.sources
            assert 0.0 < float(appl) <= 1.0


# ── 规则引用完整性补强 ───────────────────────────────────────────
def _mutated_rules(mutate):
    """深拷贝当前规则集后在内存中破坏，再交给 validate_rules。"""
    import copy

    rules = copy.deepcopy(get_rules())
    mutate(rules)
    return rules


def test_validate_rejects_question_referencing_unknown_section():
    def _break(r):
        r.questions["questions"]["q_essentials"]["section"] = "not_an_area"

    violations = validate_rules(_mutated_rules(_break))
    assert any("q_essentials" in v and "not_an_area" in v for v in violations)


def test_validate_rejects_question_order_drift():
    def _break(r):
        r.questions["meta"]["question_order"].pop()

    violations = validate_rules(_mutated_rules(_break))
    assert any("question_order" in v for v in violations)


def test_validate_rejects_core_field_not_collected():
    def _break(r):
        r.questions["questions"]["q_essentials"]["outputs"] = ["annual_bonus_months"]

    violations = validate_rules(_mutated_rules(_break))
    assert any("core fields not collected" in v for v in violations)


def test_validate_rejects_default_weights_drift():
    def _break(r):
        r.preferences["default_weights"]["economic"] = 0.5

    violations = validate_rules(_mutated_rules(_break))
    assert any("default_weights" in v for v in violations)


def test_validate_rejects_tax_brackets_drift():
    def _break(r):
        r.report["tax"]["cumulative_brackets"][1]["upper"] = 20000  # 不再升序

    violations = validate_rules(_mutated_rules(_break))
    assert any("cumulative_brackets" in v for v in violations)


def test_validate_rejects_city_missing_engine_config():
    def _break(r):
        r.data["city_index"]["cities"]["成都"] = {}

    violations = validate_rules(_mutated_rules(_break))
    assert any("成都" in v and "engine config" in v for v in violations)


# ── 分档表结构校验（防手改 YAML 引入死档/倒挂）─────────────────────
def test_validate_rejects_min_band_order_drift():
    """_band_min 类分档表必须 min 严格降序（引擎按顺序首中）。"""
    def _break(r):
        bands = r.report["salary_score_bands"]
        bands[0], bands[1] = bands[1], bands[0]

    violations = validate_rules(_mutated_rules(_break))
    assert any("salary_score_bands" in v for v in violations)


def test_validate_rejects_min_band_missing_zero_floor():
    def _break(r):
        r.report["salary_score_bands"][-1]["min"] = 5

    violations = validate_rules(_mutated_rules(_break))
    assert any("salary_score_bands" in v for v in violations)


def test_validate_rejects_purchasing_city_band_order_drift():
    """购买力城市档表（max 型）max 必须严格升序、分数严格降序。"""
    def _break(r):
        bands = r.report["purchasing_city_bands"]
        bands[0], bands[1] = bands[1], bands[0]

    violations = validate_rules(_mutated_rules(_break))
    assert any("purchasing_city_bands" in v for v in violations)


def test_validate_rejects_max_band_order_drift():
    """_band_max 类分档表（月供收入比）必须 max 严格升序、末档兜底。"""
    def _break(r):
        bands = r.report["housing_payment_ratio_bands"]
        bands[0], bands[1] = bands[1], bands[0]

    violations = validate_rules(_mutated_rules(_break))
    assert any("housing_payment_ratio_bands" in v for v in violations)


def test_validate_rejects_grade_order_drift():
    def _break(r):
        r.report["grades"]["salary"][0]["min"] = 0.0

    violations = validate_rules(_mutated_rules(_break))
    assert any("grades.salary" in v for v in violations)


def test_validate_rejects_special_deduction_out_of_range():
    def _break(r):
        r.report["special_deduction_monthly"]["rent"] = 50000

    violations = validate_rules(_mutated_rules(_break))
    assert any("special_deduction_monthly" in v for v in violations)


def test_validate_rejects_negative_welfare_value():
    def _break(r):
        r.report["welfare"]["meal_monthly"]["two_meals"] = -100

    violations = validate_rules(_mutated_rules(_break))
    assert any("meal_monthly" in v for v in violations)


def test_validate_rejects_saving_rate_out_of_range():
    def _break(r):
        r.report["housing"]["down_payment_saving_rate"] = 1.5

    violations = validate_rules(_mutated_rules(_break))
    assert any("down_payment_saving_rate" in v for v in violations)


def test_validate_rejects_city_bad_housing_config():
    def _break(r):
        r.data["city_index"]["cities"]["北京"]["housing"]["down_payment_ratio"] = 1.5

    violations = validate_rules(_mutated_rules(_break))
    assert any("down_payment_ratio" in v for v in violations)


def test_validate_rejects_city_bad_tier_score():
    def _break(r):
        r.data["city_index"]["cities"]["成都"]["tier_score"] = 0

    violations = validate_rules(_mutated_rules(_break))
    assert any("tier_score" in v for v in violations)


def test_validate_rejects_city_bad_tier_label():
    """tier 线级标签（/meta city_tiers 数据源）必须在合法枚举内。"""
    def _break(r):
        r.data["city_index"]["cities"]["成都"]["tier"] = "超一线"

    violations = validate_rules(_mutated_rules(_break))
    assert any("tier=" in v and "成都" in v for v in violations)


def test_validate_rejects_city_missing_rent_deduction():
    """rent_deduction_monthly 缺失即启动失败（引擎按城市档值算租金扣除）。"""
    def _break(r):
        r.data["city_index"]["cities"]["成都"].pop("rent_deduction_monthly")

    violations = validate_rules(_mutated_rules(_break))
    assert any("rent_deduction_monthly" in v and "成都" in v for v in violations)


def test_validate_rejects_city_bad_rent_deduction():
    """租金扣除档值只允许 800/1100/1500（国发〔2018〕41号三档）。"""
    def _break(r):
        r.data["city_index"]["cities"]["成都"]["rent_deduction_monthly"] = 1000

    violations = validate_rules(_mutated_rules(_break))
    assert any("rent_deduction_monthly" in v and "成都" in v for v in violations)


# ── 城市数据溯源与新旧度 ──────────────────────────────────────────
def test_validate_rejects_city_missing_as_of():
    def _break(r):
        r.data["city_index"]["cities"]["成都"].pop("as_of")

    violations = validate_rules(_mutated_rules(_break))
    assert any("as_of" in v and "成都" in v for v in violations)


def test_validate_rejects_city_malformed_as_of():
    def _break(r):
        r.data["city_index"]["cities"]["成都"]["as_of"] = "2026年7月"

    violations = validate_rules(_mutated_rules(_break))
    assert any("as_of" in v and "成都" in v for v in violations)


def test_city_data_warnings_flag_stale_only():
    from datetime import date

    from app.rules_runtime.validate import city_data_warnings

    # 人为把某城 as_of 拨到 15 个月前 → 必然告警；刚更新过的城市不告警
    def _set_stale(r):
        r.data["city_index"]["cities"]["成都"]["as_of"] = "2025-07"

    def _set_fresh(r):
        r.data["city_index"]["cities"]["成都"]["as_of"] = "2026-07"

    stale = city_data_warnings(_mutated_rules(_set_stale), today=date(2026, 10, 1))
    assert any("成都" in w and "建议复核" in w for w in stale)
    assert not any("成都" in w for w in city_data_warnings(_mutated_rules(_set_fresh), today=date(2026, 10, 1)))


def test_per_session_question_must_not_declare_outputs():
    """per_session 答案没有 offer 归属，而事实表 offer_id 非空：这种规则组合
    会在首次作答时 IntegrityError → 500，启动校验必须拒绝（回归锁）。"""
    import copy

    rules = get_rules()
    questions = copy.deepcopy(rules.questions)
    questions["questions"]["q_fake_per_session"] = {
        "section": "basics", "comparison_mode": "per_session", "answer_type": "composite",
        "prompt": "测试", "outputs": ["city"], "answerability": "high",
        "recommended_sources": ["offer_letter"],
    }
    copied = rules.model_copy(update={"questions": questions})
    violations = validate_rules(copied)
    assert any("per_session question must not declare outputs" in v for v in violations)
    # 真实规则集不受影响
    assert validate_rules(get_rules()) == []


# ── 政策时效（policy_expiries）───────────────────────────────────
def test_policy_expiries_registered_and_machine_readable():
    """年终奖单独计税到期日原先只在 YAML 注释里，过期不会被发现。
    必须是机器可读配置，且日期合法、review_after ≤ expires_on。"""
    items = get_rules().report["policy_expiries"]
    item = items["annual_bonus_separate_tax"]
    assert item["expires_on"] == "2027-12-31"
    assert item["review_after"] == "2027-06-30"
    assert item["basis"] and item["impact"]


def test_validate_rejects_policy_expiry_date_drift():
    def _break(r):
        r.report["policy_expiries"]["annual_bonus_separate_tax"]["review_after"] = "2027/06/30"

    violations = validate_rules(_mutated_rules(_break))
    assert any("review_after must be YYYY-MM-DD" in v for v in violations)

    def _break_order(r):
        r.report["policy_expiries"]["annual_bonus_separate_tax"]["expires_on"] = "2027-01-01"

    violations = validate_rules(_mutated_rules(_break_order))
    assert any("expires_on earlier than review_after" in v for v in violations)


def test_policy_expiry_warning_fires_only_in_window():
    """窗口外静默、窗口内提示临近失效、过期后升级为已失效。"""
    rules = get_rules()
    assert policy_expiry_warnings(rules, today=date(2026, 10, 5)) == []
    upcoming = policy_expiry_warnings(rules, today=date(2027, 7, 1))
    assert any("临近失效" in w and "2027-12-31" in w for w in upcoming)
    expired = policy_expiry_warnings(rules, today=date(2028, 1, 1))
    assert any("已失效" in w for w in expired)
