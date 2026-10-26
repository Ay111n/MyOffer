"""免写入试算端点（POST /report/scenario）回归锁。

- 试算只读：不落事实、不新增快照（seq 与历史条数不变）；
- 防陈旧：只接受最新快照的 seq，过期 seq → 409 stale_report；
- 试算对象不在报告内 → 422；monthly_base 越界 → 422；
- 试算结果可改变排名（月薪是最有力的杠杆，验证重算真实生效）。
"""
from uuid import uuid4

from fastapi.testclient import TestClient

from app.main import app

# 两份核心字段齐全的对照 Offer（北京 15k×13 vs 成都 11k×13，均 5 天/周）
_A = {
    "city": "北京", "monthly_base": 15000, "guaranteed_salary_months": 13,
    "business_level": "core", "entry_scope": "small_feature",
    "weekly_work_hours": 46, "work_days_per_week": 5,
}
_B = {
    "city": "成都", "monthly_base": 11000, "guaranteed_salary_months": 13,
    "business_level": "important", "entry_scope": "small_feature",
    "weekly_work_hours": 46, "work_days_per_week": 5,
}


def _session_with_ranked_report():
    with TestClient(app) as client:
        r = client.post("/api/v1/sessions", json={"title": None})
        assert r.status_code == 201, r.text
        sid = r.json()["data"]["session_id"]
        offers = client.get(f"/api/v1/sessions/{sid}/offers").json()["data"]
        a, b = offers[0]["offer_id"], offers[1]["offer_id"]

        r = client.post(f"/api/v1/sessions/{sid}/questions/answers/batch", json={
            "items": [{"question_key": "q_essentials", "answers": [
                {"offer_id": a, "fields": [
                    {"field_key": k, "status": "known", "value": v} for k, v in _A.items()]},
                {"offer_id": b, "fields": [
                    {"field_key": k, "status": "known", "value": v} for k, v in _B.items()]},
            ]}]})
        assert r.status_code == 200, r.text
        seq = r.json()["decision"]["snapshot_seq"]

        result = client.get(f"/api/v1/sessions/{sid}/result")
        assert result.status_code == 200, result.text
        return client, sid, a, b, seq, result.json()["data"]


def test_scenario_is_write_free_and_can_flip_ranking():
    client, sid, a, b, seq, base = _session_with_ranked_report()
    history_before = len(client.get(f"/api/v1/sessions/{sid}/results/history").json()["data"])

    # 给落后者大幅加薪再试算（谁的分低给谁调，保证结果可观测）
    scores = base["overall_scores"]
    loser = a if scores[a] <= scores[b] else b
    r = client.post(f"/api/v1/sessions/{sid}/report/scenario", json={
        "snapshot_seq": seq, "offer_id": loser, "monthly_base": 40000})
    assert r.status_code == 200, r.text
    trial = r.json()["data"]
    assert trial["snapshot_seq"] == seq  # 对比基准仍是原快照
    assert trial["overall_scores"][loser] > scores[loser]
    assert trial["ranking"][0] == loser

    # 只读证明：seq 与历史条数都不变，事实未被改写
    assert client.get(f"/api/v1/sessions/{sid}").json()["data"]["latest_snapshot_seq"] == seq
    assert len(client.get(f"/api/v1/sessions/{sid}/results/history").json()["data"]) == history_before
    facts = client.get(f"/api/v1/sessions/{sid}/offers").json()["data"]
    loser_facts = next(o for o in facts if o["offer_id"] == loser)["facts"]
    assert loser_facts["monthly_base"]["value"] in (15000, 11000)


def test_scenario_stale_seq_rejected():
    client, sid, a, _b, seq, _base = _session_with_ranked_report()
    r = client.post(f"/api/v1/sessions/{sid}/report/scenario", json={
        "snapshot_seq": seq + 1, "offer_id": a, "monthly_base": 30000})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "stale_report"


def test_scenario_unknown_offer_rejected():
    client, sid, _a, _b, seq, _base = _session_with_ranked_report()
    r = client.post(f"/api/v1/sessions/{sid}/report/scenario", json={
        "snapshot_seq": seq, "offer_id": str(uuid4()), "monthly_base": 30000})
    assert r.status_code == 422


