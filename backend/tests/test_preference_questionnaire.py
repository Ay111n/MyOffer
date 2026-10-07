from __future__ import annotations

from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.main import app
from app.rules_runtime import get_rules
from app.schemas import PreferenceAnswer
from app.services.preference_questionnaire import (
    QuestionnaireValidationError,
    score_questionnaire,
)


def _answers(*, choice: str = "equal", calibration: str = "no_difference",
             intent: str = "undecided") -> list[PreferenceAnswer]:
    questions = get_rules().preference_questionnaire()["questions"]
    return [
        PreferenceAnswer(
            question_id=question["question_id"],
            choice=calibration if question["kind"] == "calibration"
            else intent if question["kind"] == "single"
            else choice,
        )
        for question in questions
    ]


def _payload(answers: list[PreferenceAnswer], *, version: int = 1) -> dict:
    return {
        "version": version,
        "source": "questionnaire",
        "questionnaire_version": "v2",
        "answers": [answer.model_dump() for answer in answers],
    }


def _snapshot_count(client: TestClient, sid: str) -> int:
    response = client.get(f"/api/v1/sessions/{sid}/results/history")
    assert response.status_code == 200, response.text
    return len(response.json()["data"])


def test_questionnaire_neutral_answers_are_equal_weights():
    """权重只由 7 道取舍题决定：全中性 → 四维等权（购房意向题不计积分）。"""
    result = score_questionnaire(get_rules(), _answers())
    assert result.scores == {key: 2 for key in get_rules().decision_dimensions()}
    assert result.weights == pytest.approx({key: 1 / 3 for key in get_rules().decision_dimensions()})


def test_questionnaire_strong_answers_increase_selected_dimension():
    result = score_questionnaire(
        get_rules(), _answers(choice="left_strong")
    )
    assert result.weights["economic"] > 1 / 3
    assert sum(result.weights.values()) == pytest.approx(1.0)


def test_questionnaire_rejects_incomplete_duplicate_unknown_and_invalid_answers():
    rules = get_rules()
    answers = _answers()
    with pytest.raises(QuestionnaireValidationError, match="全部 4"):
        score_questionnaire(rules, answers[:-1])

    duplicate = answers[:-1] + [answers[0]]
    with pytest.raises(QuestionnaireValidationError, match="重复"):
        score_questionnaire(rules, duplicate)

    unknown = answers.copy()
    unknown[0] = PreferenceAnswer(question_id="not_a_question", choice="equal")
    with pytest.raises(QuestionnaireValidationError, match="未知题目"):
        score_questionnaire(rules, unknown)

    invalid = answers.copy()
    invalid[0] = PreferenceAnswer(
        question_id=invalid[0].question_id, choice="not_an_option"
    )
    with pytest.raises(QuestionnaireValidationError, match="选项无效"):
        score_questionnaire(rules, invalid)


@pytest.fixture()
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_meta_exposes_questionnaire_and_endpoint_persists_raw_answers(client: TestClient):
    meta = client.get("/api/v1/meta")
    assert meta.status_code == 200, meta.text
    questionnaire = meta.json()["data"]["preference_questionnaire"]
    assert questionnaire["version"] == "v2"
    assert len(questionnaire["questions"]) == 4
    # 第 8 题是购房意向情境题：不计积分，选项固定三档
    intent = questionnaire["questions"][-1]
    assert intent["question_id"] == "buy_house_intent"
    assert intent["kind"] == "single"

    session = client.post("/api/v1/sessions", json={})
    assert session.status_code == 201, session.text
    sid = session.json()["data"]["session_id"]
    answers = _answers(choice="left_slight")

    saved = client.put(f"/api/v1/sessions/{sid}/preferences", json=_payload(answers))
    assert saved.status_code == 200, saved.text
    data = saved.json()["data"]
    assert data["source"] == "questionnaire"
    assert data["questionnaire_version"] == "v2"
    assert data["answers"] == [answer.model_dump() for answer in answers]
    assert sum(data["weights"].values()) == pytest.approx(1.0)

    conflict = client.put(
        f"/api/v1/sessions/{sid}/preferences",
        json=_payload(answers, version=0),
    )
    assert conflict.status_code == 409, conflict.text

    from app.db.session import get_session_factory
    from app.models import DecisionResult

    with get_session_factory()() as db:
        snapshot = db.scalar(
            select(DecisionResult)
            .where(DecisionResult.session_id == UUID(sid))
            .order_by(DecisionResult.seq.desc())
            .limit(1)
        )
        assert snapshot is not None
        snapshot_payload = snapshot.payload
    assert snapshot_payload["inputs"]["preferences"]["source"] == "questionnaire"
    assert snapshot_payload["inputs"]["preferences"]["answers"] == [
        answer.model_dump() for answer in answers
    ]

    history_count = _snapshot_count(client, sid)
    replay_body = _payload(answers, version=data["version"])
    replay = client.put(f"/api/v1/sessions/{sid}/preferences", json=replay_body)
    assert replay.status_code == 200, replay.text
    assert _snapshot_count(client, sid) == history_count

    fetched = client.get(f"/api/v1/sessions/{sid}/preferences")
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["data"] == data


