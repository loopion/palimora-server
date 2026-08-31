# D1 — Stripe Payments + Credit Rebrand — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user buy OCR credits (one-shot packs or a monthly plan) with a card inside the web SPA, with credits granted automatically via Stripe webhooks, in Stripe test mode.

**Architecture:** A new `app/billing.py` FastAPI `APIRouter` holds the customer-facing endpoints and the webhook. All Stripe SDK access goes through a thin `app/stripe_gateway.py` seam so tests can mock it. The catalogue is a static `app/pricing.py` mapping internal pack ids to env-provided Stripe Price ids. Credits are rebranded 1:1 with pages (AI correction becomes free) via a one-shot data migration in the existing `_migrate()` hook, guarded by a new `schema_migrations` marker table. The SPA gets a `/billing` page using Stripe's Payment Element.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 (no Alembic — in-place `_migrate()`), Postgres (prod) / SQLite (tests), `stripe` Python SDK, React 18 + react-router 6 + Vite, `@stripe/stripe-js` + `@stripe/react-stripe-js`, pytest, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-d1-stripe-payments-design.md`

## Global Constraints

- Stripe test mode only. Keys come from env (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`); never hardcoded, never committed.
- Nothing hardcoded that belongs in env — follow `app/config.py`'s existing pattern (`os.getenv` with defaults).
- No Alembic. Schema changes go in `app/main.py::_migrate()` as `CREATE TABLE IF NOT EXISTS` (via `Base.metadata.create_all`) and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, each wrapped so a re-run or SQLite is harmless.
- Credit model after this plan: `1 credit = 1 page`, AI correction free. Env values: `PAGE_COST_POINTS=1`, `AI_CORRECTION_COST_POINTS=0`, `SIGNUP_BONUS_POINTS=100`.
- The rebase data migration is irreversible and must run exactly once (marker row in `schema_migrations`). A Postgres dump is taken before the deploy (ops step, not code).
- Catalogue (verbatim): `starter` 300 credits / €29.00 · `chercheur` 1500 credits / €119.00 · `archiviste` 6000 credits / €399.00 · `atelier` 500 credits/month / €39.00/month. EUR only. `atelier` credits accumulate (no monthly reset, no cap).
- Webhook path is exactly `/api/stripe/webhook` (already registered in the Stripe dashboard).
- Ledger reason strings (column is `String(40)`): `purchase`, `subscription_grant`, `refund`, `rebase_topup`.
- French user-facing copy in the SPA. Billing entity for receipts (env): `Palimora`, `250 Chemin des Groux, 78670 Villennes-sur-Seine`, `FR`, VAT note `TVA non applicable, art. 293 B du CGI`. The provided VAT number is fake — store as an env string only, never send to Stripe as a registration.
- `credits.charge()` / `credits.grant()` with `amount == 0` must be a no-op returning `None` (no ledger row); every caller must tolerate `None`.

---

## Task 1: Python test harness

**Files:**
- Create: `requirements-dev.txt`
- Create: `tests/__init__.py`
- Create: `tests/conftest.py`
- Create: `tests/test_smoke.py`
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - pytest fixture `client` → `fastapi.testclient.TestClient` bound to a fresh in-memory SQLite DB per test.
  - pytest fixture `db` → a `sqlalchemy.orm.Session` on the same DB.
  - factory `make_user(db, *, email="u@test.fr", credits=0, is_admin=False) -> User`.
  - factory `auth_headers(db, user) -> dict` returning `{"Authorization": "Bearer <token>"}`.

- [ ] **Step 1: Write `requirements-dev.txt`**

```
-r requirements.txt
pytest==8.3.4
pytest-asyncio==0.25.0
```

- [ ] **Step 2: Write `tests/__init__.py`**

Empty file.

- [ ] **Step 3: Write `tests/conftest.py`**

```python
import os
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# Force SQLite before app modules import settings.
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ.setdefault("STORAGE_BACKEND", "local")
os.environ.setdefault("STRIPE_SECRET_KEY", "sk_test_dummy")
os.environ.setdefault("STRIPE_PUBLISHABLE_KEY", "pk_test_dummy")
os.environ.setdefault("STRIPE_WEBHOOK_SECRET", "whsec_dummy")

from app import db as db_module  # noqa: E402
from app.auth import issue_device_token  # noqa: E402
from app.models import User  # noqa: E402


@pytest.fixture()
def _engine():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    db_module.Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture()
def _Session(_engine):
    return sessionmaker(bind=_engine, autoflush=False, expire_on_commit=False)


@pytest.fixture()
def db(_Session):
    session = _Session()
    yield session
    session.close()


@pytest.fixture()
def client(_engine, _Session, monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.db import get_db

    def _get_db():
        session = _Session()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_db
    monkeypatch.setattr(db_module, "engine", _engine, raising=False)
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def make_user(db, *, email="u@test.fr", credits=0, is_admin=False) -> User:
    from app.auth import hash_password
    user = User(email=email, password_hash=hash_password("x" * 12),
                is_admin=is_admin, credit_balance=credits, email_verified=True)
    db.add(user)
    db.commit()
    return user


def auth_headers(db, user) -> dict:
    token = issue_device_token(db, user, "test")
    return {"Authorization": f"Bearer {token}"}
```

- [ ] **Step 4: Write `tests/test_smoke.py`**

```python
def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
```

- [ ] **Step 5: Run and verify it passes**

Run: `pip install -r requirements-dev.txt && pytest -q`
Expected: `1 passed`. If `app.main` import fails because `storage.ensure_bucket()` runs at startup, the `TestClient(app)` context triggers `on_startup`; set `STORAGE_BACKEND=local` (done in conftest) so it uses a local dir — if it still fails, `monkeypatch.setattr("app.storage.ensure_bucket", lambda: None)` in the `client` fixture.

- [ ] **Step 6: Add a "Tests" section to `README.md`**

```markdown
## Tests

    pip install -r requirements-dev.txt
    pytest -q                 # backend
    npm --prefix web test     # frontend (Vitest)
```

- [ ] **Step 7: Commit**

```bash
git add requirements-dev.txt tests/ README.md
git commit -m "test: pytest harness with in-memory SQLite app fixture"
```

---

## Task 2: Stripe + billing config

**Files:**
- Modify: `app/config.py:52-59` (Credits block) and end of `Settings`
- Test: `tests/test_config.py`

**Interfaces:**
- Consumes: nothing.
- Produces: on `app.config.settings` —
  - `stripe_secret_key: str`, `stripe_publishable_key: str`, `stripe_webhook_secret: str`
  - `stripe_tax_enabled: bool`
  - `stripe_price_ids: dict[str, str]` keyed by `starter|chercheur|archiviste|atelier`
  - `stripe_enabled: bool` (`bool(stripe_secret_key and stripe_webhook_secret)`)
  - `billing_entity_name/address/country/vat_note: str`

- [ ] **Step 1: Write the failing test — `tests/test_config.py`**

```python
def test_stripe_settings_from_env(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_x")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_x")
    monkeypatch.setenv("STRIPE_PRICE_STARTER", "price_s")
    import importlib
    from app import config
    importlib.reload(config)
    assert config.settings.stripe_enabled is True
    assert config.settings.stripe_price_ids["starter"] == "price_s"
    assert config.settings.stripe_tax_enabled is True  # default


def test_stripe_disabled_without_secret(monkeypatch):
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.delenv("STRIPE_WEBHOOK_SECRET", raising=False)
    import importlib
    from app import config
    importlib.reload(config)
    assert config.settings.stripe_enabled is False
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_config.py -q`
Expected: FAIL — `AttributeError: 'Settings' object has no attribute 'stripe_enabled'`.

- [ ] **Step 3: Implement — edit `app/config.py`**

Change the Credits block defaults:

```python
    # Credits (1 credit = 1 Kraken page; AI correction is free)
    page_cost: int = _int("PAGE_COST_POINTS", 1)
    ai_correction_cost: int = _int("AI_CORRECTION_COST_POINTS", 0)
    signup_bonus: int = _int("SIGNUP_BONUS_POINTS", 100)
```

Add before `settings = Settings()`:

```python
    # Stripe (test mode)
    stripe_secret_key: str = os.getenv("STRIPE_SECRET_KEY", "")
    stripe_publishable_key: str = os.getenv("STRIPE_PUBLISHABLE_KEY", "")
    stripe_webhook_secret: str = os.getenv("STRIPE_WEBHOOK_SECRET", "")
    stripe_tax_enabled: bool = os.getenv("STRIPE_TAX_ENABLED", "true").lower() == "true"
    stripe_price_ids: dict = {
        "starter": os.getenv("STRIPE_PRICE_STARTER", ""),
        "chercheur": os.getenv("STRIPE_PRICE_CHERCHEUR", ""),
        "archiviste": os.getenv("STRIPE_PRICE_ARCHIVISTE", ""),
        "atelier": os.getenv("STRIPE_PRICE_ATELIER", ""),
    }
    rebase_topup_to: int = _int("REBASE_TOPUP_TO", 0)

    # Billing entity (receipts / future invoices)
    billing_entity_name: str = os.getenv("BILLING_ENTITY_NAME", "Palimora")
    billing_entity_address: str = os.getenv("BILLING_ENTITY_ADDRESS", "")
    billing_entity_country: str = os.getenv("BILLING_ENTITY_COUNTRY", "FR")
    billing_vat_note: str = os.getenv("BILLING_VAT_NOTE", "TVA non applicable, art. 293 B du CGI")

    @property
    def stripe_enabled(self) -> bool:
        return bool(self.stripe_secret_key and self.stripe_webhook_secret)
```

Note: `stripe_price_ids` as a class attribute dict is evaluated once at import — acceptable, matches `admin_emails`. `stripe_enabled` is a property so the reload-based tests see fresh env.

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_config.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add app/config.py tests/test_config.py
git commit -m "feat: stripe + billing settings, credits default to 1/page"
```

---

## Task 3: Credit zero-cost guard

**Files:**
- Modify: `app/credits.py:16-48` (`record`, `charge`, `grant`)
- Modify: `app/main.py` around lines 730-745 (the `ai_correction` charge/refund call sites)
- Test: `tests/test_credits.py`

**Interfaces:**
- Consumes: `app.config.settings` (Task 2).
- Produces: `credits.charge(...)` and `credits.grant(...)` return `CreditTransaction | None`; `None` when `amount == 0`, with no ledger row written and no balance change.

- [ ] **Step 1: Write the failing test — `tests/test_credits.py`**

```python
from app import credits
from app.models import CreditTransaction


def test_grant_zero_is_noop(db):
    from tests.conftest import make_user
    u = make_user(db, credits=5)
    tx = credits.grant(db, u, 0, "purchase")
    db.commit()
    assert tx is None
    assert u.credit_balance == 5
    assert db.query(CreditTransaction).count() == 0


def test_charge_zero_is_noop(db):
    from tests.conftest import make_user
    u = make_user(db, credits=5)
    tx = credits.charge(db, u, 0, "ai_correction")
    db.commit()
    assert tx is None
    assert u.credit_balance == 5


def test_grant_positive_writes_row(db):
    from tests.conftest import make_user
    u = make_user(db, credits=0)
    tx = credits.grant(db, u, 300, "purchase", ref_type="stripe_pi", ref_id="pi_1")
    db.commit()
    assert tx.delta == 300
    assert u.credit_balance == 300
    assert tx.balance_after == 300
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_credits.py -q`
Expected: FAIL — `test_grant_zero_is_noop` gets a `CreditTransaction`, count is 1.

- [ ] **Step 3: Implement — edit `app/credits.py`**

In `charge()`, after locking, before `record`:

```python
    if amount == 0:
        return None
```

In `grant()`, after locking:

```python
    if amount == 0:
        return None
```

(Leave `record()` unchanged.)

- [ ] **Step 4: Update call sites in `app/main.py`**

The `ai-suggest` endpoint (around line 730). Current shape:

```python
        credits.charge(db, user, credits.ai_cost(), "ai_correction",
                       ref_type="page", ref_id=page.id)
```

and on failure:

```python
        credits.grant(db, user, credits.ai_cost(), "ai_correction_refund",
                      ref_type="page", ref_id=page.id)
```

These already work unchanged (they now no-op at cost 0). Verify by reading the surrounding `try/except` — if the code branches on the return value of `charge`, guard it with `tx = credits.charge(...)` / `if tx: ...`. If it does not, leave as is. Add a one-line comment above the charge:

```python
        # ai_cost() is 0 in the current pricing (AI correction free) -> no-op.
        credits.charge(db, user, credits.ai_cost(), "ai_correction",
                       ref_type="page", ref_id=page.id)
```

- [ ] **Step 5: Run to verify it passes**

Run: `pytest tests/test_credits.py -q && pytest -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/credits.py app/main.py tests/test_credits.py
git commit -m "feat: credits.charge/grant no-op on zero amount"
```

---

## Task 4: Rebase migration + schema_migrations marker

**Files:**
- Modify: `app/models.py` (add `SchemaMigration`)
- Create: `app/migrations.py`
- Modify: `app/main.py::_migrate()` (call the rebase)
- Test: `tests/test_rebase.py`

**Interfaces:**
- Consumes: `app.config.settings.rebase_topup_to`.
- Produces:
  - model `SchemaMigration` — table `schema_migrations`, columns `name: str PK (String(64))`, `applied_at: datetime`.
  - `migrations.run_once(engine, name: str, fn: Callable[[Connection], None]) -> bool` — runs `fn` in a transaction and inserts the marker iff the marker is absent; returns `True` if it ran.
  - `migrations.rebase_credits_v2(conn)` — the ÷10 rewrite.

- [ ] **Step 1: Write the failing test — `tests/test_rebase.py`**

```python
from sqlalchemy import text
from app import migrations
from app.models import User, CreditTransaction


def _seed(db):
    from tests.conftest import make_user
    u = make_user(db, email="a@test.fr", credits=0)
    # simulate old points-era ledger: +100 signup, -10 page, -10 page  => balance 80
    for delta, after, reason in [(100, 100, "signup_bonus"), (-10, 90, "page_ocr"), (-10, 80, "page_ocr")]:
        db.add(CreditTransaction(user_id=u.id, delta=delta, balance_after=after, reason=reason))
    u.credit_balance = 80
    db.commit()
    return u


def test_rebase_divides_by_ten(db, _engine, monkeypatch):
    monkeypatch.setattr("app.config.settings.rebase_topup_to", 0)
    u = _seed(db)
    with _engine.begin() as conn:
        ran = migrations.run_once(conn, "rebase_credits_v2", migrations.rebase_credits_v2)
    assert ran is True
    db.expire_all()
    assert db.get(User, u.id).credit_balance == 8
    rows = db.query(CreditTransaction).filter_by(user_id=u.id).order_by(CreditTransaction.created_at, CreditTransaction.id).all()
    assert [r.delta for r in rows] == [10, -1, -1]
    assert [r.balance_after for r in rows] == [10, 9, 8]


def test_rebase_runs_once(db, _engine):
    _seed(db)
    with _engine.begin() as conn:
        assert migrations.run_once(conn, "rebase_credits_v2", migrations.rebase_credits_v2) is True
    with _engine.begin() as conn:
        assert migrations.run_once(conn, "rebase_credits_v2", migrations.rebase_credits_v2) is False
    db.expire_all()
    # balances not halved again
    assert db.query(User).first().credit_balance == 8


def test_rebase_topup(db, _engine, monkeypatch):
    monkeypatch.setattr("app.config.settings.rebase_topup_to", 100)
    u = _seed(db)  # post-rebase balance would be 8
    with _engine.begin() as conn:
        migrations.run_once(conn, "rebase_credits_v2", migrations.rebase_credits_v2)
    db.expire_all()
    assert db.get(User, u.id).credit_balance == 100
    topup = db.query(CreditTransaction).filter_by(reason="rebase_topup").one()
    assert topup.delta == 92
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_rebase.py -q`
Expected: FAIL — `ModuleNotFoundError: app.migrations`.

- [ ] **Step 3: Add `SchemaMigration` to `app/models.py`**

```python
class SchemaMigration(Base):
    __tablename__ = "schema_migrations"
    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    applied_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
```

- [ ] **Step 4: Write `app/migrations.py`**

```python
"""One-shot data migrations, guarded by the schema_migrations marker table.
No Alembic; called from app.main._migrate()."""
import math
from collections.abc import Callable

from sqlalchemy import text
from sqlalchemy.engine import Connection

from .config import settings


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
    floor = settings.rebase_topup_to
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
```

- [ ] **Step 5: Wire into `app/main.py::_migrate()`**

At the end of `_migrate()`, after the `with engine.begin()` ALTER loop:

```python
    from . import migrations as _mig
    with engine.begin() as conn:
        _mig.run_once(conn, "rebase_credits_v2", _mig.rebase_credits_v2)
```

- [ ] **Step 6: Run to verify it passes**

Run: `pytest tests/test_rebase.py -q`
Expected: PASS (3 passed).

- [ ] **Step 7: Commit**

```bash
git add app/models.py app/migrations.py app/main.py tests/test_rebase.py
git commit -m "feat: rebase_credits_v2 migration (10 points -> 1 credit), one-shot guarded"
```

---

## Task 5: Billing data model

**Files:**
- Modify: `app/models.py` (add `Subscription`, `StripeEvent`, `User.stripe_customer_id`)
- Modify: `app/main.py::_migrate()` (ALTER + create tables)
- Test: `tests/test_models_billing.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `User.stripe_customer_id: Mapped[str | None]` (nullable, unique, indexed).
  - `Subscription`: `id` (uuid PK), `user_id` (FK users, indexed), `stripe_subscription_id` (String(64), unique), `plan_id` (String(20)), `status` (String(20)), `current_period_end` (DateTime tz, nullable), `cancel_at_period_end` (bool, default False), `created_at`, `updated_at` (onupdate).
  - `StripeEvent`: `id` (String(64) PK), `type` (String(64)), `payload_json` (JSON), `received_at` (DateTime tz, default now), `processed_at` (DateTime tz, nullable), `error` (String(500), default "").

- [ ] **Step 1: Write the failing test — `tests/test_models_billing.py`**

```python
from datetime import datetime, timezone
from app.models import Subscription, StripeEvent, User


def test_subscription_roundtrip(db):
    from tests.conftest import make_user
    u = make_user(db)
    s = Subscription(user_id=u.id, stripe_subscription_id="sub_1", plan_id="atelier",
                     status="active", cancel_at_period_end=False)
    db.add(s)
    db.commit()
    assert db.query(Subscription).filter_by(user_id=u.id).one().status == "active"


def test_stripe_event_default_unprocessed(db):
    e = StripeEvent(id="evt_1", type="payment_intent.succeeded", payload_json={})
    db.add(e)
    db.commit()
    got = db.get(StripeEvent, "evt_1")
    assert got.processed_at is None
    assert got.error == ""


def test_user_customer_id_nullable(db):
    from tests.conftest import make_user
    u = make_user(db)
    assert u.stripe_customer_id is None
    u.stripe_customer_id = "cus_1"
    db.commit()
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_models_billing.py -q`
Expected: FAIL — `ImportError: cannot import name 'Subscription'`.

- [ ] **Step 3: Implement — edit `app/models.py`**

On `User`, add after `credit_balance`:

```python
    stripe_customer_id: Mapped[str | None] = mapped_column(
        String(64), unique=True, index=True, nullable=True)
```

Add two new classes near `CreditTransaction`:

```python
class Subscription(Base):
    __tablename__ = "subscriptions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    stripe_subscription_id: Mapped[str] = mapped_column(String(64), unique=True)
    plan_id: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="incomplete")
    current_period_end: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)
    cancel_at_period_end: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, onupdate=now)


