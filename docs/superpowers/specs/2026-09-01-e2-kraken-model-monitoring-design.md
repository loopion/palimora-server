# E2 — Kraken Model Override + OCR Timing Monitoring — Design

Date: 2026-09-01
Status: approved (design), pending spec review
Phase: E (admin + monitoring). Sub-project 2 of 2 (E1 impersonation shipped
2026-09-01 merge `0d9cb28`; this is E2).

## 1. Goal

Give an admin an operator-curated choice of Kraken model (segmentation +
recognition pair) to run OCR with, changeable at runtime without a redeploy, and
a monitoring panel that shows how long each page's OCR took and how the models
compare (median / p95 duration, average confidence). The current recognition
model is slow (~1.5 min/page) and the operator wants to A/B a faster one with
real numbers.

The Kraken microservice (`loopion/kraken-ocr-service`) is **not modified**. It
already accepts optional `seg_model_path` / `rec_model_path` form fields on
`POST /jobs` and falls back to `$MODEL_DIR/{seg,rec}.mlmodel` when they are
absent. It exposes no model-list endpoint and returns no timing in the job
payload, so:

- The set of usable models is whatever the operator has baked into the Kraken
  image (`MODEL_DOI` at build, or a manual `kraken get` into `/models/`). Palimora
  only ever passes a **path string** that must already exist on the Kraken
  container.
- Timing is measured by Palimora in wall-clock around the Kraken call. It
  includes Kraken-side queue wait + segmentation + recognition; the phases
  cannot be separated.

Non-goals for E2 (explicitly out of scope):
- Any change to `kraken-ocr-service`.
- Proactive alerting / notifications of any kind — the admin panel is the only
  surface.
- Time-series charts. Aggregates (median, p95) are tabular.
- Per-phase (seg vs rec) timing — Kraken does not provide it.
- Uploading / managing model files from Palimora. The operator manages the
  Kraken image.
- Auto-switching models based on load or confidence. The admin chooses manually.

## 2. Model whitelist config + resolution (`app/ocr_models.py`, new)

### 2.1 Env (`app/config.py`)

```
KRAKEN_MODELS="défaut=/models/seg.mlmodel|/models/rec.mlmodel,rapide=/models/seg.mlmodel|/models/rec-fast.mlmodel"
KRAKEN_MODELS_DEFAULT="défaut"
```

- `KRAKEN_MODELS`: comma-separated entries, each `label=SEG_PATH|REC_PATH`.
  The parser splits entries on `,`, then splits each entry on the **first** `=`
  (so paths may contain `=`), then splits the value on `|`. `label` is the
  trimmed left side: it must be non-empty, contain no `,`, and be ≤ 40 chars —
  accented labels like `défaut` are fine. Both paths are required and non-empty
  per entry. A malformed entry is skipped with a `print()` warning at startup;
  it does not crash boot.
- `KRAKEN_MODELS_DEFAULT`: one of the labels. If unset or not a valid label,
  resolution falls through to the Kraken fallback (see 2.3).
- Both parsed once when `settings` is constructed. `settings.kraken_models` is the
  parsed `list[dict]`; `settings.kraken_models_default` is the raw string.

### 2.2 Module API

```python
def list_models() -> list[dict]:
    """[{key, seg_path, rec_path}, ...] from settings.kraken_models. [] if unset."""

def get_model(key: str) -> dict | None:
    """Whitelist lookup by key, or None."""

def resolve_active(db: Session) -> dict:
    """The model to submit with, as {key, seg_path, rec_path}.
    seg_path/rec_path are None only in the fallback case."""

def set_active(db: Session, key: str, admin: User) -> None:
    """Validate key in whitelist (else ValueError), upsert AppSetting['ocr_model'],
    write an admin_audit_log row."""

def active_source(db: Session) -> str:
    """'setting' | 'env_default' | 'fallback' — for the panel badge."""
```

### 2.3 Resolution order (`resolve_active`)

