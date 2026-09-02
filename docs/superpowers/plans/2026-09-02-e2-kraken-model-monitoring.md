# E2 — Kraken Model Override + OCR Timing Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin pick a Kraken model (segmentation + recognition pair) from an operator-curated whitelist at runtime, and monitor per-page OCR duration + per-model median/p95/confidence in the `/admin` panel — without modifying the Kraken microservice.

**Architecture:** A new `app/ocr_models.py` parses `KRAKEN_MODELS` (env whitelist of `label=SEG|REC` entries) and resolves the active model from an `AppSetting` key/value row, falling back to an env default then to Kraken's own `/models/*.mlmodel` default. Model resolution happens in the web process at `enqueue_page_ocr` time and is frozen into the RQ payload; the worker consumes it verbatim. `_run_image` / `_run_pdf` measure wall-clock around the Kraken call and stamp `ocr_submitted_at` / `ocr_finished_at` / `ocr_model_key` / `ocr_batch_size` onto the `pages` row(s) via a short isolated session (survives the job's rollback on failure). Two admin endpoints (`GET /api/admin/ocr`, `PUT /api/admin/ocr/model`) drive a new panel section in `Admin.tsx`.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 (Mapped/mapped_column, no Alembic), RQ + Redis, httpx multipart, Postgres (`percentile_cont`) + SQLite in tests, pytest + FastAPI TestClient, React 18 + react-router-dom 6, Vite, Vitest + jsdom + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-09-01-e2-kraken-model-monitoring-design.md`

## Global Constraints

- No Alembic. New tables (`app_setting`) are created by `Base.metadata.create_all(engine)` at startup — no `_migrate()` entry. Column adds go in `_migrate()` in `app/main.py` as `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, each wrapped so one failure does not poison the rest (existing pattern, `app/main.py:113`).
- `kraken-ocr-service` (`~/Documents/antigravity/kraken-ocr-service`) is **NOT modified** by this plan. It already accepts `seg_model_path` / `rec_model_path` form fields on `POST /jobs` and returns no timing.
- `KRAKEN_MODELS` format: comma-separated `label=SEG_PATH|REC_PATH`. Split entries on `,`; split each on the **first** `=`; split the value on `|`. `label` trimmed, non-empty, no `,`, ≤ 40 chars. Both paths required non-empty. Malformed entry → skip with a `print()` warning, do not crash boot.
- `KRAKEN_MODELS_DEFAULT` = one label string, or unset.
- Resolution order: `AppSetting['ocr_model']` (if value still a valid whitelist key) → `KRAKEN_MODELS_DEFAULT` (if valid key) → fallback `{"key": "défaut", "seg_path": None, "rec_path": None}`.
- ORM id columns: `Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)`; timestamps `default=now` (helpers in `app/models.py`).
- New `pages` columns: `ocr_submitted_at` (`DateTime(timezone=True)` nullable), `ocr_finished_at` (`DateTime(timezone=True)` nullable), `ocr_model_key` (`String(40)` default `""`), `ocr_batch_size` (`Integer` default `1`).
- Timing is measured by Palimora in wall-clock and includes Kraken-side queue wait. Duration is derived (`finished - submitted`), never stored.
- Both admin endpoints use `Depends(get_admin_user)` and are naturally 403 during E1 impersonation (no middleware change).
- French user-facing strings, matching existing style.
- Audit: a model change writes `AdminAuditLog(event="ocr.model_change", method="PUT", path="/api/admin/ocr/model", status_code=200, target_user_id=None)`. The table has no free-text column — the old→new transition is not stored.
- Caveman chat style does not apply to code / comments / commit messages.
- Do not commit to `main`. The branch `feat/e2-kraken-model-monitoring` already exists and holds the spec commit (`ffb0074`) — work on it.
- Test commands: `pytest` (repo root) and `npm --prefix web test`; `npm --prefix web run build` must stay tsc-clean.

---

### Task 1: `KRAKEN_MODELS` config parsing

**Files:**
- Modify: `app/config.py` (add `_parse_kraken_models` helper + two `Settings` fields near the existing `kraken_*` lines, ~line 33)
- Test: `tests/test_ocr_config.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `settings.kraken_models: list[dict]` — `[{"key": str, "seg_path": str, "rec_path": str}, ...]`, `[]` when `KRAKEN_MODELS` is unset/empty. Malformed entries skipped.
  - `settings.kraken_models_default: str` — raw `KRAKEN_MODELS_DEFAULT` value, `""` if unset.
  - module-level `_parse_kraken_models(raw: str) -> list[dict]` for direct unit testing.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_ocr_config.py
from app.config import _parse_kraken_models


def test_parses_label_seg_rec_entries():
    raw = "défaut=/models/seg.mlmodel|/models/rec.mlmodel,rapide=/models/seg.mlmodel|/models/rec-fast.mlmodel"
    out = _parse_kraken_models(raw)
    assert out == [
        {"key": "défaut", "seg_path": "/models/seg.mlmodel", "rec_path": "/models/rec.mlmodel"},
        {"key": "rapide", "seg_path": "/models/seg.mlmodel", "rec_path": "/models/rec-fast.mlmodel"},
    ]


def test_empty_or_unset_is_empty_list():
    assert _parse_kraken_models("") == []
    assert _parse_kraken_models("   ") == []


def test_malformed_entries_are_skipped_not_fatal(capsys):
    raw = "good=/a|/b,noequalsign,missingpipe=/only-one,blank=|,=/x|/y"
    out = _parse_kraken_models(raw)
    assert out == [{"key": "good", "seg_path": "/a", "rec_path": "/b"}]
    assert "KRAKEN_MODELS" in capsys.readouterr().out  # warned


def test_first_equals_wins_so_paths_may_contain_equals():
    out = _parse_kraken_models("k=/models/a=1.mlmodel|/models/b.mlmodel")
    assert out == [{"key": "k", "seg_path": "/models/a=1.mlmodel", "rec_path": "/models/b.mlmodel"}]


def test_label_over_40_chars_skipped():
    long = "x" * 41
    assert _parse_kraken_models(f"{long}=/a|/b") == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_ocr_config.py -v`
Expected: FAIL with `ImportError: cannot import name '_parse_kraken_models'`

- [ ] **Step 3: Implement**

In `app/config.py`, add above `class Settings`:

```python
def _parse_kraken_models(raw: str) -> list[dict]:
    """Parse KRAKEN_MODELS: comma-separated `label=SEG|REC`. Malformed entries
    are skipped with a warning; never raises."""
    models: list[dict] = []
    for entry in (raw or "").split(","):
        entry = entry.strip()
        if not entry or "=" not in entry:
            if entry:
                print(f"KRAKEN_MODELS: skipping malformed entry {entry!r} (no '=')")
            continue
        label, _, value = entry.partition("=")
        label = label.strip()
        if not label or len(label) > 40:
            print(f"KRAKEN_MODELS: skipping entry with bad label {label!r}")
            continue
        if "|" not in value:
            print(f"KRAKEN_MODELS: skipping entry {label!r} (value not SEG|REC)")
            continue
        seg, _, rec = value.partition("|")
        seg, rec = seg.strip(), rec.strip()
        if not seg or not rec:
            print(f"KRAKEN_MODELS: skipping entry {label!r} (empty seg or rec path)")
            continue
        models.append({"key": label, "seg_path": seg, "rec_path": rec})
    return models
```

In `class Settings`, next to the `kraken_*` fields:

