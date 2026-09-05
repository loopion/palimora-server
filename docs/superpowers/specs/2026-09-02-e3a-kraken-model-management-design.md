# E3-A — Kraken model management endpoints + shared `/models` volume — Design

Date: 2026-09-02
Status: approved (design), pending spec review
Target repo: **`loopion/kraken-ocr-service`** (`~/Documents/antigravity/kraken-ocr-service`), NOT palimora-server.
Phase: E, sub-project 3, part A of 2 (E3-B = palimora-server admin UI + proxy, separate spec, depends on this being deployed).

## 1. Goal

Let an operator, from the Palimora admin UI (built in E3-B), browse the HTRMoPo
model catalog, download ("pull") a recognition model into the running Kraken
service, delete a downloaded model, and switch which recognition model OCR uses —
without redeploying the Kraken image and without editing env vars.

This part (E3-A) is the Kraken-side foundation: `/models` becomes a shared
persistent volume seeded from the baked defaults, and `kraken-ocr-service` grows
six authenticated endpoints for local-model listing, catalog browsing, pulling,
pull-status, deletion, and catalog refresh.

**Scope decisions (from brainstorming, operator-approved):**
- Recognition models only. Segmentation stays the baked default (`/models/seg.mlmodel`);
  no seg switching. The catalog is always filtered to `model_type == "recognition"`.
- Model management lives in `kraken-ocr-service` (it already imports `htrmopo`, owns
  `/models`, and is already an API). Palimora proxies to it.
- Pulls and catalog refreshes are long (50–200 MB downloads / full Zenodo OAI walk).
  They run as **background threads in the Kraken API container**, tracked by job
  files in the shared volume — **not** on the RQ queue, so OCR throughput is never
  blocked by a model download.
- The baked defaults `seg.mlmodel` / `rec.mlmodel` are protected from deletion.

**Non-goals:**
- Uploading a custom `.mlmodel` from the browser (only pull-by-DOI).
- Training / fine-tuning.
- Any Palimora-side change (that is E3-B).
- Seg-model switching, multi-seg configs.
- Per-model quota / disk-usage enforcement beyond a soft check.
- v1 HTRMoPo schema model cards rendering — v0 fields (`summary`, `script`,
  `keywords`, `license`) are enough; v1 records expose the same via `htrmopo`.

## 2. Shared `/models` volume + seeding

### 2.1 Coolify

- One **persistent storage** with a fixed host path (e.g. `/data/kraken-models`),
  mounted at `/models` on **both** the Kraken API app (`hjzovkwfthcaxqlfyzq5znex`)
  and the Kraken Worker app (`ifbxnsa0l46ph73bhr4dnfu0`). Same host path on both so
  a pull from the API container is immediately visible to the Worker that runs OCR.
- The current build args stay: `MODEL_SEG_DOI=10.5281/zenodo.14602569`,
  `MODEL_REC_DOI=10.5281/zenodo.21788409` (build-time, both apps).

### 2.2 `Dockerfile.bake`

- The three `RUN if [ -n "$MODEL_*_DOI" ]` bake steps copy into **`/models-dist/`**
  instead of `/models/` (new directory). `MODEL_SEG_DOI` → `/models-dist/seg.mlmodel`,
  `MODEL_REC_DOI` → `/models-dist/rec.mlmodel`, legacy `MODEL_DOI` → `/models-dist/<name>`.
- `ENV MODEL_DIR=/models` unchanged.
- New `entrypoint.sh` (used by both roles), replacing the current inline `CMD`
  role-switch — the entrypoint seeds then execs the role command:

```sh
#!/bin/sh
set -e
mkdir -p /models
if [ -z "$(ls -A /models 2>/dev/null)" ] && [ -d /models-dist ]; then
  cp -a /models-dist/. /models/
  echo "seeded /models from baked defaults: $(ls /models)"
fi
if [ "$KRAKEN_ROLE" = "worker" ]; then
  exec python worker.py
else
  exec uvicorn app:app --host 0.0.0.0 --port 8000
fi
```

`ENTRYPOINT ["/entrypoint.sh"]`, no `CMD`.

- First deploy after the volume is attached: `/models` is empty → seeded with
  `seg.mlmodel` + `rec.mlmodel`. Later deploys: volume persists, pulled models and
  the catalog cache survive.

### 2.3 Local file layout in `/models`

