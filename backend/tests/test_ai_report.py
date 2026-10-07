"""The AI report starts only from the owner's current computed snapshot."""
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from app.api.routes import results
from app.db.session import get_session_factory
from app.domain.contracts import DecisionInput, OfferInput, RawFactInput, UserPreferenceInput
from app.main import app
from app.models import DecisionResult
from app.rules_runtime import get_rules
from app.services.pipeline import compute_snapshot

CORE = {
    "city": "北京", "monthly_base": 18000, "guaranteed_salary_months": 12,
    "business_level": "core", "entry_scope": "small_feature",
    "weekly_work_hours": 45, "work_days_per_week": 5,
}


def _snapshot(session_id, complete=True):
    rules = get_rules()
    offers = []
    for order in (1, 2):
        fields = CORE if complete else {key: value for key, value in CORE.items() if key != "entry_scope"}
        offers.append(OfferInput(
            offer_id=uuid4(), display_order=order, company=f"Private company {order}",
            position="private position", facts={
                key: RawFactInput(field_key=key, value=value, status="known", source="offer_letter")
                for key, value in fields.items()
            },
        ))
    return compute_snapshot(session_id=UUID(session_id), trigger_type="test", inp=DecisionInput(
        offers=offers, preferences=UserPreferenceInput(weights=rules.default_weights())
    ), rules=rules)


def _store(session_id, snapshot, seq):
    with get_session_factory().begin() as db:
        db.add(DecisionResult(session_id=UUID(session_id), seq=seq, rule_version=snapshot.rule_version,
                              snapshot_schema_version=5, trigger_type="test",
                              payload=snapshot.model_dump(mode="json")))


def test_analysis_binds_latest_snapshot_and_sends_only_computed_metrics(monkeypatch):
    captured = []

    class FakeBridge:
        def call(self, owner, operation, args):
            captured.append((owner, operation, args))
            return {"id": str(uuid4()), "kind": "analysis", "provider": "openai",
                    "model": "test-model", "status": "pending", "snapshot_seq": 2,
                    "expires_at": "2026-10-07T12:00:00Z"}

    monkeypatch.setattr(results, "get_bridge", lambda: FakeBridge())
    with TestClient(app) as client:
        session_id = client.post("/api/v1/sessions", json={}).json()["data"]["session_id"]
        snapshot = _snapshot(session_id)
        _store(session_id, snapshot, 2)
        url = f"/api/v1/sessions/{session_id}/report/ai-analysis"
        assert client.post(url, json={"snapshot_seq": 1, "part": "economic"}).status_code == 409
        assert client.post(url, json={"snapshot_seq": 2}).status_code == 422
        response = client.post(url, json={"snapshot_seq": 2, "part": "economic"})
        assert response.status_code == 202, response.text
        assert response.json()["data"]["snapshot_seq"] == 2
        assert len(captured) == 1 and captured[0][1] == "analyze"
        assert captured[0][2]["part"] == "economic"
        payload = captured[0][2]["report"]
        assert payload["snapshot_seq"] == 2
        assert len(payload["offers"]) == 2
        assert payload["offers"][0]["score_contributions"]
        assert "Private company" not in str(payload)
        assert "input_values" not in str(payload)

        other = TestClient(app)
        other.post("/api/v1/sessions", json={})
        assert other.post(url, json={"snapshot_seq": 2, "part": "economic"}).status_code == 404


def test_incomplete_report_cannot_start_analysis(monkeypatch):
    monkeypatch.setattr(results, "get_bridge", lambda: None)
    with TestClient(app) as client:
        session_id = client.post("/api/v1/sessions", json={}).json()["data"]["session_id"]
        _store(session_id, _snapshot(session_id, complete=False), 1)
        response = client.post(f"/api/v1/sessions/{session_id}/report/ai-analysis",
                               json={"snapshot_seq": 1, "part": "overall"})
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "report_incomplete"
