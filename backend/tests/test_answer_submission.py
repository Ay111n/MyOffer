"""作答提交事务的回归锁（TestClient 端到端，复现三个历史缺陷）。

- enum 字段收到不可哈希 JSON 值 → 必须 422（曾 TypeError → 500）；
- need_confirmation 且 value=null → 必须落库（曾静默丢弃，单独提交曾 500）；
- unknown+note 的更新分支必须落 note（曾漏写 → no-op 检测失效 → 快照无限新增）。
"""
from fastapi.testclient import TestClient

from app.main import app


def _session_with_offer():
    with TestClient(app) as client:  # 上下文管理器触发 lifespan 建表
        r = client.post("/api/v1/sessions", json={"title": None})
        assert r.status_code == 201
        sid = r.json()["data"]["session_id"]
        offers = client.get(f"/api/v1/sessions/{sid}/offers").json()["data"]
        oid = offers[0]["offer_id"]
        return client, sid, oid


def _post_answers(client: TestClient, sid: str, oid: str, fields: list[dict]):
    return client.post(
        f"/api/v1/sessions/{sid}/questions/q_details/answers",
        json={"answers": [{"offer_id": oid, "fields": fields}]},
    )


def test_enum_fact_with_dict_value_is_422_not_500():
    client, sid, oid = _session_with_offer()
    r = _post_answers(client, sid, oid,
                      [{"field_key": "meal_plan", "status": "known", "value": {"a": 1}}])
    assert r.status_code == 422
    body = r.json()
    assert body["error"]["code"] == "validation_error"
    assert body["error"]["details"]["field_errors"][0]["code"] == "invalid_option"


def test_need_confirmation_null_value_persisted():
    """value=null 的待确认字段必须落库：单独提交曾 500，
    混合提交曾被静默丢弃（重放无法命中 no-op 即是丢弃证据）。"""
    client, sid, oid = _session_with_offer()
    fields = [{"field_key": "meal_plan", "status": "need_confirmation", "value": None}]
    r1 = _post_answers(client, sid, oid, fields)
    assert r1.status_code == 200
    seq1 = r1.json()["decision"]["snapshot_seq"]
    # 相同内容重放 → no-op（快照号不变）；字段被丢弃时重放会判「有变化」再加快照
    r2 = _post_answers(client, sid, oid, fields)
    assert r2.status_code == 200
    assert r2.json()["decision"]["snapshot_seq"] == seq1
    # 待确认字段应生成尽调项
    dd = client.get(f"/api/v1/sessions/{sid}/due-diligence").json()["data"]["items"]
    assert any(item["status"] == "open" for item in dd)


def test_unknown_note_replay_is_noop_after_update():
    """先 known 后 unknown+note：更新分支曾漏写 note → 备注丢失且
    相同重放永远判「有变化」，快照序列 1,1,2,3 无限新增。"""
    client, sid, oid = _session_with_offer()
    r_known = _post_answers(client, sid, oid,
                            [{"field_key": "meal_plan", "status": "known", "value": "two_meals"}])
    assert r_known.status_code == 200
    fields = [{"field_key": "meal_plan", "status": "unknown", "note": "HR说三餐都管"}]
    r1 = _post_answers(client, sid, oid, fields)
    assert r1.status_code == 200
    seq1 = r1.json()["decision"]["snapshot_seq"]
    r2 = _post_answers(client, sid, oid, fields)
    assert r2.status_code == 200
    assert r2.json()["decision"]["snapshot_seq"] == seq1


def test_stop_on_fresh_session_creates_baseline_snapshot():
    """回归：创建后未做任何写入的会话 stop 曾直接放行 → 结果页 404。
    stop 必须先补一份基线快照。"""
    with TestClient(app) as client:
        r = client.post("/api/v1/sessions", json={"title": None})
        assert r.status_code == 201
        sid = r.json()["data"]["session_id"]
        r_stop = client.post(f"/api/v1/sessions/{sid}/questions/stop")
        assert r_stop.status_code == 200
        seq = r_stop.json()["decision"]["snapshot_seq"]
        assert seq >= 1
        r_result = client.get(f"/api/v1/sessions/{sid}/result")
        assert r_result.status_code == 200
