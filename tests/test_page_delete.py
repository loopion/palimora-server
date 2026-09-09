"""DELETE /api/pages/{id} — remove a single scan from a document."""
from app.models import AISuggestion, Document, Page, PageJob, Segment, Transcription
from tests.conftest import auth_headers, make_user


def _doc_with_pages(db, n=3, content_type="image/png"):
    u = make_user(db, email="d@test.fr", credits=100)
    doc = Document(user_id=u.id, title="D")
    db.add(doc)
    db.commit()
    pages = []
    for i in range(n):
        ext = "pdf" if content_type == "application/pdf" else "png"
        key = f"k/{doc.id}.{ext}" if content_type == "application/pdf" else f"k/{doc.id}-{i}.png"
        p = Page(document_id=doc.id, page_number=i + 1, content_type=content_type,
                 storage_key=key, processing_status="to_review")
        db.add(p)
        pages.append(p)
    db.commit()
    return u, doc, pages


def test_delete_middle_page_renumbers_and_cascades(client, db):
    u, doc, pages = _doc_with_pages(db, 3)
    victim_id, doc_id = pages[1].id, doc.id
    db.add(Transcription(page_id=victim_id, version_number=1, raw_htr_text="x"))
    db.add(PageJob(page_id=victim_id, status="finished"))
    db.commit()
    tr_id = db.query(Transcription).filter_by(page_id=victim_id).one().id
    db.add(Segment(transcription_id=tr_id, reading_order=0, source_text="s"))
    db.commit()

    r = client.delete(f"/api/pages/{victim_id}", headers=auth_headers(db, u))
    assert r.status_code == 200
    assert r.json() == {"ok": True, "remaining": 2}

    db.expire_all()
    assert db.query(Page).filter_by(id=victim_id).one_or_none() is None
    assert db.query(Transcription).filter_by(page_id=victim_id).count() == 0
    assert db.query(Segment).filter_by(transcription_id=tr_id).count() == 0
    assert db.query(PageJob).filter_by(page_id=victim_id).count() == 0
    nums = sorted(p.page_number for p in db.query(Page).filter_by(document_id=doc_id))
    assert nums == [1, 2]


def test_delete_last_page_resets_document_status(client, db):
    u, doc, pages = _doc_with_pages(db, 1)
    r = client.delete(f"/api/pages/{pages[0].id}", headers=auth_headers(db, u))
    assert r.status_code == 200 and r.json()["remaining"] == 0
    db.expire_all()
    assert db.query(Document).get(doc.id).status == "draft"


def test_delete_one_pdf_page_keeps_shared_original(client, db, monkeypatch):
    u, doc, pages = _doc_with_pages(db, 3, content_type="application/pdf")
    deleted_keys: list[str] = []
    from app import storage
    monkeypatch.setattr(storage, "delete_object", lambda k: deleted_keys.append(k))

    r = client.delete(f"/api/pages/{pages[0].id}", headers=auth_headers(db, u))
    assert r.status_code == 200
    # siblings still reference k/<doc>.pdf → the original must NOT be dropped
    assert pages[0].storage_key not in deleted_keys


def test_delete_blocked_while_processing(client, db):
    u, doc, pages = _doc_with_pages(db, 2)
    pages[0].processing_status = "transcribing"
    db.commit()
    r = client.delete(f"/api/pages/{pages[0].id}", headers=auth_headers(db, u))
    assert r.status_code == 409
    db.expire_all()
    assert db.query(Page).filter_by(id=pages[0].id).one_or_none() is not None


def test_delete_requires_ownership(client, db):
    _, _, pages = _doc_with_pages(db, 1)
    other = make_user(db, email="other@test.fr")
    r = client.delete(f"/api/pages/{pages[0].id}", headers=auth_headers(db, other))
    assert r.status_code == 404
