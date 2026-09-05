import httpx
import pytest
from app import kraken, ocr_models, ocr_service
from app.models import Page, Document, AppSetting
from tests.conftest import make_user, auth_headers

_MODELS = [
    {"slug": "rec", "protected": True, "doi": None, "summary": "", "script": None,
     "keywords": [], "license": None, "size_bytes": 4096},
    {"slug": "rec-21788409", "protected": False, "doi": "10.5281/zenodo.21788409",
     "summary": "French 18C", "script": "Latn", "keywords": [], "license": None,
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


def test_switch_model_then_ocr_records_new_key(client, db, monkeypatch):
    admin = make_user(db, email="a@test.fr", is_admin=True, credits=100)

    # 1. switch active model via the admin endpoint
    r = client.put("/api/admin/ocr/model", json={"key": "rec-21788409"},
                   headers=auth_headers(db, admin))
    assert r.status_code == 200
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "rec-21788409"

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
    model = ocr_models.resolve_active(db)
    ocr_service.run_ocr_job({"page_id": page.id, "kind": "image",
                             "model_key": model["key"],
                             "seg_model_path": model["seg_path"],
                             "rec_model_path": model["rec_path"]})

    assert captured.get("rec_model_path") == "/models/rec-21788409.mlmodel"
    assert captured.get("seg_model_path") is None
    db.expire_all()
    p = db.query(Page).get(page.id)
    assert p.ocr_model_key == "rec-21788409"
    assert p.ocr_submitted_at is not None and p.ocr_finished_at is not None

    # 3. panel reflects it
    body = client.get("/api/admin/ocr", headers=auth_headers(db, admin)).json()
    assert body["active_key"] == "rec-21788409"
    assert body["active_slug"] == "rec-21788409"
    assert any(row["model_key"] == "rec-21788409" for row in body["recent"])
