import pytest

from app import kraken, ocr_models, ocr_service
from app.config import settings
from app.models import Document, Page
from tests.conftest import make_user


@pytest.fixture(autouse=True)
def _whitelist(monkeypatch):
    monkeypatch.setattr(settings, "kraken_models", [
        {"key": "rapide", "seg_path": "/m/seg.mlmodel", "rec_path": "/m/rec-fast.mlmodel"},
    ], raising=False)
    monkeypatch.setattr(settings, "kraken_models_default", "rapide", raising=False)


def _make_page(db, content_type="image/png", n=1):
    u = make_user(db, email="u@test.fr", credits=100)
    doc = Document(user_id=u.id, title="D")
    db.add(doc)
    db.commit()
    pages = []
    for i in range(n):
        p = Page(
            document_id=doc.id, page_number=i + 1, content_type=content_type,
            storage_key=f"k/{doc.id}.png" if content_type != "application/pdf" else f"k/{doc.id}.pdf",
            processing_status="queued", credits_charged=1,
        )
        db.add(p)
        pages.append(p)
    db.commit()
    return doc, pages


def test_enqueue_puts_model_in_payload(db, monkeypatch):
    captured = {}

    class _Q:
        def enqueue(self, fn, payload, **kw):
            captured.update(payload)

            class J:
                id = "j1"

            return J()

    monkeypatch.setattr("rq.Queue", lambda *a, **k: _Q())
    monkeypatch.setattr("redis.Redis.from_url", lambda *a, **k: object())
    _, pages = _make_page(db)
    ocr_service.enqueue_page_ocr(db, pages[0])
    assert captured["model_key"] == "rapide"
    assert captured["seg_model_path"] == "/m/seg.mlmodel"
    assert captured["rec_model_path"] == "/m/rec-fast.mlmodel"


def test_image_ocr_stamps_timing(client, db, monkeypatch):
    _, pages = _make_page(db)
    page_id = pages[0].id
    captured = {}
    monkeypatch.setattr(kraken, "submit_ocr", lambda *a, **k: captured.update(k) or "job-x")
    monkeypatch.setattr(kraken, "wait_for_result", lambda *a, **k: {"pages": [{"lines": []}]})
    monkeypatch.setattr(ocr_service, "_page_file_bytes", lambda page: b"x")
    ocr_service.run_ocr_job({
        "page_id": page_id, "kind": "image", "model_key": "rapide",
        "seg_model_path": "/m/seg.mlmodel", "rec_model_path": "/m/rec-fast.mlmodel",
    })
    db.expire_all()
    p = db.query(Page).get(page_id)
    assert p.ocr_submitted_at is not None and p.ocr_finished_at is not None
    assert p.ocr_model_key == "rapide"
    assert p.ocr_batch_size == 1
    assert captured["seg_model_path"] == "/m/seg.mlmodel"
    assert captured["rec_model_path"] == "/m/rec-fast.mlmodel"


def test_pdf_ocr_stamps_all_siblings_with_batch_size(client, db, monkeypatch):
    doc, pages = _make_page(db, content_type="application/pdf", n=3)
    first_id = pages[0].id
    monkeypatch.setattr(kraken, "submit_ocr", lambda *a, **k: "job-x")
    monkeypatch.setattr(kraken, "wait_for_result", lambda *a, **k: {"pages": [{"lines": []}, {"lines": []}, {"lines": []}]})
    monkeypatch.setattr(ocr_service, "_page_file_bytes", lambda page: b"x")
    monkeypatch.setattr(ocr_service, "_render_pdf_derivative", lambda *a, **k: None)
    ocr_service.run_ocr_job({
        "page_id": first_id, "kind": "pdf", "model_key": "rapide",
        "seg_model_path": "/m/seg.mlmodel", "rec_model_path": "/m/rec-fast.mlmodel",
    })
    db.expire_all()
    for p in db.query(Page).filter_by(document_id=doc.id).all():
        assert p.ocr_submitted_at is not None and p.ocr_finished_at is not None
        assert p.ocr_batch_size == 3
        assert p.ocr_model_key == "rapide"


def test_failed_ocr_still_stamps_timing_and_refunds(client, db, monkeypatch):
    _, pages = _make_page(db)
    page_id = pages[0].id
    monkeypatch.setattr(ocr_service, "_page_file_bytes", lambda page: b"x")

    def boom(*a, **k):
        raise kraken.KrakenError("kraken down")

    monkeypatch.setattr(kraken, "submit_ocr", boom)
    ocr_service.run_ocr_job({
        "page_id": page_id, "kind": "image", "model_key": "rapide",
        "seg_model_path": "/m/seg.mlmodel", "rec_model_path": "/m/rec-fast.mlmodel",
    })
    db.expire_all()
    p = db.query(Page).get(page_id)
    assert p.processing_status == "error"
    assert p.ocr_submitted_at is not None
    assert p.ocr_finished_at is not None
    assert p.ocr_model_key == "rapide"
    assert p.credits_charged == 0