def test_scenario_monthly_base_bounds():
    client, sid, a, _b, seq, _base = _session_with_ranked_report()
    for bad in (0, -1, 2_000_000):
        r = client.post(f"/api/v1/sessions/{sid}/report/scenario", json={
            "snapshot_seq": seq, "offer_id": a, "monthly_base": bad})
        assert r.status_code == 422, f"monthly_base={bad} 应被拒绝"


def test_scenario_bonus_factor_requires_bonus_fact():
    client, sid, a, _b, seq, _base = _session_with_ranked_report()
    # 两份 Offer 都没填奖金字段：bonus_factor 试算无据可依 → 422
    r = client.post(f"/api/v1/sessions/{sid}/report/scenario", json={
        "snapshot_seq": seq, "offer_id": a, "bonus_factor": 2})
    assert r.status_code == 422


# ── 反解追平点（POST /report/scenario/solve）───────────────────────

def _solve(client, sid, offer, seq):
    return client.post(f"/api/v1/sessions/{sid}/report/scenario/solve",
                       json={"snapshot_seq": seq, "offer_id": offer})


def test_solve_returns_minimal_parity_salary():
    client, sid, a, b, seq, base = _session_with_ranked_report()
    scores = base["overall_scores"]
    loser = a if scores[a] <= scores[b] else b
    leader = b if loser == a else a
    r = _solve(client, sid, loser, seq)
    assert r.status_code == 200, r.text
    sol = r.json()["data"]
    current = 15000 if loser == a else 11000
    assert sol["lever"] == "monthly_base"
    assert sol["target_id"] == loser and sol["leader_id"] == leader
    assert sol["current_value"] == current
    assert sol["required_value"] is not None and sol["required_value"] > current
    assert sol["delta"] == round(sol["required_value"] - current, 2)
    # 按报出的数字试算：追平或反超（百元向上取整保证不低于阈值）
    trial = client.post(f"/api/v1/sessions/{sid}/report/scenario", json={
        "snapshot_seq": seq, "offer_id": loser, "monthly_base": sol["required_value"]})
    t_scores = trial.json()["data"]["overall_scores"]
    assert t_scores[loser] >= sol["leader_score"]
    # 追平即并列第一（并列时 ranking 按槽位序，不影响名次值）
    loser_rank = next(o for o in trial.json()["data"]["offers"]
                      if o["offer_id"] == loser)["overall_rank"]
    assert loser_rank == 1
    # 阈值下方 500 元必然未追平（取整余量 ≥ 400）
    below = client.post(f"/api/v1/sessions/{sid}/report/scenario", json={
        "snapshot_seq": seq, "offer_id": loser, "monthly_base": sol["required_value"] - 500})
    assert below.json()["data"]["overall_scores"][loser] < sol["leader_score"]
    # 反解全程只读：快照号不变
    assert client.get(f"/api/v1/sessions/{sid}").json()["data"]["latest_snapshot_seq"] == seq


def test_solve_rejects_leader_and_stale_and_unknown():
    client, sid, a, b, seq, base = _session_with_ranked_report()
    scores = base["overall_scores"]
    leader = a if scores[a] > scores[b] else b
    assert _solve(client, sid, leader, seq).status_code == 422
    assert _solve(client, sid, a, seq + 3).status_code == 409
    assert _solve(client, sid, str(uuid4()), seq).status_code == 422


def test_solve_reports_unreachable_when_salary_cannot_close_gap():
    with TestClient(app) as client:
        r = client.post("/api/v1/sessions", json={"title": None})
        sid = r.json()["data"]["session_id"]
        offers = client.get(f"/api/v1/sessions/{sid}/offers").json()["data"]
        a, b = offers[0]["offer_id"], offers[1]["offer_id"]
        rich = {**_A, "monthly_base": 1_000_000}
        weak = {**_B, "monthly_base": 8000}
        r = client.post(f"/api/v1/sessions/{sid}/questions/answers/batch", json={
            "items": [{"question_key": "q_essentials", "answers": [
                {"offer_id": a, "fields": [{"field_key": k, "status": "known", "value": v} for k, v in rich.items()]},
                {"offer_id": b, "fields": [{"field_key": k, "status": "known", "value": v} for k, v in weak.items()]},
            ]}]})
        seq = r.json()["decision"]["snapshot_seq"]
        sol = _solve(client, sid, b, seq).json()["data"]
        # 弱势方即使月薪拉到字段上界，业务档位差距仍使其无法追平
        assert sol["required_value"] is None and sol["delta"] is None
