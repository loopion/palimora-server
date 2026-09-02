from datetime import datetime, timezone
from app.models import Page, Document
from tests.conftest import make_user


def test_page_has_ocr_timing_columns_with_defaults(db):
    u = make_user(db, email="u@test.fr")
    doc = Document(user_id=u.id, title="D")
    db.add(doc); db.commit()
    p = Page(document_id=doc.id, page_number=1)
    db.add(p); db.commit()
    db.expire_all()
    saved = db.query(Page).one()
    assert saved.ocr_submitted_at is None
    assert saved.ocr_finished_at is None
    assert saved.ocr_model_key == ""
    assert saved.ocr_batch_size == 1


def test_timing_columns_roundtrip(db):
    u = make_user(db, email="u@test.fr")
    doc = Document(user_id=u.id, title="D")
    db.add(doc); db.commit()
    now = datetime(2026, 9, 2, 12, 0, tzinfo=timezone.utc)
    p = Page(document_id=doc.id, page_number=1,
             ocr_submitted_at=now, ocr_finished_at=now, ocr_model_key="rapide", ocr_batch_size=3)
    db.add(p); db.commit()
    db.expire_all()
    saved = db.query(Page).one()
    assert saved.ocr_model_key == "rapide"
    assert saved.ocr_batch_size == 3
