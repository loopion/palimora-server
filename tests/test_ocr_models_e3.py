import httpx
import pytest

from app import kraken, ocr_models
from app.models import AdminAuditLog, AppSetting
from tests.conftest import make_user

MODELS = [
    {"slug": "rec", "protected": True, "doi": None,
     "summary": "Modèle de reconnaissance baké par défaut", "script": None,
     "keywords": [], "license": None, "size_bytes": 4096},
    {"slug": "rec-21788409", "protected": False, "doi": "10.5281/zenodo.21788409",
     "summary": "French 18C cursive", "script": "Latn", "keywords": ["french"],
     "license": "CC-BY-4.0", "size_bytes": 128},
]


@pytest.fixture(autouse=True)
def _clean_cache():
    ocr_models.invalidate()
    yield
    ocr_models.invalidate()


@pytest.fixture()
def kraken_models(monkeypatch):
    """Stub kraken.call for GET /models. `state` lets a test change the payload
    or make the call blow up, and counts the calls (for the cache tests)."""
    state = {"models": [dict(m) for m in MODELS], "error": None, "calls": 0}

    def fake_call(method, path, *, json_body=None, params=None, timeout=30.0):
        state["calls"] += 1
        if state["error"] is not None:
            raise state["error"]
        assert (method, path) == ("GET", "/models")
        return httpx.Response(200, json={"models": state["models"]})

    monkeypatch.setattr(kraken, "call", fake_call)
    return state


def test_list_models_hits_kraken(kraken_models):
    out = ocr_models.list_models()
    assert [m["slug"] for m in out] == ["rec", "rec-21788409"]
    assert kraken_models["calls"] == 1


def test_list_models_is_cached_for_60s(kraken_models):
    ocr_models.list_models()
    ocr_models.list_models()
    ocr_models.list_models()
    assert kraken_models["calls"] == 1


def test_force_bypasses_the_cache(kraken_models):
    ocr_models.list_models()
    ocr_models.list_models(force=True)
    assert kraken_models["calls"] == 2


def test_cache_expires_after_ttl(kraken_models, monkeypatch):
    ocr_models.list_models()
    now = ocr_models._CACHE["at"]
    monkeypatch.setattr(ocr_models.time, "monotonic", lambda: now + ocr_models._TTL + 1)
    ocr_models.list_models()
    assert kraken_models["calls"] == 2


def test_list_models_raises_on_kraken_error(kraken_models):
    kraken_models["error"] = kraken.KrakenError("down")
    with pytest.raises(kraken.KrakenError):
        ocr_models.list_models()


def test_list_models_raises_on_unexpected_status(monkeypatch):
    monkeypatch.setattr(kraken, "call",
                        lambda *a, **k: httpx.Response(404, json={"detail": "nope"}))
    with pytest.raises(kraken.KrakenError):
        ocr_models.list_models()


def test_get_model(kraken_models):
    assert ocr_models.get_model("rec-21788409")["script"] == "Latn"
    assert ocr_models.get_model("nope") is None


def test_resolve_active_falls_back_to_rec_when_unset(db, kraken_models):
    assert ocr_models.resolve_active(db) == {"key": "rec", "rec_path": None, "seg_path": None}
    assert ocr_models.active_slug(db) == "rec"
    assert ocr_models.active_source(db) == "fallback"


def test_resolve_active_uses_the_stored_slug(db, kraken_models):
    db.add(AppSetting(key="ocr_model", value="rec-21788409"))
    db.commit()
    assert ocr_models.resolve_active(db) == {
        "key": "rec-21788409",
        "rec_path": "/models/rec-21788409.mlmodel",
        "seg_path": None,
    }
    assert ocr_models.active_slug(db) == "rec-21788409"
    assert ocr_models.active_source(db) == "setting"


def test_stored_slug_that_vanished_falls_back(db, kraken_models):
    db.add(AppSetting(key="ocr_model", value="rec-deleted"))
    db.commit()
    assert ocr_models.resolve_active(db)["key"] == "rec"
    assert ocr_models.active_source(db) == "fallback"


def test_resolve_active_degrades_when_kraken_is_down(db, kraken_models):
    db.add(AppSetting(key="ocr_model", value="rec-21788409"))
    db.commit()
    kraken_models["error"] = kraken.KrakenError("down")
    assert ocr_models.resolve_active(db) == {"key": "rec", "rec_path": None, "seg_path": None}
    assert ocr_models.active_slug(db) == "rec"


def test_set_active_rejects_an_unknown_slug(db, kraken_models):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    with pytest.raises(ValueError):
        ocr_models.set_active(db, "rec-bogus", admin)


def test_set_active_writes_setting_and_audit_and_busts_cache(db, kraken_models):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    ocr_models.list_models()
    ocr_models.set_active(db, "rec-21788409", admin)
    db.commit()
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "rec-21788409"
    row = db.query(AdminAuditLog).filter_by(event="ocr.model_change").one()
    assert row.actor_user_id == admin.id
    assert row.path == "/api/admin/ocr/model"
    assert ocr_models._CACHE["models"] is None
    ocr_models.list_models()
    assert kraken_models["calls"] == 3  # list, set_active's validation, post-bust list


def test_set_active_upserts(db, kraken_models):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    ocr_models.set_active(db, "rec-21788409", admin); db.commit()
    ocr_models.set_active(db, "rec", admin); db.commit()
    assert db.query(AppSetting).filter_by(key="ocr_model").count() == 1
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "rec"


def test_list_models_returns_copies(kraken_models):
    out = ocr_models.list_models()
    out[0]["slug"] = "mutated"
    assert ocr_models.list_models()[0]["slug"] == "rec"