1. `AppSetting['ocr_model'].value` if present **and** still a valid whitelist key
   → that model. (source `setting`)
2. else `settings.kraken_models_default` if a valid whitelist key → that model.
   (source `env_default`)
3. else `{"key": "défaut", "seg_path": None, "rec_path": None}` — Palimora sends
   no model fields, Kraken uses `/models/{seg,rec}.mlmodel`. The recorded
   `ocr_model_key` is the literal string `"défaut"`. (source `fallback`)

An `AppSetting` row whose value is no longer in the whitelist (operator removed
the entry) is ignored, not an error — resolution proceeds to step 2.

### 2.4 `set_active`

- `get_model(key) is None` → `raise ValueError(f"Modèle inconnu: {key}")`.
- Upsert `AppSetting(key="ocr_model", value=key, updated_by=admin.id)`.
- Write `AdminAuditLog(actor_user_id=admin.id, target_user_id=None,
  event="ocr.model_change", method="PUT", path="/api/admin/ocr/model",
  status_code=200)`. The `admin_audit_log` table has no free-text column, so the
  old→new transition is not stored in the row; `AppSetting.updated_at` +
  `updated_by` plus the journal timestamp reconstruct it. Adding a `note` column
  is deferred (see §9) to keep the migration surface at zero new tables + the 4
  `pages` add-columns.

Empty whitelist (`KRAKEN_MODELS` unset) — `list_models()` is `[]`, `resolve_active`
always returns the fallback, `set_active` always raises `ValueError`, the panel
hides the selector and shows "Aucun modèle alternatif configuré".

## 3. Kraken submission + timing (`app/kraken.py`, `app/ocr_service.py`)

### 3.1 `app/kraken.py`

```python
def submit_ocr(client, file_bytes, ext, *, seg_model_path=None, rec_model_path=None) -> str:
```

The POST currently sends only `files={"file": (...)}`. Add
`data={k: v for k, v in (("seg_model_path", seg_model_path),
("rec_model_path", rec_model_path)) if v}` — httpx merges `data` and `files` into
one multipart body. When both are `None` the request is byte-identical to today.
Signature stays backward compatible (keyword-only, defaulted).

### 3.2 `app/ocr_service.py`

`enqueue_page_ocr(db, page)` — resolve the model here (web process, DB session in
hand):

```python
model = ocr_models.resolve_active(db)
payload = {
    "page_id": page.id,
    "kind": "image" | "pdf",
    "model_key": model["key"],
    "seg_model_path": model["seg_path"],   # may be None
    "rec_model_path": model["rec_path"],   # may be None
}
```

`run_ocr_job(payload)` passes `payload` into `_run_image` / `_run_pdf`
(signatures gain a `payload: dict` parameter).

Timing is stamped via a dedicated helper, **not** through the `db` session
passed into `_run_*`. `run_ocr_job` rolls back that session on any exception, so a
timing write on it would be lost exactly when a failure duration is most useful.

```python
def _stamp_timing(page_ids: list[str], *, submitted, finished, model_key, batch_size) -> None:
    """Own short-lived SessionLocal() (bound to app.db.engine at call time),
    UPDATE pages SET ocr_* WHERE id IN (...), commit, close. Never raises —
    same pattern as app/audit.py from E1."""
```

`_run_image(db, page, payload)`:
- `submitted = now()` immediately before `kraken.submit_ocr`.
- `kraken.submit_ocr(http, file_bytes, ext, seg_model_path=payload["seg_model_path"],
  rec_model_path=payload["rec_model_path"])`.
- `try/finally` around submit + `wait_for_result`: the `finally` calls
  `_stamp_timing([page.id], submitted=submitted, finished=now(),
  model_key=payload["model_key"], batch_size=1)`.
- then `_save_result(...)` as today.

`_run_pdf(db, page, document, payload)`:
- same `submitted` / `try/finally`; the `finally` calls `_stamp_timing` with the
  full sibling id list and `batch_size=len(siblings)`.
