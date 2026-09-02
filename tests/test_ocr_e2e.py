import pytest
from app import ocr_service, kraken
from app.config import settings
from app.models import Page, Document, AppSetting
from tests.conftest import make_user, auth_headers


@pytest.fixture(autouse=True)
def _whitelist(monkeypatch):
    monkeypatch.setattr(settings, "kraken_models", [
        {"key": "défaut", "seg_path": "/m/s", "rec_path": "/m/r"},
        {"key": "rapide", "seg_path": "/m/s2", "rec_path": "/m/rf"},
    ], raising=False)
    monkeypatch.setattr(settings, "kraken_models_default", "défaut", raising=False)


def test_switch_model_then_ocr_records_new_key(client, db, monkeypatch):
    admin = make_user(db, email="a@test.fr", is_admin=True, credits=100)

    # 1. switch active model via the admin endpoint
    r = client.put("/api/admin/ocr/model", json={"key": "rapide"}, headers=auth_headers(db, admin))
    assert r.status_code == 200
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "rapide"

    # 2. a page gets enqueued -> payload carries the switched model
    doc = Document(user_id=admin.id, title="D"); db.add(doc); db.commit()
    page = Page(document_id=doc.id, page_number=1, content_type="image/png",
                storage_key=f"k/{doc.id}.png", processing_status="queued", credits_charged=1)
    db.add(page); db.commit()

    captured = {}
    monkeypatch.setattr(kraken, "submit_ocr",
                        lambda *a, **k: captured.update(k) or "job-x")
    monkeypatch.setattr(kraken, "wait_for_result", lambda *a, **k: {"pages": [{"lines": []}]})
    monkeypatch.setattr(ocr_service, "_page_file_bytes", lambda p: b"x")

    # resolve + run as the worker would
    from app.ocr_models import resolve_active
    model = resolve_active(db)
    ocr_service.run_ocr_job({"page_id": page.id, "kind": "image",
                             "model_key": model["key"],
                             "seg_model_path": model["seg_path"], "rec_model_path": model["rec_path"]})

    assert captured.get("rec_model_path") == "/m/rf"
    db.expire_all()
    p = db.query(Page).get(page.id)
    assert p.ocr_model_key == "rapide"
    assert p.ocr_submitted_at is not None and p.ocr_finished_at is not None

    # 3. panel reflects it
    body = client.get("/api/admin/ocr", headers=auth_headers(db, admin)).json()
    assert body["active_key"] == "rapide"
    assert any(row["model_key"] == "rapide" for row in body["recent"])
