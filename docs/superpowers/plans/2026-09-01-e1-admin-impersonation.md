# E1 — Admin User Impersonation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin act as another user through the web SPA (via an `X-Impersonate` header resolved in the auth layer) to debug support issues, blocking money/credit actions and writing a full audit trail.

**Architecture:** `get_current_user` resolves an optional `X-Impersonate: <user_id>` header — non-admin caller → 403, unknown/inactive target → 404, admin target → 403, otherwise it returns the *target* user and stashes ids on `request.state`. A single `@app.middleware("http")` blocks a fixed list of mutating money/credit paths whenever the header is present, and (after the response) records every impersonated non-GET request to a new `admin_audit_log` table using its own DB session. Two admin endpoints start/stop a session (each writes its own audit row); one admin endpoint reads the log. The SPA stores the impersonation target in `localStorage`, injects the header, shows a sticky banner, and adds per-user "Impersoner" buttons plus an audit panel to `/admin`.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 (Mapped/mapped_column), Starlette HTTP middleware, pytest + FastAPI TestClient (SQLite in-memory), React 18 + react-router-dom 6, Vite, Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-01-e1-admin-impersonation-design.md`

## Global Constraints

- No Alembic. New tables are created by `Base.metadata.create_all(engine)` at startup; `_migrate()` in `app/main.py` is only for `ADD COLUMN`. This feature adds **no** `_migrate()` entry.
- No new env vars, no `app/config.py` change.
- ORM id columns: `Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)` where `uid` / `now` come from `app/models.py`.
- Error messages are French, matching existing style (`"Utilisateur introuvable"`, `"Accès administrateur requis"`).
- Money/credit paths blocked under impersonation: any `/api/billing/`, any `/api/stripe/`, `POST /api/documents/{id}/finalize`, `POST /api/pages/{id}/reocr`. `POST /api/pages/{id}/ai-suggest` is **allowed** (AI cost is 0 post-D1).
- Admin impersonating another admin is forbidden (403).
- Caveman chat style does not apply to code, comments, or commit messages — write those normally.
- Do not commit to `main` directly. Create a branch `feat/e1-admin-impersonation` before the first commit.
- Test commands: `pytest` (from repo root) and `npm --prefix web test`.

---

### Task 1: `AdminAuditLog` model

**Files:**
- Modify: `app/models.py` (add class near the other billing/admin models, after `StripeEvent`)
- Test: `tests/test_audit_model.py` (create)

**Interfaces:**
- Consumes: `uid`, `now`, `Base` from `app/models.py`.
- Produces: `AdminAuditLog` ORM class with columns `id: str`, `actor_user_id: str`, `target_user_id: str | None`, `event: str`, `method: str | None`, `path: str | None`, `status_code: int | None`, `created_at: datetime`. Table name `admin_audit_log`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_audit_model.py
from app.models import AdminAuditLog
from tests.conftest import make_user


def test_admin_audit_log_row_roundtrips(db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    row = AdminAuditLog(
        actor_user_id=admin.id,
        target_user_id=target.id,
        event="request",
        method="PATCH",
        path="/api/pages/abc/transcription",
        status_code=200,
    )
    db.add(row)
    db.commit()
    db.expire_all()

    saved = db.query(AdminAuditLog).one()
    assert saved.id  # uuid default applied
    assert saved.actor_user_id == admin.id
    assert saved.target_user_id == target.id
    assert saved.event == "request"
    assert saved.method == "PATCH"
    assert saved.status_code == 200
    assert saved.created_at is not None


def test_admin_audit_log_start_row_has_null_method_path(db):
    admin = make_user(db, email="a2@test.fr", is_admin=True)
    target = make_user(db, email="u2@test.fr")
    db.add(AdminAuditLog(actor_user_id=admin.id, target_user_id=target.id,
                         event="impersonation.start"))
    db.commit()
    db.expire_all()
    saved = db.query(AdminAuditLog).filter_by(event="impersonation.start").one()
    assert saved.method is None
    assert saved.path is None
    assert saved.status_code is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_audit_model.py -v`
Expected: FAIL with `ImportError: cannot import name 'AdminAuditLog'`

- [ ] **Step 3: Add the model**

In `app/models.py`, after the `StripeEvent` class:

```python
class AdminAuditLog(Base):
    """Impersonation session boundaries + every mutating request made while an
    admin is impersonating a user. Written by app.audit.record (own session)."""
    __tablename__ = "admin_audit_log"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    actor_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True)
    target_user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=True)
    event: Mapped[str] = mapped_column(String(20))  # impersonation.start|stop|request
    method: Mapped[str | None] = mapped_column(String(10), nullable=True)
    path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, index=True)
```

