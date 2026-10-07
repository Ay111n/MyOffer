from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.domain.contracts import DecisionInput, OfferInput, RawFactInput, UserPreferenceInput
from app.domain.evaluator import evaluate
from app.domain.report import _band_min, _clamp
from app.main import app
from app.rules_runtime import get_rules
from app.schemas import PreferenceAnswer
from app.services.conclusion import decision_summary
from app.services.preference_questionnaire import QuestionnaireValidationError, score_questionnaire

BASE = {"city": "北京", "monthly_base": 20000, "guaranteed_salary_months": 12,
        "business_level": "core", "entry_scope": "small_feature",
        "weekly_work_hours": 50, "work_days_per_week": 5}


def offer(order, **updates):
    values = {**BASE, **updates}
    facts = {key: RawFactInput(field_key=key, value=value, status="known", source="offer_letter")
             for key, value in values.items() if value is not None}
    return OfferInput(offer_id=uuid4(), company=f"Offer {order}", position="",
                      display_order=order, facts=facts)


def result(*offers, intent="undecided", weights=None):
    rules = get_rules()
    preferences = UserPreferenceInput(weights=weights or rules.default_weights(),
                                      buy_house_intent=intent)
    return evaluate(DecisionInput(offers=list(offers), preferences=preferences), rules)


@pytest.mark.parametrize("count", [2, 3])
def test_complete_offers_rank_and_display_ties(count):
    rows = result(*(offer(i) for i in range(1, count + 1))).offers
    assert all(row.overall_score is not None for row in rows)
    assert all(row.overall_rank == 1 for row in rows)
    assert all(set(row.dimension_scores) == {"economic", "growth", "experience"} for row in rows)


def test_missing_one_core_field_blocks_every_rank_but_keeps_partial_scores():
    rows = result(offer(1), offer(2, entry_scope=None)).offers
    assert all(row.overall_score is None and row.overall_rank is None for row in rows)
    assert rows[0].dimension_scores["economic"] is not None
    assert rows[1].dimension_scores["experience"] is not None
    assert rows[1].missing_core == ["entry_scope"]


def test_burdens_require_common_basis_but_single_offer_advantages_score():
    baseline = result(offer(1), offer(2)).offers
    partial = result(offer(1, commute_minutes=90), offer(2)).offers
    assert [row.overall_score for row in partial] == [row.overall_score for row in baseline]
    assert partial[0].known_optional["commute_minutes"] == 90
    common = result(offer(1, commute_minutes=90), offer(2, commute_minutes=10)).offers
    assert common[0].dimension_scores["experience"] < common[1].dimension_scores["experience"]
    with_subsidy = result(offer(1, monthly_subsidies=2000), offer(2)).offers
    assert with_subsidy[0].overall_score > with_subsidy[1].overall_score
    assert with_subsidy[0].key_numbers["annual_net"] == with_subsidy[0].key_numbers["scored_annual_net"]
    with_mentor = result(offer(1, mentorship="formal"), offer(2)).offers
    assert with_mentor[0].dimension_scores["growth"] > with_mentor[1].dimension_scores["growth"]


def test_city_buyer_weights_and_ranking_cash():
    a, b = offer(1), offer(2, city="上海")
    undecided = result(a, b)
    buyer = result(a, b, intent="consider")
    assert undecided.offers[0].key_numbers["purchasing_power_monthly"] != undecided.offers[1].key_numbers["purchasing_power_monthly"]
    assert buyer.offers[0].dimension_scores["economic"] != undecided.offers[0].dimension_scores["economic"]
    weighted = result(a, b, weights={"economic": 0.8, "growth": 0.1, "experience": 0.1})
    assert weighted.offers[0].overall_score != undecided.offers[0].overall_score
    with_cash = result(offer(1, signing_bonus=90000, annual_bonus_method="amount", annual_bonus_value=80000), b)
    assert with_cash.offers[0].overall_score > undecided.offers[0].overall_score
    assert with_cash.offers[0].key_numbers["entry_income_nominal"] > 0


