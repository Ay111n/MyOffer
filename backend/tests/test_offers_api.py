"""offers 写端点回归（审查缺口补齐：POST/PATCH/DELETE 曾零覆盖）。

覆盖：创建满 3 份冲突、默认命名、乐观锁 version_conflict、
PATCH 幂等（无变化不新增快照）、事实 PATCH 落库、删除级联重算。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


def _client_with_session():
    with TestClient(app) as client:
        r = client.post("/api/v1/sessions", json={"title": None})
        assert r.status_code == 201, r.text
        sid = r.json()["data"]["session_id"]
        return client, sid


def _list_offers(client, sid):
    r = client.get(f"/api/v1/sessions/{sid}/offers")
    assert r.status_code == 200, r.text
    return r.json()["data"]


def test_create_third_offer_then_limit_conflict():
    client, sid = _client_with_session()
    r = client.post(f"/api/v1/sessions/{sid}/offers", json={})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["data"]["company"] == "Offer C"
    assert body["decision"]["snapshot_seq"] >= 1

    # 空公司名 → 按空位序号默认命名（第 3 空位 → Offer C）
    r2 = client.post(f"/api/v1/sessions/{sid}/offers", json={})
    assert r2.status_code == 409
    assert r2.json()["error"]["code"] == "offer_limit_reached"


def test_patch_identity_and_facts_with_optimistic_lock():
    client, sid = _client_with_session()
    offers = _list_offers(client, sid)
    oid = offers[0]["offer_id"]
    version = offers[0]["version"]

    r = client.patch(f"/api/v1/sessions/{sid}/offers/{oid}", json={
        "version": version,
        "facts": [{"field_key": "monthly_base", "value": 20000}],
    })
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["company"] == "Offer A"
    assert data["version"] == version + 1
    assert data["facts"]["monthly_base"]["value"] == 20000

    # 旧 version 再改 → 409 并回传当前版本
    r2 = client.patch(f"/api/v1/sessions/{sid}/offers/{oid}", json={
        "version": version, "facts": [{"field_key": "monthly_base", "value": 21000}]})
    assert r2.status_code == 409
    err = r2.json()["error"]
    assert err["code"] == "version_conflict"
    assert err["details"]["current_version"] == version + 1


def test_patch_noop_keeps_version_and_snapshot():
    client, sid = _client_with_session()
    offers = _list_offers(client, sid)
    oid = offers[0]["offer_id"]
    version = offers[0]["version"]
    seq_before = client.get(f"/api/v1/sessions/{sid}").json()["data"]["latest_snapshot_seq"]

    r = client.patch(f"/api/v1/sessions/{sid}/offers/{oid}", json={"version": version})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["version"] == version
    # 幂等：不新增快照（seq 保持不变）
    assert r.json()["decision"]["snapshot_seq"] == (seq_before or 0)


def test_delete_offer_and_cascade():
    client, sid = _client_with_session()
    offers = _list_offers(client, sid)
    oid = offers[0]["offer_id"]

    r = client.delete(f"/api/v1/sessions/{sid}/offers/{oid}")
    assert r.status_code == 200, r.text
    remaining = _list_offers(client, sid)
    assert len(remaining) == 1
    assert remaining[0]["offer_id"] != oid

    # 删除他人/不存在的 offer → 404（不泄露存在性）
    r2 = client.delete(f"/api/v1/sessions/{sid}/offers/{oid}")
    assert r2.status_code == 404


@pytest.mark.parametrize("deleted_index", [0, 1, 2])
def test_delete_offer_compacts_labels_and_preserves_surviving_data(deleted_index):
    client, sid = _client_with_session()
    assert client.post(f"/api/v1/sessions/{sid}/offers", json={}).status_code == 201
    originals = _list_offers(client, sid)
    for index, offer in enumerate(originals):
        updated = client.patch(f"/api/v1/sessions/{sid}/offers/{offer['offer_id']}", json={
            "version": offer["version"],
            "facts": [{"field_key": "monthly_base", "value": 18000 + index * 1000}],
        })
        assert updated.status_code == 200, updated.text
    originals = _list_offers(client, sid)
    survivors = [offer for index, offer in enumerate(originals) if index != deleted_index]

    deleted = client.delete(f"/api/v1/sessions/{sid}/offers/{originals[deleted_index]['offer_id']}")
    assert deleted.status_code == 200, deleted.text
    remaining = _list_offers(client, sid)
    assert [offer["company"] for offer in remaining] == ["Offer A", "Offer B"]
    assert [offer["display_order"] for offer in remaining] == [1, 2]
    for slot, (before, after) in enumerate(zip(survivors, remaining, strict=True), start=1):
        assert after["offer_id"] == before["offer_id"]
        assert after["facts"] == before["facts"]
        assert after["version"] == before["version"] + (before["display_order"] != slot)

    snapshot = client.get(f"/api/v1/sessions/{sid}/result").json()["data"]
    ordered = sorted(snapshot["offers"], key=lambda offer: offer["display_order"])
    assert [offer["company"] for offer in ordered] == ["Offer A", "Offer B"]
    assert [offer["offer_id"] for offer in ordered] == [offer["offer_id"] for offer in survivors]

    added = client.post(f"/api/v1/sessions/{sid}/offers", json={})
    assert added.status_code == 201, added.text
    assert added.json()["data"]["company"] == "Offer C"
    assert [offer["display_order"] for offer in _list_offers(client, sid)] == [1, 2, 3]


def test_reset_offer_keeps_slot_and_other_offer_but_removes_its_answers():
    client, sid = _client_with_session()
    first, second = _list_offers(client, sid)
    oid = first["offer_id"]
    patched = client.patch(f"/api/v1/sessions/{sid}/offers/{oid}", json={
        "version": first["version"],
        "facts": [{"field_key": "monthly_base", "value": 20000}],
    })
    assert patched.status_code == 200
    answered = client.post(f"/api/v1/sessions/{sid}/questions/q_details/answers", json={
        "answers": [{"offer_id": oid, "fields": [
            {"field_key": "meal_plan", "status": "need_confirmation", "value": None},
        ]}],
    })
    assert answered.status_code == 200
    other = client.patch(f"/api/v1/sessions/{sid}/offers/{second['offer_id']}", json={
        "version": second["version"], "facts": [{"field_key": "monthly_base", "value": 18000}],
    })
    assert other.status_code == 200
    before = _list_offers(client, sid)[0]
    assert any(x["offer_id"] == oid for x in client.get(
        f"/api/v1/sessions/{sid}/due-diligence").json()["data"]["items"])

    reset = client.post(f"/api/v1/sessions/{sid}/offers/{oid}/reset", json={"version": before["version"]})
    assert reset.status_code == 200, reset.text
    now, untouched = _list_offers(client, sid)
    assert now["offer_id"] == oid
    assert now["display_order"] == first["display_order"]
    assert now["company"] == "Offer A" and now["position"] == "" and now["facts"] == {}
    assert untouched == other.json()["data"]
    assert all(x["offer_id"] != oid for x in client.get(
        f"/api/v1/sessions/{sid}/due-diligence").json()["data"]["items"])
    catalog = client.get(f"/api/v1/sessions/{sid}/questions").json()["data"]
    benefits = next(q for a in catalog["areas"] for q in a["questions"] if q["question_key"] == "q_details")
    assert benefits["offers"][oid]["status"] == "unanswered"
    stale = client.post(f"/api/v1/sessions/{sid}/offers/{oid}/reset", json={"version": before["version"]})
    assert stale.status_code == 409
