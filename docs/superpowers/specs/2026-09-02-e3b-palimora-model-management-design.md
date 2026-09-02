# E3-B — Palimora admin model management (proxy + UI) — Design

Date: 2026-09-02
Status: approved (design), pending spec review
Target repo: **`loopion/palimora-server`**
Phase: E, sub-project 3, part B of 2. **Depends on E3-A** (`kraken-ocr-service`
model-management endpoints + shared `/models` volume) being merged and deployed.

## 1. Goal

Replace E2's static `KRAKEN_MODELS` env whitelist with a live model list proxied
from Kraken (E3-A), and give the admin, in the `/admin` "OCR / Modèles" panel:
browse the HTRMoPo catalog, pull a recognition model, delete a downloaded one,
switch the active model. The E2 timing panel (median/p95/errors aggregates,
recent-pages table) is unchanged.

**Scope decisions (from brainstorming, operator-approved):**
- Recognition-only. `resolve_active` always returns `seg_path=None` (Kraken uses
  its baked `/models/seg.mlmodel`).
- E2's `KRAKEN_MODELS` / `KRAKEN_MODELS_DEFAULT` env vars and `_parse_kraken_models`
  are **removed**. The "whitelist" is now whatever `GET {kraken}/models` returns.
- `AppSetting['ocr_model']` (E2) is kept and now stores a model **slug**
  (`rec`, `rec-21788409`, …) instead of an env label.