def test_purchasing_subscore_only_credits_city_adjustment():
    rules = get_rules()
    first, second = result(offer(1), offer(2, city="成都")).offers
    for row in (first, second):
        recurring = row.sub_metrics["economic.recurring_net"]
        adjusted = row.sub_metrics["economic.purchasing_monthly"]
        bands = rules.report["living_multiple_bands"]
        expected = _clamp(50 + _band_min(adjusted / 8000, bands)
                          - _band_min(recurring / 12 / 8000, bands))
        assert row.sub_scores["economic.purchasing"] == pytest.approx(expected)
    assert first.sub_scores["economic.purchasing"] != second.sub_scores["economic.purchasing"]


@pytest.mark.parametrize("overrides", [
    {"social_security_type": "none"},
    {"housing_fund_base_type": "none"},
    {"social_security_type": "none", "housing_fund_base_type": "none"},
    {"social_security_type": "minimum", "housing_fund_base_type": "minimum"},
])
def test_missing_or_minimum_contributions_do_not_raise_cash_or_purchasing_scores(overrides):
    baseline = result(offer(1), offer(2)).offers[0]
    changed = result(offer(1, **overrides), offer(2)).offers[0]
    assert changed.compliance_alert
    assert changed.sub_scores["economic.cash"] == pytest.approx(baseline.sub_scores["economic.cash"])
    assert changed.sub_scores["economic.purchasing"] == pytest.approx(baseline.sub_scores["economic.purchasing"])
    assert changed.overall_score <= baseline.overall_score
    assert changed.sub_metrics["economic.recurring_net"] >= changed.sub_metrics["economic.scored_recurring_net"]


def test_not_consider_and_undecided_use_the_same_nonbuyer_score():
    a, b = offer(1), offer(2, city="上海")
    not_consider = result(a, b, intent="not_consider").offers
    undecided = result(a, b, intent="undecided").offers
    assert [row.dimension_scores["economic"] for row in not_consider] == [row.dimension_scores["economic"] for row in undecided]
    assert all(row.housing.payment_income_ratio is None for row in not_consider + undecided)


def test_new_growth_time_and_cash_fields():
    rows = result(offer(1, training_budget_year=5000, internal_mobility="available",
                        extra_paid_leave=8, relocation_grant=30000), offer(2)).offers
    assert rows[0].dimension_scores["growth"] > rows[1].dimension_scores["growth"]
    assert rows[0].dimension_scores["experience"] > rows[1].dimension_scores["experience"]
    assert rows[0].dimension_scores["economic"] > rows[1].dimension_scores["economic"]
    partial = result(offer(1, peak_week_hours=75, peak_weeks_year=12), offer(2)).offers
    baseline = result(offer(1), offer(2)).offers
    assert partial[0].dimension_scores["experience"] == baseline[0].dimension_scores["experience"]
    common = result(offer(1, peak_week_hours=75, peak_weeks_year=12),
                    offer(2, peak_week_hours=50, peak_weeks_year=12)).offers
    assert common[0].dimension_scores["experience"] < common[1].dimension_scores["experience"]


def test_one_time_cash_scores_without_entering_reported_recurring_income():
    plain = result(offer(1), offer(2)).offers[0]
    enhanced = result(offer(1, signing_bonus=30000, relocation_grant=12000), offer(2)).offers[0]
    assert enhanced.key_numbers["recurring_annual_net"] == plain.key_numbers["recurring_annual_net"]
    assert enhanced.key_numbers["entry_income_nominal"] > plain.key_numbers["entry_income_nominal"]
    assert enhanced.dimension_scores["economic"] > plain.dimension_scores["economic"]
    assert "first_year_net" not in enhanced.key_numbers
    assert "three_year_annual_equivalent" not in enhanced.key_numbers


