"""并发请求回归：进程内 SQLite(StaticPool 单连接)不得互相踩踏。

历史症状：FastAPI 线程池多线程并发使用同一 sqlite3 连接时，
偶发 500（sqlite3.InterfaceError）/ 401 User no longer exists /
404 Session not found / Result not found。前端会因此误判会话失效、
丢弃工作区并重建会话（提交到一半报 Session not found）。

修复：请求级门闩把单进程内的请求处理串行化（app.main.DbGateMiddleware）。
本测试用多线程驱动 TestClient 复现并发，修复前必失败。
"""
import threading

from fastapi.testclient import TestClient

from app.main import app

ROUNDS = 80


def _hammer(client: TestClient, sid: str, paths: list[str], errors: list[str]) -> None:
    for i in range(ROUNDS):
        for path in paths:
            r = client.get(path)
            if r.status_code != 200:
                errors.append(f"GET {path} -> {r.status_code} {r.text[:120]}")
                return
        if i % 10 == 0:
            # 每 10 轮交错一次写入，制造读/写在共享连接上的竞态；
            # 总量控制在 telemetry 限流(120/分钟)之内，429 视为测试自身失误。
            r = client.post(
                f"/api/v1/sessions/{sid}/telemetry",
                json={"events": [{"event_type": "question_answered",
                                  "payload": {"question_key": f"q_{i}", "field_count": 1}}]},
            )
            if r.status_code != 200:
                errors.append(f"POST telemetry -> {r.status_code} {r.text[:120]}")
                return


def test_concurrent_requests_do_not_corrupt_state():
    with TestClient(app) as client:
        sid = client.post("/api/v1/sessions", json={"title": None}).json()["data"]["session_id"]

        paths = [
            f"/api/v1/sessions/{sid}",
            f"/api/v1/sessions/{sid}/offers",
            f"/api/v1/sessions/{sid}/questions",
            f"/api/v1/sessions/{sid}/preferences",
            f"/api/v1/sessions/{sid}/results/history",
            f"/api/v1/sessions/{sid}/due-diligence",
        ]
        errors: list[str] = []
        threads = [threading.Thread(target=_hammer, args=(client, sid, paths, errors))
                   for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(120)

    assert errors[:5] == [], f"并发请求出现非 200 响应: {errors[:5]}"


def test_writes_and_deletion_need_no_session_lock_registry():
    """全局闸门下不再分配冗余会话锁，写入和删除仍成功。"""
    from app.services import recompute

    with TestClient(app) as client:
        sid = client.post("/api/v1/sessions", json={"title": None}).json()["data"]["session_id"]
        # 触发一次持锁写入，确保注册表里有条目
        r = client.put(f"/api/v1/sessions/{sid}/preferences", json={
            "version": 1, "source": "manual",
            "weights": {"economic": 0.4, "growth": 0.3, "experience": 0.3},
        })
        assert r.status_code == 200, r.text
        assert not hasattr(recompute, "_session_locks")

        assert client.delete(f"/api/v1/sessions/{sid}").status_code == 200