```python
    kraken_models: list = _parse_kraken_models(os.getenv("KRAKEN_MODELS", ""))
    kraken_models_default: str = os.getenv("KRAKEN_MODELS_DEFAULT", "")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_ocr_config.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add app/config.py tests/test_ocr_config.py
git commit -m "feat(ocr): parse KRAKEN_MODELS whitelist config"
```

---

### Task 2: `AppSetting` model + `app/ocr_models.py` resolution module

**Files:**
- Modify: `app/models.py` (add `AppSetting` class after `AdminAuditLog`)
- Create: `app/ocr_models.py`
- Test: `tests/test_ocr_models.py` (create)

**Interfaces:**
- Consumes: `settings.kraken_models` / `settings.kraken_models_default` (Task 1); `AdminAuditLog` (exists from E1); `User` model.
- Produces:
  - `AppSetting` ORM: `key: str` PK `String(64)`, `value: str` `String(255)` default `""`, `updated_at: datetime` (`default=now, onupdate=now`), `updated_by: str | None` FK `users.id` nullable.
  - `app/ocr_models.py`:
    - `list_models() -> list[dict]` — `settings.kraken_models` (each `{key, seg_path, rec_path}`).
    - `get_model(key: str) -> dict | None`.
    - `resolve_active(db: Session) -> dict` — `{key, seg_path, rec_path}`; `seg_path`/`rec_path` are `None` only in the fallback case (`{"key": "défaut", "seg_path": None, "rec_path": None}`).
    - `active_source(db: Session) -> str` — `"setting"` | `"env_default"` | `"fallback"`.
    - `set_active(db: Session, key: str, admin: User) -> None` — `get_model(key) is None` → `raise ValueError(f"Modèle inconnu: {key}")`; else upsert `AppSetting(key="ocr_model", value=key, updated_by=admin.id)` and `db.add(AdminAuditLog(actor_user_id=admin.id, target_user_id=None, event="ocr.model_change", method="PUT", path="/api/admin/ocr/model", status_code=200))`. Does **not** commit (caller commits).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_ocr_models.py
import pytest
from app import ocr_models
from app.config import settings
from app.models import AppSetting, AdminAuditLog
from tests.conftest import make_user

WL = [
    {"key": "défaut", "seg_path": "/m/seg.mlmodel", "rec_path": "/m/rec.mlmodel"},
    {"key": "rapide", "seg_path": "/m/seg.mlmodel", "rec_path": "/m/rec-fast.mlmodel"},
]


@pytest.fixture(autouse=True)
def _whitelist(monkeypatch):
    monkeypatch.setattr(settings, "kraken_models", list(WL), raising=False)
    monkeypatch.setattr(settings, "kraken_models_default", "", raising=False)


def test_list_and_get(monkeypatch):
    assert ocr_models.list_models() == WL
    assert ocr_models.get_model("rapide")["rec_path"] == "/m/rec-fast.mlmodel"
    assert ocr_models.get_model("nope") is None


def test_resolve_fallback_when_nothing_set(db):
    assert ocr_models.resolve_active(db) == {"key": "défaut", "seg_path": None, "rec_path": None}
    assert ocr_models.active_source(db) == "fallback"


def test_resolve_env_default(db, monkeypatch):
    monkeypatch.setattr(settings, "kraken_models_default", "rapide", raising=False)
    assert ocr_models.resolve_active(db)["key"] == "rapide"
    assert ocr_models.active_source(db) == "env_default"


def test_resolve_setting_wins(db, monkeypatch):
    monkeypatch.setattr(settings, "kraken_models_default", "rapide", raising=False)
    db.add(AppSetting(key="ocr_model", value="défaut"))
    db.commit()
    assert ocr_models.resolve_active(db)["key"] == "défaut"
    assert ocr_models.active_source(db) == "setting"


def test_stale_setting_value_ignored(db):
    db.add(AppSetting(key="ocr_model", value="removed-model"))
    db.commit()
    assert ocr_models.resolve_active(db) == {"key": "défaut", "seg_path": None, "rec_path": None}