def test_manual_weights_are_accepted_and_normalized(client: TestClient):
    """结果页权重微调：source=manual 直接携带权重，服务端归一化并重算。"""
    session = client.post("/api/v1/sessions", json={})
    assert session.status_code == 201, session.text
    sid = session.json()["data"]["session_id"]
    response = client.put(f"/api/v1/sessions/{sid}/preferences", json={
        "version": 1,
        "source": "manual",
        "weights": {
            "economic": 0.4,
            "growth": 0.3,
            "experience": 0.3,
        },
    })
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["source"] == "manual"
    assert data["weights"] == pytest.approx({
        "economic": 0.4, "growth": 0.3, "experience": 0.3,
    })
    # 快照的偏好输入携带 manual 来源
    from app.db.session import get_session_factory
    from app.models import DecisionResult

    with get_session_factory()() as db:
        snapshot = db.scalar(
            select(DecisionResult)
            .where(DecisionResult.session_id == UUID(sid))
            .order_by(DecisionResult.seq.desc())
            .limit(1)
        )
        prefs = snapshot.payload["inputs"]["preferences"]
    assert prefs["source"] == "manual"
    assert prefs["weights"]["economic"] == pytest.approx(0.4)


def test_manual_weights_are_normalized_to_sum_one(client: TestClient):
    """手动权重未归一（和为 2）时服务端按比例归一，不原样入库。"""
    session = client.post("/api/v1/sessions", json={})
    assert session.status_code == 201, session.text
    sid = session.json()["data"]["session_id"]
    response = client.put(f"/api/v1/sessions/{sid}/preferences", json={
        "version": 1,
        "source": "manual",
        "weights": {"economic": 2, "growth": 1, "experience": 1},
    })
    assert response.status_code == 200, response.text
    weights = response.json()["data"]["weights"]
    assert sum(weights.values()) == pytest.approx(1.0)
    assert weights["economic"] == pytest.approx(0.5)


def test_manual_preference_contract_is_rejected(client: TestClient):
    """manual 来源缺 weights / 缺维度键 → 422。"""
    session = client.post("/api/v1/sessions", json={})
    assert session.status_code == 201, session.text
    sid = session.json()["data"]["session_id"]
    missing_weights = client.put(f"/api/v1/sessions/{sid}/preferences", json={
        "version": 1, "source": "manual",
    })
    assert missing_weights.status_code == 422, missing_weights.text

    missing_key = client.put(f"/api/v1/sessions/{sid}/preferences", json={
        "version": 1,
        "source": "manual",
        "weights": {"economic": 1, "growth": 1},
    })
    assert missing_key.status_code == 422, missing_key.text

    unknown_key = client.put(f"/api/v1/sessions/{sid}/preferences", json={
        "version": 1,
        "source": "manual",
        "weights": {"economic": 1, "growth": 1, "experience": 1, "extra": 1},
    })
    assert unknown_key.status_code == 422, unknown_key.text


@pytest.mark.parametrize("mutation", [
    lambda answers: answers[:-1],
    lambda answers: answers[:-1] + [answers[0]],
    lambda answers: [PreferenceAnswer(question_id="unknown", choice="equal")] + answers[1:],
])
def test_questionnaire_http_validation_returns_422(client: TestClient, mutation):
    session = client.post("/api/v1/sessions", json={})
    assert session.status_code == 201, session.text
    sid = session.json()["data"]["session_id"]
    response = client.put(
        f"/api/v1/sessions/{sid}/preferences",
        json=_payload(mutation(_answers())),
    )
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_error"