`ForeignKey`, `Integer`, `String`, `DateTime` are already imported in `app/models.py`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_audit_model.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git checkout -b feat/e1-admin-impersonation
git add app/models.py tests/test_audit_model.py
git commit -m "feat(admin): add admin_audit_log table for impersonation audit"
```

---

### Task 2: `app/audit.py` — audit writer with its own session

**Files:**
- Create: `app/audit.py`
- Test: `tests/test_audit_writer.py` (create)

**Interfaces:**
- Consumes: `app.db` module (reads `app.db.engine` at call time), `AdminAuditLog` from Task 1.
- Produces: `record(*, actor_user_id: str, target_user_id: str | None = None, event: str, method: str | None = None, path: str | None = None, status_code: int | None = None) -> None`. Opens a fresh `Session` bound to `app.db.engine`, inserts one row, commits, closes. Never raises — logs to stderr on failure.

**Why a fresh session:** the request's own DB session may have been rolled back by an exception in the route; the audit row must survive that. Reading `app.db.engine` at call time (not import time) lets the pytest `client` fixture's `monkeypatch.setattr(db_module, "engine", _engine)` redirect audit writes to the shared in-memory test DB.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_audit_writer.py
from app import audit
from app.models import AdminAuditLog
from tests.conftest import make_user


def test_record_inserts_row(client, db, monkeypatch):
    # client fixture patches app.db.engine to the shared test engine
    import app.db as db_module
    monkeypatch.setattr(audit, "_db", db_module, raising=False)  # no-op if already the module
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")

    audit.record(actor_user_id=admin.id, target_user_id=target.id,
                 event="request", method="POST", path="/api/glossary", status_code=200)

    db.expire_all()
    row = db.query(AdminAuditLog).one()
    assert row.event == "request"
    assert row.actor_user_id == admin.id
    assert row.status_code == 200


def test_record_never_raises_on_bad_data(client, db):
    # event too long / bad FK should be swallowed, not raised
    audit.record(actor_user_id="does-not-exist", event="request",
                 method="GET", path="/x", status_code=200)
    # no assertion needed: absence of exception is the test
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_audit_writer.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.audit'`

- [ ] **Step 3: Write the module**

```python
# app/audit.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_audit_writer.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add app/audit.py tests/test_audit_writer.py
git commit -m "feat(admin): add audit.record writer with isolated session"
```

---

### Task 3: `X-Impersonate` resolution in `get_current_user`

**Files:**
- Modify: `app/auth.py` (`get_current_user`, plus new helper `resolve_impersonation_target`)
- Test: `tests/test_impersonation_resolve.py` (create)

**Interfaces:**
- Consumes: existing `bearer_token`, `get_user_by_token`; `User` model.
- Produces:
  - `resolve_impersonation_target(db: Session, target_id: str) -> User` — raises `HTTPException(404, "Utilisateur introuvable")` if missing or `not is_active`; `HTTPException(403, "Impersonation d'un administrateur interdite")` if `is_admin`; else returns the `User`.
  - `get_current_user` unchanged signature `(request: Request, db: Session = Depends(get_db)) -> User`. New behaviour: when header `X-Impersonate` is present **and** `request.url.path` does not start with `/api/admin/impersonate`:
    - real user not `is_admin` → `HTTPException(403, "Impersonation réservée aux administrateurs")`
    - else resolve target via helper, set `request.state.impersonator_id` and `request.state.impersonated_id`, return the target.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_impersonation_resolve.py
from tests.conftest import make_user, auth_headers


def _imp_headers(db, admin, target_id):
    return {**auth_headers(db, admin), "X-Impersonate": target_id}


