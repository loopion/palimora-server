from datetime import datetime, timezone, timedelta
import pytest
from app.config import settings
from app.models import Page, Document, Transcription
from tests.conftest import make_user, auth_headers


@pytest.fixture(autouse=True)
def _whitelist(monkeypatch):
    monkeypatch.setattr(settings, "kraken_models", [
        {"key": "défaut", "seg_path": "/m/seg.mlmodel", "rec_path": "/m/rec.mlmodel"},
        {"key": "rapide", "seg_path": "/m/seg.mlmodel", "rec_path": "/m/rec-fast.mlmodel"},
    ], raising=False)
    monkeypatch.setattr(settings, "kraken_models_default", "défaut", raising=False)


def _page(db, doc, *, key, dur_s, conf, when=None):
    when = when or datetime.now(timezone.utc)
    p = Page(document_id=doc.id, page_number=1, processing_status="done",
             ocr_submitted_at=when, ocr_finished_at=when + timedelta(seconds=dur_s),
             ocr_model_key=key, ocr_batch_size=1)
    db.add(p); db.flush()
    db.add(Transcription(page_id=p.id, raw_htr_text="x", edited_text="",
                         confidence_score=conf, source="htr", version_number=1))
    return p


def test_shape_and_active(client, db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    doc = Document(user_id=admin.id, title="Doc A"); db.add(doc); db.commit()
    _page(db, doc, key="défaut", dur_s=90, conf=0.7)
    _page(db, doc, key="rapide", dur_s=30, conf=0.6)
    db.commit()
    r = client.get("/api/admin/ocr", headers=auth_headers(db, admin))
    assert r.status_code == 200
    body = r.json()
    assert [m["key"] for m in body["models"]] == ["défaut", "rapide"]
    assert body["active_key"] == "défaut"
    assert body["active_source"] == "env_default"
    assert len(body["recent"]) == 2
    assert body["recent"][0]["duration_s"] in (30.0, 90.0)
    agg = {a["model_key"]: a for a in body["aggregates"]}
    assert agg["défaut"]["pages"] == 1
    assert agg["rapide"]["median_s"] == 30.0


def test_recent_capped_at_50_and_excludes_untimed(client, db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    doc = Document(user_id=admin.id, title="D"); db.add(doc); db.commit()
    for _ in range(55):
        _page(db, doc, key="défaut", dur_s=10, conf=0.5)
    db.add(Page(document_id=doc.id, page_number=1, processing_status="idle"))  # untimed
    db.commit()
    r = client.get("/api/admin/ocr", headers=auth_headers(db, admin))
    assert len(r.json()["recent"]) == 50


def test_aggregates_window_30_days(client, db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    doc = Document(user_id=admin.id, title="D"); db.add(doc); db.commit()
    old = datetime.now(timezone.utc) - timedelta(days=40)
    _page(db, doc, key="défaut", dur_s=99, conf=0.5, when=old)
    _page(db, doc, key="défaut", dur_s=11, conf=0.5)
    db.commit()
    r = client.get("/api/admin/ocr", headers=auth_headers(db, admin))
    agg = {a["model_key"]: a for a in r.json()["aggregates"]}
    assert agg["défaut"]["pages"] == 1  # the 40-day-old one excluded


def test_fast_error_page_excluded_from_timing_counted_in_errors(client, db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    doc = Document(user_id=admin.id, title="D"); db.add(doc); db.commit()
    _page(db, doc, key="rapide", dur_s=88, conf=0.7)  # healthy, done
    broken = _page(db, doc, key="rapide", dur_s=0.2, conf=0.0)  # errored fast
    broken.processing_status = "error"
    db.commit()
    r = client.get("/api/admin/ocr", headers=auth_headers(db, admin))
    agg = {a["model_key"]: a for a in r.json()["aggregates"]}
    assert agg["rapide"]["pages"] == 1  # only the done page
    assert agg["rapide"]["errors"] == 1
    assert agg["rapide"]["median_s"] == 88.0  # not dragged to 0.2


def test_requires_admin(client, db):
    u = make_user(db, email="u@test.fr")
    assert client.get("/api/admin/ocr", headers=auth_headers(db, u)).status_code == 403
