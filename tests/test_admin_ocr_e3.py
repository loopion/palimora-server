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


def test_pull_proxies_and_audits(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("POST", "/models")] = (
        202, {"job_id": "j-pull", "slug": "rec-1", "status": "started"})
    r = client.post("/api/admin/ocr/models", json={"doi": "10.5281/zenodo.1"},
                    headers=auth_headers(db, admin))
    assert r.status_code == 202
    assert r.json() == {"job_id": "j-pull", "slug": "rec-1", "status": "started"}
    proxied = [c for c in kstub.calls if c["path"] == "/models" and c["method"] == "POST"][0]
    assert proxied["json"] == {"doi": "10.5281/zenodo.1"}
    db.expire_all()
    row = db.query(AdminAuditLog).filter_by(event="ocr.model_pull").one()
    assert row.actor_user_id == admin.id
    assert row.path == "/api/admin/ocr/models"
    assert row.status_code == 202


def test_pull_relays_a_409_and_writes_no_audit(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("POST", "/models")] = (409, {"detail": "Modèle déjà présent"})
    r = client.post("/api/admin/ocr/models", json={"doi": "10.5281/zenodo.1"},
                    headers=auth_headers(db, admin))
    assert r.status_code == 409
    assert r.json()["detail"] == "Modèle déjà présent"
    db.expire_all()
    assert db.query(AdminAuditLog).filter_by(event="ocr.model_pull").count() == 0


def test_pull_relays_a_400(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("POST", "/models")] = (400, {"detail": "DOI Zenodo invalide"})
    r = client.post("/api/admin/ocr/models", json={"doi": "nope"},
                    headers=auth_headers(db, admin))
    assert r.status_code == 400
    assert r.json()["detail"] == "DOI Zenodo invalide"


def test_finished_pull_job_writes_a_completion_audit_and_busts_the_cache(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("GET", "/models/jobs/j-ok")] = (200, {
        "kind": "pull", "job_id": "j-ok", "status": "finished",
        "doi": "10.5281/zenodo.1", "slug": "rec-1", "error": None, "progress": 100})
    ocr_models.list_models()  # warm the cache
    r = client.get("/api/admin/ocr/models/jobs/j-ok", headers=auth_headers(db, admin))
    assert r.status_code == 200 and r.json()["status"] == "finished"
    assert ocr_models._CACHE["models"] is None
    db.expire_all()
    row = db.query(AdminAuditLog).filter_by(event="ocr.model_pull_done").one()
    assert row.actor_user_id == admin.id
    assert row.path == "/api/admin/ocr/models/jobs/j-ok"
    assert row.status_code == 200


def test_failed_pull_job_writes_a_500_completion_audit(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("GET", "/models/jobs/j-bad")] = (200, {
        "kind": "pull", "job_id": "j-bad", "status": "failed",
        "doi": "10.5281/zenodo.1", "slug": "rec-1",
        "error": "pas un modèle de reconnaissance", "progress": 0})
    r = client.get("/api/admin/ocr/models/jobs/j-bad", headers=auth_headers(db, admin))
    assert r.status_code == 200
    db.expire_all()
    row = db.query(AdminAuditLog).filter_by(event="ocr.model_pull_done").one()
    assert row.status_code == 500
    assert row.path == "/api/admin/ocr/models/jobs/j-bad"


def test_completion_audit_is_written_once_per_job(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("GET", "/models/jobs/j-ok")] = (200, {
        "kind": "pull", "job_id": "j-ok", "status": "finished",
        "doi": "10.5281/zenodo.1", "slug": "rec-1", "error": None, "progress": 100})
    for _ in range(3):
        client.get("/api/admin/ocr/models/jobs/j-ok", headers=auth_headers(db, admin))
    db.expire_all()
    assert db.query(AdminAuditLog).filter_by(event="ocr.model_pull_done").count() == 1


def test_a_running_pull_job_writes_no_completion_audit(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("GET", "/models/jobs/j-run")] = (200, {
        "kind": "pull", "job_id": "j-run", "status": "started",
        "doi": "10.5281/zenodo.1", "slug": "rec-1", "error": None, "progress": 42})
    ocr_models.list_models()
    client.get("/api/admin/ocr/models/jobs/j-run", headers=auth_headers(db, admin))
    db.expire_all()
    assert db.query(AdminAuditLog).filter_by(event="ocr.model_pull_done").count() == 0
    assert ocr_models._CACHE["models"] is not None  # cache untouched mid-pull


