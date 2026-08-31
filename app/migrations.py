"""One-shot data migrations, guarded by the schema_migrations marker table.
No Alembic; called from app.main._migrate()."""
import math
from collections.abc import Callable

from sqlalchemy import text
from sqlalchemy.engine import Connection

from . import config


def run_once(conn: Connection, name: str, fn: Callable[[Connection], None]) -> bool:
    """Run fn exactly once across the lifetime of the database. Returns True if it ran."""
    conn.execute(text(
        "CREATE TABLE IF NOT EXISTS schema_migrations "
        "(name VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMP)"
    ))
    already = conn.execute(
        text("SELECT 1 FROM schema_migrations WHERE name = :n"), {"n": name}
    ).first()
    if already:
        return False
    fn(conn)
    conn.execute(
        text("INSERT INTO schema_migrations (name, applied_at) VALUES (:n, CURRENT_TIMESTAMP)"),
        {"n": name},
    )
    return True


def _trunc_toward_zero(x: int) -> int:
    return int(math.trunc(x / 10))


def rebase_credits_v2(conn: Connection) -> None:
    """Points era -> credits era: 1 credit = 1 page (was 10 points = 1 page).
    Rewrites balances and the ledger by /10, then optional goodwill top-up."""
    # 1. ledger: recompute delta and a fresh running balance_after per user
    users = [r[0] for r in conn.execute(text("SELECT id FROM users")).all()]
    for uid in users:
        rows = conn.execute(
            text("SELECT id, delta FROM credit_transactions WHERE user_id = :u "
                 "ORDER BY created_at, id"),
            {"u": uid},
        ).all()
        running = 0
        for row_id, delta in rows:
            new_delta = _trunc_toward_zero(delta)
            running += new_delta
            conn.execute(
                text("UPDATE credit_transactions SET delta = :d, balance_after = :b "
                     "WHERE id = :i"),
                {"d": new_delta, "b": running, "i": row_id},
            )
        conn.execute(
            text("UPDATE users SET credit_balance = :b WHERE id = :u"),
            {"b": running, "u": uid},
        )

    # 2. optional goodwill top-up
    floor = config.settings.rebase_topup_to
    if floor and floor > 0:
        low = conn.execute(
            text("SELECT id, credit_balance FROM users WHERE is_active = 1 "
                 "AND credit_balance < :f") if conn.dialect.name == "sqlite"
            else text("SELECT id, credit_balance FROM users WHERE is_active = true "
                      "AND credit_balance < :f"),
            {"f": floor},
        ).all()
        for uid, bal in low:
            diff = floor - bal
            new_bal = bal + diff
            conn.execute(
                text("INSERT INTO credit_transactions "
                     "(id, user_id, delta, balance_after, reason, ref_type, ref_id, note, created_at) "
                     "VALUES (:i, :u, :d, :b, 'rebase_topup', '', '', 'rebase goodwill', CURRENT_TIMESTAMP)"),
                {"i": _new_uuid(), "u": uid, "d": diff, "b": new_bal},
            )
            conn.execute(
                text("UPDATE users SET credit_balance = :b WHERE id = :u"),
                {"b": new_bal, "u": uid},
            )


def _new_uuid() -> str:
    import uuid
    return str(uuid.uuid4())