def test_secondary_scores_reconcile_and_talent_subsidy_is_nominal():
    first, second = result(
        offer(1, signing_bonus=12000, relocation_grant=8000,
              government_talent_subsidy=30000, probation_months=6,
              probation_pay_percent=80, mentorship="formal", remote_days_week=2),
        offer(2, signing_bonus=0, government_talent_subsidy=0,
              probation_months=3, probation_pay_percent=100, mentorship="self_reliant"),
        intent="consider",
    ).offers
    assert first.sub_metrics["economic.entry_income"] == 50000
    assert first.sub_metrics["economic.probation_loss"] == pytest.approx(24000)
    assert first.sub_scores["economic.entry"] > second.sub_scores["economic.entry"]
    assert first.sub_scores["economic.probation"] < second.sub_scores["economic.probation"]
    for row in (first, second):
        for dimension, value in row.dimension_scores.items():
            contributed = sum(detail["contribution"] for key, detail in row.sub_details.items()
                              if key.startswith(f"{dimension}."))
            assert contributed == pytest.approx(value)
        assert "economic.housing" in row.sub_scores
        assert "growth.cultivation" in row.sub_scores


def test_inactive_growth_and_housing_categories_are_absent():
    row = result(offer(1), offer(2), intent="not_consider").offers[0]
    assert "economic.housing" not in row.sub_scores
    assert "growth.cultivation" not in row.sub_scores
    assert "growth.development" not in row.sub_scores
    assert "experience.daily" not in row.sub_scores


def test_growth_scope_and_responsibility_both_count():
    rows = result(offer(1, business_level="core", entry_scope="marginal_tasks"),
                  offer(2, business_level="normal", entry_scope="own_module")).offers
    assert rows[0].dimension_scores["growth"] != rows[1].dimension_scores["growth"]


def test_growth_categories_use_existing_inputs_without_scoring_project_stage():
    first, second = result(
        offer(1, autonomy_level="high", problem_complexity_level="systemic",
              skill_transferability="high", mentorship="formal", training_days_year=5,
              internal_mobility="available", project_stage="scaling"),
        offer(2, autonomy_level="process", problem_complexity_level="routine",
              skill_transferability="low", mentorship="self_reliant", project_stage="declining"),
    ).offers
    expected = {"opportunity", "responsibility", "skills", "cultivation", "options"}
    assert {key.removeprefix("growth.") for key in first.sub_scores if key.startswith("growth.")} == expected
    assert first.sub_scores["growth.responsibility"] > second.sub_scores["growth.responsibility"]
    assert first.sub_scores["growth.skills"] > second.sub_scores["growth.skills"]
    assert first.sub_scores["growth.options"] > second.sub_scores["growth.options"]
    no_stage = result(offer(1, project_stage="scaling"), offer(2, project_stage="declining")).offers
    plain = result(offer(1), offer(2)).offers
    assert [row.dimension_scores["growth"] for row in no_stage] == [row.dimension_scores["growth"] for row in plain]


def test_experience_categories_separate_time_rest_and_boundary():
    first, second = result(
        offer(1, commute_minutes=45, remote_days_week=2, extra_paid_leave=5,
              travel_days_per_month=0, oncall_cadence="none", weekend_overtime_days_month=0),
        offer(2, commute_minutes=45, extra_paid_leave=0,
              travel_days_per_month=5, oncall_cadence="frequent", weekend_overtime_days_month=3),
    ).offers
    assert first.sub_metrics["experience.commute_weekly"] == pytest.approx(4.5)
    assert second.sub_metrics["experience.commute_weekly"] == pytest.approx(7.5)
    assert first.sub_metrics["experience.rest_days_weekly"] == 2
    assert first.sub_metrics["experience.extra_leave_days"] == 5
    assert first.sub_scores["experience.rest"] > second.sub_scores["experience.rest"]
    assert first.sub_scores["experience.boundary"] > second.sub_scores["experience.boundary"]
    assert first.sub_metrics["experience.travel_days_annual"] == 0
    assert second.sub_metrics["experience.travel_days_annual"] == 60
    assert first.sub_metrics["experience.occupied_weekly"] == pytest.approx(54.5)
    assert "experience.daily" not in first.sub_scores


def test_partial_commute_and_boundary_facts_do_not_create_scores():
    first, second = result(offer(1, commute_minutes=90, travel_days_per_month=8), offer(2)).offers
    assert first.sub_metrics["experience.commute_weekly"] is None
    assert second.sub_metrics["experience.travel_days_annual"] is None
    assert "experience.boundary" not in first.sub_scores
    assert first.dimension_scores["experience"] == second.dimension_scores["experience"]