| File | Meaning | Deletable |
|------|---------|-----------|
| `seg.mlmodel` | baked default segmentation | no (protected) |
| `rec.mlmodel` | baked default recognition | no (protected) |
| `rec-<zenodo_id>.mlmodel` | a pulled recognition model | yes |
| `rec-<zenodo_id>.json` | sidecar metadata for the pulled model | (with the model) |
| `.catalog.json` | cached HTRMoPo listing (§4) | internal |
| `.jobs/<job_id>.json` | pull / refresh job state (§5) | internal |

`<zenodo_id>` = `htrmopo.util._doi_to_zenodo_id(doi)` (the numeric record id).
Slug = the filename stem (`rec`, `rec-21788409`, …).

Sidecar JSON:
```json
{"doi": "10.5281/zenodo.21788409", "summary": "...", "script": "Latn",
 "keywords": ["french", "18th century"], "license": "...", "size_bytes": 104857600,
 "pulled_at": "2026-09-02T..."}
```

## 3. Endpoints (`app.py`)

All behind the existing `Depends(verify_key)` (`X-API-Key` header, `API_KEYS` env).
New imports at module level: `from pathlib import Path`, `import json`, `import threading`,
`import time`, and inside handlers/threads `import htrmopo` + `from htrmopo.util import _doi_to_zenodo_id`.

`MODELS_DIR = Path(os.getenv("MODEL_DIR", "/models"))`. `PROTECTED = {"seg", "rec"}`.

### 3.1 `GET /models` → locally present recognition models

Scan `MODELS_DIR.glob("rec*.mlmodel")` (excludes `seg.mlmodel`). For each, read the
`<stem>.json` sidecar if present.

```json
{"models": [
  {"slug": "rec", "protected": true, "doi": null, "summary": "modèle recognition baké par défaut",
   "script": null, "keywords": [], "license": null, "size_bytes": 104857600},
  {"slug": "rec-21788409", "protected": false, "doi": "10.5281/zenodo.21788409",
   "summary": "...", "script": "Latn", "keywords": [...], "license": "...", "size_bytes": ...}
]}
```

`rec` always appears first, `protected: true`, with a static summary and
`size_bytes` from `stat()`. Pulled models sorted by `slug`.

### 3.2 `GET /repo?script=Latn&all=false` → HTRMoPo catalog (from cache)

- Reads `MODELS_DIR / ".catalog.json"` (written by the refresh job, §5.2).
- If missing OR `cached_at` older than 24 h: spawn a `refresh_catalog` background
  thread (if not already running — guard on a job file), and serve the stale cache
  if one exists, else `{"cached_at": null, "stale": true, "refreshing": true, "models": []}`.
- Filter the cached `models` to those whose `script` matches `script` (case-insensitive)
  unless `all=true`. `model_type == "recognition"` is already enforced at write time.

```json
{"cached_at": "2026-09-02T09:00:00Z", "stale": false, "refreshing": false,
 "models": [{"doi": "10.5281/zenodo.XXXX", "summary": "...", "script": "Latn",
             "keywords": [...], "license": "...", "already_local": true}]}
```

`already_local` = the DOI matches a sidecar in `/models`.

### 3.3 `POST /models` body `{"doi": "10.5281/zenodo.XXXX"}` → start a pull

- Validate: `doi` matches `^10\.5281/zenodo\.\d+$` (else 400). `_doi_to_zenodo_id`
  returns non-None (else 400).
- If `rec-<zid>.mlmodel` already exists → 409 `{"detail": "Modèle déjà présent", "slug": "rec-<zid>"}`.
- If a pull job for this `zid` is already `queued`/`started` → 409.
- Create `/models/.jobs/<job_id>.json` = `{"kind": "pull", "job_id": ..., "doi": ..., "slug": "rec-<zid>", "status": "started", "error": null, "progress": 0, "started_at": <iso>, "updated_at": <iso>}` where `job_id = uuid4().hex`.
- Spawn `threading.Thread(target=_pull_model_job, args=(job_id, doi), daemon=True)`.
- Return `{"job_id": job_id, "slug": "rec-<zid>", "status": "started"}` (202).

### 3.4 `GET /models/jobs/{job_id}` → pull / refresh job status

- Read `/models/.jobs/<job_id>.json` → 404 if missing.
- A job in `status: "started"` whose `updated_at` is older than 30 min is reported
  as `status: "failed", error: "job interrompu (timeout)"` (the container likely
  restarted mid-download). The file is left as-is; a retry POST creates a new job.
- Response: the job file contents.

### 3.5 `DELETE /models/{slug}` → remove a pulled model

