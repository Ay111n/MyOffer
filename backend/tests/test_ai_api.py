"""Exercise the real private Node bridge, without provider calls or real credentials."""
from fastapi.testclient import TestClient

from app.main import app


def test_model_config_identity_isolation_and_no_comparison_replacement():
    with TestClient(app) as client:
        assert client.get("/api/v1/ai/config").status_code == 401
        config = client.post("/api/v1/ai/bootstrap")
        assert config.status_code == 200, config.text
        alice_cookie = client.cookies.get("offer_sid")
        providers = config.json()["data"]["providers"]
        assert {"openai", "anthropic", "github-copilot"} <= {p["id"] for p in providers}
        model = next(p for p in providers if p["id"] == "deepseek")["models"][0]["id"]
        assert client.put("/api/v1/ai/selection", json={"provider": "deepseek", "model": model}).status_code == 400
        saved = client.put("/api/v1/ai/providers/deepseek/key", json={"api_key": "test-secret-key"})
        assert saved.status_code == 200
        assert "test-secret-key" not in saved.text
        assert client.put("/api/v1/ai/selection", json={"provider": "deepseek", "model": model}).status_code == 200

        # Settings identity is reused by the main flow; opening settings cannot erase an Offer.
        sid = client.post("/api/v1/sessions").json()["data"]["session_id"]
        assert client.cookies.get("offer_sid") == alice_cookie
        assert client.post("/api/v1/ai/bootstrap").json()["data"]["selected"]["model"] == model
        assert client.get(f"/api/v1/sessions/{sid}").status_code == 200

        client.cookies.clear()
        bob = client.post("/api/v1/ai/bootstrap").json()["data"]
        assert bob["selected"] is None
        assert all(p["auth_type"] is None for p in bob["providers"])
        client.cookies.set("offer_sid", alice_cookie)
        assert client.get("/api/v1/ai/config").json()["data"]["selected"]["model"] == model
        disconnected = client.delete("/api/v1/ai/providers/deepseek").json()["data"]
        assert disconnected["selected"] is None
        assert next(p for p in disconnected["providers"] if p["id"] == "deepseek")["auth_type"] is None


def test_secret_validation_and_unknown_provider_use_safe_envelope():
    with TestClient(app) as client:
        client.post("/api/v1/ai/bootstrap")
        for key in ["", "a\nb", "s" * 4097]:
            result = client.put("/api/v1/ai/providers/deepseek/key", json={"api_key": key})
            assert result.status_code == 422
            assert "input" not in result.json()["error"]["details"]
            if key:
                assert key not in result.text
        result = client.put("/api/v1/ai/providers/unknown/key", json={"api_key": "secret"})
        assert result.status_code == 400
        assert result.json()["error"]["code"] == "unknown_provider"
        assert client.get("/api/v1/ai/jobs/00000000-0000-0000-0000-000000000001").status_code == 404
        schema = app.openapi()["components"]["schemas"]
        assert schema["AiKeyRequest"]["properties"]["api_key"]["writeOnly"] is True


def test_backend_restart_clears_model_credentials():
    with TestClient(app) as client:
        client.post("/api/v1/ai/bootstrap")
        client.put("/api/v1/ai/providers/deepseek/key", json={"api_key": "temporary-key"})
        cookie = client.cookies.get("offer_sid")
    with TestClient(app) as client:
        client.cookies.set("offer_sid", cookie)
        config = client.get("/api/v1/ai/config").json()["data"]
        assert all(p["auth_type"] is None for p in config["providers"])