class StripeEvent(Base):
    __tablename__ = "stripe_events"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    type: Mapped[str] = mapped_column(String(64))
    payload_json: Mapped[dict] = mapped_column(JSON, default=dict)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    processed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)
    error: Mapped[str] = mapped_column(String(500), default="")
```

- [ ] **Step 4: Wire into `app/main.py::_migrate()`**

Add to the `stmts` list:

```python
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(64)",
```

`Base.metadata.create_all(engine)` in `on_startup` already creates the new tables. No extra statement needed for `subscriptions` / `stripe_events`.

- [ ] **Step 5: Run to verify it passes**

Run: `pytest tests/test_models_billing.py -q`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add app/models.py app/main.py tests/test_models_billing.py
git commit -m "feat: Subscription, StripeEvent models + User.stripe_customer_id"
```

---

## Task 6: Pricing catalogue module

**Files:**
- Create: `app/pricing.py`
- Test: `tests/test_pricing.py`

**Interfaces:**
- Consumes: `app.config.settings.stripe_price_ids`.
- Produces:
  - `pricing.PACKS: dict[str, Pack]` where `Pack` is a frozen dataclass `Pack(id: str, kind: Literal["one_shot","subscription"], credits: int, amount_eur: Decimal, label: str)`.
  - `pricing.catalogue() -> list[dict]` — serialisable, one entry per pack, each `{"id","kind","credits","amount_eur": float, "price_per_page": float, "label", "stripe_price_id"}`, subscription entries include `"interval": "month"`.
  - `pricing.pack_by_price_id(price_id: str) -> Pack | None`.
  - `pricing.get(pack_id: str) -> Pack | None`.

