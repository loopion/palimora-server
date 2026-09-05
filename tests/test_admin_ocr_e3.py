import httpx
import pytest

from app import kraken, ocr_models
from app.models import AppSetting
from tests.conftest import auth_headers, make_user

LOCAL_MODELS = [
    {"slug": "rec", "protected": True, "doi": None,
     "summary": "Modèle de reconnaissance baké par défaut", "script": None,
     "keywords": [], "license": None, "size_bytes": 4096},
    {"slug": "rec-21788409", "protected": False, "doi": "10.5281/zenodo.21788409",
     "summary": "French 18C cursive", "script": "Latn", "keywords": ["french"],
     "license": "CC-BY-4.0", "size_bytes": 128},
]

CATALOG = {
    "cached_at": "2026-09-05T08:00:00+00:00", "stale": False, "refreshing": False,
    "models": [{"doi": "10.5281/zenodo.1", "summary": "m1", "script": "Latn",
                "keywords": ["k"], "license": "CC-BY-4.0", "already_local": False}],
}


@pytest.fixture(autouse=True)
def _clean_cache():
    ocr_models.invalidate()
    yield
    ocr_models.invalidate()


@pytest.fixture()
def kstub(monkeypatch):
    """Record every proxied call and serve canned Kraken responses.

    `routes[(method, path)]` is either an (status, json) tuple or an Exception
    to raise. Unregistered paths 404; `GET /models` is registered by default."""
    calls: list[dict] = []
    routes: dict[tuple[str, str], object] = {
        ("GET", "/models"): (200, {"models": LOCAL_MODELS}),
    }

    def fake_call(method, path, *, json_body=None, params=None, timeout=30.0):
        calls.append({"method": method, "path": path, "json": json_body,
                      "params": params})
        entry = routes.get((method, path))
        if isinstance(entry, Exception):
            raise entry
        if entry is None:
            return httpx.Response(404, json={"detail": "not found"})
        status, body = entry
        return httpx.Response(status, json=body)

    monkeypatch.setattr(kraken, "call", fake_call)

    class _Stub:
        pass

    stub = _Stub()
    stub.calls = calls
    stub.routes = routes
    return stub


def _admin(db):
    return make_user(db, email="a@test.fr", is_admin=True)


def test_panel_exposes_local_models_and_active_slug(client, db, kstub):
    admin = _admin(db)
    r = client.get("/api/admin/ocr", headers=auth_headers(db, admin))
    assert r.status_code == 200
    body = r.json()
    assert [m["slug"] for m in body["local_models"]] == ["rec", "rec-21788409"]
    assert body["active_slug"] == "rec"
    assert body["active_key"] == "rec"
    assert body["active_source"] == "fallback"
    assert body["kraken_error"] is None
    assert "models" not in body           # the E2 env-whitelist key is gone
    assert body["recent"] == [] and body["aggregates"] == []


def test_panel_reflects_the_stored_slug(client, db, kstub):
    admin = _admin(db)
    db.add(AppSetting(key="ocr_model", value="rec-21788409"))
    db.commit()
    body = client.get("/api/admin/ocr", headers=auth_headers(db, admin)).json()
    assert body["active_slug"] == "rec-21788409"
    assert body["active_source"] == "setting"


def test_panel_survives_a_kraken_outage(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("GET", "/models")] = kraken.KrakenError("down")
    r = client.get("/api/admin/ocr", headers=auth_headers(db, admin))
    assert r.status_code == 200
    body = r.json()
    assert body["local_models"] == []
    assert body["kraken_error"] == "Service Kraken injoignable"
    assert body["active_slug"] == "rec"
    assert "aggregates" in body and "recent" in body


def test_panel_requires_admin(client, db, kstub):
    u = make_user(db, email="u@test.fr")
    assert client.get("/api/admin/ocr", headers=auth_headers(db, u)).status_code == 403