- `slug` in `PROTECTED` → 409 `{"detail": "Modèle protégé"}`.
- `rec-<...>.mlmodel` not found → 404.
- Delete the `.mlmodel` + its `.json` sidecar. Return `{"deleted": slug}` (200).
- Kraken does **not** know which model Palimora has marked active — that guard is
  Palimora's (E3-B `DELETE` checks `active_slug` before proxying here). If Palimora's
  guard is bypassed and the active model is deleted, `resolve_active` on the Palimora
  side falls back to `rec` (baked) on the next job — no crash, just a silent revert.

### 3.6 `POST /repo/refresh` → force a catalog refresh

- If a `refresh_catalog` job is already `started` → return its `job_id` (idempotent).
- Else create `/models/.jobs/<job_id>.json` `{"kind": "refresh", "status": "started", ...}`,
  spawn `_refresh_catalog_job(job_id)`, return `{"job_id": job_id, "status": "started"}` (202).

## 4. Catalog cache

`.catalog.json`:
```json
{"cached_at": "2026-09-02T09:00:00Z", "count": 47,
 "models": [{"doi": "...", "summary": "...", "script": "Latn", "keywords": [...], "license": "..."}]}
```

- Written only by `_refresh_catalog_job` (§5.2), atomically (`.catalog.json.tmp` +
  `os.replace`).
- 24 h TTL for the auto-refresh trigger in `GET /repo`. No hard expiry — a stale
  cache is always served rather than blocking.
- Lives in the shared volume, so it survives redeploys and is written once for both
  containers (only the API container runs the refresh thread).

## 5. Background jobs (`app.py` module-level functions, run in threads)

Job files live in `MODELS_DIR / ".jobs"`. Helper `_write_job(job_id, **patch)` merges
into the file with `updated_at` bumped, atomic write. Helper `_read_job(job_id)`.

### 5.1 `_pull_model_job(job_id, doi)`

1. `_write_job(job_id, status="started", progress=0)`.
2. `tmp = Path(tempfile.mkdtemp(prefix="pull-"))`.
3. `htrmopo.get_model(doi, tmp, callback=lambda total, advance: _write_job(job_id, progress=<pct>))`
   — `get_model` has its own on-disk cache, so a re-pull of a cached DOI is fast.
4. Find the model file in `tmp`: prefer `*.mlmodel`, else `*.safetensors`. None → raise.
5. **Validate it is a loadable recognition model**: `from kraken.tasks import
   RecognitionTaskModel; RecognitionTaskModel.load_model(str(model_file))` — raises
   if it is a segmentation model or corrupt. (This is the same loader `tasks.py`
   uses for OCR, so "loads here" == "will load in the OCR worker".)
6. `zid = _doi_to_zenodo_id(doi)`; `shutil.copy(model_file, MODELS_DIR / f"rec-{zid}.mlmodel")`.
7. Fetch metadata: `rec = htrmopo.get_description(doi)`; write the sidecar
   `rec-{zid}.json` with `summary`/`script`/`keywords`/`license` from the record,
   `size_bytes` from the copied file, `pulled_at`.
8. `shutil.rmtree(tmp, ignore_errors=True)`.
9. `_write_job(job_id, status="finished", slug=f"rec-{zid}", progress=100)`.

Any exception → `_write_job(job_id, status="failed", error=str(exc)[:500])`, cleanup
`tmp`, do **not** leave a partial `.mlmodel` in `/models` (copy is the last step, and
if step 6 half-wrote, unlink it in the `except`).

### 5.2 `_refresh_catalog_job(job_id)`

1. `_write_job(job_id, status="started")`.
2. `listing = htrmopo.get_listing()` — the full OAI-PMH walk.
3. Flatten: for each concept DOI, take the newest version record; keep those with
   `model_type == "recognition"` (v0 `model_type`, or v1 equivalent — `htrmopo`
   records expose `.model_type`). Build `{doi, summary, script, keywords, license}`.
4. Atomic write `.catalog.json` with `cached_at = now`, `count`.
5. `_write_job(job_id, status="finished", count=N)`.

Exception → `status="failed", error=...`; the old cache is untouched.

**Concurrency:** only one refresh thread at a time — `POST /repo/refresh` and the
auto-trigger both check for a live `refresh` job file first. Pull threads are
per-DOI; the §3.3 pre-check prevents duplicates.

## 6. Requirements / deps

