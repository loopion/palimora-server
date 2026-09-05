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


def test_catalog_proxies_repo_with_params(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("GET", "/repo")] = (200, CATALOG)
    r = client.get("/api/admin/ocr/catalog?script=Grek&all=false",
                   headers=auth_headers(db, admin))
    assert r.status_code == 200
    assert r.json() == CATALOG
    proxied = [c for c in kstub.calls if c["path"] == "/repo"][0]
    assert proxied["method"] == "GET"
    assert proxied["params"] == {"script": "Grek", "all": "false"}


def test_catalog_defaults_to_latn(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("GET", "/repo")] = (200, CATALOG)
    client.get("/api/admin/ocr/catalog", headers=auth_headers(db, admin))
    proxied = [c for c in kstub.calls if c["path"] == "/repo"][0]
    assert proxied["params"] == {"script": "Latn", "all": "false"}


def test_catalog_all_true_is_relayed(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("GET", "/repo")] = (200, CATALOG)
    client.get("/api/admin/ocr/catalog?all=true", headers=auth_headers(db, admin))
    proxied = [c for c in kstub.calls if c["path"] == "/repo"][0]
    assert proxied["params"]["all"] == "true"


def test_catalog_502_when_kraken_is_down(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("GET", "/repo")] = kraken.KrakenError("down")
    r = client.get("/api/admin/ocr/catalog", headers=auth_headers(db, admin))
    assert r.status_code == 502
    assert r.json()["detail"] == "Service Kraken injoignable"


def test_catalog_refresh_proxies_and_returns_202(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("POST", "/repo/refresh")] = (202, {"job_id": "j-ref", "status": "started"})
    r = client.post("/api/admin/ocr/catalog/refresh", headers=auth_headers(db, admin))
    assert r.status_code == 202
    assert r.json() == {"job_id": "j-ref", "status": "started"}
    assert ("POST", "/repo/refresh") in {(c["method"], c["path"]) for c in kstub.calls}


def test_job_status_is_proxied(client, db, kstub):
    admin = _admin(db)
    job = {"kind": "pull", "job_id": "j1", "status": "finished",
           "doi": "10.5281/zenodo.1", "slug": "rec-1", "error": None, "progress": 100}
    kstub.routes[("GET", "/models/jobs/j1")] = (200, job)
    r = client.get("/api/admin/ocr/models/jobs/j1", headers=auth_headers(db, admin))
    assert r.status_code == 200 and r.json() == job


def test_unknown_job_404_is_relayed(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("GET", "/models/jobs/nope")] = (404, {"detail": "Job introuvable"})
    r = client.get("/api/admin/ocr/models/jobs/nope", headers=auth_headers(db, admin))
    assert r.status_code == 404
    assert r.json()["detail"] == "Job introuvable"


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/admin/ocr/catalog"),
    ("POST", "/api/admin/ocr/catalog/refresh"),
    ("GET", "/api/admin/ocr/models/jobs/j1"),
])
def test_catalog_routes_require_admin(client, db, kstub, method, path):
    u = make_user(db, email="u@test.fr")
    assert client.request(method, path, headers=auth_headers(db, u)).status_code == 403
