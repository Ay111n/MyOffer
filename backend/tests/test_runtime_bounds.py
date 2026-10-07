"""内存上限、淘汰级联、闸门超时/取消及认证事务的回归。"""
import asyncio
import io
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.api.deps import hash_token, resolve_user
from app.config import get_settings
from app.db.base import Base
from app.db.gate import DbGate
from app.db.session import get_engine
from app.main import DbGateMiddleware
from app.models import AuthSession, DecisionResult, DecisionSession, Offer, TelemetryEvent, User
from app.services import telemetry_service
from app.services.retention import prune_state
from app.services.session_service import create_session, ensure_identity


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    with engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA foreign_keys=ON")
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as session:
        yield session
    engine.dispose()


def test_identity_cap_evicts_oldest_and_cascades(db, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_identities", 2)
    oldest, _, _ = create_session(db, "old")
    old_user = oldest.user_id
    newer, _, _ = create_session(db, "new")
    oldest.updated_at = datetime.now(UTC) - timedelta(hours=2)
    db.get(User, old_user).updated_at = oldest.updated_at
    db.add(DecisionResult(session_id=oldest.id, seq=1, rule_version="test",
                          snapshot_schema_version=1, trigger_type="test", payload={}))
    db.commit()
    create_session(db, "third")
    assert db.scalar(select(func.count()).select_from(User)) == 2
    assert db.scalar(select(DecisionSession.id).where(DecisionSession.id == oldest.id)) is None
    assert db.scalar(select(Offer.id).where(Offer.session_id == oldest.id)) is None
    assert db.scalar(select(DecisionResult.id).where(DecisionResult.session_id == oldest.id)) is None
    assert db.scalar(select(AuthSession.id).where(AuthSession.user_id == old_user)) is None
    assert db.scalar(select(DecisionSession.id).where(DecisionSession.id == newer.id)) == newer.id


def test_session_cap_uses_updated_at_and_preserves_current_identity(db, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_sessions", 2)
    first, _, _ = create_session(db, "first")
    second, _, _ = create_session(db, "second")
    second.updated_at = datetime.now(UTC) - timedelta(hours=2)
    db.commit()
    create_session(db, "third")
    assert db.scalar(select(func.count()).select_from(DecisionSession)) == 2
    assert db.scalar(select(DecisionSession.id).where(DecisionSession.id == first.id)) == first.id
    assert db.scalar(select(DecisionSession.id).where(DecisionSession.id == second.id)) is None


def test_pruning_reclaims_idle_comparisons_and_expired_settings_only_identities(db):
    old, _, _ = create_session(db, "old")
    fresh, _, _ = create_session(db, "fresh")
    identity, _, _ = ensure_identity(db)
    db.commit()
    old.updated_at = datetime.now(UTC) - timedelta(days=3)
    auth = db.scalar(select(AuthSession).where(AuthSession.user_id == identity.id))
    auth.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()
    prune_state(db)
    db.commit()
    assert db.scalar(select(DecisionSession.id).where(DecisionSession.id == old.id)) is None
    assert db.scalar(select(User.id).where(User.id == identity.id)) is None
    assert db.scalar(select(DecisionSession.id).where(DecisionSession.id == fresh.id)) == fresh.id


def test_telemetry_disabled_and_bounded_when_enabled(db, monkeypatch):
    settings = get_settings()
    sid = uuid4()
    events = [("step_enter", {"step": "completion"}, None)]
    monkeypatch.setattr(settings, "telemetry_enabled", False)
    assert telemetry_service.store_batch(db, sid, events) == 0
    assert db.scalar(select(func.count()).select_from(TelemetryEvent)) == 0
    monkeypatch.setattr(settings, "telemetry_enabled", True)
    monkeypatch.setattr(settings, "telemetry_max_per_session", 2)
    monkeypatch.setattr(settings, "telemetry_max_total", 3)
    for _ in range(5):
        telemetry_service.store_batch(db, sid, events)
        db.commit()
    assert db.scalar(select(func.count()).select_from(TelemetryEvent)) == 2
    telemetry_service.store_batch(db, uuid4(), events * 4)
    db.commit()
    assert db.scalar(select(func.count()).select_from(TelemetryEvent)) == 3


def test_resolve_user_never_commits_flushed_business_changes(db):
    session, token, _ = create_session(db, "original")
    session.title = "uncommitted"
    db.flush()
    request = Request({"type": "http", "headers": [(b"cookie", f"offer_sid={token}".encode())]})
    resolve_user(request, db)
    db.rollback()
    assert db.get(DecisionSession, session.id).title == "original"


def test_hmac_depends_on_session_secret(monkeypatch):
    old = hash_token("token")
    monkeypatch.setattr(get_settings(), "session_secret", "a" * 32)
    assert hash_token("token") != old


def test_sqlite_has_page_limit():
    with get_engine().connect() as conn:
        pages = conn.scalar(text("PRAGMA max_page_count"))
        size = conn.scalar(text("PRAGMA page_size"))
    assert pages * size <= get_settings().memory_db_max_mb * 1024 * 1024


def test_gate_fifo_timeout_and_cancellation():
    async def exercise():
        gate = DbGate()
        await gate.acquire(1)
        order = []

        async def enter(i):
            await gate.acquire(1)
            try:
                order.append(i)
                await asyncio.sleep(0)
            finally:
                gate.release()

        tasks = [asyncio.create_task(enter(i)) for i in range(6)]
        await asyncio.sleep(0)
        tasks[2].cancel()
        with pytest.raises(asyncio.CancelledError):
            await tasks[2]
        with pytest.raises(TimeoutError):
            await gate.acquire(0.01)
        gate.release()
        await asyncio.gather(*(t for i, t in enumerate(tasks) if i != 2))
        assert order == [0, 1, 3, 4, 5]
        # 取消发生在授予锁之后、Future 唤醒之前，也必须交接给下个请求。
        await gate.acquire(1)
        cancelled = asyncio.create_task(enter(6))
        await asyncio.sleep(0)
        gate.release()
        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled
        await gate.acquire(0.1)
        gate.release()
    asyncio.run(exercise())


def test_gate_timeout_returns_envelope_and_cors(monkeypatch):
    from fastapi.middleware.cors import CORSMiddleware
    gate = DbGate()
    application = FastAPI()
    application.add_middleware(DbGateMiddleware, gate=gate)
    application.add_middleware(CORSMiddleware, allow_origins=["http://localhost:3000"])
    monkeypatch.setattr(get_settings(), "db_gate_timeout_seconds", 0.01)
    asyncio.run(gate.acquire(1))
    try:
        with TestClient(application) as client:
            response = client.get("/test", headers={"Origin": "http://localhost:3000"})
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "server_busy"
        assert response.headers["retry-after"] == "1"
        assert response.headers["access-control-allow-origin"] == "http://localhost:3000"
    finally:
        gate.release()


def test_bridge_survives_non_json_and_invalid_frames(monkeypatch, caplog):
    from app.services import ai_service
    process = SimpleNamespace(stdout=io.StringIO('noisy secret\n[]\n{"id":"valid","data":{}}\n'),
                              stderr=io.StringIO('TypeError: sensitive startup details\n'),
                              stdin=io.StringIO(), poll=lambda: 0)
    monkeypatch.setattr(ai_service.subprocess, "Popen", lambda *args, **kwargs: process)
    bridge = ai_service.AiBridge()
    bridge._start()
    assert bridge._messages.get(timeout=1)["id"] == "valid"
    assert bridge._messages.get(timeout=1) is None
    bridge.close()
    assert "skipped non-JSON" in caplog.text
    assert "noisy secret" not in caplog.text
    assert "sensitive startup details" not in caplog.text


def test_snapshot_window_and_cookie_renewal():
    from app.main import app
    with TestClient(app) as client:
        created = client.post("/api/v1/sessions", json={})
        sid = created.json()["data"]["session_id"]
        offers = client.get(f"/api/v1/sessions/{sid}/offers").json()["data"]
        oid = offers[0]["offer_id"]
        version = offers[0]["version"]
        for monthly_base in range(10000, 10013):
            response = client.patch(f"/api/v1/sessions/{sid}/offers/{oid}", json={
                "version": version,
                "facts": [{"field_key": "monthly_base", "value": monthly_base}],
            })
            assert response.status_code == 200, response.text
            version = response.json()["data"]["version"]
        history = client.get(f"/api/v1/sessions/{sid}/results/history")
        rows = history.json()["data"]
        assert len(rows) == 10
        assert rows[0]["seq"] - rows[-1]["seq"] == 9
        assert "Max-Age=172800" in history.headers["set-cookie"]
        assert client.get("/readyz").json()["database_ready"] is True


def test_sqlite_full_returns_safe_503_and_remains_usable():
    from app.api.errors import install_error_handlers
    application = FastAPI()
    install_error_handlers(application)

    @application.post("/fill")
    def fill():
        with engine.begin() as conn:
            conn.exec_driver_sql("INSERT INTO blobs VALUES (zeroblob(100000))")

    # 同步路由在另一线程；独立 SQLite 连接须共享这一小容量测试 DB。
    from sqlalchemy.pool import StaticPool
    engine = create_engine("sqlite://", poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    with engine.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE blobs (value BLOB)")
        conn.exec_driver_sql("PRAGMA max_page_count=4")
    with TestClient(application) as client:
        response = client.post("/fill")
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "storage_capacity"
    with engine.begin() as conn:
        conn.exec_driver_sql("INSERT INTO blobs VALUES ('small')")
        assert conn.scalar(text("SELECT count(*) FROM blobs")) == 1
    engine.dispose()
