"""OCR job implementations (executed by the RQ worker) + enqueue helpers.

Two job shapes:
- image page: 1 page = 1 Kraken job
- PDF page:   1 Kraken job for the whole file, result split across the page rows
"""
import httpx
from pdf2image import convert_from_path
from sqlalchemy.orm import Session

from . import credits, kraken, storage
from .config import settings


def _page_file_bytes(page) -> bytes:
    """Fetch the original file bytes: direct from S3 when configured, otherwise
    from the API over an internal route (local backend has no shared volume)."""
    if settings.storage_backend == "s3":
        import tempfile, os
        local = storage.download_to_temp(page.storage_key)
        try:
            with open(local, "rb") as f:
                return f.read()
        finally:
            try:
                os.remove(local)
            except OSError:
                pass
    resp = httpx.get(
        f"{settings.internal_api_url}/api/internal/pages/{page.id}/file",
        headers={"X-Internal-Key": settings.secret_key},
        timeout=300,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Fichier source inaccessible ({resp.status_code})")
    return resp.content
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
            message = str(exc)
            targets = [page]
            if page.content_type.startswith("application/pdf"):
                targets = (
                    db.query(Page)
                    .filter_by(document_id=page.document_id, storage_key=page.storage_key)
                    .all()
                )
            for p in targets:
                _fail(db, p, message)
            db.commit()
            return {"ok": False, "page_id": page.id, "error": message[:500]}
    finally:
        db.close()


def _run_image(db: Session, page: Page) -> None:
    page.processing_status = "transcribing"
    db.commit()
    file_bytes = _page_file_bytes(page)
    ext = "." + (page.storage_key.rsplit(".", 1)[-1] or "bin")
    with httpx.Client() as http:
        job_id = kraken.submit_ocr(http, file_bytes, ext)
        page.kraken_job_id = job_id
        db.commit()
        result = kraken.wait_for_result(http, job_id)
    _save_result(db, page, result.get("pages") or [])


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

    file_bytes = _page_file_bytes(page)
    with httpx.Client() as http:
        job_id = kraken.submit_ocr(http, file_bytes, ".pdf")
        for p in siblings:
            p.kraken_job_id = job_id
        db.commit()
        result = kraken.wait_for_result(http, job_id)
    pages_result = result.get("pages") or []
    ordered = sorted(siblings, key=lambda p: (p.page_number, p.id))
    for idx, p in enumerate(ordered):
        kraken_page = pages_result[idx] if idx < len(pages_result) else None
        _save_result(db, p, [kraken_page] if kraken_page else [])
        _render_pdf_derivative(db, p, idx + 1, len(ordered))


def _render_pdf_derivative(db: Session, page: Page, page_number: int, total: int) -> None:
    """Store a PNG render of the PDF page so the web viewer can display it."""
    import os as _os
    import tempfile as _tempfile

    try:
        local = storage.download_to_temp(page.storage_key)
    except Exception:
        return
    try:
        images = convert_from_path(local, dpi=150, first_page=page_number, last_page=page_number)
        if not images:
            return
        fd, png_path = _tempfile.mkstemp(suffix=".png")
        _os.close(fd)
        images[0].save(png_path, format="PNG")
        derivative_key = page.storage_key.rsplit(".", 1)[0] + ".png"
        storage.upload_file(png_path, derivative_key, "image/png")
        page.derivative_key = derivative_key
        db.commit()
        _os.remove(png_path)
    except Exception as exc:  # noqa: BLE001 — derivative is best-effort
        print(f"derivative render failed for page {page.id}: {exc}")
    finally:
        try:
            _os.remove(local)
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
    # (bulk query.delete() bypasses ORM cascades — delete segments explicitly)
    for old_t in db.query(Transcription).filter_by(page_id=page.id).all():
        db.query(Segment).filter_by(transcription_id=old_t.id).delete()
        db.delete(old_t)

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