def test_set_active_rejects_unknown_key(db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    with pytest.raises(ValueError):
        ocr_models.set_active(db, "bogus", admin)


def test_set_active_writes_setting_and_audit(db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    ocr_models.set_active(db, "rapide", admin)
    db.commit()
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "rapide"
    row = db.query(AdminAuditLog).filter_by(event="ocr.model_change").one()
    assert row.actor_user_id == admin.id
    assert row.path == "/api/admin/ocr/model"


def test_set_active_upserts(db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    ocr_models.set_active(db, "rapide", admin); db.commit()
    ocr_models.set_active(db, "défaut", admin); db.commit()
    assert db.query(AppSetting).filter_by(key="ocr_model").count() == 1
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "défaut"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_ocr_models.py -v`
Expected: FAIL — `ImportError` on `AppSetting` / `app.ocr_models`.

- [ ] **Step 3: Add `AppSetting` to `app/models.py`**

After the `AdminAuditLog` class:

```python
class AppSetting(Base):
    """Generic runtime key/value settings (currently only key='ocr_model')."""
    __tablename__ = "app_setting"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(String(255), default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, onupdate=now)
    updated_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=True)
```

- [ ] **Step 4: Write `app/ocr_models.py`**

```python
"""Kraken model whitelist + active-model resolution (Phase E2)."""
from sqlalchemy.orm import Session

from .config import settings
from .models import AdminAuditLog, AppSetting

_FALLBACK = {"key": "défaut", "seg_path": None, "rec_path": None}
_SETTING_KEY = "ocr_model"


def list_models() -> list[dict]:
    return list(settings.kraken_models)


def get_model(key: str) -> dict | None:
    return next((m for m in settings.kraken_models if m["key"] == key), None)


def _setting_value(db: Session) -> str | None:
    row = db.query(AppSetting).filter_by(key=_SETTING_KEY).one_or_none()
    return row.value if row else None


def resolve_active(db: Session) -> dict:
    val = _setting_value(db)
    if val and get_model(val):
        return get_model(val)
    if settings.kraken_models_default and get_model(settings.kraken_models_default):
        return get_model(settings.kraken_models_default)
    return dict(_FALLBACK)


def active_source(db: Session) -> str:
    val = _setting_value(db)
    if val and get_model(val):
        return "setting"
    if settings.kraken_models_default and get_model(settings.kraken_models_default):
        return "env_default"
    return "fallback"


def set_active(db: Session, key: str, admin) -> None:
    if get_model(key) is None:
        raise ValueError(f"Modèle inconnu: {key}")
    row = db.query(AppSetting).filter_by(key=_SETTING_KEY).one_or_none()
    if row:
        row.value = key
        row.updated_by = admin.id
    else:
        db.add(AppSetting(key=_SETTING_KEY, value=key, updated_by=admin.id))
    db.add(AdminAuditLog(
        actor_user_id=admin.id, target_user_id=None,
        event="ocr.model_change", method="PUT",
        path="/api/admin/ocr/model", status_code=200))
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_ocr_models.py -v`
Expected: PASS (8 tests)

- [ ] **Step 6: Full backend suite**

Run: `pytest -q`
Expected: PASS (E1's 83 + these).

- [ ] **Step 7: Commit**

```bash
git add app/models.py app/ocr_models.py tests/test_ocr_models.py
git commit -m "feat(ocr): AppSetting table + active-model resolution module"
```

---

### Task 3: `pages` timing columns

**Files:**
- Modify: `app/models.py` (`Page` — 4 columns after `kraken_job_id`)
- Modify: `app/main.py` (`_migrate()` — 4 `ALTER TABLE` statements in the `stmts` list, ~line 121)
- Test: `tests/test_page_timing_columns.py` (create)

**Interfaces:**
- Produces: `Page.ocr_submitted_at: datetime | None`, `Page.ocr_finished_at: datetime | None`, `Page.ocr_model_key: str` (default `""`), `Page.ocr_batch_size: int` (default `1`).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_page_timing_columns.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_page_timing_columns.py -v`
Expected: FAIL — `TypeError: 'ocr_model_key' is an invalid keyword argument for Page`

- [ ] **Step 3: Add the columns**

In `app/models.py`, in `class Page` after `kraken_job_id`:

```python
    ocr_submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)
    ocr_finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)
    ocr_model_key: Mapped[str] = mapped_column(String(40), default="")
    ocr_batch_size: Mapped[int] = mapped_column(Integer, default=1)
```

In `app/main.py` `_migrate()` `stmts` list, append:

```python
        "ALTER TABLE pages ADD COLUMN IF NOT EXISTS ocr_submitted_at TIMESTAMPTZ",
        "ALTER TABLE pages ADD COLUMN IF NOT EXISTS ocr_finished_at TIMESTAMPTZ",
        "ALTER TABLE pages ADD COLUMN IF NOT EXISTS ocr_model_key VARCHAR(40) DEFAULT ''",
        "ALTER TABLE pages ADD COLUMN IF NOT EXISTS ocr_batch_size INTEGER DEFAULT 1",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_page_timing_columns.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add app/models.py app/main.py tests/test_page_timing_columns.py
git commit -m "feat(ocr): add per-page OCR timing columns"
```

---

### Task 4: `submit_ocr` model-path kwargs

**Files:**
- Modify: `app/kraken.py` (`submit_ocr`)
- Test: `tests/test_kraken_submit_models.py` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `submit_ocr(client, file_bytes, ext, *, seg_model_path: str | None = None, rec_model_path: str | None = None) -> str`. When both are `None`, the POST body is unchanged from today. When set, they are sent as multipart form fields `seg_model_path` / `rec_model_path`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_kraken_submit_models.py
import httpx
from app import kraken


class _Capture:
    def __init__(self):
        self.last = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.last = request.content
        return httpx.Response(200, json={"job_id": "j1"})


def test_model_paths_sent_as_form_fields():
    cap = _Capture()
    client = httpx.Client(transport=httpx.MockTransport(cap.handler))
    kraken.submit_ocr(client, b"bytes", ".png",
                      seg_model_path="/m/seg.mlmodel", rec_model_path="/m/rec.mlmodel")
    body = cap.last.decode("latin-1")
    assert 'name="seg_model_path"' in body and "/m/seg.mlmodel" in body
    assert 'name="rec_model_path"' in body and "/m/rec.mlmodel" in body


def test_no_model_fields_when_none():
    cap = _Capture()
    client = httpx.Client(transport=httpx.MockTransport(cap.handler))
    kraken.submit_ocr(client, b"bytes", ".png")
    body = cap.last.decode("latin-1")
    assert "seg_model_path" not in body
    assert "rec_model_path" not in body
    assert 'name="file"' in body
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_kraken_submit_models.py -v`
Expected: FAIL — `submit_ocr() got an unexpected keyword argument 'seg_model_path'`

- [ ] **Step 3: Implement**

In `app/kraken.py` `submit_ocr`:

```python
def submit_ocr(client: httpx.Client, file_bytes: bytes, ext: str, *,
               seg_model_path: str | None = None,
               rec_model_path: str | None = None) -> str:
    """POST /jobs — returns the Kraken job id."""
    data = {k: v for k, v in (("seg_model_path", seg_model_path),
                              ("rec_model_path", rec_model_path)) if v}
    resp = client.post(
        f"{settings.kraken_api_url}/jobs",
        files={"file": (f"page{ext}", file_bytes)},
        data=data or None,
        headers=_headers(),
        timeout=300,
    )
    if resp.status_code != 200:
        raise KrakenError(f"Kraken /jobs a répondu {resp.status_code}: {resp.text[:300]}")
    job_id = resp.json().get("job_id")
    if not job_id:
        raise KrakenError("Réponse Kraken sans job_id")
    return job_id
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_kraken_submit_models.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Full backend suite (no regression in existing OCR tests)**

Run: `pytest -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/kraken.py tests/test_kraken_submit_models.py
git commit -m "feat(ocr): optional seg/rec model paths on submit_ocr"
```

---

### Task 5: model resolution at enqueue + timing capture in the worker

**Files:**
- Modify: `app/ocr_service.py` (`enqueue_page_ocr`, `run_ocr_job`, `_run_image`, `_run_pdf`, new `_stamp_timing`)
- Test: `tests/test_ocr_timing.py` (create)

**Interfaces:**
- Consumes: `ocr_models.resolve_active` (Task 2), `submit_ocr` kwargs (Task 4), `Page` timing columns (Task 3), `app.db` module (for the isolated session, like `app/audit.py`).
- Produces:
  - `enqueue_page_ocr` adds `model_key` / `seg_model_path` / `rec_model_path` to the RQ `payload`.
  - `run_ocr_job(payload)` passes `payload` to `_run_image(db, page, payload)` / `_run_pdf(db, page, document, payload)`.
  - `_stamp_timing(page_ids: list[str], *, submitted, finished, model_key: str, batch_size: int) -> None` — opens `sessionmaker(bind=app.db.engine)()` at call time, `UPDATE pages SET ocr_submitted_at=..., ocr_finished_at=..., ocr_model_key=..., ocr_batch_size=... WHERE id IN page_ids`, commit, close. Never raises (try/except + stderr print), same rationale as `app/audit.py`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_ocr_timing.py
import httpx
import pytest
from app import ocr_service, kraken, ocr_models
from app.config import settings
from app.models import Page, Document, Transcription
from tests.conftest import make_user


@pytest.fixture(autouse=True)
def _whitelist(monkeypatch):
    monkeypatch.setattr(settings, "kraken_models", [
        {"key": "rapide", "seg_path": "/m/seg.mlmodel", "rec_path": "/m/rec-fast.mlmodel"},
    ], raising=False)
    monkeypatch.setattr(settings, "kraken_models_default", "rapide", raising=False)


def _make_page(db, content_type="image/png", n=1):
    u = make_user(db, email="u@test.fr", credits=100)
    doc = Document(user_id=u.id, title="D")
    db.add(doc); db.commit()
    pages = []
    for i in range(n):
        p = Page(document_id=doc.id, page_number=i + 1, content_type=content_type,
                 storage_key=f"k/{doc.id}.png" if content_type != "application/pdf" else f"k/{doc.id}.pdf",
                 processing_status="queued", credits_charged=1)
        db.add(p); pages.append(p)
    db.commit()
    return doc, pages


def test_enqueue_puts_model_in_payload(db, monkeypatch):
    captured = {}
    class _Q:
        def enqueue(self, fn, payload, **kw):
            captured.update(payload)
            class J: id = "j1"
            return J()
    monkeypatch.setattr(ocr_service, "Queue", lambda *a, **k: _Q(), raising=False)
    monkeypatch.setattr("redis.Redis.from_url", lambda *a, **k: object())
    _, pages = _make_page(db)
    ocr_service.enqueue_page_ocr(db, pages[0])
    assert captured["model_key"] == "rapide"
    assert captured["seg_model_path"] == "/m/seg.mlmodel"
    assert captured["rec_model_path"] == "/m/rec-fast.mlmodel"


def test_image_ocr_stamps_timing(client, db, monkeypatch):
    _, pages = _make_page(db)
    page_id = pages[0].id
    monkeypatch.setattr(kraken, "submit_ocr", lambda *a, **k: "job-x")
    monkeypatch.setattr(kraken, "wait_for_result", lambda *a, **k: {"pages": [{"lines": []}]})
    monkeypatch.setattr(ocr_service, "_page_file_bytes", lambda page: b"x")
    ocr_service.run_ocr_job({"page_id": page_id, "kind": "image",
                             "model_key": "rapide",
                             "seg_model_path": "/m/seg.mlmodel", "rec_model_path": "/m/rec-fast.mlmodel"})
    db.expire_all()
    p = db.query(Page).get(page_id)
    assert p.ocr_submitted_at is not None and p.ocr_finished_at is not None
    assert p.ocr_model_key == "rapide"
    assert p.ocr_batch_size == 1


def test_pdf_ocr_stamps_all_siblings_with_batch_size(client, db, monkeypatch):
    doc, pages = _make_page(db, content_type="application/pdf", n=3)
    first_id = pages[0].id
    monkeypatch.setattr(kraken, "submit_ocr", lambda *a, **k: "job-x")
    monkeypatch.setattr(kraken, "wait_for_result", lambda *a, **k: {"pages": [{"lines": []}, {"lines": []}, {"lines": []}]})
    monkeypatch.setattr(ocr_service, "_page_file_bytes", lambda page: b"x")
    monkeypatch.setattr(ocr_service, "_render_pdf_derivative", lambda *a, **k: None)
    ocr_service.run_ocr_job({"page_id": first_id, "kind": "pdf", "model_key": "rapide",
                             "seg_model_path": "/m/seg.mlmodel", "rec_model_path": "/m/rec-fast.mlmodel"})
    db.expire_all()
    for p in db.query(Page).filter_by(document_id=doc.id).all():
        assert p.ocr_submitted_at is not None and p.ocr_finished_at is not None
        assert p.ocr_batch_size == 3
        assert p.ocr_model_key == "rapide"


def test_failed_ocr_still_stamps_timing_and_refunds(client, db, monkeypatch):
    _, pages = _make_page(db)
    page_id = pages[0].id
    monkeypatch.setattr(ocr_service, "_page_file_bytes", lambda page: b"x")
    def boom(*a, **k):
        raise kraken.KrakenError("kraken down")
    monkeypatch.setattr(kraken, "submit_ocr", boom)
    ocr_service.run_ocr_job({"page_id": page_id, "kind": "image", "model_key": "rapide",
                             "seg_model_path": "/m/seg.mlmodel", "rec_model_path": "/m/rec-fast.mlmodel"})
    db.expire_all()
    p = db.query(Page).get(page_id)
    assert p.processing_status == "error"
    assert p.ocr_submitted_at is not None
    assert p.ocr_finished_at is not None      # stamped in the finally even though submit threw
    assert p.ocr_model_key == "rapide"
    assert p.credits_charged == 0             # refunded
```

(Adjust `monkeypatch.setattr(ocr_service, "Queue", ...)` / redis patching to match how `enqueue_page_ocr` imports them — it does `from redis import Redis` and `from rq import Queue` **inside** the function, so patch `redis.Redis.from_url` and `rq.Queue`. Confirm before finalizing the test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_ocr_timing.py -v`
Expected: FAIL — payload lacks `model_key`; timing columns stay `None`.

- [ ] **Step 3: Implement**

In `app/ocr_service.py`:

```python
from . import credits, kraken, ocr_models, storage
```

`_stamp_timing` (module level):

```python
def _stamp_timing(page_ids, *, submitted, finished, model_key, batch_size):
    """Write OCR timing on the given pages via a fresh session so it survives a
    rollback in run_ocr_job's failure path. Never raises (same pattern as app.audit)."""
    from sqlalchemy.orm import sessionmaker
    from . import db as _db
    session = sessionmaker(bind=_db.engine, autoflush=False, expire_on_commit=False)()
    try:
        (session.query(Page).filter(Page.id.in_(page_ids))
         .update({Page.ocr_submitted_at: submitted, Page.ocr_finished_at: finished,
                  Page.ocr_model_key: model_key, Page.ocr_batch_size: batch_size},
                 synchronize_session=False))
        session.commit()
    except Exception as exc:  # noqa: BLE001
        print(f"ocr timing stamp failed: {exc}")
        session.rollback()
    finally:
        session.close()
```

`enqueue_page_ocr` — after computing `kind`:

```python
    model = ocr_models.resolve_active(db)
    payload = {
        "page_id": page.id,
        "kind": "image" if not page.content_type.startswith("application/pdf") else "pdf",
        "model_key": model["key"],
        "seg_model_path": model["seg_path"],
        "rec_model_path": model["rec_path"],
    }
```

`run_ocr_job` — pass `payload`:

```python
            if page.content_type.startswith("application/pdf"):
                _run_pdf(db, page, document, payload)
            else:
                _run_image(db, page, payload)
```

`_run_image(db, page, payload)`:

```python
def _run_image(db: Session, page: Page, payload: dict) -> None:
    page.processing_status = "transcribing"
    db.commit()
    file_bytes = _page_file_bytes(page)
    ext = "." + (page.storage_key.rsplit(".", 1)[-1] or "bin")
    submitted = _now()
    try:
        with httpx.Client() as http:
            job_id = kraken.submit_ocr(http, file_bytes, ext,
                                       seg_model_path=payload["seg_model_path"],
                                       rec_model_path=payload["rec_model_path"])
            page.kraken_job_id = job_id
            db.commit()
            result = kraken.wait_for_result(http, job_id)
    finally:
        _stamp_timing([page.id], submitted=submitted, finished=_now(),
                      model_key=payload["model_key"], batch_size=1)
    _save_result(db, page, result.get("pages") or [])
```

`_run_pdf(db, page, document, payload)` — same shape: capture `submitted` before the `httpx.Client()` block, wrap submit + `wait_for_result` in `try/finally`, and in the `finally` call `_stamp_timing([p.id for p in siblings], submitted=submitted, finished=_now(), model_key=payload["model_key"], batch_size=len(siblings))`. Keep the rest (`_save_result` loop, `_render_pdf_derivative`) unchanged.

Add `_now` helper (or reuse `datetime.now(timezone.utc)` inline — match the file's existing style; `app/models.py` has `now()` but importing it here is fine):

```python
from datetime import datetime, timezone
def _now():
    return datetime.now(timezone.utc)
```

`_stamp_timing` runs in the `finally`, so on the failure path it commits before `run_ocr_job`'s `except` rolls back the main session and calls `_fail`. `_fail` must not touch the timing columns (it doesn't — leave it).

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_ocr_timing.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Full backend suite**

Run: `pytest -q`
Expected: PASS (existing OCR tests still green — `_run_image` / `_run_pdf` signature change is internal).

- [ ] **Step 6: Commit**

```bash
git add app/ocr_service.py tests/test_ocr_timing.py
git commit -m "feat(ocr): resolve model at enqueue + capture per-page timing"
```

---

### Task 6: `GET /api/admin/ocr` panel-data endpoint

**Files:**
- Modify: `app/main.py` (new route in the admin section, after the E1 `admin_audit` route; add `ocr_models` + `AppSetting` to imports as needed)
- Test: `tests/test_admin_ocr_get.py` (create)

**Interfaces:**
- Consumes: `ocr_models.list_models` / `resolve_active` / `active_source`; `Page` timing columns; `Transcription.confidence_score`; `Document.title`.
- Produces: `GET /api/admin/ocr` → 
  ```json
  {"models": [{"key","seg_path","rec_path"}],
   "active_key": "rapide", "active_source": "setting",
   "recent": [{"page_id","document_id","document_title","processing_status",
               "duration_s": 92.4|null, "per_page_s": 92.4|null,
               "model_key","avg_confidence": 0.7|null,"submitted_at": "iso"}],
   "aggregates": [{"model_key","pages","median_s","p95_s","avg_confidence"}]}
  ```
  - `recent`: 50 most recent `Page` with `ocr_submitted_at IS NOT NULL`, `ocr_submitted_at DESC`.
  - `aggregates`: `Page` with `ocr_submitted_at >= now()-30d AND ocr_finished_at IS NOT NULL`, grouped by `ocr_model_key`. `median_s`/`p95_s` via `percentile_cont` on Postgres; Python nearest-rank on SQLite (`db.bind.dialect.name == "sqlite"`).
  - `avg_confidence` per row/group: mean of the page's latest `Transcription.confidence_score` (a page may have 0 → `null`).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_admin_ocr_get.py
from datetime import datetime, timezone, timedelta
import pytest
from app.config import settings
from app.models import Page, Document, Transcription
from tests.conftest import make_user, auth_headers


@pytest.fixture(autouse=True)
def _whitelist(monkeypatch):
    monkeypatch.setattr(settings, "kraken_models", [
        {"key": "défaut", "seg_path": "/m/seg.mlmodel", "rec_path": "/m/rec.mlmodel"},
        {"key": "rapide", "seg_path": "/m/seg.mlmodel", "rec_path": "/m/rec-fast.mlmodel"},
    ], raising=False)
    monkeypatch.setattr(settings, "kraken_models_default", "défaut", raising=False)


def _page(db, doc, *, key, dur_s, conf, when=None):
    when = when or datetime.now(timezone.utc)
    p = Page(document_id=doc.id, page_number=1, processing_status="done",
             ocr_submitted_at=when, ocr_finished_at=when + timedelta(seconds=dur_s),
             ocr_model_key=key, ocr_batch_size=1)
    db.add(p); db.flush()
    db.add(Transcription(page_id=p.id, raw_htr_text="x", edited_text="",
                         confidence_score=conf, source="htr", version_number=1))
    return p


def test_shape_and_active(client, db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    doc = Document(user_id=admin.id, title="Doc A"); db.add(doc); db.commit()
    _page(db, doc, key="défaut", dur_s=90, conf=0.7)
    _page(db, doc, key="rapide", dur_s=30, conf=0.6)
    db.commit()
    r = client.get("/api/admin/ocr", headers=auth_headers(db, admin))
    assert r.status_code == 200
    body = r.json()
    assert [m["key"] for m in body["models"]] == ["défaut", "rapide"]
    assert body["active_key"] == "défaut"
    assert body["active_source"] == "env_default"
    assert len(body["recent"]) == 2
    assert body["recent"][0]["duration_s"] in (30.0, 90.0)
    agg = {a["model_key"]: a for a in body["aggregates"]}
    assert agg["défaut"]["pages"] == 1
    assert agg["rapide"]["median_s"] == 30.0


def test_recent_capped_at_50_and_excludes_untimed(client, db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    doc = Document(user_id=admin.id, title="D"); db.add(doc); db.commit()
    for _ in range(55):
        _page(db, doc, key="défaut", dur_s=10, conf=0.5)
    db.add(Page(document_id=doc.id, page_number=1, processing_status="idle"))  # untimed
    db.commit()
    r = client.get("/api/admin/ocr", headers=auth_headers(db, admin))
    assert len(r.json()["recent"]) == 50


def test_aggregates_window_30_days(client, db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    doc = Document(user_id=admin.id, title="D"); db.add(doc); db.commit()
    old = datetime.now(timezone.utc) - timedelta(days=40)
    _page(db, doc, key="défaut", dur_s=99, conf=0.5, when=old)
    _page(db, doc, key="défaut", dur_s=11, conf=0.5)
    db.commit()
    r = client.get("/api/admin/ocr", headers=auth_headers(db, admin))
    agg = {a["model_key"]: a for a in r.json()["aggregates"]}
    assert agg["défaut"]["pages"] == 1  # the 40-day-old one excluded


def test_requires_admin(client, db):
    u = make_user(db, email="u@test.fr")
    assert client.get("/api/admin/ocr", headers=auth_headers(db, u)).status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_admin_ocr_get.py -v`
Expected: FAIL — 404.

- [ ] **Step 3: Implement**

Add to `app/main.py` imports: `from . import ai, billing, credits, kraken, ocr_models, storage` (extend the existing line); `AppSetting` to the `.models` import.

```python
def _percentiles(durations: list[float], dialect: str):
    """Return (median, p95). Postgres does this in SQL; this is the SQLite path."""
    if not durations:
        return None, None
    s = sorted(durations)
    def rank(p):
        i = max(0, min(len(s) - 1, int(round(p * (len(s) - 1)))))
        return s[i]
    return rank(0.5), rank(0.95)


@app.get("/api/admin/ocr")
def admin_ocr(db: Session = Depends(get_db), admin: User = Depends(get_admin_user)):
    from datetime import datetime, timezone, timedelta
    active = ocr_models.resolve_active(db)
    recent_rows = (
        db.query(Page, Document.title)
        .join(Document, Document.id == Page.document_id)
        .filter(Page.ocr_submitted_at.isnot(None))
        .order_by(Page.ocr_submitted_at.desc())
        .limit(50).all()
    )

    def _dur(p):
        if p.ocr_submitted_at and p.ocr_finished_at:
            return round((p.ocr_finished_at - p.ocr_submitted_at).total_seconds(), 1)
        return None

    def _avg_conf(page_id):
        v = (db.query(func.avg(Transcription.confidence_score))
             .filter(Transcription.page_id == page_id).scalar())
        return round(float(v), 3) if v is not None else None

    recent = []
    for p, title in recent_rows:
        d = _dur(p)
        recent.append({
            "page_id": p.id, "document_id": p.document_id, "document_title": title,
            "processing_status": p.processing_status,
            "duration_s": d,
            "per_page_s": round(d / max(p.ocr_batch_size, 1), 1) if d is not None else None,
            "model_key": p.ocr_model_key or "",
            "avg_confidence": _avg_conf(p.id),
            "submitted_at": p.ocr_submitted_at.isoformat() if p.ocr_submitted_at else None,
        })

    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    agg_pages = (
        db.query(Page)
        .filter(Page.ocr_submitted_at.isnot(None), Page.ocr_finished_at.isnot(None),
                Page.ocr_submitted_at >= cutoff)
        .all()
    )
    by_key: dict[str, list[Page]] = {}
    for p in agg_pages:
        by_key.setdefault(p.ocr_model_key or "", []).append(p)
    dialect = db.bind.dialect.name if db.bind else "sqlite"
    aggregates = []
    for key, ps in sorted(by_key.items()):
        durs = [(p.ocr_finished_at - p.ocr_submitted_at).total_seconds() for p in ps]
        med, p95 = _percentiles(durs, dialect)
        confs = [c for c in (_avg_conf(p.id) for p in ps) if c is not None]
        aggregates.append({
            "model_key": key, "pages": len(ps),
            "median_s": round(med, 1) if med is not None else None,
            "p95_s": round(p95, 1) if p95 is not None else None,
            "avg_confidence": round(sum(confs) / len(confs), 3) if confs else None,
        })

    return {
        "models": ocr_models.list_models(),
        "active_key": active["key"],
        "active_source": ocr_models.active_source(db),
        "recent": recent,
        "aggregates": aggregates,
    }
```

Note: the spec allows a Postgres-native `percentile_cont` path; the Python `_percentiles` is correct on both engines and simpler to keep single-path. **Ruling for the implementer:** use the Python path unconditionally (fetch the rows, compute in Python) — the 30-day admin-only volume is small, and it removes a Postgres/SQLite branch. Drop the `dialect` argument if unused.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_admin_ocr_get.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add app/main.py tests/test_admin_ocr_get.py
git commit -m "feat(ocr): GET /api/admin/ocr panel data (models + timing aggregates)"
```

---

### Task 7: `PUT /api/admin/ocr/model`

**Files:**
- Modify: `app/main.py` (route after `admin_ocr`; add a small `BaseModel`)
- Test: `tests/test_admin_ocr_put.py` (create)

**Interfaces:**
- Consumes: `ocr_models.set_active` (Task 2).
- Produces: `PUT /api/admin/ocr/model` body `{"key": str}` → `200 {"active_key": key}`; `ValueError` from `set_active` → `400` with the message; `Depends(get_admin_user)`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_admin_ocr_put.py
import pytest
from app.config import settings
from app.models import AppSetting, AdminAuditLog
from tests.conftest import make_user, auth_headers


@pytest.fixture(autouse=True)
def _whitelist(monkeypatch):
    monkeypatch.setattr(settings, "kraken_models", [
        {"key": "défaut", "seg_path": "/m/s", "rec_path": "/m/r"},
        {"key": "rapide", "seg_path": "/m/s", "rec_path": "/m/rf"},
    ], raising=False)


def test_valid_key_sets_active_and_audits(client, db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    r = client.put("/api/admin/ocr/model", json={"key": "rapide"}, headers=auth_headers(db, admin))
    assert r.status_code == 200
    assert r.json() == {"active_key": "rapide"}
    db.expire_all()
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "rapide"
    assert db.query(AdminAuditLog).filter_by(event="ocr.model_change").count() == 1


def test_invalid_key_400(client, db):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    r = client.put("/api/admin/ocr/model", json={"key": "bogus"}, headers=auth_headers(db, admin))
    assert r.status_code == 400
    assert "bogus" in r.json()["detail"]


def test_requires_admin(client, db):
    u = make_user(db, email="u@test.fr")
    r = client.put("/api/admin/ocr/model", json={"key": "rapide"}, headers=auth_headers(db, u))
    assert r.status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_admin_ocr_put.py -v`
Expected: FAIL — 404 / 405.

- [ ] **Step 3: Implement**

In `app/main.py` (near the other `BaseModel`s):

```python
class OcrModelIn(BaseModel):
    key: str
```

Route:

```python
@app.put("/api/admin/ocr/model")
def admin_set_ocr_model(payload: OcrModelIn, db: Session = Depends(get_db),
                        admin: User = Depends(get_admin_user)):
    try:
        ocr_models.set_active(db, payload.key, admin)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    db.commit()
    return {"active_key": payload.key}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_admin_ocr_put.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Full backend suite**

Run: `pytest -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/main.py tests/test_admin_ocr_put.py
git commit -m "feat(ocr): PUT /api/admin/ocr/model to switch active model"
```

---

### Task 8: `web/src/api.ts` — `put` method + OCR types

**Files:**
- Modify: `web/src/api.ts`
- Test: `web/src/api.ocr.test.ts` (create)

**Interfaces:**
- Consumes: existing `request`.
- Produces:
  - `api.put: <T>(path: string, body: unknown) => Promise<T>` (method `PUT`).
  - Types: `OcrModel {key: string; seg_path: string; rec_path: string}`, `OcrRecentRow`, `OcrAggregate`, `OcrPanelData {models: OcrModel[]; active_key: string; active_source: 'setting'|'env_default'|'fallback'; recent: OcrRecentRow[]; aggregates: OcrAggregate[]}`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/api.ocr.test.ts
import { beforeEach, expect, it, vi } from 'vitest'
import { api, setToken } from './api'

beforeEach(() => { localStorage.clear(); setToken('tok'); vi.restoreAllMocks() })

it('api.put issues a PUT with a JSON body', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ active_key: 'rapide' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const out = await api.put('/api/admin/ocr/model', { key: 'rapide' })
  expect(out).toEqual({ active_key: 'rapide' })
  const [, opts] = fetchMock.mock.calls[0]
  expect(opts.method).toBe('PUT')
  expect(JSON.parse(opts.body)).toEqual({ key: 'rapide' })
  expect(opts.headers['Content-Type']).toBe('application/json')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- api.ocr`
Expected: FAIL — `api.put is not a function`.

- [ ] **Step 3: Implement**

In `web/src/api.ts`, in the `api` object next to `patch`:

```ts
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body }),
```

Add the types (near the other exported interfaces):

```ts
export interface OcrModel { key: string; seg_path: string; rec_path: string }
export interface OcrRecentRow {
  page_id: string; document_id: string; document_title: string
  processing_status: string
  duration_s: number | null; per_page_s: number | null
  model_key: string; avg_confidence: number | null; submitted_at: string | null
}
export interface OcrAggregate {
  model_key: string; pages: number
  median_s: number | null; p95_s: number | null; avg_confidence: number | null
}
export interface OcrPanelData {
  models: OcrModel[]
  active_key: string
  active_source: 'setting' | 'env_default' | 'fallback'
  recent: OcrRecentRow[]
  aggregates: OcrAggregate[]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web test -- api.ocr`
Expected: PASS

- [ ] **Step 5: Full web suite + build**

Run: `npm --prefix web test`
Expected: PASS (E1's 21 + this)
Run: `npm --prefix web run build`
Expected: tsc clean

- [ ] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/api.ocr.test.ts
git commit -m "feat(web): api.put + OCR panel types"
```

---

### Task 9: `Admin.tsx` — OCR / Modèles panel section

**Files:**
- Modify: `web/src/pages/Admin.tsx`
- Test: `web/src/pages/Admin.ocr.test.tsx` (create)

**Interfaces:**
- Consumes: `api.get<OcrPanelData>('/api/admin/ocr')`, `api.put('/api/admin/ocr/model', {key})`, the types from Task 8.
- Produces: a new "OCR / Modèles" section below "Journal d'impersonation".

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/pages/Admin.ocr.test.tsx
import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Admin from './Admin'

vi.mock('react-router-dom', async (orig) => ({ ...(await orig<any>()), useNavigate: () => vi.fn() }))

const ocrData = {
  models: [
    { key: 'défaut', seg_path: '/m/s', rec_path: '/m/r' },
    { key: 'rapide', seg_path: '/m/s', rec_path: '/m/rf' },
  ],
  active_key: 'défaut', active_source: 'env_default',
  recent: [{
    page_id: 'p1', document_id: 'd1', document_title: 'Doc A', processing_status: 'done',
    duration_s: 92.4, per_page_s: 92.4, model_key: 'défaut', avg_confidence: 0.71,
    submitted_at: '2026-09-02T10:00:00Z',
  }],
  aggregates: [
    { model_key: 'défaut', pages: 10, median_s: 90, p95_s: 140, avg_confidence: 0.7 },
    { model_key: 'rapide', pages: 4, median_s: 30, p95_s: 45, avg_confidence: 0.65 },
  ],
}

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('palimora_token', 'tok'); vi.restoreAllMocks()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ is_admin: true }), { status: 200 })
    if (url.endsWith('/api/admin/users')) return new Response(JSON.stringify({ users: [] }), { status: 200 })
    if (url.endsWith('/api/admin/stats')) return new Response(JSON.stringify({ users: 0, documents: 0, pages_done: 0, pages_error: 0, pages_total: 0, credits_in_circulation: 0 }), { status: 200 })
    if (url.includes('/api/admin/audit')) return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    if (url.endsWith('/api/admin/ocr')) return new Response(JSON.stringify(ocrData), { status: 200 })
    if (url.endsWith('/api/admin/ocr/model')) return new Response(JSON.stringify({ active_key: 'rapide' }), { status: 200 })
    return new Response('{}', { status: 200 })
  }))
})