- [ ] **Step 1: Write the failing test — `tests/test_pricing.py`**

```python
from decimal import Decimal
from app import pricing


def test_packs_match_spec():
    assert pricing.get("starter").credits == 300
    assert pricing.get("starter").amount_eur == Decimal("29.00")
    assert pricing.get("chercheur").credits == 1500
    assert pricing.get("archiviste").amount_eur == Decimal("399.00")
    sub = pricing.get("atelier")
    assert sub.kind == "subscription"
    assert sub.credits == 500


def test_catalogue_serialisable():
    cat = {c["id"]: c for c in pricing.catalogue()}
    assert set(cat) == {"starter", "chercheur", "archiviste", "atelier"}
    assert cat["starter"]["price_per_page"] == round(29.0 / 300, 4)
    assert cat["atelier"]["interval"] == "month"


def test_reverse_lookup(monkeypatch):
    monkeypatch.setitem(pricing._price_ids(), "starter", "price_abc")
    assert pricing.pack_by_price_id("price_abc").id == "starter"
    assert pricing.pack_by_price_id("nope") is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_pricing.py -q`
Expected: FAIL — `ModuleNotFoundError: app.pricing`.

- [ ] **Step 3: Write `app/pricing.py`**

```python
"""Credit catalogue — the single source of truth for what a pack contains.
Stripe is authoritative for the amount actually charged; the amounts here are
for display and sanity checks only."""
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

from .config import settings


@dataclass(frozen=True)
class Pack:
    id: str
    kind: Literal["one_shot", "subscription"]
    credits: int
    amount_eur: Decimal
    label: str


PACKS: dict[str, Pack] = {
    "starter": Pack("starter", "one_shot", 300, Decimal("29.00"), "Starter"),
    "chercheur": Pack("chercheur", "one_shot", 1500, Decimal("119.00"), "Chercheur"),
    "archiviste": Pack("archiviste", "one_shot", 6000, Decimal("399.00"), "Archiviste"),
    "atelier": Pack("atelier", "subscription", 500, Decimal("39.00"), "Atelier"),
}


def _price_ids() -> dict:
    return settings.stripe_price_ids


def get(pack_id: str) -> Pack | None:
    return PACKS.get(pack_id)


def pack_by_price_id(price_id: str) -> Pack | None:
    if not price_id:
        return None
    for pack_id, pid in _price_ids().items():
        if pid and pid == price_id:
            return PACKS.get(pack_id)
    return None


def catalogue() -> list[dict]:
    out = []
    for p in PACKS.values():
        entry = {
            "id": p.id,
            "kind": p.kind,
            "credits": p.credits,
            "amount_eur": float(p.amount_eur),
            "price_per_page": round(float(p.amount_eur) / p.credits, 4),
            "label": p.label,
            "stripe_price_id": _price_ids().get(p.id, ""),
        }
        if p.kind == "subscription":
            entry["interval"] = "month"
        out.append(entry)
    return out
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_pricing.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add app/pricing.py tests/test_pricing.py
git commit -m "feat: pricing catalogue module"
```

---

## Task 7: Stripe gateway seam

**Files:**
- Create: `app/stripe_gateway.py`
- Modify: `requirements.txt` (add `stripe`)
- Test: `tests/test_stripe_gateway.py`

**Interfaces:**
- Consumes: `app.config.settings` (secret key, tax flag).
- Produces (all raise `stripe_gateway.GatewayError` on any `stripe.error.StripeError`):
  - `ensure_customer(user) -> str` — returns `user.stripe_customer_id`, creating a Stripe Customer and setting the attribute (caller commits).
  - `create_payment_intent(*, customer_id: str, price_id: str, metadata: dict) -> tuple[str, int, str]` → `(client_secret, amount, currency)`. Retrieves the Price for the amount; never trusts a client amount.
  - `create_subscription(*, customer_id: str, price_id: str, metadata: dict) -> tuple[str, str]` → `(client_secret, stripe_subscription_id)`.
  - `cancel_subscription(stripe_subscription_id: str) -> None` — sets `cancel_at_period_end=True`.
  - `retrieve_price_amount(price_id: str) -> tuple[int, str]` → `(unit_amount, currency)`.
  - `construct_event(payload: bytes, sig_header: str) -> dict` — verified webhook event (raises `GatewayError` on bad signature).

- [ ] **Step 1: Add `stripe` to `requirements.txt`**

```
stripe==11.4.0
```

- [ ] **Step 2: Write the failing test — `tests/test_stripe_gateway.py`**

```python
import pytest
from app import stripe_gateway as gw


class _FakeStripeError(Exception):
    pass


def test_ensure_customer_creates_and_sets(db, monkeypatch):
    from tests.conftest import make_user
    u = make_user(db)
    created = {}
    monkeypatch.setattr(gw.stripe.Customer, "create",
                        lambda **kw: created.update(kw) or type("C", (), {"id": "cus_x"}))
    cid = gw.ensure_customer(u)
    db.commit()
    assert cid == "cus_x"
    assert u.stripe_customer_id == "cus_x"
    assert created["email"] == u.email


def test_ensure_customer_idempotent(db, monkeypatch):
    from tests.conftest import make_user
    u = make_user(db)
    u.stripe_customer_id = "cus_existing"
    monkeypatch.setattr(gw.stripe.Customer, "create",
                        lambda **kw: pytest.fail("should not create"))
    assert gw.ensure_customer(u) == "cus_existing"


def test_create_payment_intent_uses_price_amount(monkeypatch):
    monkeypatch.setattr(gw.stripe.Price, "retrieve",
                        lambda pid: type("P", (), {"unit_amount": 2900, "currency": "eur"}))
    monkeypatch.setattr(gw.stripe.PaymentIntent, "create",
                        lambda **kw: type("PI", (), {"client_secret": "pi_secret_x"}))
    secret, amount, currency = gw.create_payment_intent(
        customer_id="cus_x", price_id="price_s", metadata={"user_id": "u1"})
    assert (secret, amount, currency) == ("pi_secret_x", 2900, "eur")


def test_gateway_wraps_stripe_error(monkeypatch):
    import stripe
    monkeypatch.setattr(gw.stripe.Price, "retrieve",
                        lambda pid: (_ for _ in ()).throw(stripe.error.APIConnectionError("boom")))
    with pytest.raises(gw.GatewayError):
        gw.retrieve_price_amount("price_s")
```

- [ ] **Step 3: Run to verify it fails**

Run: `pip install stripe==11.4.0 && pytest tests/test_stripe_gateway.py -q`
Expected: FAIL — `ModuleNotFoundError: app.stripe_gateway`.

- [ ] **Step 4: Write `app/stripe_gateway.py`**

```python
"""Thin, mockable wrapper around the Stripe SDK. Every public function raises
GatewayError (never a raw stripe.error.*) so callers map it to one HTTP status."""
import stripe

from .config import settings

stripe.api_key = settings.stripe_secret_key


class GatewayError(Exception):
    pass


def _tax() -> dict:
    return {"enabled": settings.stripe_tax_enabled}


def ensure_customer(user) -> str:
    if user.stripe_customer_id:
        return user.stripe_customer_id
    try:
        cus = stripe.Customer.create(
            email=user.email,
            name=user.display_name or user.email,
            metadata={"user_id": user.id},
        )
    except stripe.error.StripeError as e:  # pragma: no cover - exercised via mock
        raise GatewayError(str(e)) from e
    user.stripe_customer_id = cus.id
    return cus.id


def retrieve_price_amount(price_id: str) -> tuple[int, str]:
    try:
        price = stripe.Price.retrieve(price_id)
    except stripe.error.StripeError as e:
        raise GatewayError(str(e)) from e
    return int(price.unit_amount), str(price.currency)


def create_payment_intent(*, customer_id: str, price_id: str, metadata: dict) -> tuple[str, int, str]:
    amount, currency = retrieve_price_amount(price_id)
    try:
        pi = stripe.PaymentIntent.create(
            amount=amount,
            currency=currency,
            customer=customer_id,
            automatic_tax=_tax(),
            metadata=metadata,
        )
    except stripe.error.StripeError as e:
        raise GatewayError(str(e)) from e
    return pi.client_secret, amount, currency


def create_subscription(*, customer_id: str, price_id: str, metadata: dict) -> tuple[str, str]:
    try:
        sub = stripe.Subscription.create(
            customer=customer_id,
            items=[{"price": price_id}],
            payment_behavior="default_incomplete",
            payment_settings={"save_default_payment_method": "on_subscription"},
            automatic_tax=_tax(),
            expand=["latest_invoice.payment_intent"],
            metadata=metadata,
        )
    except stripe.error.StripeError as e:
        raise GatewayError(str(e)) from e
    pi = sub.latest_invoice.payment_intent
    return pi.client_secret, sub.id


def cancel_subscription(stripe_subscription_id: str) -> None:
    try:
        stripe.Subscription.modify(stripe_subscription_id, cancel_at_period_end=True)
    except stripe.error.StripeError as e:
        raise GatewayError(str(e)) from e


def construct_event(payload: bytes, sig_header: str) -> dict:
    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, settings.stripe_webhook_secret)
    except (ValueError, stripe.error.SignatureVerificationError) as e:
        raise GatewayError("bad signature") from e
    return event
```

- [ ] **Step 5: Run to verify it passes**

Run: `pytest tests/test_stripe_gateway.py -q`
Expected: PASS (4 passed).

- [ ] **Step 6: Commit**

```bash
git add app/stripe_gateway.py requirements.txt tests/test_stripe_gateway.py
git commit -m "feat: stripe_gateway seam over the Stripe SDK"
```

---

## Task 8: Billing router — catalogue + status, mount, publishable key

**Files:**
- Create: `app/billing.py`
- Modify: `app/main.py` (import + `app.include_router`; extend the existing config endpoint near line 308-312)
- Test: `tests/test_billing_catalogue.py`