def test_explicit_absence_does_not_activate_gain_categories():
    first, second = result(
        offer(1, internal_mobility="none", user_impact_exposure="none",
              training_days_year=0, extra_paid_leave=0, remote_days_week=0),
        offer(2),
    ).offers
    assert "growth.options" not in first.sub_scores
    assert "growth.cultivation" not in first.sub_scores
    assert first.sub_scores["growth.opportunity"] == second.sub_scores["growth.opportunity"]
    assert "experience.daily" not in first.sub_scores
    assert first.dimension_scores["experience"] == second.dimension_scores["experience"]


def test_high_income_long_hours_weight_change_reverses_rank_and_explanation():
    a = offer(1, monthly_base=35000, weekly_work_hours=75)
    b = offer(2, monthly_base=16000, weekly_work_hours=40)
    money_first = result(a, b, weights={"economic": 0.8, "growth": 0.1, "experience": 0.1})
    time_first = result(a, b, weights={"economic": 0.1, "growth": 0.1, "experience": 0.8})
    assert money_first.offers[0].overall_rank == 1
    assert time_first.offers[1].overall_rank == 1
    _, contributions, _, tradeoff = decision_summary(money_first.offers)
    assert contributions["economic"] > 0
    assert contributions["experience"] < 0
    assert "经济回报" in tradeoff and "工作体验" in tradeoff


def test_questionnaire_three_pairs_and_buyer_question():
    rules = get_rules()
    questions = rules.preference_questionnaire()["questions"]
    answers = [PreferenceAnswer(question_id=q["question_id"],
                                choice="undecided" if q["kind"] == "single" else "equal") for q in questions]
    scored = score_questionnaire(rules, answers)
    assert len(questions) == 4
    assert rules.default_weights() == {"economic": 0.34, "growth": 0.33, "experience": 0.33}
    assert scored.weights == pytest.approx({key: 1 / 3 for key in rules.decision_dimensions()})
    strong = list(answers)
    strong[0] = PreferenceAnswer(question_id=questions[0]["question_id"], choice="left_strong")
    assert score_questionnaire(rules, strong).weights["economic"] > scored.weights["economic"]
    with pytest.raises(QuestionnaireValidationError):
        score_questionnaire(rules, answers[:-1])


def test_questionnaire_api_and_manual_floor():
    questions = get_rules().preference_questionnaire()["questions"]
    answers = [{"question_id": question["question_id"],
                "choice": "undecided" if question["kind"] == "single" else "equal"}
               for question in questions]
    with TestClient(app) as client:
        sid = client.post("/api/v1/sessions", json={}).json()["data"]["session_id"]
        saved = client.put(f"/api/v1/sessions/{sid}/preferences", json={
            "version": 1, "source": "questionnaire", "questionnaire_version": "v2",
            "answers": answers,
        })
        assert saved.status_code == 200, saved.text
        rejected = client.put(f"/api/v1/sessions/{sid}/preferences", json={
            "version": saved.json()["data"]["version"], "source": "manual",
            "weights": {"economic": 98, "growth": 1, "experience": 1},
        })
        assert rejected.status_code == 422
        manual = client.put(f"/api/v1/sessions/{sid}/preferences", json={
            "version": saved.json()["data"]["version"], "source": "manual",
            "weights": {"economic": 80, "growth": 10, "experience": 10},
        })
        assert manual.status_code == 200, manual.text
        assert len(manual.json()["data"]["answers"]) == 4


def test_manual_confirmation_preserves_questionnaire_answers_on_first_save():
    questions = get_rules().preference_questionnaire()["questions"]
    answers = [{"question_id": question["question_id"],
                "choice": "consider" if question["kind"] == "single" else "equal"}
               for question in questions]
    with TestClient(app) as client:
        sid = client.post("/api/v1/sessions", json={}).json()["data"]["session_id"]
        saved = client.put(f"/api/v1/sessions/{sid}/preferences", json={
            "version": 1, "source": "manual", "questionnaire_version": "v2",
            "answers": answers,
            "weights": {"economic": 0.5, "growth": 0.3, "experience": 0.2},
        })
        assert saved.status_code == 200, saved.text
        data = saved.json()["data"]
        assert data["source"] == "manual"
        assert data["weights"] == pytest.approx({"economic": 0.5, "growth": 0.3, "experience": 0.2})
        assert data["answers"] == answers
        invalid = client.put(f"/api/v1/sessions/{sid}/preferences", json={
            "version": data["version"], "source": "manual", "questionnaire_version": "v2",
            "answers": answers[:-1],
            "weights": {"economic": 0.5, "growth": 0.3, "experience": 0.2},
        })
        assert invalid.status_code == 422


