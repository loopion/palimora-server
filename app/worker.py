"""RQ worker entrypoint. Role selected via PALIMORA_ROLE env (Coolify ignores the
per-app Start Command for Dockerfile builds — same workaround as the OCR engine)."""
import os

from redis import Redis
from rq import Queue, Worker

from .config import settings


def main() -> None:
    conn = Redis.from_url(settings.redis_url)
    queues = [Queue(settings.queue_name, connection=conn)]
    worker = Worker(queues, connection=conn, name=f"palimora-worker-{os.urandom(3).hex()}")
    worker.work()


if __name__ == "__main__":
    main()
