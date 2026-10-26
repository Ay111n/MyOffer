"""批量作答事务的回归锁（TestClient 端到端）。

- 多题一批：单事务只重算一次、只落一条快照（对照单题逐次提交的 N 条）；
- 全 no-op 重放：快照号不变；
- 任一题校验失败：整批 422、零写入（草稿留在客户端可安全重试），
  错误 details 附 question_key；
- results 阶段的批量作答把 phase 拉回 completion（与单题语义一致）。
"""
from fastapi.testclient import TestClient

from app.main import app


def _session_with_offers():
    with TestClient(app) as client:  # 上下文管理器触发 lifespan 建表
        r = client.post("/api/v1/sessions", json={"title": None})
        assert r.status_code == 201
        sid = r.json()["data"]["session_id"]
        offers = client.get(f"/api/v1/sessions/{sid}/offers").json()["data"]
        return client, sid, [o["offer_id"] for o in offers]


def _batch(client, sid, items):
    return client.post(f"/api/v1/sessions/{sid}/questions/answers/batch",
                       json={"items": items})


def test_batch_writes_once_and_creates_single_snapshot():
    client, sid, (a, b) = _session_with_offers()
    # 基线：先单独提交一题，快照号从 1 起
    r0 = client.post(f"/api/v1/sessions/{sid}/questions/q_details/answers",
                     json={"answers": [{"offer_id": a, "fields": [
                         {"field_key": "meal_plan", "status": "known", "value": "no_meals"}]}]})
    assert r0.status_code == 200
    seq0 = r0.json()["decision"]["snapshot_seq"]

    r = _batch(client, sid, [
        {"question_key": "q_essentials", "answers": [
            {"offer_id": a, "fields": [{"field_key": "city", "status": "known", "value": "北京"}]},
            {"offer_id": b, "fields": [{"field_key": "city", "status": "known", "value": "成都"}]},
        ]},
        {"question_key": "q_growth_details", "answers": [
            {"offer_id": a, "fields": [{"field_key": "jd_match_level", "status": "known", "value": "high_match"}]},
        ]},
    ])
    assert r.status_code == 200, r.text
    body = r.json()
    # 两题各回报了自己的 states（offer_id → 聚合状态；部分作答聚合为 answered）
    assert body["data"]["questions"]["q_essentials"][a] == "answered"
    assert body["data"]["questions"]["q_essentials"][b] == "answered"
    assert body["data"]["questions"]["q_growth_details"][a] == "answered"
    # 关键口径：两题一批只新增一条快照
    assert body["decision"]["snapshot_seq"] == seq0 + 1


def test_batch_all_noop_replay_keeps_snapshot_seq():
    client, sid, (a, _b) = _session_with_offers()
    items = [{"question_key": "q_details", "answers": [
        {"offer_id": a, "fields": [{"field_key": "meal_plan", "status": "known", "value": "two_meals"}]}]}]
    r1 = _batch(client, sid, items)
    assert r1.status_code == 200
    seq1 = r1.json()["decision"]["snapshot_seq"]
    r2 = _batch(client, sid, items)
    assert r2.status_code == 200
    assert r2.json()["decision"]["snapshot_seq"] == seq1


def test_batch_validation_failure_is_atomic_and_locates_question():
    client, sid, (a, _b) = _session_with_offers()
    r0 = _batch(client, sid, [
        {"question_key": "q_essentials", "answers": [
            {"offer_id": a, "fields": [{"field_key": "city", "status": "known", "value": "北京"}]}]}])
    assert r0.status_code == 200
    seq0 = r0.json()["decision"]["snapshot_seq"]

    # 第二题校验失败（枚举字段收到不可哈希 dict）：整批拒绝
    bad = _batch(client, sid, [
        {"question_key": "q_essentials", "answers": [
            {"offer_id": a, "fields": [{"field_key": "city", "status": "known", "value": "成都"}]}]},
        {"question_key": "q_details", "answers": [
            {"offer_id": a, "fields": [{"field_key": "meal_plan", "status": "known", "value": {"a": 1}}]}]},
    ])
    assert bad.status_code == 422
    details = bad.json()["error"]["details"]
    assert details["question_key"] == "q_details"

    # 原子性：第一题（合法）也没有落库，快照号不变
    facts = client.get(f"/api/v1/sessions/{sid}/offers").json()["data"][0]["facts"]
    assert facts.get("city", {}).get("value") == "北京"
    r_after = client.get(f"/api/v1/sessions/{sid}")
    assert r_after.status_code == 200
    assert r_after.json()["data"]["latest_snapshot_seq"] == seq0


def test_batch_rejects_duplicate_question_key():
    client, sid, (a, _b) = _session_with_offers()
    item = {"question_key": "q_details", "answers": [
        {"offer_id": a, "fields": [{"field_key": "meal_plan", "status": "known", "value": "no_meals"}]}]}
    r = _batch(client, sid, [item, dict(item)])
    assert r.status_code == 422
    assert r.json()["error"]["details"]["question_key"] == "q_details"


def test_batch_answer_reopens_completion_phase():
    client, sid, (a, _b) = _session_with_offers()
    assert client.post(f"/api/v1/sessions/{sid}/questions/stop").status_code == 200
    r = _batch(client, sid, [
        {"question_key": "q_details", "answers": [
            {"offer_id": a, "fields": [{"field_key": "meal_plan", "status": "known", "value": "one_meal"}]}]}])
    assert r.status_code == 200
    phase = client.get(f"/api/v1/sessions/{sid}").json()["data"]["phase"]
    assert phase == "completion"
