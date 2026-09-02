import pytest
from app.config import settings
from app.models import AppSetting, AdminAuditLog
from tests.conftest import make_user, auth_headers


@pytest.fixture(autouse=True)
def _whitelist(monkeypatch):
    monkeypatch.setattr(settings, "kraken_models", [
        {"key": "défaut", "seg_path": "/m/s", "rec_path": "/m/r"},
        {"key": "rapide", "seg_path": "/m/s", "rec_path": "/m/rf"},
    ], raising=False)


def test_valid_key_sets_active_and_audits(client, db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    r = client.put("/api/admin/ocr/model", json={"key": "rapide"}, headers=auth_headers(db, admin))
    assert r.status_code == 200
    assert r.json() == {"active_key": "rapide"}
    db.expire_all()
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "rapide"
    assert db.query(AdminAuditLog).filter_by(event="ocr.model_change").count() == 1


def test_invalid_key_400(client, db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    r = client.put("/api/admin/ocr/model", json={"key": "bogus"}, headers=auth_headers(db, admin))
    assert r.status_code == 400
    assert "bogus" in r.json()["detail"]


def test_requires_admin(client, db):
    u = make_user(db, email="u@test.fr")
    r = client.put("/api/admin/ocr/model", json={"key": "rapide"}, headers=auth_headers(db, u))
    assert r.status_code == 403
