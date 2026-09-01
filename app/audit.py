"""Audit-log writer. Uses its own short-lived Session (bound to app.db.engine at
call time) so an audit row survives a rollback in the request that triggered it,
and so tests can redirect it by monkeypatching app.db.engine."""
from sqlalchemy.orm import sessionmaker

from . import db as _db
from .models import AdminAuditLog


def record(*, actor_user_id: str, target_user_id: str | None = None,
           event: str, method: str | None = None, path: str | None = None,
           status_code: int | None = None) -> None:
    Session = sessionmaker(bind=_db.engine, autoflush=False, expire_on_commit=False)
    session = Session()
    try:
        session.add(AdminAuditLog(
            actor_user_id=actor_user_id,
            target_user_id=target_user_id,
            event=event,
            method=method,
            path=(path[:255] if path else None),
            status_code=status_code,
        ))
        session.commit()
    except Exception as exc:  # noqa: BLE001 — audit must never break a request
        print(f"audit log write failed: {exc}")
        session.rollback()
    finally:
        session.close()
