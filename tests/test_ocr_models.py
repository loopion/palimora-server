import pytest
from app import ocr_models
from app.config import settings
from app.models import AppSetting, AdminAuditLog
from tests.conftest import make_user

WL = [
    {"key": "défaut", "seg_path": "/m/seg.mlmodel", "rec_path": "/m/rec.mlmodel"},
    {"key": "rapide", "seg_path": "/m/seg.mlmodel", "rec_path": "/m/rec-fast.mlmodel"},
]


@pytest.fixture(autouse=True)
def _whitelist(monkeypatch):
    monkeypatch.setattr(settings, "kraken_models", list(WL), raising=False)
    monkeypatch.setattr(settings, "kraken_models_default", "", raising=False)


def test_list_and_get(monkeypatch):
    assert ocr_models.list_models() == WL
    assert ocr_models.get_model("rapide")["rec_path"] == "/m/rec-fast.mlmodel"
    assert ocr_models.get_model("nope") is None


def test_resolve_fallback_when_nothing_set(db):
    assert ocr_models.resolve_active(db) == {"key": "défaut", "seg_path": None, "rec_path": None}
    assert ocr_models.active_source(db) == "fallback"


def test_resolve_env_default(db, monkeypatch):
    monkeypatch.setattr(settings, "kraken_models_default", "rapide", raising=False)
    assert ocr_models.resolve_active(db)["key"] == "rapide"
    assert ocr_models.active_source(db) == "env_default"


def test_resolve_setting_wins(db, monkeypatch):
    monkeypatch.setattr(settings, "kraken_models_default", "rapide", raising=False)
    db.add(AppSetting(key="ocr_model", value="défaut"))
    db.commit()
    assert ocr_models.resolve_active(db)["key"] == "défaut"
    assert ocr_models.active_source(db) == "setting"


def test_stale_setting_value_ignored(db):
    db.add(AppSetting(key="ocr_model", value="removed-model"))
    db.commit()
    assert ocr_models.resolve_active(db) == {"key": "défaut", "seg_path": None, "rec_path": None}


def test_resolve_active_returns_a_copy(db, monkeypatch):
    monkeypatch.setattr(settings, "kraken_models_default", "rapide", raising=False)
    a = ocr_models.resolve_active(db)
    a["seg_path"] = "/mutated"
    assert ocr_models.resolve_active(db)["seg_path"] == "/m/seg.mlmodel"


def test_set_active_rejects_unknown_key(db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    with pytest.raises(ValueError):
        ocr_models.set_active(db, "bogus", admin)


def test_set_active_writes_setting_and_audit(db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    ocr_models.set_active(db, "rapide", admin)
    db.commit()
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "rapide"
    row = db.query(AdminAuditLog).filter_by(event="ocr.model_change").one()
    assert row.actor_user_id == admin.id
    assert row.path == "/api/admin/ocr/model"


def test_set_active_upserts(db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    ocr_models.set_active(db, "rapide", admin); db.commit()
    ocr_models.set_active(db, "défaut", admin); db.commit()
    assert db.query(AppSetting).filter_by(key="ocr_model").count() == 1
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "défaut"
