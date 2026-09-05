import httpx
import pytest
from app import kraken, ocr_models
from app.models import AppSetting, AdminAuditLog
from tests.conftest import make_user, auth_headers

_MODELS = [
    {"slug": "rec", "protected": True, "doi": None, "summary": "", "script": None,
     "keywords": [], "license": None, "size_bytes": 4096},
    {"slug": "rec-21788409", "protected": False, "doi": "10.5281/zenodo.21788409",
     "summary": "", "script": "Latn", "keywords": [], "license": None,
     "size_bytes": 128},
]


@pytest.fixture(autouse=True)
def _kraken_models(monkeypatch):
    ocr_models.invalidate()
    monkeypatch.setattr(
        kraken, "call",
        lambda method, path, **kw: httpx.Response(200, json={"models": _MODELS}))
    yield
    ocr_models.invalidate()


def test_valid_key_sets_active_and_audits(client, db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    r = client.put("/api/admin/ocr/model", json={"key": "rec-21788409"}, headers=auth_headers(db, admin))
    assert r.status_code == 200
    assert r.json() == {"active_key": "rec-21788409"}
    db.expire_all()
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "rec-21788409"
    assert db.query(AdminAuditLog).filter_by(event="ocr.model_change").count() == 1


def test_invalid_key_400(client, db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    r = client.put("/api/admin/ocr/model", json={"key": "bogus"}, headers=auth_headers(db, admin))
    assert r.status_code == 400
    assert "bogus" in r.json()["detail"]
    db.expire_all()
    from app.models import AdminAuditLog
    assert db.query(AdminAuditLog).filter_by(event="ocr.model_change").count() == 0


def test_requires_admin(client, db):
    u = make_user(db, email="u@test.fr")
    r = client.put("/api/admin/ocr/model", json={"key": "rec-21788409"}, headers=auth_headers(db, u))
    assert r.status_code == 403