**Interfaces:**
- Consumes: `pricing.catalogue`, `app.auth.get_current_user`, `app.db.get_db`, `settings.stripe_publishable_key`, `settings.stripe_enabled`.
- Produces:
  - `billing.router: APIRouter` (prefix `/api/billing`, tag `billing`).
  - `GET /api/billing/catalogue` → `{"packs": [...], "publishable_key": str, "enabled": bool}`.
  - `GET /api/billing/status` → `{"credit_balance": int, "subscription": {...}|None, "purchases": [{"reason","delta","created_at","note"}]}`.
  - `GET /api/config` (existing) gains `"stripe_publishable_key"` and `"credits_per_page"`.
  - helper `billing.require_stripe()` — raises `HTTPException(503, "Paiements indisponibles")` when `not settings.stripe_enabled`.

- [ ] **Step 1: Write the failing test — `tests/test_billing_catalogue.py`**

```python
def test_catalogue_public_shape(client):
    r = client.get("/api/billing/catalogue")
    assert r.status_code == 200
    body = r.json()
    assert {p["id"] for p in body["packs"]} == {"starter", "chercheur", "archiviste", "atelier"}
    assert body["publishable_key"] == "pk_test_dummy"


def test_status_requires_auth(client):
    assert client.get("/api/billing/status").status_code == 401


def test_status_shape(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db, credits=42)
    r = client.get("/api/billing/status", headers=auth_headers(db, u))
    assert r.status_code == 200
    body = r.json()
    assert body["credit_balance"] == 42
    assert body["subscription"] is None
    assert body["purchases"] == []
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_billing_catalogue.py -q`
Expected: FAIL — 404 on `/api/billing/catalogue`.

- [ ] **Step 3: Write `app/billing.py`**

```python
"""Customer-facing billing: catalogue, purchase intents, subscription, webhook."""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from . import credits, pricing, stripe_gateway
from .auth import get_current_user
from .config import settings
from .db import get_db
from .models import CreditTransaction, StripeEvent, Subscription, User

router = APIRouter(prefix="/api/billing", tags=["billing"])

PURCHASE_REASONS = ("purchase", "subscription_grant", "refund", "rebase_topup")


def require_stripe() -> None:
    if not settings.stripe_enabled:
        raise HTTPException(status_code=503, detail="Paiements indisponibles")


def _sub_dict(s: Subscription | None) -> dict | None:
    if not s:
        return None
    return {
        "plan_id": s.plan_id,
        "status": s.status,
        "current_period_end": s.current_period_end.isoformat() if s.current_period_end else None,
        "cancel_at_period_end": s.cancel_at_period_end,
    }


@router.get("/catalogue")
def catalogue():
    return {
        "packs": pricing.catalogue(),
        "publishable_key": settings.stripe_publishable_key,
        "enabled": settings.stripe_enabled,
    }


@router.get("/status")
def status(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sub = (db.query(Subscription)
           .filter(Subscription.user_id == user.id,
                   Subscription.status.in_(("active", "past_due", "incomplete")))
           .order_by(Subscription.created_at.desc()).first())
    purchases = (db.query(CreditTransaction)
                 .filter(CreditTransaction.user_id == user.id,
                         CreditTransaction.reason.in_(PURCHASE_REASONS))
                 .order_by(CreditTransaction.created_at.desc()).limit(10).all())
    return {
        "credit_balance": user.credit_balance,
        "subscription": _sub_dict(sub),
        "purchases": [
            {"reason": p.reason, "delta": p.delta,
             "created_at": p.created_at.isoformat() if p.created_at else None,
             "note": p.note}
            for p in purchases
        ],
    }
```

- [ ] **Step 4: Mount in `app/main.py`**

Add import near the other `from . import ...`:

```python
from . import ai, billing, credits, kraken, storage
```

After `app = FastAPI(...)` and middleware:

```python
app.include_router(billing.router)
```

Extend the existing config endpoint (the dict that returns `page_cost` / `ai_correction_cost`, ~line 308):

```python
        "stripe_publishable_key": settings.stripe_publishable_key,
        "credits_per_page": credits.page_cost(),
```

- [ ] **Step 5: Run to verify it passes**

Run: `pytest tests/test_billing_catalogue.py -q`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add app/billing.py app/main.py tests/test_billing_catalogue.py
git commit -m "feat: billing router with catalogue + status endpoints"
```

---

## Task 9: Purchase intent (one-shot packs)

**Files:**
- Modify: `app/billing.py` (add `POST /intent`)
- Test: `tests/test_billing_intent.py`

**Interfaces:**
- Consumes: `stripe_gateway.ensure_customer`, `stripe_gateway.create_payment_intent`, `pricing.get`, `settings.stripe_price_ids`.
- Produces: `POST /api/billing/intent` body `{"pack_id": str}` →
  - 200 `{"client_secret": str, "amount": int, "currency": str}`
  - 400 if `pack_id` unknown or is a subscription pack
  - 503 if Stripe disabled
  - 502 on `GatewayError`

- [ ] **Step 1: Write the failing test — `tests/test_billing_intent.py`**

```python
import pytest
from app import billing, stripe_gateway


@pytest.fixture(autouse=True)
def _stub_gateway(monkeypatch):
    monkeypatch.setattr(stripe_gateway, "ensure_customer", lambda user: "cus_x")
    monkeypatch.setattr(
        stripe_gateway, "create_payment_intent",
        lambda **kw: ("pi_secret_x", 2900, "eur"))
    monkeypatch.setitem(billing.settings.stripe_price_ids, "starter", "price_s")


