"""RQ worker entrypoint. Role selected via PALIMORA_ROLE env (Coolify ignores the
per-app Start Command for Dockerfile builds — same workaround as the OCR engine)."""
import os
from datetime import datetime, timedelta, timezone

from redis import Redis
from rq import Queue, Worker

from .config import settings


def _reconcile_stale_jobs() -> None:
    """Re-enqueue pages stuck in queued/transcribing for >15 minutes (orphaned
    jobs after a worker restart during a Coolify rolling update)."""
    from .db import SessionLocal
    from .models import Page

    db = SessionLocal()
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=15)
        stuck = (
            db.query(Page)
            .filter(Page.processing_status.in_(("queued", "transcribing")),
                    Page.updated_at < cutoff)
            .all()
        )
        if not stuck:
            return
        from .ocr_service import enqueue_page_ocr
        for page in stuck:
            page.processing_status = "queued"
            enqueue_page_ocr(db, page)
            print(f"reconcile: re-enqueued page {page.id}")
        db.commit()
    except Exception as exc:  # noqa: BLE001 — never block worker startup
        print(f"reconcile failed: {exc}")
        db.rollback()
    finally:
        db.close()


def main() -> None:
    conn = Redis.from_url(settings.redis_url)
    queues = [Queue(settings.queue_name, connection=conn)]
    _reconcile_stale_jobs()
    worker = Worker(queues, connection=conn, name=f"palimora-worker-{os.urandom(3).hex()}")
    worker.work()


if __name__ == "__main__":
    main()
