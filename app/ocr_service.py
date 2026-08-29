"""OCR job implementations (executed by the RQ worker) + enqueue helpers.

Two job shapes:
- image page: 1 page = 1 Kraken job
- PDF page:   1 Kraken job for the whole file, result split across the page rows
"""
import httpx
from sqlalchemy.orm import Session

from . import credits, kraken, storage
from .config import settings
from .models import Document, Page, PageJob, Transcription, Segment


def enqueue_page_ocr(db: Session, page: Page) -> str:
    """Enqueue the RQ job for one page. Returns the rq job id."""
    from redis import Redis
    from rq import Queue

    conn = Redis.from_url(settings.redis_url)
    queue = Queue(settings.queue_name, connection=conn, default_timeout=settings.kraken_timeout + 600)
    payload = {"page_id": page.id, "kind": "image" if not page.content_type.startswith("application/pdf") else "pdf"}
    job = queue.enqueue(
        "app.ocr_service.run_ocr_job",
        payload,
        job_timeout=settings.kraken_timeout + 600,
        result_ttl=86400,
        failure_ttl=86400,
    )
    db.add(PageJob(page_id=page.id, rq_job_id=job.id))
    return job.id


def run_ocr_job(payload: dict) -> dict:
    """RQ entrypoint (module-level function string reference)."""
    from .db import SessionLocal

    page_id = payload["page_id"]
    db = SessionLocal()
    try:
        page = db.query(Page).filter_by(id=page_id).one()
        document = db.query(Document).filter_by(id=page.document_id).one()
        try:
            if page.content_type.startswith("application/pdf"):
                _run_pdf(db, page, document)
            else:
                _run_image(db, page)
            db.commit()
            return {"ok": True, "page_id": page.id}
        except Exception as exc:  # noqa: BLE001 — refund + flag, never crash silently
            db.rollback()
            _fail(db, page, str(exc))
            db.commit()
            return {"ok": False, "page_id": page.id, "error": str(exc)[:500]}
    finally:
        db.close()


def _run_image(db: Session, page: Page) -> None:
    page.processing_status = "transcribing"
    db.commit()
    local = storage.download_to_temp(page.storage_key)
    try:
        with open(local, "rb") as f:
            file_bytes = f.read()
        ext = "." + (page.storage_key.rsplit(".", 1)[-1] or "bin")
        with httpx.Client() as http:
            job_id = kraken.submit_ocr(http, file_bytes, ext)
            page.kraken_job_id = job_id
            db.commit()
            result = kraken.wait_for_result(http, job_id)
        _save_result(db, page, result.get("pages") or [])
    finally:
        import os
        try:
            os.remove(local)
        except OSError:
            pass


def _run_pdf(db: Session, page: Page, document: Document) -> None:
    """One Kraken job for the whole PDF; siblings share the same storage_key."""
    siblings = (
        db.query(Page)
        .filter_by(document_id=document.id, storage_key=page.storage_key)
        .order_by(Page.page_number)
        .all()
    )
    for p in siblings:
        p.processing_status = "transcribing"
    db.commit()

    local = storage.download_to_temp(page.storage_key)
    try:
        with open(local, "rb") as f:
            file_bytes = f.read()
        with httpx.Client() as http:
            job_id = kraken.submit_ocr(http, file_bytes, ".pdf")
            for p in siblings:
                p.kraken_job_id = job_id
            db.commit()
            result = kraken.wait_for_result(http, job_id)
        pages_result = result.get("pages") or []
        for p in siblings:
            kraken_page = next(
                (pr for pr in pages_result if pr.get("page") == p.page_number), None
            )
            if kraken_page is None and p.page_number <= len(pages_result):
                kraken_page = pages_result[p.page_number - 1]
            _save_result(db, p, [kraken_page] if kraken_page else [])
    finally:
        import os
        try:
            os.remove(local)
        except OSError:
            pass


def _save_result(db: Session, page: Page, kraken_pages: list[dict]) -> None:
    lines: list[dict] = []
    for kp in kraken_pages:
        lines.extend(kp.get("lines") or [])

    raw_text = "\n".join((l.get("prediction") or "").strip() for l in lines if (l.get("prediction") or "").strip())
    confidences = [float(l.get("confidence") or 0) for l in lines if l.get("prediction")]
    avg_conf = (sum(confidences) / len(confidences)) if confidences else 0.0

    # keep only the latest transcription: replace previous rows
    db.query(Transcription).filter_by(page_id=page.id).delete()

    transcription = Transcription(
        page_id=page.id,
        raw_htr_text=raw_text,
        edited_text="",
        confidence_score=avg_conf,
        source="htr",
        version_number=1,
    )
    db.add(transcription)
    db.flush()

    for idx, line in enumerate(lines):
        bbox = line.get("bbox") or line.get("geometry")
        db.add(Segment(
            transcription_id=transcription.id,
            type="line",
            source_text=line.get("prediction") or "",
            edited_text="",
            confidence_score=float(line.get("confidence") or 0),
            bbox_json=bbox,
            reading_order=idx,
            is_uncertain=bool(bbox is None or float(line.get("confidence") or 0) < 0.7),
        ))

    page.processing_status = "done"
    page.validation_status = "unreviewed"
    page.error = ""
    _maybe_finish_document(db, page)


def _maybe_finish_document(db: Session, page: Page) -> None:
    document = db.query(Document).filter_by(id=page.document_id).one()
    pending = (
        db.query(Page)
        .filter(Page.document_id == document.id,
                Page.processing_status.in_(("idle", "queued", "transcribing")))
        .count()
    )
    if pending == 0:
        failed = (
            db.query(Page)
            .filter(Page.document_id == document.id, Page.processing_status == "error")
            .count()
        )
        document.status = "to_review" if failed == 0 else "processing"
    db.add(document)


def _fail(db: Session, page: Page, message: str) -> None:
    page.processing_status = "error"
    page.error = message[:2000]
    # refund credits charged for this page
    if page.credits_charged > 0:
        user = page.document.user
        credits.grant(db, user, page.credits_charged, "page_ocr_refund",
                      ref_type="page", ref_id=page.id, note="Échec OCR — remboursement")
        page.credits_charged = 0
    for job in db.query(PageJob).filter_by(page_id=page.id).all():
        job.status = "failed"
        job.error = message[:2000]
    _maybe_finish_document(db, page)