- then per-page `_save_result` + `_render_pdf_derivative` as today.

So on **success** the timing columns are written once (by `_stamp_timing`, before
`run_ocr_job`'s own `db.commit()`); on **failure** they are already committed by
`_stamp_timing` in the `finally` before the exception propagates to
`run_ocr_job`'s rollback + `_fail`. `_fail` does not touch the timing columns.
If `submit_ocr` itself throws before returning, `ocr_finished_at` is still
stamped (`now()` in the `finally`) and the short duration flags a fast failure.
(Rationale recorded so the plan does not "simplify" `_stamp_timing` back onto the
rolled-back session.)

`worker.py` `_reconcile_stale_jobs` re-enqueues via `enqueue_page_ocr` → model is
re-resolved at re-enqueue time. Acceptable (a stuck job picks up the currently
active model).

## 4. Data model (`app/models.py`)

### 4.1 `Page` — 4 new columns (via `_migrate()` `ADD COLUMN IF NOT EXISTS`)

```python
ocr_submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
ocr_finished_at:  Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
ocr_model_key:    Mapped[str] = mapped_column(String(40), default="")
ocr_batch_size:   Mapped[int] = mapped_column(Integer, default=1)
```

- Duration is derived (`ocr_finished_at - ocr_submitted_at`), never stored.
- `ocr_model_key == ""` marks a page OCR'd before E2 — the panel shows `—`.
- No backfill. Defaults are safe for existing rows.

### 4.2 New table `AppSetting` (auto-created by `create_all`, no `_migrate()` entry)

```python
class AppSetting(Base):
    __tablename__ = "app_setting"
    key:        Mapped[str] = mapped_column(String(64), primary_key=True)
    value:      Mapped[str] = mapped_column(String(255), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    updated_by: Mapped[str | None] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
```

One row for E2: `key="ocr_model"`. Generic key/value store for future runtime
settings. Queried directly, no relationship.

### 4.3 `_migrate()` additions (`app/main.py`)

Four `ALTER TABLE pages ADD COLUMN IF NOT EXISTS ...`, each in its own
transaction, matching the existing style. `app_setting` needs no entry —
`Base.metadata.create_all` creates new tables at startup (same as D1's
`schema_migrations` and E1's `admin_audit_log`).

## 5. Admin endpoints (`app/main.py`, `Depends(get_admin_user)`)

### 5.1 `GET /api/admin/ocr`

```json
{
  "models": [{"key": "défaut", "seg_path": "/models/seg.mlmodel", "rec_path": "/models/rec.mlmodel"}],
  "active_key": "rapide",
  "active_source": "setting",
  "recent": [
    {"page_id": "...", "document_id": "...", "document_title": "...",
     "processing_status": "done", "duration_s": 92.4, "per_page_s": 92.4,
     "model_key": "défaut", "avg_confidence": 0.71, "submitted_at": "2026-09-01T..."}
  ],
  "aggregates": [
    {"model_key": "défaut", "pages": 210, "median_s": 88.0, "p95_s": 140.0, "avg_confidence": 0.71},
    {"model_key": "rapide", "pages": 45, "median_s": 31.0, "p95_s": 52.0, "avg_confidence": 0.66}
  ]
}
```

- `models` — `ocr_models.list_models()`.
- `active_key` / `active_source` — `resolve_active(db)["key"]` /
  `active_source(db)`.
- `recent` — the 50 most recent `Page` rows with `ocr_submitted_at IS NOT NULL`,
  ordered `ocr_submitted_at DESC`. `duration_s = (ocr_finished_at -
  ocr_submitted_at).total_seconds()` or `null` if `ocr_finished_at` is null.
  `per_page_s = duration_s / max(ocr_batch_size, 1)` or `null`.
  `document_title` from a join on `documents`. `avg_confidence` = the page's
  latest `Transcription.confidence_score` (already computed at OCR;
  `_latest_transcription`-style lookup or a subquery), `null` if none.
- `aggregates` — `Page` rows with `ocr_submitted_at >= now() - 30 days` and
  `ocr_finished_at IS NOT NULL`, grouped by `ocr_model_key`. `pages` = count,
  `avg_confidence` = mean of the joined transcription scores.
  `median_s` / `p95_s` = duration percentiles:
  - **Postgres:** `percentile_cont(0.5)` / `percentile_cont(0.95)` within group
    over `EXTRACT(EPOCH FROM (ocr_finished_at - ocr_submitted_at))`.
  - **SQLite (tests):** `percentile_cont` is unavailable — detect via
    `db.bind.dialect.name == "sqlite"` and compute the percentiles in Python
    from the fetched per-group duration lists (nearest-rank).
  A row where `ocr_model_key == ""` is grouped under the key `""` and rendered
  as `—` by the frontend.

### 5.2 `PUT /api/admin/ocr/model` — body `{"key": "rapide"}`

- `ocr_models.set_active(db, key, admin)` — `ValueError` → `400` with the
  message; else `db.commit()`, return `{"active_key": key}`.
- The `admin_audit_log` row is written inside `set_active`.

Both endpoints are naturally 403 during impersonation (E1: `get_admin_user`
receives the non-admin target). No middleware change — `ai-suggest`-style money
concerns do not apply; a model change costs nothing.

## 6. Frontend (`web/`)

### 6.1 `web/src/api.ts`

- Add a `put` method to the `api` object: `put: <T>(path, body) => request<T>(path,
  { method: 'PUT', body })`.
- Types: `OcrModel {key, seg_path, rec_path}`, `OcrRecentRow`, `OcrAggregate`,
  `OcrPanelData {models, active_key, active_source, recent, aggregates}`.
- `api.get<OcrPanelData>('/api/admin/ocr')`, `api.put('/api/admin/ocr/model', {key})`.

### 6.2 `web/src/pages/Admin.tsx` — new "OCR / Modèles" section

Rendered below the "Journal d'impersonation" section. `refresh()` extends its
`Promise.all` with `api.get('/api/admin/ocr')`, new `ocr` state.

- **Active-model selector:** `<select>` of `models[].key`, current value
  `active_key`, a small badge showing `active_source`
  (`setting` / `env_default` / `fallback`). "Enregistrer" button → `api.put` →
  toast (reuse the existing `setToast` pattern) + `refresh()`. When `models` is
  empty: render the text "Aucun modèle alternatif configuré (env `KRAKEN_MODELS`)",
  no selector.
- **Aggregates table (30 j):** columns Modèle, Pages, Médiane (s), p95 (s),
  Confiance moy. One row per `model_key` (`""` → `—`).
- **Recent-pages table (50):** Date, Document (link to the doc), Statut, Durée,
  Durée/page, Modèle, Confiance. `—` where a value is null.

No chart library, no new route. Everything lives in `/admin`.

## 7. Testing

### 7.1 pytest

- `tests/test_ocr_models.py` — env parse (`label=SEG|REC`, comma-separated);
  malformed entry skipped, not fatal; `list_models() == []` when unset;
  `get_model` lookup; `resolve_active` priority (setting → env_default →
  fallback); `resolve_active` ignores an `AppSetting` value no longer in the
  whitelist; `set_active` rejects an unknown key (`ValueError`), writes
  `AppSetting`, writes an `admin_audit_log` `ocr.model_change` row;
  `active_source` returns the right label for each case.
- `tests/test_ocr_timing.py` — `enqueue_page_ocr` puts `model_key` /
  `seg_model_path` / `rec_model_path` in the RQ payload (monkeypatch the queue);
  with `kraken.submit_ocr` / `wait_for_result` monkeypatched, `run_ocr_job` on an
  image page writes `ocr_submitted_at` / `ocr_finished_at` / `ocr_model_key` /
  `ocr_batch_size == 1`; a PDF with 3 sibling pages writes the same timestamps to
  all 3 with `ocr_batch_size == 3`; an OCR failure still leaves
  `ocr_submitted_at` / `ocr_finished_at` set on the page and the credit refund
  intact.
- `tests/test_kraken_submit.py` — `submit_ocr` with `rec_model_path` set →
  the `rec_model_path` form field is in the request body (mock transport / respx);
  without it → the field is absent and the body matches the pre-E2 shape.
- `tests/test_admin_ocr.py` — `GET /api/admin/ocr` response shape (models,
  active_key, active_source, recent, aggregates); aggregates grouped by
  `ocr_model_key` over a 30-day window; median / p95 computed in Python under
  SQLite; `recent` capped at 50, newest first, only rows with
  `ocr_submitted_at`; `PUT /api/admin/ocr/model` valid → 200 + audit row,
  invalid key → 400; non-admin → 403.

### 7.2 vitest

- `api.put` issues a `PUT` with a JSON body.
- `Admin` OCR section: selector populated from a mocked `models`, "Enregistrer"
  calls `api.put` with the chosen key; empty `models` → "aucun modèle configuré"
  message and no selector; aggregates + recent tables render from the mock;
  `—` shown for null durations and the `""` model key.

### 7.3 Files touched

`app/config.py`, `app/ocr_models.py` (new), `app/kraken.py`, `app/ocr_service.py`,
`app/models.py`, `app/main.py`, `web/src/api.ts`, `web/src/pages/Admin.tsx`,
+ the test files above.

## 8. Rollout

1. Operator bakes a second model into the Kraken image (a second `MODEL_DOI`
   downloaded to e.g. `/models/rec-fast.mlmodel`, or a manual `kraken get` layer),
   redeploys `kraken-ocr-service`. **Prerequisite** — until a second model file
   exists on the Kraken container, only the `"défaut"` entry is meaningful.
2. Set `KRAKEN_MODELS` + `KRAKEN_MODELS_DEFAULT` in Coolify on Palimora Server
   **and** Worker (the Worker resolves nothing now — E2 resolves at enqueue in
   the Server process — but keep them in sync in case that changes). Redeploy.
3. `_migrate()` adds the 4 `pages` columns; `create_all` adds `app_setting`.
4. Verify: `/admin` OCR section shows the selector with both labels, source badge
   `env_default`. OCR a page → a `recent` row appears with a duration and
   `model_key`.
5. Switch the active model in the panel, OCR another page, confirm the new
   `model_key` and compare durations in the aggregates table after a handful of
   pages.

## 9. Open questions / risks

- **Whitelist paths are unvalidated against the Kraken container.** A label
  pointing at a path that does not exist on the Kraken box makes every OCR with
  that model fail (Kraken raises, Palimora refunds + flags the page). Mitigation:
  the whitelist is operator-curated (approach A was chosen precisely for this),
  and a failing model shows up immediately in the panel as errored pages with a
  duration. No pre-flight check is built.
- **Timing includes Kraken-side queue wait.** If the Kraken worker is busy, a
  page's measured duration is inflated by unrelated load. Acceptable for a
  relative model A/B; noted so the numbers are not read as pure inference time.
- **PDF timing is per-job, attributed per-page via `ocr_batch_size`.** A 10-page
  PDF that took 300 s shows `per_page_s = 30`. This is an approximation (page 1
  and page 10 are not necessarily equal) but adequate for model comparison.
- **The audit row for a model change records the route, not the old→new
  transition** (the `admin_audit_log` table has no free-text column). `AppSetting.
  updated_at` + `updated_by` plus the journal timestamp reconstruct it. Adding a
  `note` column is a possible E2.1; deliberately deferred to keep the migration
  at zero new-table + 4 add-column.
- **`KRAKEN_MODELS` label charset.** Accented labels (`défaut`) are allowed;
  the parser splits on `,` and the first `=` only, so paths may contain `=` but
  not `,`. A Windows-style path is irrelevant (Kraken is Linux). Documented so
  the plan's parser test covers the `défaut` case.