def test_export_incomplete_restore_and_old_rejection():
    with TestClient(app) as client:
        created = client.post("/api/v1/sessions", json={})
        assert created.status_code == 201
        sid = created.json()["data"]["session_id"]
        old_offers = client.get(f"/api/v1/sessions/{sid}/offers").json()["data"]
        first = old_offers[0]
        saved = client.patch(f"/api/v1/sessions/{sid}/offers/{first['offer_id']}", json={
            "version": first["version"], "facts": [
                {"field_key": "city", "value": "北京"},
                {"field_key": "probation_months", "value": 3},
                {"field_key": "training_budget_year", "value": 5000},
                {"field_key": "remote_days_week", "value": 2},
            ],
        })
        assert saved.status_code == 200, saved.text
        exported = client.get(f"/api/v1/sessions/{sid}/report/export")
        assert exported.status_code == 200
        archive = exported.json()
        assert archive["format"] == "myoffer-input-v5"
        assert "outputs" not in archive
        assert "company" not in archive["inputs"]["offers"][0]
        assert "position" not in archive["inputs"]["offers"][0]
        assert archive["inputs"]["offers"][0]["facts"]["city"]["value"] == "北京"
        assert archive["inputs"]["offers"][0]["facts"]["training_budget_year"]["value"] == 5000
        assert client.post("/api/v1/sessions/restore", json={"format": "myoffer-report-v1"}).status_code == 422
        restored = client.post("/api/v1/sessions/restore", json=archive)
        assert restored.status_code == 200, restored.text
        new_sid = restored.json()["data"]["session_id"]
        restored_offers = client.get(f"/api/v1/sessions/{new_sid}/offers")
        assert restored_offers.status_code == 200
        assert restored_offers.json()["data"][0]["facts"]["city"]["value"] == "北京"
        assert restored_offers.json()["data"][0]["facts"]["remote_days_week"]["value"] == 2
        for item in restored_offers.json()["data"]:
            remaining = {key: value for key, value in BASE.items()
                         if key not in item["facts"]}
            patch = client.patch(f"/api/v1/sessions/{new_sid}/offers/{item['offer_id']}", json={
                "version": item["version"],
                "facts": [{"field_key": key, "value": value} for key, value in remaining.items()],
            })
            assert patch.status_code == 200, patch.text
        client.post(f"/api/v1/sessions/{new_sid}/questions/stop")
        assert len(client.get(f"/api/v1/sessions/{new_sid}/result").json()["data"]["ranking"]) == 2
        assert client.get(f"/api/v1/sessions/{new_sid}/report/export").status_code == 200


def test_api_complete_report_uses_three_dimensions():
    with TestClient(app) as client:
        created = client.post("/api/v1/sessions", json={})
        sid = created.json()["data"]["session_id"]
        offers = client.get(f"/api/v1/sessions/{sid}/offers").json()["data"]
        for item in offers:
            patch = client.patch(f"/api/v1/sessions/{sid}/offers/{item['offer_id']}", json={
                "version": item["version"],
                "facts": [{"field_key": key, "value": value} for key, value in BASE.items()],
            })
            assert patch.status_code == 200, patch.text
        assert client.post(f"/api/v1/sessions/{sid}/questions/stop").status_code == 200
        report = client.get(f"/api/v1/sessions/{sid}/result")
        assert report.status_code == 200, report.text
        data = report.json()["data"]
        assert len(data["ranking"]) == 2
        assert set(data["weights"]) == {"economic", "growth", "experience"}
        assert data["weights"] == {"economic": 0.34, "growth": 0.33, "experience": 0.33}
        assert all(row["housing"]["payment_income_ratio"] is not None for row in data["offers"])
        assert [row["overall_rank"] for row in data["offers"]] == [1, 1]