def test_a_refresh_job_writes_no_pull_audit(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("GET", "/models/jobs/j-ref")] = (200, {
        "kind": "refresh", "job_id": "j-ref", "status": "finished",
        "error": None, "count": 12})
    client.get("/api/admin/ocr/models/jobs/j-ref", headers=auth_headers(db, admin))
    db.expire_all()
    assert db.query(AdminAuditLog).filter_by(event="ocr.model_pull_done").count() == 0


def test_delete_refuses_the_active_model_without_calling_kraken(client, db, kstub):
    admin = _admin(db)
    db.add(AppSetting(key="ocr_model", value="rec-21788409"))
    db.commit()
    r = client.delete("/api/admin/ocr/models/rec-21788409",
                      headers=auth_headers(db, admin))
    assert r.status_code == 409
    assert "actif" in r.json()["detail"].lower()
    assert ("DELETE", "/models/rec-21788409") not in {
        (c["method"], c["path"]) for c in kstub.calls}


def test_delete_proxies_audits_and_busts_the_cache(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("DELETE", "/models/rec-21788409")] = (200, {"deleted": "rec-21788409"})
    ocr_models.list_models()  # warm the cache
    r = client.delete("/api/admin/ocr/models/rec-21788409",
                      headers=auth_headers(db, admin))
    assert r.status_code == 200
    assert r.json() == {"deleted": "rec-21788409"}
    assert ocr_models._CACHE["models"] is None
    db.expire_all()
    row = db.query(AdminAuditLog).filter_by(event="ocr.model_delete").one()
    assert row.path == "/api/admin/ocr/models/rec-21788409"
    assert row.status_code == 200


def test_delete_relays_krakens_protected_409(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("DELETE", "/models/rec")] = (409, {"detail": "Modèle protégé"})
    db.add(AppSetting(key="ocr_model", value="rec-21788409"))
    db.commit()
    r = client.delete("/api/admin/ocr/models/rec", headers=auth_headers(db, admin))
    assert r.status_code == 409
    assert r.json()["detail"] == "Modèle protégé"


def test_delete_relays_a_404(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("DELETE", "/models/rec-404")] = (404, {"detail": "Modèle introuvable"})
    r = client.delete("/api/admin/ocr/models/rec-404", headers=auth_headers(db, admin))
    assert r.status_code == 404


def test_put_model_accepts_a_live_slug(client, db, kstub):
    admin = _admin(db)
    r = client.put("/api/admin/ocr/model", json={"key": "rec-21788409"},
                   headers=auth_headers(db, admin))
    assert r.status_code == 200
    assert r.json() == {"active_key": "rec-21788409"}
    db.expire_all()
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "rec-21788409"


def test_put_model_rejects_an_unknown_slug(client, db, kstub):
    admin = _admin(db)
    r = client.put("/api/admin/ocr/model", json={"key": "rec-bogus"},
                   headers=auth_headers(db, admin))
    assert r.status_code == 400
    assert "rec-bogus" in r.json()["detail"]


def test_put_model_502_when_kraken_is_down(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("GET", "/models")] = kraken.KrakenError("down")
    r = client.put("/api/admin/ocr/model", json={"key": "rec-21788409"},
                   headers=auth_headers(db, admin))
    assert r.status_code == 502


@pytest.mark.parametrize("method,path,body", [
    ("POST", "/api/admin/ocr/models", {"doi": "10.5281/zenodo.1"}),
    ("DELETE", "/api/admin/ocr/models/rec-1", None),
    ("PUT", "/api/admin/ocr/model", {"key": "rec"}),
])
def test_write_routes_require_admin(client, db, kstub, method, path, body):
    u = make_user(db, email="u@test.fr")
    r = client.request(method, path, json=body, headers=auth_headers(db, u))
    assert r.status_code == 403


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/admin/ocr", None),
    ("GET", "/api/admin/ocr/catalog", None),
    ("POST", "/api/admin/ocr/catalog/refresh", None),
    ("POST", "/api/admin/ocr/models", {"doi": "10.5281/zenodo.1"}),
    ("DELETE", "/api/admin/ocr/models/rec-1", None),
    ("PUT", "/api/admin/ocr/model", {"key": "rec"}),
])
def test_every_ocr_route_403_during_impersonation(client, db, kstub, method, path, body):
    admin = _admin(db)
    target = make_user(db, email="t@test.fr")
    headers = {**auth_headers(db, admin), "X-Impersonate": target.id}
    assert client.request(method, path, json=body, headers=headers).status_code == 403