def test_intent_happy_path(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    r = client.post("/api/billing/intent", json={"pack_id": "starter"},
                    headers=auth_headers(db, u))
    assert r.status_code == 200
    assert r.json() == {"client_secret": "pi_secret_x", "amount": 2900, "currency": "eur"}


def test_intent_rejects_subscription(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    r = client.post("/api/billing/intent", json={"pack_id": "atelier"},
                    headers=auth_headers(db, u))
    assert r.status_code == 400


def test_intent_rejects_unknown(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    r = client.post("/api/billing/intent", json={"pack_id": "nope"},
                    headers=auth_headers(db, u))
    assert r.status_code == 400


def test_intent_requires_auth(client):
    assert client.post("/api/billing/intent", json={"pack_id": "starter"}).status_code == 401
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_billing_intent.py -q`
Expected: FAIL — 404 / 405 on `/api/billing/intent`.

- [ ] **Step 3: Implement — append to `app/billing.py`**

```python
class IntentIn(BaseModel):
    pack_id: str


@router.post("/intent")
def create_intent(payload: IntentIn, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    require_stripe()
    pack = pricing.get(payload.pack_id)
    if not pack or pack.kind != "one_shot":
        raise HTTPException(status_code=400, detail="Pack inconnu")
    price_id = settings.stripe_price_ids.get(pack.id)
    if not price_id:
        raise HTTPException(status_code=503, detail="Pack non configuré")
    try:
        customer_id = stripe_gateway.ensure_customer(user)
        db.commit()
        secret, amount, currency = stripe_gateway.create_payment_intent(
            customer_id=customer_id,
            price_id=price_id,
            metadata={"user_id": user.id, "pack_id": pack.id, "kind": "credit_pack"},
        )
    except stripe_gateway.GatewayError as e:
        raise HTTPException(status_code=502, detail="Paiement indisponible") from e
    return {"client_secret": secret, "amount": amount, "currency": currency}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_billing_intent.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add app/billing.py tests/test_billing_intent.py
git commit -m "feat: POST /api/billing/intent for one-shot credit packs"
```

---

## Task 10: Subscription create + cancel

**Files:**
- Modify: `app/billing.py` (add `POST /subscribe`, `POST /cancel`)
- Test: `tests/test_billing_subscription.py`

**Interfaces:**
- Consumes: `stripe_gateway.create_subscription`, `stripe_gateway.cancel_subscription`, `stripe_gateway.ensure_customer`.
- Produces:
  - `POST /api/billing/subscribe` body `{"plan_id": str}` →
    - 200 `{"client_secret": str, "subscription_id": str}` and a local `Subscription` row `status="incomplete"`
    - 400 if `plan_id` not a subscription pack
    - 409 if the user already has a row with status in `("active","past_due","incomplete")`
    - 503 / 502 as Task 9
  - `POST /api/billing/cancel` (no body) →
    - 200 `{"status": "canceling"}`, local row `cancel_at_period_end=True`
    - 404 if no cancellable subscription

- [ ] **Step 1: Write the failing test — `tests/test_billing_subscription.py`**

```python
import pytest
from app import billing, stripe_gateway
from app.models import Subscription


@pytest.fixture(autouse=True)
def _stub(monkeypatch):
    monkeypatch.setattr(stripe_gateway, "ensure_customer", lambda user: "cus_x")
    monkeypatch.setattr(stripe_gateway, "create_subscription",
                        lambda **kw: ("seti_secret_x", "sub_123"))
    monkeypatch.setattr(stripe_gateway, "cancel_subscription", lambda sid: None)
    monkeypatch.setitem(billing.settings.stripe_price_ids, "atelier", "price_a")


def test_subscribe_creates_incomplete_row(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    r = client.post("/api/billing/subscribe", json={"plan_id": "atelier"},
                    headers=auth_headers(db, u))
    assert r.status_code == 200
    assert r.json()["subscription_id"] == "sub_123"
    row = db.query(Subscription).filter_by(user_id=u.id).one()
    assert row.status == "incomplete"
    assert row.stripe_subscription_id == "sub_123"


def test_subscribe_conflict(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    db.add(Subscription(user_id=u.id, stripe_subscription_id="sub_old",
                        plan_id="atelier", status="active"))
    db.commit()
    r = client.post("/api/billing/subscribe", json={"plan_id": "atelier"},
                    headers=auth_headers(db, u))
    assert r.status_code == 409


def test_subscribe_rejects_one_shot(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    r = client.post("/api/billing/subscribe", json={"plan_id": "starter"},
                    headers=auth_headers(db, u))
    assert r.status_code == 400


def test_cancel(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    db.add(Subscription(user_id=u.id, stripe_subscription_id="sub_1",
                        plan_id="atelier", status="active"))
    db.commit()
    r = client.post("/api/billing/cancel", headers=auth_headers(db, u))
    assert r.status_code == 200
    db.expire_all()
    assert db.query(Subscription).filter_by(user_id=u.id).one().cancel_at_period_end is True


def test_cancel_without_subscription(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    assert client.post("/api/billing/cancel", headers=auth_headers(db, u)).status_code == 404
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_billing_subscription.py -q`
Expected: FAIL — 404 / 405.

- [ ] **Step 3: Implement — append to `app/billing.py`**

```python
_ACTIVE_SUB = ("active", "past_due", "incomplete")


class SubscribeIn(BaseModel):
    plan_id: str


@router.post("/subscribe")
def subscribe(payload: SubscribeIn, user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    require_stripe()
    pack = pricing.get(payload.plan_id)
    if not pack or pack.kind != "subscription":
        raise HTTPException(status_code=400, detail="Plan inconnu")
    price_id = settings.stripe_price_ids.get(pack.id)
    if not price_id:
        raise HTTPException(status_code=503, detail="Plan non configuré")
    existing = (db.query(Subscription)
                .filter(Subscription.user_id == user.id,
                        Subscription.status.in_(_ACTIVE_SUB)).first())
    if existing:
        raise HTTPException(status_code=409, detail="Abonnement déjà actif")
    try:
        customer_id = stripe_gateway.ensure_customer(user)
        db.commit()
        secret, sub_id = stripe_gateway.create_subscription(
            customer_id=customer_id, price_id=price_id,
            metadata={"user_id": user.id, "plan_id": pack.id},
        )
    except stripe_gateway.GatewayError as e:
        raise HTTPException(status_code=502, detail="Paiement indisponible") from e
    db.add(Subscription(user_id=user.id, stripe_subscription_id=sub_id,
                        plan_id=pack.id, status="incomplete"))
    db.commit()
    return {"client_secret": secret, "subscription_id": sub_id}


@router.post("/cancel")
def cancel(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    require_stripe()
    row = (db.query(Subscription)
           .filter(Subscription.user_id == user.id,
                   Subscription.status.in_(_ACTIVE_SUB))
           .order_by(Subscription.created_at.desc()).first())
    if not row:
        raise HTTPException(status_code=404, detail="Aucun abonnement")
    try:
        stripe_gateway.cancel_subscription(row.stripe_subscription_id)
    except stripe_gateway.GatewayError as e:
        raise HTTPException(status_code=502, detail="Paiement indisponible") from e
    row.cancel_at_period_end = True
    db.commit()
    return {"status": "canceling"}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_billing_subscription.py -q`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add app/billing.py tests/test_billing_subscription.py
git commit -m "feat: subscription create + cancel endpoints"
```

---

## Task 11: Stripe webhook

**Files:**
- Modify: `app/billing.py` (add `POST /api/stripe/webhook` — note: NOT under the router prefix; add a second `APIRouter` with no prefix, or register on `app` in `main.py`. Use a second router `webhook_router = APIRouter()` exported from `billing.py`.)
- Modify: `app/main.py` (`app.include_router(billing.webhook_router)`)
- Test: `tests/test_webhook.py`

**Interfaces:**
- Consumes: `stripe_gateway.construct_event`, `credits.grant`, `pricing.pack_by_price_id`, models `StripeEvent`, `Subscription`, `CreditTransaction`, `User`.
- Produces:
  - `billing.webhook_router: APIRouter`.
  - `POST /api/stripe/webhook`:
    - 400 on bad signature
    - 200 on duplicate event id (no re-processing), unknown event type, or success
    - 500 when a handler raises (so Stripe retries); `StripeEvent.error` set, `processed_at` NULL
  - internal `billing._handle_event(db, event: dict) -> None` — dispatch, importable by the admin replay endpoint (Task 12).
  - internal `billing._grant_once(db, user, amount, reason, ref_type, ref_id) -> None` — skips if a `CreditTransaction` with that `ref_id` already exists.

- [ ] **Step 1: Write the failing test — `tests/test_webhook.py`**

```python
import pytest
from app import billing, stripe_gateway
from app.models import CreditTransaction, StripeEvent, Subscription


def _event(evt_id, evt_type, obj):
    return {"id": evt_id, "type": evt_type, "data": {"object": obj}}


@pytest.fixture()
def _accept_sig(monkeypatch):
    holder = {}
    monkeypatch.setattr(stripe_gateway, "construct_event",
                        lambda payload, sig: holder["event"])
    return holder


def test_bad_signature(client, monkeypatch):
    monkeypatch.setattr(stripe_gateway, "construct_event",
                        lambda p, s: (_ for _ in ()).throw(stripe_gateway.GatewayError("bad")))
    r = client.post("/api/stripe/webhook", content=b"{}",
                    headers={"Stripe-Signature": "x"})
    assert r.status_code == 400


def test_payment_intent_succeeded_grants_credits(client, db, _accept_sig, monkeypatch):
    from tests.conftest import make_user
    u = make_user(db, credits=0)
    monkeypatch.setitem(billing.settings.stripe_price_ids, "starter", "price_s")
    _accept_sig["event"] = _event("evt_1", "payment_intent.succeeded", {
        "id": "pi_1", "metadata": {"user_id": u.id, "pack_id": "starter", "kind": "credit_pack"},
    })
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    assert r.status_code == 200
    db.expire_all()
    assert db.get(type(u), u.id).credit_balance == 300
    assert db.query(CreditTransaction).filter_by(ref_id="pi_1", reason="purchase").count() == 1


def test_duplicate_event_no_double_grant(client, db, _accept_sig, monkeypatch):
    from tests.conftest import make_user
    u = make_user(db, credits=0)
    _accept_sig["event"] = _event("evt_dup", "payment_intent.succeeded", {
        "id": "pi_9", "metadata": {"user_id": u.id, "pack_id": "starter", "kind": "credit_pack"},
    })
    for _ in range(2):
        assert client.post("/api/stripe/webhook", content=b"{}",
                           headers={"Stripe-Signature": "x"}).status_code == 200
    db.expire_all()
    assert db.get(type(u), u.id).credit_balance == 300


def test_invoice_paid_grants_and_upserts_subscription(client, db, _accept_sig, monkeypatch):
    from tests.conftest import make_user
    u = make_user(db, credits=0)
    db.add(Subscription(user_id=u.id, stripe_subscription_id="sub_1",
                        plan_id="atelier", status="incomplete"))
    db.commit()
    monkeypatch.setitem(billing.settings.stripe_price_ids, "atelier", "price_a")
    _accept_sig["event"] = _event("evt_inv", "invoice.paid", {
        "id": "in_1", "subscription": "sub_1", "billing_reason": "subscription_create",
        "lines": {"data": [{"price": {"id": "price_a"}}]},
        "period_end": 1893456000,
    })
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    assert r.status_code == 200
    db.expire_all()
    assert db.get(type(u), u.id).credit_balance == 500
    assert db.query(Subscription).filter_by(stripe_subscription_id="sub_1").one().status == "active"


def test_charge_refunded_clamps_at_zero(client, db, _accept_sig, monkeypatch):
    from tests.conftest import make_user
    from app import credits
    u = make_user(db, credits=0)
    credits.grant(db, u, 300, "purchase", ref_type="stripe_pi", ref_id="pi_r")
    db.commit()
    # user spends 250, leaving 50
    credits.charge(db, u, 250, "page_ocr")
    db.commit()
    _accept_sig["event"] = _event("evt_ref", "charge.refunded", {
        "id": "ch_1", "payment_intent": "pi_r", "amount_refunded": 2900,
        "metadata": {}, "refunds": {"data": []},
    })
    client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    db.expire_all()
    assert db.get(type(u), u.id).credit_balance == 0  # clamped, not -250


def test_unknown_event_ok(client, db, _accept_sig):
    _accept_sig["event"] = _event("evt_u", "customer.created", {"id": "cus_1"})
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    assert r.status_code == 200
    assert db.get(StripeEvent, "evt_u").processed_at is not None


def test_handler_error_returns_500_and_records(client, db, _accept_sig, monkeypatch):
    from tests.conftest import make_user
    make_user(db)
    _accept_sig["event"] = _event("evt_err", "payment_intent.succeeded", {
        "id": "pi_x", "metadata": {"user_id": "missing-user", "pack_id": "starter",
                                   "kind": "credit_pack"},
    })
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    assert r.status_code == 500
    row = db.get(StripeEvent, "evt_err")
    assert row.processed_at is None
    assert row.error != ""
```

Notes for the implementer:
- For `charge.refunded`, "refunded credits" is derived by finding the original grant (`CreditTransaction` with `ref_id == payment_intent`, `reason == "purchase"`) and using its `delta` as the full credit amount; a partial refund proportional to `amount_refunded / original_charge` is out of scope — refund the full pack, clamped at the current balance.
- `invoice.paid` `period_end` is a Unix timestamp → `datetime.fromtimestamp(ts, tz=timezone.utc)`.
- `invoice.paid` price id path: `event["data"]["object"]["lines"]["data"][0]["price"]["id"]`.

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_webhook.py -q`
Expected: FAIL — 404 on `/api/stripe/webhook`.

- [ ] **Step 3: Implement — append to `app/billing.py`**

```python
from datetime import datetime, timezone

webhook_router = APIRouter()


def _grant_once(db: Session, user: User, amount: int, reason: str,
                ref_type: str, ref_id: str) -> None:
    if amount == 0:
        return
    exists = (db.query(CreditTransaction)
              .filter(CreditTransaction.ref_id == ref_id,
                      CreditTransaction.reason == reason).first())
    if exists:
        return
    credits.grant(db, user, amount, reason, ref_type=ref_type, ref_id=ref_id)


def _user_or_raise(db: Session, user_id: str) -> User:
    user = db.get(User, user_id)
    if not user:
        raise ValueError(f"unknown user {user_id}")
    return user


def _on_payment_intent_succeeded(db: Session, obj: dict) -> None:
    meta = obj.get("metadata") or {}
    if meta.get("kind") != "credit_pack":
        return
    user = _user_or_raise(db, meta.get("user_id", ""))
    pack = pricing.get(meta.get("pack_id", ""))
    if not pack:
        raise ValueError(f"unknown pack {meta.get('pack_id')}")
    _grant_once(db, user, pack.credits, "purchase",
                ref_type="stripe_pi", ref_id=obj["id"])


def _on_invoice_paid(db: Session, obj: dict) -> None:
    sub_id = obj.get("subscription")
    if not sub_id:
        return
    price_id = obj["lines"]["data"][0]["price"]["id"]
    pack = pricing.pack_by_price_id(price_id)
    if not pack:
        raise ValueError(f"unknown price {price_id}")
    row = (db.query(Subscription)
           .filter_by(stripe_subscription_id=sub_id).first())
    if row:
        user = _user_or_raise(db, row.user_id)
        row.status = "active"
        period_end = obj.get("period_end")
        if period_end:
            row.current_period_end = datetime.fromtimestamp(period_end, tz=timezone.utc)
    else:
        raise ValueError(f"no local subscription {sub_id}")
    _grant_once(db, user, pack.credits, "subscription_grant",
                ref_type="stripe_inv", ref_id=obj["id"])


def _on_subscription_updated(db: Session, obj: dict) -> None:
    row = db.query(Subscription).filter_by(stripe_subscription_id=obj["id"]).first()
    if not row:
        return
    row.status = obj.get("status", row.status)
    row.cancel_at_period_end = bool(obj.get("cancel_at_period_end"))
    period_end = obj.get("current_period_end")
    if period_end:
        row.current_period_end = datetime.fromtimestamp(period_end, tz=timezone.utc)


def _on_subscription_deleted(db: Session, obj: dict) -> None:
    row = db.query(Subscription).filter_by(stripe_subscription_id=obj["id"]).first()
    if row:
        row.status = "canceled"


def _on_charge_refunded(db: Session, obj: dict) -> None:
    pi = obj.get("payment_intent")
    if not pi:
        return
    grant = (db.query(CreditTransaction)
             .filter_by(ref_id=pi, reason="purchase").first())
    if not grant:
        return
    user = _user_or_raise(db, grant.user_id)
    take = min(grant.delta, user.credit_balance)
    if take <= 0:
        return
    _grant_once(db, user, -take, "refund", ref_type="stripe_refund", ref_id=obj["id"])
    if take < grant.delta:
        # record the clamp for audit
        last = (db.query(CreditTransaction)
                .filter_by(ref_id=obj["id"], reason="refund").first())
        if last:
            last.note = f"clamped: owed {grant.delta}, took {take}"


_HANDLERS = {
    "payment_intent.succeeded": _on_payment_intent_succeeded,
    "invoice.paid": _on_invoice_paid,
    "customer.subscription.updated": _on_subscription_updated,
    "customer.subscription.deleted": _on_subscription_deleted,
    "charge.refunded": _on_charge_refunded,
}


def _handle_event(db: Session, event: dict) -> None:
    handler = _HANDLERS.get(event["type"])
    if handler:
        handler(db, event["data"]["object"])


@webhook_router.post("/api/stripe/webhook")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    payload = await request.body()
    sig = request.headers.get("Stripe-Signature", "")
    try:
        event = stripe_gateway.construct_event(payload, sig)
    except stripe_gateway.GatewayError:
        raise HTTPException(status_code=400, detail="Signature invalide")

    row = db.get(StripeEvent, event["id"])
    if row and row.processed_at is not None:
        return {"received": True, "duplicate": True}
    if row is None:
        row = StripeEvent(id=event["id"], type=event["type"], payload_json=event)
        db.add(row)
        db.commit()

    try:
        _handle_event(db, event)
        row.processed_at = datetime.now(timezone.utc)
        row.error = ""
        db.commit()
    except Exception as e:  # noqa: BLE001 - store + surface for Stripe retry
        db.rollback()
        row = db.get(StripeEvent, event["id"])
        row.error = str(e)[:500]
        row.processed_at = None
        db.commit()
        raise HTTPException(status_code=500, detail="Traitement échoué") from e
    return {"received": True}
```

- [ ] **Step 4: Register in `app/main.py`**

```python
app.include_router(billing.webhook_router)
```

- [ ] **Step 5: Run to verify it passes**

Run: `pytest tests/test_webhook.py -q`
Expected: PASS (8 passed).

- [ ] **Step 6: Run the full suite**

Run: `pytest -q`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add app/billing.py app/main.py tests/test_webhook.py
git commit -m "feat: idempotent Stripe webhook (packs, subscription, refund)"
```

---

## Task 12: Admin billing triage

**Files:**
- Modify: `app/main.py` (add two admin endpoints near the existing admin routes ~line 890-905)
- Test: `tests/test_admin_billing.py`

**Interfaces:**
- Consumes: `app.auth.get_admin_user`, `billing._handle_event`, models `StripeEvent`, `Subscription`, `CreditTransaction`.
- Produces:
  - `GET /api/admin/billing/events?failed=1` → `{"events": [{"id","type","error","received_at","processed"}]}` (when `failed=1`, only rows with `processed_at IS NULL AND error != ''`).
  - `POST /api/admin/billing/events/{event_id}/replay` → re-runs `billing._handle_event` on the stored `payload_json`; on success sets `processed_at`, clears `error`, returns `{"status":"processed"}`; on failure returns 500 with the error and updates `error`.
  - `GET /api/admin/users/{user_id}/billing` → `{"credit_balance", "subscription", "purchases": [...]}` (same shape as `/api/billing/status`, for the target user).

- [ ] **Step 1: Write the failing test — `tests/test_admin_billing.py`**

```python
def test_events_failed_filter(client, db):
    from tests.conftest import make_user, auth_headers
    from app.models import StripeEvent
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    db.add(StripeEvent(id="evt_ok", type="x", payload_json={}, error="",
                       processed_at=__import__("datetime").datetime.now()))
    db.add(StripeEvent(id="evt_bad", type="payment_intent.succeeded",
                       payload_json={"id": "evt_bad", "type": "customer.created",
                                     "data": {"object": {}}}, error="boom"))
    db.commit()
    r = client.get("/api/admin/billing/events?failed=1", headers=auth_headers(db, admin))
    assert r.status_code == 200
    ids = [e["id"] for e in r.json()["events"]]
    assert ids == ["evt_bad"]


def test_replay_marks_processed(client, db):
    from tests.conftest import make_user, auth_headers
    from app.models import StripeEvent
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    db.add(StripeEvent(id="evt_r", type="customer.created", error="was down",
                       payload_json={"id": "evt_r", "type": "customer.created",
                                     "data": {"object": {"id": "cus_1"}}}))
    db.commit()
    r = client.post("/api/admin/billing/events/evt_r/replay", headers=auth_headers(db, admin))
    assert r.status_code == 200
    db.expire_all()
    assert db.get(StripeEvent, "evt_r").processed_at is not None


def test_events_requires_admin(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    assert client.get("/api/admin/billing/events", headers=auth_headers(db, u)).status_code == 403
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_admin_billing.py -q`
Expected: FAIL — 404.

- [ ] **Step 3: Implement — add to `app/main.py`**

```python
from . import billing as _billing_mod
from .models import StripeEvent, Subscription


@app.get("/api/admin/billing/events")
def admin_billing_events(failed: int = 0, db: Session = Depends(get_db),
                         admin: User = Depends(get_admin_user)):
    q = db.query(StripeEvent)
    if failed:
        q = q.filter(StripeEvent.processed_at.is_(None), StripeEvent.error != "")
    rows = q.order_by(StripeEvent.received_at.desc()).limit(100).all()
    return {"events": [
        {"id": e.id, "type": e.type, "error": e.error,
         "received_at": e.received_at.isoformat() if e.received_at else None,
         "processed": e.processed_at is not None}
        for e in rows
    ]}


@app.post("/api/admin/billing/events/{event_id}/replay")
def admin_billing_replay(event_id: str, db: Session = Depends(get_db),
                         admin: User = Depends(get_admin_user)):
    row = db.get(StripeEvent, event_id)
    if not row:
        raise HTTPException(status_code=404, detail="Événement inconnu")
    try:
        _billing_mod._handle_event(db, row.payload_json)
        row.processed_at = datetime.now(timezone.utc)
        row.error = ""
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        row = db.get(StripeEvent, event_id)
        row.error = str(e)[:500]
        db.commit()
        raise HTTPException(status_code=500, detail=str(e)[:200]) from e
    return {"status": "processed"}


@app.get("/api/admin/users/{user_id}/billing")
def admin_user_billing(user_id: str, db: Session = Depends(get_db),
                       admin: User = Depends(get_admin_user)):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Utilisateur inconnu")
    sub = (db.query(Subscription).filter_by(user_id=user_id)
           .order_by(Subscription.created_at.desc()).first())
    purchases = (db.query(Segment.__class__ and __import__("app.models", fromlist=["CreditTransaction"]).CreditTransaction)
                 .filter_by(user_id=user_id).order_by(
                     __import__("app.models", fromlist=["CreditTransaction"]).CreditTransaction.created_at.desc())
                 .limit(20).all())
    return {
        "credit_balance": target.credit_balance,
        "subscription": _billing_mod._sub_dict(sub),
        "purchases": [{"reason": p.reason, "delta": p.delta, "note": p.note,
                       "created_at": p.created_at.isoformat() if p.created_at else None}
                      for p in purchases],
    }
```

Implementer: clean up that `purchases` query — import `CreditTransaction` at the top of `main.py` alongside the other model imports and use it directly:

```python
from .models import (
    AISuggestion, CreditTransaction, Device, Document, GlossaryEntry, Page,
    PageJob, Segment, StripeEvent, Subscription, Transcription, User,
)
```

then

```python
    purchases = (db.query(CreditTransaction).filter_by(user_id=user_id)
                 .order_by(CreditTransaction.created_at.desc()).limit(20).all())
```

- [ ] **Step 4: Run to verify it passes**

Run: `pytest tests/test_admin_billing.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add app/main.py tests/test_admin_billing.py
git commit -m "feat: admin billing event triage + replay + per-user billing view"
```

---

## Task 13: Frontend — Stripe deps + api client

**Files:**
- Modify: `web/package.json` (deps + `test` script)
- Create: `web/vitest.config.ts`
- Modify: `web/src/api.ts` (types + calls)
- Create: `web/src/api.billing.test.ts`

**Interfaces:**
- Consumes: existing `api` object in `web/src/api.ts`.
- Produces on `web/src/api.ts`:
  - types `BillingPack`, `BillingCatalogue`, `BillingStatus`, `BillingSubscription`.
  - `api.billing = { catalogue(): Promise<BillingCatalogue>, status(): Promise<BillingStatus>, intent(packId: string): Promise<{client_secret:string; amount:number; currency:string}>, subscribe(planId: string): Promise<{client_secret:string; subscription_id:string}>, cancel(): Promise<{status:string}> }`.

- [ ] **Step 1: Add deps + script to `web/package.json`**

Under `dependencies`:

```json
    "@stripe/react-stripe-js": "^3.1.1",
    "@stripe/stripe-js": "^5.5.0",
```

Under `devDependencies`:

```json
    "jsdom": "^25.0.1",
    "vitest": "^2.1.8",
```

Under `scripts`:

```json
    "test": "vitest run"
```

Run: `npm --prefix web install`

- [ ] **Step 2: Create `web/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'jsdom', globals: true },
})
```

- [ ] **Step 3: Write the failing test — `web/src/api.billing.test.ts`**

```ts
import { afterEach, expect, test, vi } from 'vitest'
import { api } from './api'

afterEach(() => vi.restoreAllMocks())

test('billing.catalogue calls the endpoint', async () => {
  const body = { packs: [], publishable_key: 'pk_test', enabled: true }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
  const cat = await api.billing.catalogue()
  expect(cat.publishable_key).toBe('pk_test')
})

test('billing.intent posts pack_id', async () => {
  const spy = vi.fn(async () => new Response(JSON.stringify(
    { client_secret: 'cs', amount: 2900, currency: 'eur' }), { status: 200 }))
  vi.stubGlobal('fetch', spy)
  const r = await api.billing.intent('starter')
  expect(r.client_secret).toBe('cs')
  expect(JSON.parse((spy.mock.calls[0][1] as any).body)).toEqual({ pack_id: 'starter' })
})
```

- [ ] **Step 4: Run to verify it fails**

Run: `npm --prefix web test`
Expected: FAIL — `api.billing` is undefined.

- [ ] **Step 5: Implement — append to `web/src/api.ts`**

```ts
export interface BillingPack {
  id: string
  kind: 'one_shot' | 'subscription'
  credits: number
  amount_eur: number
  price_per_page: number
  label: string
  stripe_price_id: string
  interval?: 'month'
}

export interface BillingCatalogue {
  packs: BillingPack[]
  publishable_key: string
  enabled: boolean
}

export interface BillingSubscription {
  plan_id: string
  status: string
  current_period_end: string | null
  cancel_at_period_end: boolean
}

export interface BillingStatus {
  credit_balance: number
  subscription: BillingSubscription | null
  purchases: { reason: string; delta: number; created_at: string | null; note: string }[]
}

api.billing = {
  catalogue: () => api.get<BillingCatalogue>('/api/billing/catalogue'),
  status: () => api.get<BillingStatus>('/api/billing/status'),
  intent: (packId: string) =>
    api.post<{ client_secret: string; amount: number; currency: string }>(
      '/api/billing/intent', { pack_id: packId }),
  subscribe: (planId: string) =>
    api.post<{ client_secret: string; subscription_id: string }>(
      '/api/billing/subscribe', { plan_id: planId }),
  cancel: () => api.post<{ status: string }>('/api/billing/cancel'),
}
```

Change the `export const api = { ... }` declaration so the object has a mutable `billing` field — add `billing: {} as any,` inside the literal, then the assignment above narrows it. Or convert to:

```ts
export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body !== undefined ? body : {} }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  billing: undefined as unknown as {
    catalogue: () => Promise<BillingCatalogue>
    status: () => Promise<BillingStatus>
    intent: (packId: string) => Promise<{ client_secret: string; amount: number; currency: string }>
    subscribe: (planId: string) => Promise<{ client_secret: string; subscription_id: string }>
    cancel: () => Promise<{ status: string }>
  },
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm --prefix web test && npm --prefix web run build`
Expected: tests PASS, build OK.

- [ ] **Step 7: Commit**

```bash
git add web/package.json web/package-lock.json web/vitest.config.ts web/src/api.ts web/src/api.billing.test.ts
git commit -m "feat(web): stripe deps + billing api client + vitest"
```

---

## Task 14: Frontend — PromptModal, replace window.prompt

**Files:**
- Create: `web/src/components/PromptModal.tsx`
- Modify: `web/src/pages/Station.tsx` (`newDocument`, `editTags`)
- Create: `web/src/components/PromptModal.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `usePrompt()` hook returning `{ prompt: (opts: { title: string; label?: string; initial?: string; placeholder?: string }) => Promise<string | null>, node: React.ReactNode }`. `node` must be rendered once in the component tree; `prompt()` resolves to the entered string or `null` on cancel.

- [ ] **Step 1: Write the failing test — `web/src/components/PromptModal.test.tsx`**

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { expect, test } from 'vitest'
import { useEffect } from 'react'
import { usePrompt } from './PromptModal'

function Harness({ onResult }: { onResult: (v: string | null) => void }) {
  const { prompt, node } = usePrompt()
  useEffect(() => { prompt({ title: 'Titre ?' }).then(onResult) }, [])
  return <>{node}</>
}

test('resolves with the typed value', async () => {
  let result: string | null | undefined
  render(<Harness onResult={(v) => { result = v }} />)
  const input = await screen.findByRole('textbox')
  fireEvent.change(input, { target: { value: 'Liste Augustin' } })
  fireEvent.click(screen.getByText('Valider'))
  await waitFor(() => expect(result).toBe('Liste Augustin'))
})

test('resolves null on cancel', async () => {
  let result: string | null | undefined = 'x'
  render(<Harness onResult={(v) => { result = v }} />)
  await screen.findByRole('textbox')
  fireEvent.click(screen.getByText('Annuler'))
  await waitFor(() => expect(result).toBeNull())
})
```

Add `@testing-library/react` + `@testing-library/dom` to `web` devDependencies (`^16.1.0` / `^10.4.0`) and `npm --prefix web install`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix web test`
Expected: FAIL — no `usePrompt`.

- [ ] **Step 3: Write `web/src/components/PromptModal.tsx`**

```tsx
import { useCallback, useRef, useState } from 'react'

interface PromptOpts {
  title: string
  label?: string
  initial?: string
  placeholder?: string
}

export function usePrompt() {
  const [opts, setOpts] = useState<PromptOpts | null>(null)
  const [value, setValue] = useState('')
  const resolver = useRef<((v: string | null) => void) | null>(null)

  const prompt = useCallback((o: PromptOpts) => {
    setOpts(o)
    setValue(o.initial ?? '')
    return new Promise<string | null>((resolve) => { resolver.current = resolve })
  }, [])

  const close = (result: string | null) => {
    resolver.current?.(result)
    resolver.current = null
    setOpts(null)
  }

  const node = opts ? (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
         onMouseDown={() => close(null)}>
      <div className="bg-white rounded-lg shadow-xl w-80 p-4" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold mb-2">{opts.title}</h2>
        {opts.label && <label className="text-xs text-slate-500">{opts.label}</label>}
        <input autoFocus className="w-full border rounded-md px-2 py-1.5 text-sm mt-1"
               placeholder={opts.placeholder}
               value={value} onChange={(e) => setValue(e.target.value)}
               onKeyDown={(e) => {
                 if (e.key === 'Enter') close(value)
                 if (e.key === 'Escape') close(null)
               }} />
        <div className="flex justify-end gap-2 mt-3 text-sm">
          <button className="px-3 py-1 text-slate-500" onClick={() => close(null)}>Annuler</button>
          <button className="px-3 py-1 bg-indigo-600 text-white rounded-md"
                  onClick={() => close(value)}>Valider</button>
        </div>
      </div>
    </div>
  ) : null

  return { prompt, node }
}
```

- [ ] **Step 4: Wire into `web/src/pages/Station.tsx`**

At the top of `Station()`:

```tsx
  const { prompt: showPrompt, node: promptNode } = usePrompt()
```

Render `{promptNode}` just before the closing `</div>` of the top-level return (next to `{toast && ...}`).

Replace `newDocument`:

```tsx
  async function newDocument() {
    const title = await showPrompt({ title: 'Nouveau document', label: 'Titre', placeholder: 'Liste Augustin…' })
    if (!title) return
    const data = await api.post<{ id: string }>('/api/documents', { title })
    await refreshQueue()
    await selectDoc(data.id)
    notify('Document créé — sélectionne des fichiers à envoyer')
  }
```

Replace the `prompt(...)` call in `editTags`:

```tsx
    const next = await showPrompt({
      title: 'Dossier / tags', label: 'Séparés par des virgules',
      initial: doc.tags.join(', '),
    })
    if (next === null) return
    const tags = [...new Set(next.split(',').map((t) => t.trim()).filter(Boolean))]
```

Import: `import { usePrompt } from '../components/PromptModal'`.

- [ ] **Step 5: Run to verify it passes**

Run: `npm --prefix web test && npm --prefix web run build`
Expected: PASS + build OK.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/PromptModal.tsx web/src/components/PromptModal.test.tsx web/src/pages/Station.tsx web/package.json web/package-lock.json
git commit -m "feat(web): PromptModal replaces blocking window.prompt"
```

---

## Task 15: Frontend — Billing page

**Files:**
- Create: `web/src/pages/Billing.tsx`
- Modify: `web/src/main.tsx` (route)
- Modify: `web/src/pages/Station.tsx` (nav link in the header)
- Create: `web/src/pages/Billing.test.tsx`

**Interfaces:**
- Consumes: `api.billing`, `@stripe/stripe-js` `loadStripe`, `@stripe/react-stripe-js` `Elements`, `PaymentElement`, `AddressElement`, `useStripe`, `useElements`.
- Produces: default-exported `Billing` component, route `/billing`.

- [ ] **Step 1: Write the failing test — `web/src/pages/Billing.test.tsx`**

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, test, vi, afterEach } from 'vitest'
import { api } from '../api'
import Billing from './Billing'

afterEach(() => vi.restoreAllMocks())

test('renders the catalogue packs', async () => {
  vi.spyOn(api.billing, 'catalogue').mockResolvedValue({
    enabled: true, publishable_key: 'pk_test',
    packs: [
      { id: 'starter', kind: 'one_shot', credits: 300, amount_eur: 29, price_per_page: 0.097, label: 'Starter', stripe_price_id: 'price_s' },
      { id: 'atelier', kind: 'subscription', credits: 500, amount_eur: 39, price_per_page: 0.078, label: 'Atelier', stripe_price_id: 'price_a', interval: 'month' },
    ],
  })
  vi.spyOn(api.billing, 'status').mockResolvedValue(
    { credit_balance: 12, subscription: null, purchases: [] })
  render(<MemoryRouter><Billing /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText('Starter')).toBeTruthy())
  expect(screen.getByText('Atelier')).toBeTruthy()
  expect(screen.getByText(/12/)).toBeTruthy()
})

test('shows disabled notice when billing is off', async () => {
  vi.spyOn(api.billing, 'catalogue').mockResolvedValue(
    { enabled: false, publishable_key: '', packs: [] })
  vi.spyOn(api.billing, 'status').mockResolvedValue(
    { credit_balance: 0, subscription: null, purchases: [] })
  render(<MemoryRouter><Billing /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText(/indisponible/i)).toBeTruthy())
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix web test`
Expected: FAIL — `./Billing` not found.

- [ ] **Step 3: Write `web/src/pages/Billing.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Elements, PaymentElement, AddressElement, useElements, useStripe }
  from '@stripe/react-stripe-js'
import { loadStripe, Stripe } from '@stripe/stripe-js'
import { api, BillingCatalogue, BillingStatus, BillingPack } from '../api'

function CheckoutForm({ onDone }: { onDone: () => void }) {
  const stripe = useStripe()
  const elements = useElements()
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!stripe || !elements) return
    setBusy(true); setErr('')
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/billing?done=1` },
      redirect: 'if_required',
    })
    setBusy(false)
    if (error) setErr(error.message || 'Paiement refusé')
    else onDone()
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <AddressElement options={{ mode: 'billing' }} />
      <PaymentElement />
      {err && <p className="text-sm text-red-600">{err}</p>}
      <button disabled={!stripe || busy}
              className="w-full bg-indigo-600 text-white rounded-md py-2 text-sm disabled:opacity-50">
        {busy ? 'Traitement…' : 'Payer'}
      </button>
    </form>
  )
}

export default function Billing() {
  const [cat, setCat] = useState<BillingCatalogue | null>(null)
  const [status, setStatus] = useState<BillingStatus | null>(null)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [selected, setSelected] = useState<BillingPack | null>(null)
  const [msg, setMsg] = useState('')

  const stripePromise = useMemo<Promise<Stripe | null> | null>(
    () => (cat?.publishable_key ? loadStripe(cat.publishable_key) : null), [cat?.publishable_key])

  const reload = () => Promise.all([api.billing.catalogue(), api.billing.status()])
    .then(([c, s]) => { setCat(c); setStatus(s) })

  useEffect(() => { reload() }, [])
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('done')) {
      setMsg('Paiement reçu — les crédits arrivent dans quelques secondes.')
      const t = setInterval(() => api.billing.status().then(setStatus), 2500)
      setTimeout(() => clearInterval(t), 20000)
    }
  }, [])

  async function pick(p: BillingPack) {
    setSelected(p); setClientSecret(null); setMsg('')
    const r = p.kind === 'subscription'
      ? await api.billing.subscribe(p.id)
      : await api.billing.intent(p.id)
    setClientSecret(r.client_secret)
  }

  async function cancelSub() {
    await api.billing.cancel()
    setMsg('Abonnement résilié à la fin de la période.')
    reload()
  }

  if (!cat || !status) return <div className="p-8 text-slate-400">Chargement…</div>

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-4">
        <Link to="/" className="text-sm text-slate-500">← Station</Link>
        <h1 className="text-lg font-semibold">Crédits</h1>
        <span className="text-sm bg-indigo-50 text-indigo-700 rounded-full px-3 py-1">
          {status.credit_balance} crédits
        </span>
      </div>

      <p className="text-sm text-slate-500 mb-4">1 crédit = 1 page. La correction IA est offerte.</p>
      {msg && <p className="text-sm text-emerald-700 bg-emerald-50 rounded-md p-2 mb-4">{msg}</p>}

      {!cat.enabled && (
        <p className="text-sm text-amber-700 bg-amber-50 rounded-md p-3">
          Les paiements sont temporairement indisponibles.
        </p>
      )}

      {status.subscription && (
        <div className="border rounded-lg p-3 mb-4 text-sm">
          Abonnement <b>{status.subscription.plan_id}</b> — {status.subscription.status}
          {status.subscription.cancel_at_period_end
            ? ' (résiliation programmée)'
            : <button className="ml-3 text-red-600" onClick={cancelSub}>Résilier</button>}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        {cat.packs.map((p) => (
          <button key={p.id} onClick={() => pick(p)} disabled={!cat.enabled}
                  className={`text-left border rounded-lg p-4 hover:border-indigo-400 disabled:opacity-40
                              ${selected?.id === p.id ? 'border-indigo-500 ring-1 ring-indigo-300' : ''}`}>
            <div className="flex items-center justify-between">
              <span className="font-medium">{p.label}</span>
              {p.id === 'chercheur' && (
                <span className="text-[10px] bg-indigo-100 text-indigo-700 rounded px-1.5 py-0.5">
                  meilleur rapport
                </span>
              )}
            </div>
            <p className="text-2xl font-semibold mt-1">
              {p.amount_eur.toFixed(0)} €{p.interval ? <span className="text-sm">/mois</span> : null}
            </p>
            <p className="text-xs text-slate-500">
              {p.credits} crédits · {(p.price_per_page).toFixed(3)} €/page
            </p>
          </button>
        ))}
      </div>

      {clientSecret && stripePromise && (
        <div className="border rounded-lg p-4 mt-5">
          <h2 className="text-sm font-semibold mb-3">Paiement — {selected?.label}</h2>
          <Elements stripe={stripePromise} options={{ clientSecret }}>
            <CheckoutForm onDone={() => {
              setClientSecret(null)
              setMsg('Paiement confirmé — mise à jour du solde…')
              const t = setInterval(() => api.billing.status().then(setStatus), 2000)
              setTimeout(() => clearInterval(t), 20000)
            }} />
          </Elements>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Add the route in `web/src/main.tsx`**

```tsx
import Billing from './pages/Billing'
// ...
        <Route path="/billing" element={<RequireAuth><Billing /></RequireAuth>} />
```

- [ ] **Step 5: Add a header link in `web/src/pages/Station.tsx`**

Next to the credits chip in the `<header>`:

```tsx
        <Link to="/billing" className="text-sm text-indigo-600 hover:underline">Acheter des crédits</Link>
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm --prefix web test && npm --prefix web run build`
Expected: PASS + build OK. If the Stripe modules break jsdom import, mock them in the test file with `vi.mock('@stripe/react-stripe-js', ...)` and `vi.mock('@stripe/stripe-js', ...)` returning stubs.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/Billing.tsx web/src/pages/Billing.test.tsx web/src/main.tsx web/src/pages/Station.tsx
git commit -m "feat(web): /billing page with Payment Element"
```

---

## Task 16: Rollout notes + full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-08-31-d1-stripe-payments-design.md` (tick the rollout section as done where applicable — optional)
- Modify: `README.md` (env var list, if one exists; otherwise add a short "Stripe (D1)" section)
- Create: `docs/superpowers/plans/2026-08-31-d1-stripe-payments-DONE.md` (short: what shipped, what the operator must still do)

**Interfaces:** none.

- [ ] **Step 1: Run the whole backend suite**

Run: `pytest -q`
Expected: all pass. Fix any regressions in `main.py` (import of `CreditTransaction`, `StripeEvent`, `Subscription` must be present exactly once).

- [ ] **Step 2: Run the whole frontend suite + build**

Run: `npm --prefix web test && npm --prefix web run build`
Expected: all pass, build OK.

- [ ] **Step 3: Write the operator checklist — `docs/superpowers/plans/2026-08-31-d1-stripe-payments-DONE.md`**

```markdown
# D1 shipped — operator actions

## Before deploying
1. `pg_dump` the Palimora-Postgres service (Coolify) — the rebase migration
   rewrites the credit ledger irreversibly.

## Stripe test dashboard
2. Create 4 Prices (EUR): starter €29 one-shot, chercheur €119 one-shot,
   archiviste €399 one-shot, atelier €39/month recurring.
3. Confirm the webhook endpoint points at
   `https://api.palimora.pays.fr.eu.org/api/stripe/webhook` and sends
   `payment_intent.succeeded`, `invoice.paid`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `charge.refunded`.

## Coolify env (Palimora Server + Worker)
STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET,
STRIPE_PRICE_STARTER, STRIPE_PRICE_CHERCHEUR, STRIPE_PRICE_ARCHIVISTE,
STRIPE_PRICE_ATELIER, STRIPE_TAX_ENABLED=true,
BILLING_ENTITY_NAME, BILLING_ENTITY_ADDRESS, BILLING_ENTITY_COUNTRY=FR,
PAGE_COST_POINTS=1, AI_CORRECTION_COST_POINTS=0, SIGNUP_BONUS_POINTS=100,
REBASE_TOPUP_TO=0 (set to 100 for one deploy if you want to top existing users up).

## After deploy — smoke test
- A known account's balance is exactly floor(old/10).
- New signup → 100 credits.
- OCR one page → costs 1 credit; AI correction → costs 0.
- Buy Starter with test card 4242 4242 4242 4242 → balance +300, ledger row
  `purchase`, Stripe dashboard webhook shows 2xx.
- Subscribe to Atelier → first invoice paid → +500, subscription row `active`.
- Refund the Starter charge in Stripe → balance drops (clamped at 0).

## Still open (not D1)
- VAT status confirmation; GBP/USD; branded invoices → D3.
- palimora.app domain switch.
```

- [ ] **Step 4: Commit**

```bash
git add docs/ README.md
git commit -m "docs: D1 operator checklist + env reference"
```

- [ ] **Step 5: Push**

```bash
git push origin main
```

---

## Self-Review

**Spec coverage:**
- §2 credit rebrand → Tasks 2, 3, 4. ✔
- §3 catalogue → Task 6. ✔
- §4 data model → Tasks 4, 5. ✔
- §5 endpoints (catalogue/status/intent/subscribe/cancel/webhook) → Tasks 8, 9, 10, 11. ✔
- §5 address/tax handling → Task 7 (`_tax()`), Task 15 (`AddressElement`). ✔ (partial: the "retry once without automatic_tax on 400" nuance from the spec is simplified — the gateway sends `automatic_tax` always; if Stripe 400s in test the operator sees a 502. Acceptable for sandbox; noted here as a known simplification.)
- §6 webhook idempotency + handlers → Task 11. ✔
- §7 config/secrets → Task 2. ✔
- §7 receipts (Stripe native) → operator toggle, Task 16 checklist. ✔
- §9 admin triage → Task 12. ✔
- §10 testing → Task 1 + tests in every task. ✔
- §11 rollout → Task 16. ✔
- §8 frontend → Tasks 13, 14, 15. ✔
- §2 `window.prompt` replacement → Task 14. ✔

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Test code is spelled out. The one soft spot (`admin_user_billing` query) is flagged with the exact fix inline.

**Type consistency:**
- `credits.grant`/`charge` return `CreditTransaction | None` — used consistently (Tasks 3, 11 `_grant_once`).
- `pack.kind` values `"one_shot"` / `"subscription"` — consistent across `pricing.py`, `billing.py` (`create_intent`, `subscribe`), `api.ts` `BillingPack`.
- `stripe_gateway` function signatures match their call sites in Tasks 9–11.
- `_sub_dict` / `_handle_event` / `_grant_once` names reused verbatim in Task 12.
- Webhook lives on `billing.webhook_router` (no prefix); customer endpoints on `billing.router` (`/api/billing`). Both mounted in Task 8 / Task 11.

**Known simplifications (accepted, sandbox scope):** partial-refund proportionality (full-pack clamp instead); `automatic_tax` no-retry; subscription assumed single-plan (`atelier`).