def test_admin_sees_target_data(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    # target has a document; admin (impersonating) should see it via /api/documents
    r = client.post("/api/documents", json={"title": "T"},
                    headers=auth_headers(db, target))
    assert r.status_code == 200
    r = client.get("/api/documents", headers=_imp_headers(db, admin, target.id))
    assert r.status_code == 200
    assert any(d["title"] == "T" for d in r.json()["documents"])


def test_non_admin_impersonation_header_forbidden(client, db):
    u1 = make_user(db, email="u1@test.fr")
    u2 = make_user(db, email="u2@test.fr")
    r = client.get("/api/documents", headers=_imp_headers(db, u1, u2.id))
    assert r.status_code == 403


def test_unknown_target_404(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    r = client.get("/api/documents", headers=_imp_headers(db, admin, "nope"))
    assert r.status_code == 404


def test_inactive_target_404(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    target.is_active = False
    db.commit()
    r = client.get("/api/documents", headers=_imp_headers(db, admin, target.id))
    assert r.status_code == 404


def test_impersonating_another_admin_403(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    admin2 = make_user(db, email="admin2@test.fr", is_admin=True)
    r = client.get("/api/documents", headers=_imp_headers(db, admin, admin2.id))
    assert r.status_code == 403


def test_admin_routes_403_while_impersonating(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    r = client.get("/api/admin/users", headers=_imp_headers(db, admin, target.id))
    assert r.status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_impersonation_resolve.py -v`
Expected: FAIL — `test_admin_sees_target_data` returns the admin's own (empty) document list; `test_unknown_target_404` returns 200; etc.

- [ ] **Step 3: Implement**

In `app/auth.py`, add the helper and edit `get_current_user`:

```python
def resolve_impersonation_target(db: Session, target_id: str) -> User:
    target = db.query(User).filter_by(id=target_id).one_or_none()
    if not target or not target.is_active:
        raise HTTPException(status_code=404, detail="Utilisateur introuvable")
    if target.is_admin:
        raise HTTPException(status_code=403,
                            detail="Impersonation d'un administrateur interdite")
    return target


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = bearer_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Authentification requise")
    user = get_user_by_token(db, token)
    if not user:
        raise HTTPException(status_code=401, detail="Jeton invalide ou expiré")

    impersonate = request.headers.get("X-Impersonate")
    if impersonate and not request.url.path.startswith("/api/admin/impersonate"):
        if not user.is_admin:
            raise HTTPException(status_code=403,
                                detail="Impersonation réservée aux administrateurs")
        target = resolve_impersonation_target(db, impersonate)
        request.state.impersonator_id = user.id
        request.state.impersonated_id = target.id
        return target
    return user
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_impersonation_resolve.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full backend suite (no regressions)**

Run: `pytest -q`
Expected: PASS (all prior tests still green)

- [ ] **Step 6: Commit**

```bash
git add app/auth.py tests/test_impersonation_resolve.py
git commit -m "feat(auth): resolve X-Impersonate header to target user for admins"
```

---

### Task 4: Write-block middleware

**Files:**
- Modify: `app/main.py` (add `import re`, a module-level compiled pattern list, and one `@app.middleware("http")` function after the `CORSMiddleware` block; add `from .audit import record as _audit_record` to imports — used in Task 5 but import now)
- Test: `tests/test_impersonation_block.py` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime except `request.state` names from Task 3.
- Produces: middleware `impersonation_guard(request, call_next)`. For a request whose method is not in `{GET, HEAD, OPTIONS}` **and** that carries `X-Impersonate` **and** whose path is not an impersonation control path: if the path matches a blocked pattern, return `JSONResponse(status_code=403, content={"detail": "Action indisponible en mode impersonation"})` without calling the route. Otherwise proceed. (Request-audit logging is added in Task 5.)

- [ ] **Step 1: Write the failing test**

```python
# tests/test_impersonation_block.py
from tests.conftest import make_user, auth_headers


def _imp(db, admin, target_id):
    return {**auth_headers(db, admin), "X-Impersonate": target_id}


def test_finalize_blocked_while_impersonating(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr", credits=100)
    doc = client.post("/api/documents", json={"title": "T"},
                      headers=auth_headers(db, target)).json()
    r = client.post(f"/api/documents/{doc['id']}/finalize",
                    headers=_imp(db, admin, target.id))
    assert r.status_code == 403
    assert r.json()["detail"] == "Action indisponible en mode impersonation"


def test_reocr_blocked_while_impersonating(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr", credits=100)
    r = client.post("/api/pages/whatever/reocr", headers=_imp(db, admin, target.id))
    assert r.status_code == 403
    assert r.json()["detail"] == "Action indisponible en mode impersonation"


def test_billing_blocked_while_impersonating(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    r = client.post("/api/billing/intent", json={"pack_id": "starter"},
                    headers=_imp(db, admin, target.id))
    assert r.status_code == 403
    assert r.json()["detail"] == "Action indisponible en mode impersonation"


def test_benign_patch_allowed_while_impersonating(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    r = client.post("/api/glossary", json={"term": "abbé", "definition": "titre"},
                    headers=_imp(db, admin, target.id))
    assert r.status_code == 200


def test_finalize_not_blocked_without_header(client, db):
    # a normal user hitting finalize on a missing doc gets 404, not the 403 block
    u = make_user(db, email="user@test.fr", credits=100)
    r = client.post("/api/documents/missing/finalize", headers=auth_headers(db, u))
    assert r.status_code == 404
```

(If `POST /api/glossary` payload keys differ in the codebase, match the real `GlossaryEntry` create schema — check `app/main.py` around the glossary route before writing the test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_impersonation_block.py -v`
Expected: FAIL — blocked routes return their normal status (404/422/503), not 403 with the impersonation detail.

- [ ] **Step 3: Implement the middleware**

In `app/main.py`, add `import re` at the top with the other stdlib imports, add `from fastapi.responses import JSONResponse` (extend the existing `fastapi.responses` import line), and add `from .audit import record as _audit_record` near the other `.` imports. Then, immediately after the `app.add_middleware(CORSMiddleware, ...)` block:

```python
_IMPERSONATION_BLOCKED = (
    re.compile(r"^/api/billing/"),
    re.compile(r"^/api/stripe/"),
    re.compile(r"^/api/documents/[^/]+/finalize$"),
    re.compile(r"^/api/pages/[^/]+/reocr$"),
)
_WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _is_impersonation_control(path: str) -> bool:
    return path == "/api/admin/impersonate" or path.startswith("/api/admin/impersonate/")


@app.middleware("http")
async def impersonation_guard(request: Request, call_next):
    impersonate = request.headers.get("X-Impersonate")
    is_write = request.method in _WRITE_METHODS
    path = request.url.path
    relevant = bool(impersonate) and is_write and not _is_impersonation_control(path)

    if relevant and any(p.search(path) for p in _IMPERSONATION_BLOCKED):
        return JSONResponse(
            status_code=403,
            content={"detail": "Action indisponible en mode impersonation"},
        )

    response = await call_next(request)

    # Task 5 adds request-audit logging here.
    return response
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_impersonation_block.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full backend suite**

Run: `pytest -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/main.py tests/test_impersonation_block.py
git commit -m "feat(admin): block money/credit routes during impersonation"
```

---

### Task 5: Request-audit logging in the middleware

**Files:**
- Modify: `app/main.py` (fill in the `# Task 5 adds ...` spot in `impersonation_guard`)
- Test: `tests/test_impersonation_request_audit.py` (create)

**Interfaces:**
- Consumes: `_audit_record` (= `app.audit.record`), `request.state.impersonator_id` / `impersonated_id` set by Task 3.
- Produces: after `call_next`, for a non-GET request that carried `X-Impersonate` and is not a control path and was not blocked: if `request.state.impersonator_id` is set, call `_audit_record(actor_user_id=<impersonator_id>, target_user_id=<impersonated_id>, event="request", method=request.method, path=path, status_code=response.status_code)`. Logged regardless of status code (including 5xx). If `impersonator_id` is absent (dependency rejected the request before setting it), no row is written.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_impersonation_request_audit.py
from app.models import AdminAuditLog
from tests.conftest import make_user, auth_headers


def _imp(db, admin, target_id):
    return {**auth_headers(db, admin), "X-Impersonate": target_id}


def test_benign_mutation_writes_request_row(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    r = client.post("/api/glossary", json={"term": "abbé", "definition": "titre"},
                    headers=_imp(db, admin, target.id))
    assert r.status_code == 200
    db.expire_all()
    rows = db.query(AdminAuditLog).filter_by(event="request").all()
    assert len(rows) == 1
    assert rows[0].actor_user_id == admin.id
    assert rows[0].target_user_id == target.id
    assert rows[0].method == "POST"
    assert rows[0].path == "/api/glossary"
    assert rows[0].status_code == 200


def test_get_requests_not_logged(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    client.get("/api/documents", headers=_imp(db, admin, target.id))
    db.expire_all()
    assert db.query(AdminAuditLog).filter_by(event="request").count() == 0


def test_blocked_route_not_logged_as_request(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    client.post("/api/billing/intent", json={"pack_id": "starter"},
                headers=_imp(db, admin, target.id))
    db.expire_all()
    assert db.query(AdminAuditLog).filter_by(event="request").count() == 0


def test_non_admin_rejected_request_not_logged(client, db):
    u1 = make_user(db, email="u1@test.fr")
    u2 = make_user(db, email="u2@test.fr")
    client.post("/api/glossary", json={"term": "x", "definition": "y"},
                headers=_imp(db, u1, u2.id))
    db.expire_all()
    assert db.query(AdminAuditLog).count() == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_impersonation_request_audit.py -v`
Expected: FAIL — no `request` rows are written yet.

- [ ] **Step 3: Implement**

Replace the `# Task 5 adds request-audit logging here.` line in `impersonation_guard` with:

```python
    if relevant:
        actor_id = getattr(request.state, "impersonator_id", None)
        target_id = getattr(request.state, "impersonated_id", None)
        if actor_id:
            _audit_record(
                actor_user_id=actor_id,
                target_user_id=target_id,
                event="request",
                method=request.method,
                path=path,
                status_code=response.status_code,
            )
```

(`relevant` is already `False` for blocked routes because those `return` before `call_next`; it is `True` only for non-GET, header-present, non-control paths that ran the route.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_impersonation_request_audit.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add app/main.py tests/test_impersonation_request_audit.py
git commit -m "feat(admin): log impersonated mutations to admin_audit_log"
```

---

### Task 6: Impersonation control + audit-read endpoints

**Files:**
- Modify: `app/main.py` (add three routes in the admin section, after `admin_stats`; add `AdminAuditLog` to the `.models` import)
- Test: `tests/test_impersonation_endpoints.py` (create)

**Interfaces:**
- Consumes: `resolve_impersonation_target` from Task 3, `AdminAuditLog` from Task 1, existing `get_admin_user`, `get_db`.
- Produces:
  - `POST /api/admin/impersonate/{user_id}` → `{"id": str, "email": str, "display_name": str}`; writes `AdminAuditLog(event="impersonation.start", actor_user_id=admin.id, target_user_id=user_id)` via the request session. 404/403 from `resolve_impersonation_target`.
  - `DELETE /api/admin/impersonate` with optional query param `user_id: str | None` → `204`; writes `AdminAuditLog(event="impersonation.stop", actor_user_id=admin.id, target_user_id=user_id)`.
  - `GET /api/admin/audit?limit=100&target=<user_id?>` → `{"rows": [{id, created_at, event, method, path, status_code, actor_email, target_email}]}`, newest first, `limit` clamped to `1..500`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_impersonation_endpoints.py
from app.models import AdminAuditLog
from tests.conftest import make_user, auth_headers


def test_start_impersonation_writes_row_and_returns_target(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    r = client.post(f"/api/admin/impersonate/{target.id}", headers=auth_headers(db, admin))
    assert r.status_code == 200
    assert r.json() == {"id": target.id, "email": "user@test.fr",
                        "display_name": target.display_name}
    db.expire_all()
    row = db.query(AdminAuditLog).filter_by(event="impersonation.start").one()
    assert row.actor_user_id == admin.id
    assert row.target_user_id == target.id


def test_start_impersonation_of_admin_403(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    admin2 = make_user(db, email="admin2@test.fr", is_admin=True)
    r = client.post(f"/api/admin/impersonate/{admin2.id}", headers=auth_headers(db, admin))
    assert r.status_code == 403


def test_start_impersonation_unknown_404(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    r = client.post("/api/admin/impersonate/nope", headers=auth_headers(db, admin))
    assert r.status_code == 404


def test_start_impersonation_requires_admin(client, db):
    u = make_user(db, email="u@test.fr")
    other = make_user(db, email="o@test.fr")
    r = client.post(f"/api/admin/impersonate/{other.id}", headers=auth_headers(db, u))
    assert r.status_code == 403


def test_stop_impersonation_writes_row(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    r = client.request("DELETE", f"/api/admin/impersonate?user_id={target.id}",
                       headers=auth_headers(db, admin))
    assert r.status_code == 204
    db.expire_all()
    row = db.query(AdminAuditLog).filter_by(event="impersonation.stop").one()
    assert row.actor_user_id == admin.id
    assert row.target_user_id == target.id


def test_audit_list_newest_first_and_target_filter(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    a = make_user(db, email="a@test.fr")
    b = make_user(db, email="b@test.fr")
    client.post(f"/api/admin/impersonate/{a.id}", headers=auth_headers(db, admin))
    client.post(f"/api/admin/impersonate/{b.id}", headers=auth_headers(db, admin))

    r = client.get("/api/admin/audit?limit=10", headers=auth_headers(db, admin))
    assert r.status_code == 200
    rows = r.json()["rows"]
    assert len(rows) == 2
    assert rows[0]["target_email"] == "b@test.fr"  # newest first
    assert rows[0]["actor_email"] == "admin@test.fr"

    r = client.get(f"/api/admin/audit?target={a.id}", headers=auth_headers(db, admin))
    rows = r.json()["rows"]
    assert len(rows) == 1
    assert rows[0]["target_email"] == "a@test.fr"


def test_audit_requires_admin(client, db):
    u = make_user(db, email="u@test.fr")
    r = client.get("/api/admin/audit", headers=auth_headers(db, u))
    assert r.status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_impersonation_endpoints.py -v`
Expected: FAIL with 404 (routes don't exist).

- [ ] **Step 3: Implement**

Add `AdminAuditLog` to the `from .models import (...)` tuple in `app/main.py`. Add `from .auth import ... resolve_impersonation_target` to the existing auth import. In the admin section of `app/main.py`, after `admin_stats`:

```python
@app.post("/api/admin/impersonate/{user_id}")
def admin_start_impersonation(user_id: str, db: Session = Depends(get_db),
                              admin: User = Depends(get_admin_user)):
    target = resolve_impersonation_target(db, user_id)
    db.add(AdminAuditLog(actor_user_id=admin.id, target_user_id=target.id,
                         event="impersonation.start"))
    db.commit()
    return {"id": target.id, "email": target.email, "display_name": target.display_name}


@app.delete("/api/admin/impersonate", status_code=204)
def admin_stop_impersonation(user_id: str | None = None, db: Session = Depends(get_db),
                             admin: User = Depends(get_admin_user)):
    db.add(AdminAuditLog(actor_user_id=admin.id, target_user_id=user_id,
                         event="impersonation.stop"))
    db.commit()


@app.get("/api/admin/audit")
def admin_audit(limit: int = 100, target: str | None = None,
                db: Session = Depends(get_db), admin: User = Depends(get_admin_user)):
    limit = max(1, min(limit, 500))
    q = db.query(AdminAuditLog).order_by(AdminAuditLog.created_at.desc())
    if target:
        q = q.filter(AdminAuditLog.target_user_id == target)
    rows = q.limit(limit).all()
    ids = {r.actor_user_id for r in rows} | {r.target_user_id for r in rows if r.target_user_id}
    emails = {u.id: u.email for u in db.query(User).filter(User.id.in_(ids)).all()} if ids else {}
    return {"rows": [
        {"id": r.id,
         "created_at": r.created_at.isoformat() if r.created_at else None,
         "event": r.event, "method": r.method, "path": r.path,
         "status_code": r.status_code,
         "actor_email": emails.get(r.actor_user_id),
         "target_email": emails.get(r.target_user_id)}
        for r in rows
    ]}
```

Note: `DELETE /api/admin/impersonate` and `POST /api/admin/impersonate/{user_id}` are called by the admin on their **own** session. `get_current_user` already skips `X-Impersonate` resolution for any path under `/api/admin/impersonate` (Task 3), so even if the SPA still has the header set when calling stop, the admin is resolved correctly.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_impersonation_endpoints.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Full backend suite + commit**

Run: `pytest -q`
Expected: PASS

```bash
git add app/main.py tests/test_impersonation_endpoints.py
git commit -m "feat(admin): impersonate start/stop + audit-log read endpoints"
```

---

### Task 7: Frontend API layer — impersonation storage + header

**Files:**
- Modify: `web/src/api.ts`
- Test: `web/src/api.impersonation.test.ts` (create)

**Interfaces:**
- Consumes: existing `request`, `getToken`.
- Produces:
  - `getImpersonation(): { id: string; email: string } | null` and `setImpersonation(v: { id: string; email: string } | null)` — `localStorage` key `palimora_impersonate`, JSON-encoded.
  - `request` adds header `X-Impersonate: <id>` when an impersonation target is set.
  - 401/403/404 handling: when impersonation is active and a response status is 403 or 404 with a `detail` containing `"impersonation"` (case-insensitive) OR status 404 on any path while impersonating, clear **only** `palimora_impersonate` (keep the token) and `window.location.reload()`. The existing 401→`setToken(null)`→`/login` path stays but must not fire from a bad impersonation target: guard it with `!getImpersonation()`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/api.impersonation.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, getImpersonation, setImpersonation, setToken } from './api'

beforeEach(() => {
  localStorage.clear()
  setToken('tok')
  vi.restoreAllMocks()
})

describe('impersonation storage', () => {
  it('round-trips', () => {
    expect(getImpersonation()).toBeNull()
    setImpersonation({ id: 'u1', email: 'u@test.fr' })
    expect(getImpersonation()).toEqual({ id: 'u1', email: 'u@test.fr' })
    setImpersonation(null)
    expect(getImpersonation()).toBeNull()
  })
})

describe('X-Impersonate header', () => {
  it('is sent when a target is set, absent otherwise', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await api.get('/api/documents')
    expect(fetchMock.mock.calls[0][1].headers['X-Impersonate']).toBeUndefined()

    setImpersonation({ id: 'u1', email: 'u@test.fr' })
    await api.get('/api/documents')
    expect(fetchMock.mock.calls[1][1].headers['X-Impersonate']).toBe('u1')
  })
})

describe('bad impersonation target', () => {
  it('clears only the impersonation key on 404, keeps token', async () => {
    setImpersonation({ id: 'bad', email: 'x@test.fr' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Utilisateur introuvable' }), { status: 404 })))
    const reload = vi.fn()
    vi.stubGlobal('location', { reload } as any)

    await api.get('/api/documents').catch(() => {})
    expect(getImpersonation()).toBeNull()
    expect(localStorage.getItem('palimora_token')).toBe('tok')
    expect(reload).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- api.impersonation`
Expected: FAIL — `getImpersonation` / `setImpersonation` not exported.

- [ ] **Step 3: Implement**

In `web/src/api.ts`:

```ts
const IMPERSONATE_KEY = 'palimora_impersonate'

export function getImpersonation(): { id: string; email: string } | null {
  const raw = localStorage.getItem(IMPERSONATE_KEY)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

export function setImpersonation(v: { id: string; email: string } | null) {
  if (v) localStorage.setItem(IMPERSONATE_KEY, JSON.stringify(v))
  else localStorage.removeItem(IMPERSONATE_KEY)
}
```

In `request`, after the `Authorization` header is set:

```ts
  const impersonation = getImpersonation()
  if (impersonation) headers['X-Impersonate'] = impersonation.id
```

Replace the 401 block with:

```ts
  if (resp.status === 401 && !path.includes('/auth/') && !getImpersonation()) {
    setToken(null)
    window.location.href = '/login'
    throw new ApiError(401, 'Session expirée')
  }
  const text = await resp.text()
  const data = text ? JSON.parse(text) : null
  if (!resp.ok) {
    const detail: string = data?.detail || ''
    if (getImpersonation() &&
        (resp.status === 404 || /impersonation/i.test(detail))) {
      setImpersonation(null)
      window.location.reload()
    }
    throw new ApiError(resp.status, detail || `Erreur ${resp.status}`)
  }
  return data as T
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web test -- api.impersonation`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/api.impersonation.test.ts
git commit -m "feat(web): X-Impersonate header + scoped auth-error handling"
```

---

### Task 8: `ImpersonationBanner` component + mount

**Files:**
- Create: `web/src/components/ImpersonationBanner.tsx`
- Modify: `web/src/main.tsx` (render the banner inside `<BrowserRouter>`, above `<Routes>`)
- Test: `web/src/components/ImpersonationBanner.test.tsx` (create)

**Interfaces:**
- Consumes: `getImpersonation`, `setImpersonation`, `api` from `../api`.
- Produces: default-exported `ImpersonationBanner` component. Renders `null` when `getImpersonation()` is null. When set: a sticky top bar showing the target email and an "Arrêter" button. "Arrêter" calls `api.delete('/api/admin/impersonate?user_id=' + id)`, then `setImpersonation(null)`, then `window.location.assign('/admin')`.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/components/ImpersonationBanner.test.tsx
import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ImpersonationBanner from './ImpersonationBanner'
import { setImpersonation } from '../api'

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })

it('renders nothing when not impersonating', () => {
  const { container } = render(<ImpersonationBanner />)
  expect(container).toBeEmptyDOMElement()
})

it('shows the target email and stops on click', async () => {
  setImpersonation({ id: 'u1', email: 'cible@test.fr' })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 204 })))
  const assign = vi.fn()
  vi.stubGlobal('location', { assign, reload: vi.fn() } as any)
  localStorage.setItem('palimora_token', 'tok')

  render(<ImpersonationBanner />)
  expect(screen.getByText(/cible@test\.fr/)).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: /arrêter/i }))
  expect(localStorage.getItem('palimora_impersonate')).toBeNull()
  expect(assign).toHaveBeenCalledWith('/admin')
})
```

If `@testing-library/react` / `user-event` / `jsdom` matchers are not yet dev-deps, add them:
`npm --prefix web i -D @testing-library/react @testing-library/user-event @testing-library/jest-dom`
and ensure `web/vitest.config.ts` has a setup file importing `@testing-library/jest-dom` (check `web/src/pages/Billing.test.tsx` — it already renders components, so the harness likely exists; reuse whatever it uses).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- ImpersonationBanner`
Expected: FAIL — component file does not exist.

- [ ] **Step 3: Implement the component**

```tsx
// web/src/components/ImpersonationBanner.tsx
import { api, getImpersonation, setImpersonation } from '../api'

export default function ImpersonationBanner() {
  const target = getImpersonation()
  if (!target) return null

  async function stop() {
    try {
      await api.delete(`/api/admin/impersonate?user_id=${encodeURIComponent(target!.id)}`)
    } finally {
      setImpersonation(null)
      window.location.assign('/admin')
    }
  }

  return (
    <div className="sticky top-0 z-50 flex items-center gap-3 bg-amber-500 px-4 py-2 text-sm text-white">
      <span>
        Vous agissez en tant que <strong>{target.email}</strong>
      </span>
      <button onClick={stop} className="ml-auto rounded bg-white/20 px-2 py-1 font-medium">
        Arrêter
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Mount it**

In `web/src/main.tsx`, import and render above `<Routes>`:

```tsx
import ImpersonationBanner from './components/ImpersonationBanner'
// ...
    <BrowserRouter>
      <ImpersonationBanner />
      <Routes>
        {/* unchanged */}
      </Routes>
    </BrowserRouter>
```

- [ ] **Step 5: Run tests + build**

Run: `npm --prefix web test -- ImpersonationBanner`
Expected: PASS
Run: `npm --prefix web run build`
Expected: succeeds (tsc clean)

- [ ] **Step 6: Commit**

```bash
git add web/src/components/ImpersonationBanner.tsx web/src/components/ImpersonationBanner.test.tsx web/src/main.tsx web/package.json web/package-lock.json
git commit -m "feat(web): sticky impersonation banner with stop action"
```

---

### Task 9: Admin page — "Impersoner" buttons + audit panel

**Files:**
- Modify: `web/src/pages/Admin.tsx`
- Test: `web/src/pages/Admin.impersonation.test.tsx` (create)

**Interfaces:**
- Consumes: `api`, `setImpersonation` from `../api`; `GET /api/admin/audit` shape from Task 6 (`{ rows: {id, created_at, event, method, path, status_code, actor_email, target_email}[] }`).
- Produces: for each non-admin user row, an "Impersoner" button that calls `POST /api/admin/impersonate/{id}`, then `setImpersonation({ id, email })`, then `navigate('/')`. A new "Journal d'impersonation" section below the users table listing audit rows (date, actor, cible, event, method, path, status).

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/pages/Admin.impersonation.test.tsx
import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Admin from './Admin'

const navigate = vi.fn()
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<any>()),
  useNavigate: () => navigate,
}))

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('palimora_token', 'tok')
  navigate.mockClear()
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts: any) => {
    if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ is_admin: true }), { status: 200 })
    if (url.endsWith('/api/admin/users')) return new Response(JSON.stringify({ users: [
      { id: 'u1', email: 'user@test.fr', display_name: 'U', credit_balance: 5, is_admin: false, is_active: true, created_at: '2026-09-01T00:00:00Z' },
    ] }), { status: 200 })
    if (url.endsWith('/api/admin/stats')) return new Response(JSON.stringify({
      users: 1, documents: 0, pages_done: 0, pages_error: 0, pages_total: 0, credits_in_circulation: 5 }), { status: 200 })
    if (url.includes('/api/admin/audit')) return new Response(JSON.stringify({ rows: [
      { id: 'a1', created_at: '2026-09-01T10:00:00Z', event: 'impersonation.start', method: null, path: null, status_code: null, actor_email: 'admin@test.fr', target_email: 'user@test.fr' },
    ] }), { status: 200 })
    if (url.match(/\/api\/admin\/impersonate\/u1$/)) return new Response(JSON.stringify({ id: 'u1', email: 'user@test.fr', display_name: 'U' }), { status: 200 })
    return new Response('{}', { status: 200 })
  }))
})

it('impersonate button stores target and navigates home', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  const btn = await screen.findByRole('button', { name: /impersoner/i })
  await userEvent.click(btn)
  await waitFor(() => {
    expect(localStorage.getItem('palimora_impersonate')).toContain('u1')
    expect(navigate).toHaveBeenCalledWith('/')
  })
})

it('renders the audit journal', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  expect(await screen.findByText(/Journal d'impersonation/i)).toBeInTheDocument()
  await waitFor(() => expect(screen.getByText('impersonation.start')).toBeInTheDocument())
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- Admin.impersonation`
Expected: FAIL — no "Impersoner" button, no journal heading.

- [ ] **Step 3: Implement**

In `web/src/pages/Admin.tsx`:

1. Add import: `import { api, setImpersonation, setToken } from '../api'`.
2. Add types + state near the top of the component:

```tsx
interface AuditRow {
  id: string; created_at: string | null; event: string
  method: string | null; path: string | null; status_code: number | null
  actor_email: string | null; target_email: string | null
}
```
```tsx
  const [audit, setAudit] = useState<AuditRow[]>([])
```

3. In `refresh`, also fetch the audit log:

```tsx
  const refresh = useCallback(async () => {
    const [u, s, a] = await Promise.all([
      api.get<{ users: AdminUser[] }>('/api/admin/users'),
      api.get<Stats>('/api/admin/stats'),
      api.get<{ rows: AuditRow[] }>('/api/admin/audit?limit=100'),
    ])
    setUsers(u.users)
    setStats(s)
    setAudit(a.rows)
  }, [])
```

4. Add the impersonate handler:

```tsx
  async function impersonate(u: AdminUser) {
    await api.post(`/api/admin/impersonate/${u.id}`)
    setImpersonation({ id: u.id, email: u.email })
    navigate('/')
  }
```

5. In the users table, add a cell in the header (`<th className="p-2">Actions</th>`) and in each row, rendered only for non-admins:

```tsx
                <td className="p-2">
                  {!u.is_admin && (
                    <button className="text-indigo-600" onClick={() => impersonate(u)}>
                      Impersoner
                    </button>
                  )}
                </td>
```

6. After the `</table>`'s wrapping `<div>`, add the journal section:

```tsx
      <div className="px-4 pb-12">
        <h2 className="mb-2 font-semibold">Journal d'impersonation</h2>
        <table className="w-full bg-white rounded-lg border text-sm">
          <thead>
            <tr className="text-left text-slate-500 border-b">
              <th className="p-2">Date</th><th className="p-2">Admin</th>
              <th className="p-2">Cible</th><th className="p-2">Événement</th>
              <th className="p-2">Méthode</th><th className="p-2">Chemin</th>
              <th className="p-2">Statut</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((r) => (
              <tr key={r.id} className="border-b">
                <td className="p-2">{r.created_at ? new Date(r.created_at).toLocaleString('fr-FR') : ''}</td>
                <td className="p-2">{r.actor_email}</td>
                <td className="p-2">{r.target_email}</td>
                <td className="p-2">{r.event}</td>
                <td className="p-2">{r.method}</td>
                <td className="p-2 font-mono text-xs">{r.path}</td>
                <td className="p-2">{r.status_code}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web test -- Admin.impersonation`
Expected: PASS (2 tests)

- [ ] **Step 5: Full frontend suite + build**

Run: `npm --prefix web test`
Expected: PASS (all)
Run: `npm --prefix web run build`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Admin.tsx web/src/pages/Admin.impersonation.test.tsx
git commit -m "feat(web): admin impersonate buttons + audit journal panel"
```

---

### Task 10: End-to-end smoke test + docs

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-e1-admin-impersonation-design.md` (add "Status: implemented" line)
- Create: `tests/test_impersonation_e2e.py`

**Interfaces:**
- Consumes: everything above.
- Produces: one full-flow test.

- [ ] **Step 1: Write the E2E test**

```python
# tests/test_impersonation_e2e.py
from app.models import AdminAuditLog
from tests.conftest import make_user, auth_headers


def test_full_impersonation_flow(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr", credits=50)

    # 1. start
    r = client.post(f"/api/admin/impersonate/{target.id}", headers=auth_headers(db, admin))
    assert r.status_code == 200

    imp = {**auth_headers(db, admin), "X-Impersonate": target.id}

    # 2. benign mutation as target -> allowed + audited
    r = client.post("/api/documents", json={"title": "Doc de la cible"}, headers=imp)
    assert r.status_code == 200

    # 3. money action -> blocked
    r = client.post("/api/billing/subscribe", json={"plan_id": "atelier"}, headers=imp)
    assert r.status_code == 403

    # 4. admin route -> blocked (target is non-admin)
    assert client.get("/api/admin/users", headers=imp).status_code == 403

    # 5. stop
    r = client.request("DELETE", f"/api/admin/impersonate?user_id={target.id}",
                       headers=auth_headers(db, admin))
    assert r.status_code == 204

    # 6. audit trail: start, one request row (the POST /api/documents), stop
    db.expire_all()
    events = [x.event for x in db.query(AdminAuditLog).order_by(AdminAuditLog.created_at).all()]
    assert events == ["impersonation.start", "request", "impersonation.stop"]
    req_row = db.query(AdminAuditLog).filter_by(event="request").one()
    assert req_row.path == "/api/documents"
    assert req_row.status_code == 200
```

- [ ] **Step 2: Run it**

Run: `pytest tests/test_impersonation_e2e.py -v`
Expected: PASS

- [ ] **Step 3: Full suite, both sides**

Run: `pytest -q && npm --prefix web test`
Expected: all PASS

- [ ] **Step 4: Update the spec status line**

Change the spec header `Status:` line to `Status: implemented (E1)`.

- [ ] **Step 5: Commit**

```bash
git add tests/test_impersonation_e2e.py docs/superpowers/specs/2026-09-01-e1-admin-impersonation-design.md
git commit -m "test(admin): end-to-end impersonation flow + mark E1 spec implemented"
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/e1-admin-impersonation
gh pr create --title "E1 — Admin user impersonation for debugging" --body "$(cat <<'EOF'
Implements the E1 spec (docs/superpowers/specs/2026-09-01-e1-admin-impersonation-design.md):

- `X-Impersonate: <user_id>` header resolved in `get_current_user` (admin-only; unknown/inactive target 404; admin target 403).
- HTTP middleware blocks `/api/billing/*`, `/api/stripe/*`, `finalize`, `reocr` while impersonating; benign edits allowed.
- New `admin_audit_log` table: session start/stop + every impersonated mutation.
- `POST/DELETE /api/admin/impersonate`, `GET /api/admin/audit`.
- SPA: header injection, sticky banner, per-user "Impersoner" buttons, audit journal panel.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §2.1 header resolution (Approach A), all 5 rules | Task 3 |
| §2.1 `/api/admin/*` → 403 while impersonating | Task 3 (test) |
| §2.2 write-block middleware, blocked path list | Task 4 |
| §2.2 `ai-suggest` allowed | Task 4 (allowed by omission from block list; e2e/glossary covers "benign allowed") |
| §2.3 interaction table | Tasks 3–5 tests, Task 10 e2e |
| §3.1 `admin_audit_log` table | Task 1 |
| §3.2 start/stop endpoints + their audit rows | Task 6 |
| §3.3 request logging, fresh session, best-effort, skip when no impersonator_id | Task 2 + Task 5 |
| §3.4 `GET /api/admin/audit` + filter + limit cap | Task 6 |
| §4.1 api.ts storage + header + scoped 401 | Task 7 |
| §4.2 `ImpersonationBanner` + shell mount | Task 8 |
| §4.3 Admin.tsx buttons + journal panel | Task 9 |
| §5.1 pytest list | Tasks 1,3,4,5,6,10 |
| §5.2 vitest list | Tasks 7,8 |
| §6 files touched | matches Tasks 1–9 |
| §7 risk: header inert without token | Task 3 (real token still required by `get_current_user`) |

No gaps.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Every code step has real code. Two spots say "check the real schema before writing the test" (glossary payload keys, vitest setup file) — these are verification instructions, not placeholders; the surrounding code is complete and the check is a 1-line confirmation.

**3. Type consistency:**
- `resolve_impersonation_target(db, target_id) -> User` — same signature in Task 3 (def), Task 6 (call).
- `audit.record(*, actor_user_id, target_user_id=None, event, method=None, path=None, status_code=None)` — Task 2 def matches Task 5 call (all kwargs).
- `request.state.impersonator_id` / `impersonated_id` — set in Task 3, read in Task 5. Consistent names.
- `AdminAuditLog` columns — Task 1 def matches inserts in Tasks 5, 6 and reads in Task 6.
- `GET /api/admin/audit` returns `{rows: [...]}` — Task 6 def, consumed identically in Task 9.
- `getImpersonation()`/`setImpersonation()` — Task 7 def, used in Tasks 8, 9.
- Banner stop calls `DELETE /api/admin/impersonate?user_id=` — matches Task 6 route (optional `user_id` query param).

Consistent.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-01-e1-admin-impersonation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
