"""收入三分法、可解释评分、试算和导出恢复的跨层回归。"""
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.rules_runtime import get_rules
from app.schemas import ReportScenarioRequest
from app.services.pipeline import compute_snapshot
from app.services.report_tools import scenario
from tests.golden import A_FACTS, A_ID, B_FACTS, B_ID, g1_input, make_input, make_offer, offer_by_id

pytestmark = pytest.mark.skip(reason="v4 报告及情景试算已退役，使用 test_three_dimension.py")


def test_entry_income_does_not_change_recurring_cash_score_or_long_term_metrics():
    rules = get_rules()
    baseline = g1_input()
    changed = make_input([
        make_offer(A_ID, "A公司", 1, {**A_FACTS, "signing_bonus": 200000}),
        make_offer(B_ID, "B公司", 2, B_FACTS),
    ])
    before = offer_by_id(compute_snapshot(session_id=uuid4(), trigger_type="test", inp=baseline, rules=rules).outputs, A_ID)
    after = offer_by_id(compute_snapshot(session_id=uuid4(), trigger_type="test", inp=changed, rules=rules).outputs, A_ID)
    assert after.salary.income.entry_net > before.salary.income.entry_net
    assert after.salary.income.annual_cash_net == before.salary.income.annual_cash_net
    assert after.salary.income.recurring_total == before.salary.income.recurring_total
    assert after.salary.score == before.salary.score
    assert after.efficiency.hourly == before.efficiency.hourly
    assert after.housing.down_payment_years == before.housing.down_payment_years
    assert after.overall_score == before.overall_score


def test_cash_benefits_and_score_contributions_reconcile():
    rules = get_rules()
    a = offer_by_id(compute_snapshot(session_id=uuid4(), trigger_type="test", inp=g1_input(), rules=rules).outputs, A_ID)
    income = a.salary.income
    assert income.guaranteed_gross == 396000  # 工资 + 年度现金补贴
    assert income.annual_cash_net == income.guaranteed_net + income.bonus_net
    assert income.annual_benefits == income.hf_personal + income.hf_employer + income.in_kind
    assert income.recurring_total == income.annual_cash_net + income.annual_benefits
    assert sum(a.score_contributions.values()) == a.overall_score


def test_quality_separates_scored_modules_from_input_coverage():
    rules = get_rules()
    inp = make_input([make_offer(A_ID, "A", 1, A_FACTS,
                                 drop=("business_level", "business_growth_expectation", "business_affinity",
                                       "boss_resource_ability", "boss_ability", "boss_attitude", "communication_style")),
                      make_offer(B_ID, "B", 2, B_FACTS)])
    report = offer_by_id(compute_snapshot(session_id=uuid4(), trigger_type="test", inp=inp, rules=rules).outputs, A_ID)
    assert report.quality.module_coverage == 100
    assert report.quality.field_coverage < 100
    assert report.quality.provisional
    assert report.quality.priority_fields


def test_scenario_is_pure_and_changes_only_requested_input():
    rules = get_rules()
    snapshot = compute_snapshot(session_id=uuid4(), trigger_type="test", inp=g1_input(), rules=rules)
    trial = scenario(snapshot, ReportScenarioRequest(snapshot_seq=1, offer_id=A_ID,
                    bonus_factor=0, weekly_work_hours=40), rules)
    original = offer_by_id(snapshot.outputs, A_ID)
    modified = offer_by_id(trial.outputs, A_ID)
    assert modified.salary.income.bonus_gross == 0
    assert modified.efficiency.hourly != original.efficiency.hourly
    assert snapshot.inputs.offers[0].facts["annual_bonus_value"].value == A_FACTS["annual_bonus_value"]
    assert trial.outputs.offers != snapshot.outputs.offers


def test_export_restore_recomputes_and_invalid_import_preserves_session():
    rules = get_rules()
    with TestClient(app) as client:
        initial = client.post("/api/v1/sessions", json={})
        assert initial.status_code == 201, initial.text
        old_id = initial.json()["data"]["session_id"]
        snapshot = compute_snapshot(session_id=uuid4(), trigger_type="fixture", inp=g1_input(), rules=rules)
        payload = snapshot.model_dump(mode="json")
        invalid = snapshot.model_dump(mode="json")
        invalid["inputs"]["offers"][0]["facts"]["monthly_base"]["value"] = -1
        rejected = client.post("/api/v1/sessions/restore", json={"format": "myoffer-report-v1", "snapshot": invalid})
        assert rejected.status_code == 422
        assert client.get(f"/api/v1/sessions/{old_id}").status_code == 200
        payload["outputs"]["offers"][0]["overall_score"] = 999
        restored = client.post("/api/v1/sessions/restore", json={"format": "myoffer-report-v1", "snapshot": payload})
        assert restored.status_code == 200, restored.text
        new_id = restored.json()["data"]["session_id"]
        preferences = client.get(f"/api/v1/sessions/{new_id}/preferences")
        assert preferences.status_code == 200
        assert preferences.json()["data"]["source"] == "default"
        result = client.get(f"/api/v1/sessions/{new_id}/result")
        assert result.status_code == 200
        offers = result.json()["data"]["offers"]
        assert max(o["overall_score"] for o in offers) < 999
        seq = result.json()["data"]["snapshot_seq"]
        archive = client.get(f"/api/v1/sessions/{new_id}/report/export", params={"seq": seq})
        assert archive.status_code == 200
        assert archive.json()["snapshot"]["rules_digest"] == archive.json()["rules_digest"]
        trial = client.post(f"/api/v1/sessions/{new_id}/report/scenario", json={
            "snapshot_seq": seq, "offer_id": offers[0]["offer_id"], "bonus_factor": 0.5,
        })
        assert trial.status_code == 200, trial.text
        assert client.get(f"/api/v1/sessions/{new_id}/result").json()["data"]["snapshot_seq"] == seq