- Palimora never touches the Kraken filesystem — every model operation is a proxied
  call to an E3-A endpoint, with Palimora holding the guard rails (active model
  can't be deleted; admin-gated; audit-logged).

**Non-goals:**
- Any `kraken-ocr-service` change (that is E3-A).
- Seg switching.
- Showing training metrics / accuracy benchmarks from HTRMoPo model cards beyond
  the `summary` / `keywords` text.
- A background poller that auto-refreshes the catalog — refresh is a button.

## 2. Config (`app/config.py`)

- **Remove** `kraken_models`, `kraken_models_default`, `_parse_kraken_models`.
- **Keep** `kraken_api_url`, `kraken_api_key`, `kraken_timeout`.
- The E3-A endpoints live under the same `kraken_api_url` base
  (`http://hjzovkwfthcaxqlfyzq5znex:8000`), authenticated with `kraken_api_key`
  via the `X-API-Key` header (same as `app/kraken.py` today).

Coolify: after deploy, **delete** `KRAKEN_MODELS` and `KRAKEN_MODELS_DEFAULT` from
Palimora Server + Worker (they were never actually set in prod — E2 shipped with
them unset — so this is a no-op in practice, documented for completeness).

## 3. Kraken client (`app/kraken.py`)

Add a thin helper next to `submit_ocr` / `wait_for_result`:

```python
def call(method: str, path: str, *, json_body: dict | None = None,
         params: dict | None = None, timeout: float = 30.0) -> httpx.Response:
    """One call to the Kraken service with the API-key header. Raises KrakenError
    on transport failure or a 5xx; returns the Response otherwise (callers inspect
    4xx themselves)."""
```

Used by `app/ocr_models.py` and the new admin routes. A `httpx.ConnectError` /
timeout / 5xx → `KrakenError`, which the admin routes turn into `HTTPException(502,
"Service Kraken injoignable")`.

## 4. Model resolution rewrite (`app/ocr_models.py`)

The module is rewritten. `AppSetting` model unchanged (E2). `AdminAuditLog` unchanged.

```python
_CACHE: dict = {"models": None, "at": 0.0}   # 60s process cache
_TTL = 60
_SETTING_KEY = "ocr_model"

def list_models(force: bool = False) -> list[dict]:
    """GET {kraken}/models, cached 60s. Each entry:
    {slug, protected, doi, summary, script, keywords, license, size_bytes}.
    On Kraken error: raise KrakenError (callers decide fallback vs 502)."""

def get_model(slug: str) -> dict | None:
    return next((m for m in _safe_list() if m["slug"] == slug), None)

def _safe_list() -> list[dict]:
    """list_models() but returns [] instead of raising — for resolve_active."""

def resolve_active(db: Session) -> dict:
    """{key: slug, rec_path: str|None, seg_path: None}.
    1. AppSetting['ocr_model'] slug, if still present in _safe_list() ->
       {key: slug, rec_path: f'/models/{slug}.mlmodel', seg_path: None}
    2. else -> {key: 'rec', rec_path: None, seg_path: None}  (Kraken baked default)"""

def active_slug(db: Session) -> str:
    """The stored slug if set & valid, else 'rec'. For the delete guard."""

def active_source(db: Session) -> str:
    """'setting' | 'fallback'"""

def set_active(db: Session, slug: str, admin) -> None:
    """slug must be in list_models() (raise ValueError else). Upsert AppSetting,
    add AdminAuditLog(event='ocr.model_change', ...). Does not commit.
    Invalidate _CACHE."""
```

- `resolve_active` uses `_safe_list()` — a Kraken outage must not break OCR
  enqueue; it degrades to the baked `rec` model and logs a warning.
- `rec_path` is `f"/models/{slug}.mlmodel"` — the path **on the Kraken container**,
  which E3-A guarantees exists for any slug `GET /models` returned.
- 60 s cache: short, because a pull/delete/switch changes the list. `set_active`
  and the delete route bust it explicitly; everything else rides the TTL.

**`app/ocr_service.py`:** `resolve_active` now always returns `seg_path=None`, so
`_run_image` / `_run_pdf` pass `seg_model_path=None` unconditionally. `submit_ocr`
signature unchanged. `ocr_model_key` stamped on the page = the slug (E2 behaviour).
The E2 payload keys (`model_key`, `seg_model_path`, `rec_model_path`) are unchanged
in shape; `seg_model_path` is just always `None` now.

## 5. Admin endpoints (`app/main.py`)

All `Depends(get_admin_user)` → 403 during E1 impersonation (no middleware change).
A private helper `_kraken_proxy(method, path, **kw)` wraps `kraken.call`, maps
`KrakenError` → `HTTPException(502, "Service Kraken injoignable")`, and relays the
Kraken response status + JSON for 4xx (so a 409 "déjà présent" reaches the SPA).

### 5.1 `GET /api/admin/ocr` (E2, extended)

Add to the existing response:
- `local_models` = `ocr_models.list_models()` (the E2 `models` key is renamed to
  this; the old env-whitelist meaning is gone).
- `active_slug` = `ocr_models.active_slug(db)`.

Keep `active_key`, `active_source`, `recent`, `aggregates` exactly as E2 (post
final-review fixes: done-only timing, `errors` count, isolated fetch).

If `list_models()` raises `KrakenError`: return the panel with `local_models: [],
kraken_error: "Service Kraken injoignable"` and HTTP 200 (the timing panel from the
DB still works; the SPA shows a banner). Do not 502 the whole panel.

### 5.2 `GET /api/admin/ocr/catalog?script=Latn&all=false`

Proxy `GET {kraken}/repo` with the same query params. Returns
`{cached_at, stale, refreshing, models: [...]}` verbatim from Kraken.

### 5.3 `POST /api/admin/ocr/catalog/refresh`

Proxy `POST {kraken}/repo/refresh` → `{job_id, status}`.

### 5.4 `POST /api/admin/ocr/models` body `{"doi": "10.5281/zenodo.XXXX"}`

Proxy `POST {kraken}/models`. 202 `{job_id, slug, status}`; relay Kraken's 400 /
409. Write `AdminAuditLog(event="ocr.model_pull", path="/api/admin/ocr/models",
status_code=202)` on a 202.

### 5.5 `GET /api/admin/ocr/models/jobs/{job_id}`

Proxy `GET {kraken}/models/jobs/{job_id}` → the job file JSON, or 404.

### 5.6 `DELETE /api/admin/ocr/models/{slug}`

1. **Guard**: `slug == ocr_models.active_slug(db)` → `409 {"detail": "Modèle actif,
   impossible de supprimer. Change le modèle actif d'abord."}`.
2. Proxy `DELETE {kraken}/models/{slug}` (Kraken also refuses `seg` / `rec` → relay
   its 409).
3. On success: `ocr_models` cache bust, `AdminAuditLog(event="ocr.model_delete",
   path=f"/api/admin/ocr/models/{slug}", status_code=200)`. Return `{"deleted": slug}`.

### 5.7 `PUT /api/admin/ocr/model` body `{"key": slug}` (E2, kept)

`ocr_models.set_active(db, key, admin)` — `ValueError` → 400; else `db.commit()`,
return `{"active_key": slug}`. `set_active` validates `slug ∈ list_models()`.
Audit row `event="ocr.model_change"` (unchanged from E2).

## 6. Frontend (`web/`)

### 6.1 `web/src/api.ts`

New types:
```ts
export interface LocalModel {
  slug: string; protected: boolean; doi: string | null
  summary: string; script: string | null; keywords: string[]
  license: string | null; size_bytes: number
}
export interface CatalogModel {
  doi: string; summary: string; script: string | null
  keywords: string[]; license: string | null; already_local: boolean
}
export interface CatalogResponse {
  cached_at: string | null; stale: boolean; refreshing: boolean; models: CatalogModel[]
}
export interface ModelJob {
  kind: 'pull' | 'refresh'; job_id: string; status: 'started' | 'finished' | 'failed'
  doi?: string; slug?: string; error: string | null; progress?: number
}
```
Extend `OcrPanelData` (E2): `models` → `local_models: LocalModel[]`, add
`active_slug: string`, add `kraken_error?: string | null`. `api.get`/`post`/`delete`/
`put` already exist.

### 6.2 `web/src/pages/Admin.tsx` — "OCR / Modèles" reworked into 3 blocks

`refresh()` keeps the isolated OCR fetch (E2 final-review fix:
`.catch(() => setOcr(null))`). When `ocr.kraken_error` is set, render a red banner
"Service Kraken injoignable — gestion des modèles indisponible" above the blocks
and still render the timing aggregates (they come from the DB).

**Block 1 — Modèle actif & performance**
- `<select>` of `ocr.local_models` (option label `slug` + short `summary`),
  value = the E2 `effectiveKey` guard against `active_key ∉ local_models`
  (placeholder `— rec (défaut Kraken) —`), "Activer" button → `PUT
  /api/admin/ocr/model` → toast + `refresh()`. `savingModel` in-flight guard (E2).
  Source badge (`active_source`).
- The E2 aggregates table (Modèle / Pages / Erreurs / Médiane / p95 / Confiance) —
  unchanged.

**Block 2 — Modèles téléchargés**
- Table: Slug, DOI, Script, Taille (human-readable), [Supprimer].
- "Supprimer" disabled when `m.protected` or `m.slug === ocr.active_slug`.
- Click → a small in-component confirm modal (reuse the E1 `ImpersonationBanner`-style
  inline pattern or a minimal `<dialog>`; NOT `window.confirm`) → `DELETE
  /api/admin/ocr/models/{slug}` → toast + `refresh()`. Relayed 409 → error toast
  with the detail.

**Block 3 — Catalogue HTRMoPo** (collapsible, closed by default)
- On first expand: `GET /api/admin/ocr/catalog?script=<current>`.
- Header: script `<select>` (Latn default; Grek, Arab, Hebr, Cyrl, …, "tous" →
  `all=true`), "Rafraîchir" button → `POST /api/admin/ocr/catalog/refresh` → poll
  `GET /api/admin/ocr/models/jobs/{job_id}` every 3 s until `finished`/`failed` →
  re-fetch catalog + toast. Show `cached_at` (relative) + an "obsolète" chip when
  `stale`, a spinner when `refreshing`.
- List: per model — `summary`, `script`, `keywords` (chips), `license`, `doi`
  (monospace). "Télécharger" button → `POST /api/admin/ocr/models {doi}` → poll the
  returned `job_id` every 3 s, show a progress bar from `job.progress`, on
  `finished` → `refresh()` + toast, on `failed` → error toast with `job.error`.
  Button disabled when `m.already_local`.

No chart library, no new route, no new npm dep. All three blocks live in `/admin`.

## 7. Testing

### 7.1 pytest (`tests/`)

- `tests/test_ocr_models_e3.py` — `list_models` hits `GET {kraken}/models` (respx
  / monkeypatched `kraken.call`), 60 s cache, `force=True` bypasses; `list_models`
  raises `KrakenError` on a Kraken 502; `resolve_active` returns the stored slug's
  `/models/<slug>.mlmodel` when present, falls back to `{key:"rec", rec_path:None}`
  when the slug vanished or Kraken is down; `active_slug` mirrors it; `set_active`
  rejects an unknown slug, writes `AppSetting` + audit, busts the cache.
- `tests/test_admin_ocr_e3.py` — `GET /api/admin/ocr` includes `local_models` +
  `active_slug`; when `kraken.call` raises, the panel still returns 200 with
  `kraken_error` set and the DB aggregates present. `GET /catalog` /
  `POST /catalog/refresh` / `POST /models` / `GET /models/jobs/{id}` proxy through
  (assert the outgoing Kraken request + relayed status/body, incl. a relayed 409).
  `DELETE /api/admin/ocr/models/{slug}`: 409 when slug is active; proxies + audits
  + busts cache otherwise; relays Kraken's 409 for `seg`/`rec`. `PUT` (E2) still
  works against the live list. Every route 403 for non-admin, 403 during
  impersonation.
- `tests/test_ocr_timing.py` (E2) — update the monkeypatched `resolve_active` /
  whitelist fixtures to the new shape (`seg_path` always None, slug-based).
- Delete `tests/test_ocr_config.py` (E2 `_parse_kraken_models` — gone). Delete or
  rewrite `tests/test_admin_ocr_put.py` invalid-key path against the live list.

### 7.2 vitest

- `Admin.ocr.test.tsx` (E2) updated: `local_models` shape, `active_slug`, the
  3-block layout. New cases: delete disabled for `protected` / active slug; delete
  confirm modal → `DELETE` fired; catalog block lazy-loads on expand; "Télécharger"
  polls the job and calls `refresh()` on `finished`; `kraken_error` renders the
  banner and still shows the aggregates table.
- `api.ocr.test.ts` (E2) — new types compile; a `DELETE` / catalog `GET` issue the
  right requests.

### 7.3 Files touched

`app/config.py`, `app/kraken.py`, `app/ocr_models.py` (rewrite), `app/ocr_service.py`
(minor), `app/main.py` (endpoints), `web/src/api.ts`, `web/src/pages/Admin.tsx`,
+ tests above (some E2 test files updated/removed).

## 8. Rollout

**Strict order — E3-A must be fully deployed and verified first (its §8).**

1. Merge + push palimora-server (this spec's work). Coolify auto-deploys Server +
   Worker. `_migrate()` has nothing new (no schema change — `AppSetting` +
   `pages.ocr_*` already exist from E2).
2. Roll Server before Worker is **not** required here (no migration), but harmless
   to keep the habit.
3. Verify `/admin` "OCR / Modèles":
   - Block 1: `local_models` shows `rec` (+ anything pulled during E3-A testing).
   - Block 3: expand → catalog loads; "Rafraîchir" completes.
   - Pull a Latin recognition model → progress → appears in Block 2.
   - Activate it → `active_source: setting`, OCR a page → the aggregates row for
     that slug appears with a real duration; compare against `rec`.
   - Try to delete the active model → 409; switch back to `rec`, delete → gone.
4. (Optional) delete `KRAKEN_MODELS` / `KRAKEN_MODELS_DEFAULT` from Palimora Coolify
   env if they were ever added (they were not).

## 9. Open questions / risks

- **Ordering dependency.** E3-B's `resolve_active` calls `/models` on Kraken; if
  E3-B ships before E3-A, that endpoint 404s and `_safe_list()` returns `[]` → every
  OCR job uses the baked `rec` (unchanged behaviour, no breakage) but the admin
  panel is non-functional. The rollout section makes the order explicit; the code
  degrades safely regardless.
- **60 s model-list cache vs. a just-finished pull.** After a pull completes the
  SPA calls `refresh()` which re-hits `GET /api/admin/ocr` → `list_models()` may
  serve a ≤60 s stale list missing the new model. Acceptable (the model appears
  within a minute); `set_active`/delete bust the cache, pull does not — a follow-up
  could pass `force=true` on the post-pull refresh.
- **`resolve_active` does a network call (cached) on the OCR enqueue path.** E2
  resolved from env (free); E3-B resolves from Kraken. The 60 s cache keeps this to
  ~1 call/minute under load, and `_safe_list()` swallows failures. A Kraken hiccup
  at enqueue time silently uses the baked model — the page's `ocr_model_key`
  records `"rec"`, so the panel shows the truth.
- **Catalog `script` values.** HTRMoPo records use ISO 15924 codes (`Latn`, `Grek`,
  …) but not all records set `script`. The Kraken `GET /repo` filter treats a
  missing `script` as non-matching unless `all=true`; the SPA's default `Latn` view
  therefore hides script-less records. A "tous" toggle is the escape hatch.
- **E2 was merged ~2 h before this design.** E3-B deletes E2's `KRAKEN_MODELS` env
  parsing and reshapes `GET /api/admin/ocr`. Since E2's env was never set in prod,
  no production behaviour changes on the E3-B deploy until a model is pulled and
  activated. The E2 timing panel is carried forward intact.
- **Audit rows for pull/delete** use new `event` values (`ocr.model_pull`,
  `ocr.model_delete`) on the existing `admin_audit_log` table — no schema change,
  `event` is `String(20)` and both fit.