`htrmopo` is already installed (used in `Dockerfile.bake`). `kraken` is installed.
No new pip deps. `threading`, `json`, `pathlib`, `tempfile`, `shutil`, `uuid` are
stdlib. Confirm `htrmopo` exposes `get_model` / `get_description` / `get_listing`
and `htrmopo.util._doi_to_zenodo_id` at the installed version (the `Dockerfile.bake`
already calls `from htrmopo import get_model`).

## 7. Testing (`kraken-ocr-service`)

The repo has no test suite today. Add a minimal `pytest` setup (`requirements-dev.txt`:
`pytest`, `httpx`), `tests/conftest.py` (a `TestClient(app)` fixture with `MODEL_DIR`
pointed at a `tmp_path`, `API_KEYS` set, and `htrmopo` monkeypatched).

- `tests/test_models_local.py` — `GET /models` on an empty dir returns just the
  synthetic `rec` entry when `rec.mlmodel` exists; a `rec-123.mlmodel` + sidecar is
  listed with its metadata; `seg.mlmodel` is never listed.
- `tests/test_pull.py` — `POST /models` with a bad DOI → 400; with an
  already-present DOI → 409; with a valid new DOI → 202 + a job file created;
  `_pull_model_job` with `htrmopo.get_model` monkeypatched to drop a fake `.mlmodel`
  and `RecognitionTaskModel.load_model` monkeypatched to succeed → the model + sidecar
  land in `MODEL_DIR`, job file `finished`; loader raises → job `failed`, no
  `.mlmodel` left behind.
- `tests/test_delete.py` — `DELETE /models/seg` / `DELETE /models/rec` → 409;
  `DELETE /models/rec-123` removes both files → 200; missing → 404.
- `tests/test_catalog.py` — `GET /repo` with no cache → `stale: true`, spawns a
  refresh (monkeypatched `get_listing`); with a fresh cache file → filtered by
  `script`; `all=true` returns everything; `POST /repo/refresh` writes `.catalog.json`
  with only `recognition` records.
- `tests/test_jobs.py` — `GET /models/jobs/<id>` 404 on unknown; a `started` job
  older than 30 min reports `failed`.
- Auth: every new route returns 403 without the `X-API-Key` header.

## 8. Rollout (E3-A only — E3-B follows once this is live)

1. Create the Coolify persistent storage, attach `/models` to Kraken API + Worker.
2. Merge + push `kraken-ocr-service` (`Dockerfile.bake` + `app.py` + `entrypoint.sh`
   + tests). Coolify rebuilds both apps.
3. First boot: entrypoint seeds `/models` from `/models-dist`. Verify
   `GET https://kraken-ocr.pays.fr.eu.org/models` (with the API key) returns the
   `rec` entry, and an OCR job still succeeds (uses `/models/rec.mlmodel`).
4. `POST /repo/refresh`, wait, `GET /repo` shows a populated catalog.
5. `POST /models {doi}` for one known Latin recognition model, poll the job to
   `finished`, confirm `GET /models` lists it and an OCR job with
   `rec_model_path=/models/rec-<id>.mlmodel` (manual curl) produces output.
6. Only then start E3-B.

## 9. Open questions / risks

- **A pull thread dies if the API container restarts mid-download.** Mitigated by
  the 30-min stale-job rule (§3.4) and idempotent retry (`get_model`'s cache makes
  the retry cheap). No partial model file is ever exposed (copy is the last step).
- **`get_listing()` is slow and hits Zenodo's OAI endpoint** — a few dozen seconds,
  occasionally more. Run only in a thread, cached 24 h, never on the request path.
  If Zenodo is down, the refresh job fails and the old cache keeps serving.
- **Disk.** Recognition models are ~50–150 MB. The volume should be sized for, say,
  10 models (~1.5 GB) plus headroom. No hard enforcement in E3-A; E3-B's UI shows
  `size_bytes` per model and total. A soft check could be added later.
- **`RecognitionTaskModel.load_model` as the validation gate** ties model
  acceptance to the exact kraken version in the image. Correct behaviour: a model
  the running kraken cannot load is rejected at pull time rather than failing every
  OCR job later.
- **Volume migration is one-way in practice.** Once `/models` is a volume with
  pulled models, reverting to baked-only means losing them. Acceptable — the baked
  defaults are always re-seedable into an empty volume, and pulled models are
  re-pullable by DOI.
- **Two "Kraken Worker" + two "Kraken API" apps exist in Coolify** (prod + preview).
  E3-A attaches the volume to the prod pair only (`hjzo…` API, `ifbx…` worker).
  Preview apps keep baked-only behaviour; that is fine (preview does no real OCR).