it('renders the model selector, aggregates and recent tables', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  expect(await screen.findByText(/OCR \/ Modèles/i)).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('défaut'))
  expect(screen.getByText('Doc A')).toBeInTheDocument()
  expect(screen.getByText(/env_default/)).toBeInTheDocument()
  // aggregates
  expect(screen.getByText('rapide')).toBeInTheDocument()
})

it('saving a new model calls PUT', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await screen.findByRole('combobox')
  await userEvent.selectOptions(screen.getByRole('combobox'), 'rapide')
  await userEvent.click(screen.getByRole('button', { name: /enregistrer/i }))
  await waitFor(() => {
    const putCall = (fetch as any).mock.calls.find((c: any[]) => c[0].endsWith('/api/admin/ocr/model'))
    expect(putCall).toBeTruthy()
    expect(putCall[1].method).toBe('PUT')
  })
})

it('shows a message and no selector when no models configured', async () => {
  ;(fetch as any).mockImplementation(async (url: string) => {
    if (url.endsWith('/api/admin/ocr')) return new Response(JSON.stringify({ ...ocrData, models: [] }), { status: 200 })
    if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ is_admin: true }), { status: 200 })
    if (url.endsWith('/api/admin/users')) return new Response(JSON.stringify({ users: [] }), { status: 200 })
    if (url.endsWith('/api/admin/stats')) return new Response(JSON.stringify({ users: 0, documents: 0, pages_done: 0, pages_error: 0, pages_total: 0, credits_in_circulation: 0 }), { status: 200 })
    if (url.includes('/api/admin/audit')) return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    return new Response('{}', { status: 200 })
  })
  render(<MemoryRouter><Admin /></MemoryRouter>)
  expect(await screen.findByText(/Aucun modèle alternatif configuré/i)).toBeInTheDocument()
  expect(screen.queryByRole('combobox')).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- Admin.ocr`
Expected: FAIL — no "OCR / Modèles" heading.

- [ ] **Step 3: Implement**

In `web/src/pages/Admin.tsx`:

1. Import: `import { api, setImpersonation, setToken } from '../api'` → also `import type { OcrPanelData } from '../api'`.
2. State: `const [ocr, setOcr] = useState<OcrPanelData | null>(null)` and `const [modelKey, setModelKey] = useState('')`.
3. In `refresh`, extend the `Promise.all`:

```tsx
    const [u, s, a, o] = await Promise.all([
      api.get<{ users: AdminUser[] }>('/api/admin/users'),
      api.get<Stats>('/api/admin/stats'),
      api.get<{ rows: AuditRow[] }>('/api/admin/audit?limit=100'),
      api.get<OcrPanelData>('/api/admin/ocr'),
    ])
    setUsers(u.users); setStats(s); setAudit(a.rows)
    setOcr(o); setModelKey(o.active_key)
```

4. Handler:

```tsx
  async function saveModel() {
    try {
      await api.put('/api/admin/ocr/model', { key: modelKey })
      setToast('Modèle OCR mis à jour')
      setTimeout(() => setToast(''), 2500)
      refresh()
    } catch {
      setToast('Erreur mise à jour modèle')
      setTimeout(() => setToast(''), 2500)
    }
  }
```

5. New section after the "Journal d'impersonation" `</div>`:

```tsx
      {ocr && (
        <div className="px-4 pb-12">
          <h2 className="mb-2 font-semibold">OCR / Modèles</h2>

          {ocr.models.length === 0 ? (
            <p className="text-sm text-slate-500">
              Aucun modèle alternatif configuré (env <code>KRAKEN_MODELS</code>).
            </p>
          ) : (
            <div className="mb-4 flex items-center gap-2 text-sm">
              <select className="border rounded px-2 py-1"
                      value={modelKey} onChange={(e) => setModelKey(e.target.value)}>
                {ocr.models.map((m) => <option key={m.key} value={m.key}>{m.key}</option>)}
              </select>
              <button className="bg-indigo-600 text-white rounded px-3 py-1" onClick={saveModel}>
                Enregistrer
              </button>
              <span className="text-xs text-slate-500">source&nbsp;: {ocr.active_source}</span>
            </div>
          )}

          <table className="w-full bg-white rounded-lg border text-sm mb-6">
            <thead><tr className="text-left text-slate-500 border-b">
              <th className="p-2">Modèle</th><th className="p-2">Pages</th>
              <th className="p-2">Médiane (s)</th><th className="p-2">p95 (s)</th>
              <th className="p-2">Confiance moy.</th>
            </tr></thead>
            <tbody>
              {ocr.aggregates.map((a) => (
                <tr key={a.model_key || '—'} className="border-b">
                  <td className="p-2">{a.model_key || '—'}</td>
                  <td className="p-2">{a.pages}</td>
                  <td className="p-2">{a.median_s ?? '—'}</td>
                  <td className="p-2">{a.p95_s ?? '—'}</td>
                  <td className="p-2">{a.avg_confidence ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="w-full bg-white rounded-lg border text-sm">
            <thead><tr className="text-left text-slate-500 border-b">
              <th className="p-2">Date</th><th className="p-2">Document</th>
              <th className="p-2">Statut</th><th className="p-2">Durée (s)</th>
              <th className="p-2">Durée/page (s)</th><th className="p-2">Modèle</th>
              <th className="p-2">Confiance</th>
            </tr></thead>
            <tbody>
              {ocr.recent.map((r) => (
                <tr key={r.page_id} className="border-b">
                  <td className="p-2">{r.submitted_at ? new Date(r.submitted_at).toLocaleString('fr-FR') : '—'}</td>
                  <td className="p-2">
                    <Link to={`/`} className="text-indigo-600">{r.document_title}</Link>
                  </td>
                  <td className="p-2">{r.processing_status}</td>
                  <td className="p-2">{r.duration_s ?? '—'}</td>
                  <td className="p-2">{r.per_page_s ?? '—'}</td>
                  <td className="p-2">{r.model_key || '—'}</td>
                  <td className="p-2">{r.avg_confidence ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
```

(`Link` is already imported in `Admin.tsx`. There is no per-document route in the SPA today — link to `/` is a placeholder consistent with the rest of the admin page; do not invent a route.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web test -- Admin.ocr`
Expected: PASS (3 tests)

- [ ] **Step 5: Full web suite + build**

Run: `npm --prefix web test`
Expected: PASS
Run: `npm --prefix web run build`
Expected: tsc clean

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Admin.tsx web/src/pages/Admin.ocr.test.tsx
git commit -m "feat(web): OCR / Modèles admin panel section"
```

---

### Task 10: end-to-end + spec status + rollout notes

**Files:**
- Create: `tests/test_ocr_e2e.py`
- Modify: `docs/superpowers/specs/2026-09-01-e2-kraken-model-monitoring-design.md` (`Status:` line)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the E2E test**

```python
# tests/test_ocr_e2e.py
import pytest
from app import ocr_service, kraken
from app.config import settings
from app.models import Page, Document, AppSetting
from tests.conftest import make_user, auth_headers


@pytest.fixture(autouse=True)
def _whitelist(monkeypatch):
    monkeypatch.setattr(settings, "kraken_models", [
        {"key": "défaut", "seg_path": "/m/s", "rec_path": "/m/r"},
        {"key": "rapide", "seg_path": "/m/s2", "rec_path": "/m/rf"},
    ], raising=False)
    monkeypatch.setattr(settings, "kraken_models_default", "défaut", raising=False)


def test_switch_model_then_ocr_records_new_key(client, db, monkeypatch):
    admin = make_user(db, email="a@test.fr", is_admin=True, credits=100)

    # 1. switch active model via the admin endpoint
    r = client.put("/api/admin/ocr/model", json={"key": "rapide"}, headers=auth_headers(db, admin))
    assert r.status_code == 200
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "rapide"

    # 2. a page gets enqueued -> payload carries the switched model
    doc = Document(user_id=admin.id, title="D"); db.add(doc); db.commit()
    page = Page(document_id=doc.id, page_number=1, content_type="image/png",
                storage_key=f"k/{doc.id}.png", processing_status="queued", credits_charged=1)
    db.add(page); db.commit()

    captured = {}
    monkeypatch.setattr(kraken, "submit_ocr",
                        lambda *a, **k: captured.update(k) or "job-x")
    monkeypatch.setattr(kraken, "wait_for_result", lambda *a, **k: {"pages": [{"lines": []}]})
    monkeypatch.setattr(ocr_service, "_page_file_bytes", lambda p: b"x")

    # resolve + run as the worker would
    from app.ocr_models import resolve_active
    model = resolve_active(db)
    ocr_service.run_ocr_job({"page_id": page.id, "kind": "image",
                             "model_key": model["key"],
                             "seg_model_path": model["seg_path"], "rec_model_path": model["rec_path"]})

    assert captured.get("rec_model_path") == "/m/rf"
    db.expire_all()
    p = db.query(Page).get(page.id)
    assert p.ocr_model_key == "rapide"
    assert p.ocr_submitted_at is not None and p.ocr_finished_at is not None

    # 3. panel reflects it
    body = client.get("/api/admin/ocr", headers=auth_headers(db, admin)).json()
    assert body["active_key"] == "rapide"
    assert any(row["model_key"] == "rapide" for row in body["recent"])
```

- [ ] **Step 2: Run it + full suites**

Run: `pytest tests/test_ocr_e2e.py -v`
Expected: PASS
Run: `pytest -q && npm --prefix web test`
Expected: all PASS

- [ ] **Step 3: Update the spec status line**

`Status: approved (design), pending spec review` → `Status: implemented (E2)`.

- [ ] **Step 4: Commit**

```bash
git add tests/test_ocr_e2e.py docs/superpowers/specs/2026-09-01-e2-kraken-model-monitoring-design.md
git commit -m "test(ocr): end-to-end model switch + timing flow; mark E2 spec implemented"
```

- [ ] **Step 5: STOP — do not push or open a PR**

Report the branch state to the controller. Pushing `feat/e2-kraken-model-monitoring` and opening a PR (or merging) is the user's decision, taken after the final review, exactly as E1 was handled. Rollout prerequisites (operator bakes a 2nd model into the Kraken image, sets `KRAKEN_MODELS` / `KRAKEN_MODELS_DEFAULT` on Server **and** Worker in Coolify) are in spec §8 and must be relayed.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §2.1 `KRAKEN_MODELS` / `KRAKEN_MODELS_DEFAULT` parsing | Task 1 |
| §2.2 module API (`list_models`/`get_model`/`resolve_active`/`active_source`/`set_active`) | Task 2 |
| §2.3 resolution order (setting → env_default → fallback) | Task 2 (tests cover all 3 + stale value) |
| §2.4 `set_active` validation + `AppSetting` upsert + audit row | Task 2 |
| §3.1 `submit_ocr` model kwargs, byte-identical when None | Task 4 |
| §3.2 resolve at enqueue, payload fields, `_stamp_timing` isolated session, failure path | Task 5 |
| §4.1 `Page` 4 timing columns | Task 3 |
| §4.2 `AppSetting` table | Task 2 |
| §4.3 `_migrate()` 4 ALTERs | Task 3 |
| §5.1 `GET /api/admin/ocr` (models/active/source/recent/aggregates) | Task 6 |
| §5.1 median/p95 (Postgres + SQLite) | Task 6 — **Ruling: single Python path** (see below) |
| §5.2 `PUT /api/admin/ocr/model` | Task 7 |
| §6.1 `api.put` + types | Task 8 |
| §6.2 Admin.tsx section (selector + source badge + empty state + 2 tables) | Task 9 |
| §7.1 pytest list | Tasks 1,2,3,4,5,6,7,10 |
| §7.2 vitest list | Tasks 8,9 |
| §8 rollout prerequisites | Task 10 Step 5 (relayed, not automated) |
| §9 risks | acknowledged; no code owed |

No gaps.

**Ruling (recorded):** §5.1 offers a Postgres-native `percentile_cont` path with a SQLite Python fallback. The plan collapses this to **one Python path** (Task 6 Step 3): fetch the in-window rows, compute median/p95 in Python (nearest-rank). Rationale: admin-only 30-day volume is small (hundreds of rows), and a single path removes a dialect branch that the spec itself flagged as awkward. Cost if wrong: a slow query only if OCR volume grows into millions of pages/month, at which point a materialized aggregate is the real fix anyway.

**2. Placeholder scan:** No "TBD"/"handle errors"/"similar to". Every code step is complete. Two notes ("confirm how `enqueue_page_ocr` imports Queue/Redis before finalizing the test", "no per-document route exists — link to `/`") are verification instructions with the surrounding code fully written, not placeholders.

**3. Type consistency:**
- `resolve_active(db) -> {"key","seg_path","rec_path"}` — Task 2 def, consumed in Tasks 5, 6, 10 with those exact keys.
- `_stamp_timing(page_ids, *, submitted, finished, model_key, batch_size)` — Task 5 def + both call sites (`_run_image` batch_size=1, `_run_pdf` batch_size=len(siblings)).
- RQ payload keys `model_key` / `seg_model_path` / `rec_model_path` — written in `enqueue_page_ocr` (Task 5), read in `_run_image`/`_run_pdf` (Task 5), asserted in Tasks 5 + 10.
- `GET /api/admin/ocr` JSON shape — Task 6 def, consumed identically by `OcrPanelData` (Task 8) and `Admin.tsx` (Task 9): `models[].key`, `active_key`, `active_source`, `recent[].{duration_s,per_page_s,model_key,avg_confidence,submitted_at,document_title,...}`, `aggregates[].{model_key,pages,median_s,p95_s,avg_confidence}`.
- `AppSetting` columns (`key`,`value`,`updated_at`,`updated_by`) — Task 2 def, used in Tasks 2, 6, 10.
- `PUT /api/admin/ocr/model` body `{key}` / response `{active_key}` — Task 7 def, Task 8 test, Task 9 call.
- `api.put(path, body)` — Task 8 def, Task 9 call.
- `ocr_model_key == ""` rendered as `—` — Task 6 emits `""`, Task 9 renders `|| '—'`.

Consistent.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-02-e2-kraken-model-monitoring.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, broad final review.
2. **Inline Execution** — tasks in this session with checkpoints.

Which approach?
