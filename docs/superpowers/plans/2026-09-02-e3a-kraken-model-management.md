# E3-A — Kraken Model Management Endpoints + Shared `/models` Volume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/models` in `kraken-ocr-service` into a shared persistent volume seeded from the baked defaults, and add six authenticated endpoints so an operator can list local recognition models, browse the HTRMoPo catalog, pull a model by DOI, check pull status, delete a pulled model, and force a catalog refresh — without redeploying the image.

**Architecture:** `Dockerfile.bake` bakes the default seg/rec models into `/models-dist/`; a new `entrypoint.sh` copies them into `/models` when the volume is empty, then execs the role command (`worker.py` or `uvicorn`). Six new FastAPI routes in `app.py`, all behind the existing `verify_key` dependency. Pulls and catalog refreshes run as **daemon threads in the API container** (not on the RQ queue, so OCR is never blocked), with state tracked by JSON job files in `/models/.jobs/`. The catalog is cached to `/models/.catalog.json` with a 24 h soft TTL. Model files are `rec-<zenodo_id>.mlmodel` plus a `.json` sidecar of htrmopo metadata; `seg.mlmodel` and `rec.mlmodel` are protected from deletion.

**Tech Stack:** FastAPI 0.115, `htrmopo` (already installed — `get_model` / `get_description` / `get_listing`), kraken 7.x (`RecognitionTaskModel.load_model` for validation), Python stdlib `threading` / `json` / `pathlib` / `tempfile` / `shutil` / `uuid`. Tests: `pytest` + `httpx` (new dev deps) + `TestClient`.

**Spec:** `docs/superpowers/specs/2026-09-02-e3a-kraken-model-management-design.md` (in the palimora-server repo — this plan and spec are stored there for orchestration; **the code lives in `kraken-ocr-service`**).

**Working directory for ALL tasks:** `~/Documents/antigravity/kraken-ocr-service` (a DIFFERENT repo from palimora-server). Branch `feat/e3a-model-management` off `main` (`79fffe0`). This repo has no test suite yet — Task 1 adds one.

## Global Constraints

- Every new route is `Depends(verify_key)` (the `X-API-Key` header check already in `app.py:42`). No auth without the header when `API_KEYS` is set → 403.
- `MODELS_DIR = Path(os.getenv("MODEL_DIR", "/models"))`. `PROTECTED = {"seg", "rec"}`. Recognition models only — `GET /models` never lists `seg.mlmodel`; the catalog is always filtered to `model_type == "recognition"`.
- Slug = model filename stem. Pulled model file = `rec-<zid>.mlmodel` where `zid` = the numeric Zenodo record id from `htrmopo.util._doi_to_zenodo_id(doi)`. Sidecar = `rec-<zid>.json`.
- `htrmopo.get_model(model_id, path=None, callback)` downloads to htrmopo's own cache when `path=None` and returns the cache Path; re-pull of a cached DOI is fast. Copy the `.mlmodel` (fallback `.safetensors`) out of that dir — **same pattern as `Dockerfile.bake:43-47`**.
- Pull/refresh jobs run in `threading.Thread(..., daemon=True)`, NOT `queue.enqueue`. `worker.py` is untouched.
- Job files: `/models/.jobs/<job_id>.json`, `job_id = uuid.uuid4().hex`. Atomic writes (`<file>.tmp` + `os.replace`). A job `status == "started"` whose `updated_at` is > 30 min old is reported as `failed` (container restarted mid-run).
- `.catalog.json` and `.jobs/` live in the volume; only the API container writes them.
- Do not break `GET /` (serves `templates/index.html`), `POST /jobs`, `GET /jobs/{id}`, the exports, or `worker.py`.
- No new runtime pip deps (`htrmopo`, `kraken` already present). `pytest` + `httpx` are dev-only.
- Commit style: `feat(models): ...` / `test(models): ...`. Do not push. Do not touch Coolify.

---

### Task 1: Test scaffold

**Files (in `kraken-ocr-service`):**
- Create: `requirements-dev.txt`, `tests/__init__.py`, `tests/conftest.py`, `pytest.ini`
- Test: `tests/test_health_smoke.py`

**Interfaces:**
- Produces: a `client` fixture (`TestClient(app)` with `API_KEYS` set to `"testkey"` and `MODEL_DIR` pointed at a per-test `tmp_path` via env + `importlib.reload` OR a module-level `MODELS_DIR` monkeypatch — see Step 3); a `models_dir` fixture returning that `Path`; an `auth` fixture returning `{"X-API-Key": "testkey"}`; a `fake_rec_model` helper that writes a small bytes blob as a `.mlmodel`.

- [ ] **Step 1: Write the smoke test**

```python
# tests/test_health_smoke.py
def test_health_no_auth(client):
    assert client.get("/health").json() == {"status": "ok"}
```

- [ ] **Step 2: Run it, watch it fail (no pytest / no conftest)**

Run: `cd ~/Documents/antigravity/kraken-ocr-service && python -m pytest -q`
Expected: FAIL — pytest not installed, or `conftest` import error.

- [ ] **Step 3: Create the scaffold**

`requirements-dev.txt`:
```
pytest==8.3.3
httpx==0.27.2
```

`pytest.ini`:
```
[pytest]
testpaths = tests
```

`tests/__init__.py` — empty.

`tests/conftest.py`:
```python
import importlib
import os
import pytest


@pytest.fixture()
def models_dir(tmp_path):
    d = tmp_path / "models"
    d.mkdir()
    return d


@pytest.fixture()
def client(models_dir, monkeypatch):
    monkeypatch.setenv("MODEL_DIR", str(models_dir))
    monkeypatch.setenv("API_KEYS", "testkey")
    import app as app_module
    importlib.reload(app_module)          # re-read MODEL_DIR / API_KEYS at import
    from fastapi.testclient import TestClient
    with TestClient(app_module.app) as c:
        yield c


@pytest.fixture()
def auth():
    return {"X-API-Key": "testkey"}


def write_fake_model(models_dir, slug: str, sidecar: dict | None = None):
    (models_dir / f"{slug}.mlmodel").write_bytes(b"FAKE" * 32)
    if sidecar is not None:
        import json
        (models_dir / f"{slug}.json").write_text(json.dumps(sidecar))
```

Note: `app.py` reads `API_KEYS` and (after this plan) `MODELS_DIR` at module import, so `importlib.reload` after `monkeypatch.setenv` is required. If a later task makes `app.py` read `MODEL_DIR` lazily inside handlers instead, the reload can be dropped — keep whichever the implementation needs and note it.

- [ ] **Step 4: Install dev deps + run**

Run: `pip install -r requirements-dev.txt && python -m pytest -q`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/antigravity/kraken-ocr-service
git checkout -b feat/e3a-model-management
git add requirements-dev.txt pytest.ini tests/
git commit -m "test(models): pytest scaffold with TestClient + tmp MODEL_DIR fixture"
```

---

### Task 2: `GET /models` — local recognition-model listing

**Files:**
- Modify: `app.py` (imports + module constants + the route)
- Test: `tests/test_models_local.py` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: module-level `MODELS_DIR = Path(os.getenv("MODEL_DIR", "/models"))`, `PROTECTED = {"seg", "rec"}`, and helper `_local_models() -> list[dict]`. Route `GET /models` → `{"models": [ {slug, protected, doi, summary, script, keywords, license, size_bytes} ]}`.
  - `rec` entry is synthetic: `{"slug": "rec", "protected": True, "doi": None, "summary": "Modèle de reconnaissance baké par défaut", "script": None, "keywords": [], "license": None, "size_bytes": <stat of rec.mlmodel or 0>}`, listed first.
  - `rec-*.mlmodel` entries: `protected: False`, metadata from the `<stem>.json` sidecar (missing sidecar → nulls/empty), `size_bytes` from `stat()`.
  - `seg.mlmodel` never listed.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_models_local.py
import json
from tests.conftest import write_fake_model


def test_lists_only_rec_synthetic_when_dir_has_defaults(client, models_dir, auth):
    write_fake_model(models_dir, "seg")
    write_fake_model(models_dir, "rec")
    r = client.get("/models", headers=auth)
    assert r.status_code == 200
    models = r.json()["models"]
    assert [m["slug"] for m in models] == ["rec"]
    assert models[0]["protected"] is True
    assert models[0]["size_bytes"] > 0


def test_lists_pulled_model_with_sidecar(client, models_dir, auth):
    write_fake_model(models_dir, "rec")
    write_fake_model(models_dir, "rec-21788409", sidecar={
        "doi": "10.5281/zenodo.21788409", "summary": "French 18C", "script": "Latn",
        "keywords": ["french"], "license": "CC-BY-4.0", "size_bytes": 128,
    })
    models = client.get("/models", headers=auth).json()["models"]
    slugs = [m["slug"] for m in models]
    assert slugs == ["rec", "rec-21788409"]
    pulled = models[1]
    assert pulled["doi"] == "10.5281/zenodo.21788409"
    assert pulled["script"] == "Latn"
    assert pulled["protected"] is False


def test_pulled_model_without_sidecar_has_nulls(client, models_dir, auth):
    write_fake_model(models_dir, "rec")
    write_fake_model(models_dir, "rec-999")
    m = [x for x in client.get("/models", headers=auth).json()["models"] if x["slug"] == "rec-999"][0]
    assert m["doi"] is None and m["keywords"] == []


def test_requires_api_key(client):
    assert client.get("/models").status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_models_local.py -v`
Expected: FAIL — 404 (route missing).

- [ ] **Step 3: Implement**

In `app.py`, add to the imports block:
```python
import json
from pathlib import Path
```

After the `API_KEYS` block:
```python
MODELS_DIR = Path(os.getenv("MODEL_DIR", "/models"))
PROTECTED = {"seg", "rec"}
_REC_SUMMARY = "Modèle de reconnaissance baké par défaut"


def _sidecar(slug: str) -> dict:
    p = MODELS_DIR / f"{slug}.json"
    if p.exists():
        try:
            return json.loads(p.read_text())
        except (ValueError, OSError):
            pass
    return {}


def _local_models() -> list[dict]:
    out = []
    rec = MODELS_DIR / "rec.mlmodel"
    out.append({
        "slug": "rec", "protected": True, "doi": None, "summary": _REC_SUMMARY,
        "script": None, "keywords": [], "license": None,
        "size_bytes": rec.stat().st_size if rec.exists() else 0,
    })
    for p in sorted(MODELS_DIR.glob("rec-*.mlmodel")):
        slug = p.stem
        meta = _sidecar(slug)
        out.append({
            "slug": slug, "protected": False,
            "doi": meta.get("doi"), "summary": meta.get("summary", ""),
            "script": meta.get("script"), "keywords": meta.get("keywords", []),
            "license": meta.get("license"), "size_bytes": p.stat().st_size,
        })
    return out
```

Route (place after `GET /health`):
```python
@app.get("/models")
async def list_models(api_key: str = Depends(verify_key)):
    return {"models": _local_models()}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_models_local.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_models_local.py
git commit -m "feat(models): GET /models — local recognition model listing"
```

---

### Task 3: Job-file helpers + `GET /models/jobs/{job_id}`

**Files:**
- Modify: `app.py`
- Test: `tests/test_jobs.py` (create)

**Interfaces:**
- Consumes: `MODELS_DIR`.
- Produces:
  - `_JOBS_DIR = MODELS_DIR / ".jobs"`.
  - `_now_iso() -> str` (`datetime.now(timezone.utc).isoformat()`).
  - `_write_job(job_id: str, **patch) -> dict` — merge `patch` into the existing job file (or a fresh `{}`), set `updated_at`, atomic write, return the merged dict.
  - `_read_job(job_id: str) -> dict | None`.
  - `_job_view(job: dict) -> dict` — returns the job with `status` forced to `"failed"` + `error` set when `status == "started"` and `updated_at` older than 30 min.
  - `_active_job(kind: str, key: str | None = None) -> dict | None` — the newest job file with `kind == kind` (and `doi == key` if given) whose `_job_view` status is `"started"`.
  - Route `GET /models/jobs/{job_id}` → `_job_view(...)` or 404.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_jobs.py
import json
from datetime import datetime, timedelta, timezone


def _put_job(models_dir, jid, **fields):
    d = models_dir / ".jobs"
    d.mkdir(exist_ok=True)
    (d / f"{jid}.json").write_text(json.dumps(fields))


def test_unknown_job_404(client, auth):
    assert client.get("/models/jobs/nope", headers=auth).status_code == 404


def test_running_job_returned_as_is(client, models_dir, auth):
    _put_job(models_dir, "j1", kind="pull", status="started",
             updated_at=datetime.now(timezone.utc).isoformat(), doi="10.5281/zenodo.1")
    body = client.get("/models/jobs/j1", headers=auth).json()
    assert body["status"] == "started"


def test_stale_started_job_reported_failed(client, models_dir, auth):
    old = (datetime.now(timezone.utc) - timedelta(minutes=45)).isoformat()
    _put_job(models_dir, "j2", kind="pull", status="started", updated_at=old, doi="x")
    body = client.get("/models/jobs/j2", headers=auth).json()
    assert body["status"] == "failed"
    assert "timeout" in body["error"].lower() or "interrompu" in body["error"].lower()


def test_finished_job_untouched(client, models_dir, auth):
    old = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    _put_job(models_dir, "j3", kind="pull", status="finished", updated_at=old, slug="rec-1")
    assert client.get("/models/jobs/j3", headers=auth).json()["status"] == "finished"


def test_jobs_route_requires_key(client):
    assert client.get("/models/jobs/whatever").status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_jobs.py -v`
Expected: FAIL — 404 for all (route missing) / helper import errors.

- [ ] **Step 3: Implement**

In `app.py` imports: `from datetime import datetime, timezone` and `import time`.

```python
_JOBS_DIR = MODELS_DIR / ".jobs"
_STALE_SECONDS = 30 * 60


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def _write_job(job_id: str, **patch) -> dict:
    cur = _read_job(job_id) or {"job_id": job_id}
    cur.update(patch)
    cur["updated_at"] = _now_iso()
    _atomic_write(_JOBS_DIR / f"{job_id}.json", json.dumps(cur))
    return cur


def _read_job(job_id: str) -> dict | None:
    p = _JOBS_DIR / f"{job_id}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (ValueError, OSError):
        return None


def _job_view(job: dict) -> dict:
    if job.get("status") == "started":
        try:
            ts = datetime.fromisoformat(job["updated_at"])
            if (datetime.now(timezone.utc) - ts).total_seconds() > _STALE_SECONDS:
                return {**job, "status": "failed", "error": "job interrompu (timeout)"}
        except (KeyError, ValueError):
            pass
    return job


def _active_job(kind: str, key: str | None = None) -> dict | None:
    if not _JOBS_DIR.exists():
        return None
    newest = None
    for p in _JOBS_DIR.glob("*.json"):
        j = _read_job(p.stem)
        if not j or j.get("kind") != kind:
            continue
        if key is not None and j.get("doi") != key:
            continue
        if _job_view(j).get("status") != "started":
            continue
        if newest is None or j.get("updated_at", "") > newest.get("updated_at", ""):
            newest = j
    return newest
```

Route (after `GET /models`):
```python
@app.get("/models/jobs/{job_id}")
async def model_job_status(job_id: str, api_key: str = Depends(verify_key)):
    job = _read_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job introuvable")
    return _job_view(job)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_jobs.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_jobs.py
git commit -m "feat(models): job-file helpers + GET /models/jobs/{id} with stale detection"
```

---

### Task 4: `POST /models` + `_pull_model_job` thread

**Files:**
- Modify: `app.py`
- Test: `tests/test_pull.py` (create)

**Interfaces:**
- Consumes: `_local_models`, `_write_job`, `_active_job`, `MODELS_DIR`.
- Produces:
  - `_DOI_RE = re.compile(r"^10\.5281/zenodo\.\d+$")`.
  - `_pull_model_job(job_id: str, doi: str) -> None` — the thread body (see spec §5.1). Uses `htrmopo.get_model(doi, callback=...)` (cache dir), picks `*.mlmodel` else `*.safetensors`, validates with `RecognitionTaskModel.load_model(str(f))`, copies to `MODELS_DIR / f"rec-{zid}.mlmodel"`, writes the `rec-{zid}.json` sidecar from `htrmopo.get_description(doi)`, sets job `finished`. On any exception: job `failed`, unlink a half-written `.mlmodel`.
  - Route `POST /models` body `PullIn(doi: str)` → 400 (bad DOI) / 409 (already local or pull in flight) / 202 `{"job_id", "slug", "status": "started"}`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_pull.py
import json
import types
import pytest


@pytest.fixture()
def stub_htrmopo(monkeypatch, tmp_path):
    """Fake htrmopo: get_model drops a .mlmodel into a cache dir; get_description
    returns an object with the v0 fields the sidecar needs."""
    cache = tmp_path / "htrmopo-cache"
    cache.mkdir()
    (cache / "model.mlmodel").write_bytes(b"REALMODEL" * 16)

    def fake_get_model(doi, path=None, callback=lambda t, a: None):
        callback(100, 100)
        return cache

    rec = types.SimpleNamespace(doi=doi_placeholder := "10.5281/zenodo.21788409",
                                summary="French 18C cursive", script="Latn",
                                keywords=["french", "cursive"], license="CC-BY-4.0",
                                model_type="recognition")

    def fake_get_description(doi, *a, **k):
        return rec

    import app as app_module
    monkeypatch.setattr(app_module.htrmopo, "get_model", fake_get_model, raising=False)
    monkeypatch.setattr(app_module.htrmopo, "get_description", fake_get_description, raising=False)
    # RecognitionTaskModel.load_model must succeed for a valid rec model
    monkeypatch.setattr(app_module, "_load_rec_for_validation", lambda p: None, raising=False)
    return cache


def test_bad_doi_400(client, auth):
    assert client.post("/models", json={"doi": "not-a-doi"}, headers=auth).status_code == 400


def test_already_present_409(client, models_dir, auth):
    from tests.conftest import write_fake_model
    write_fake_model(models_dir, "rec-21788409")
    r = client.post("/models", json={"doi": "10.5281/zenodo.21788409"}, headers=auth)
    assert r.status_code == 409


def test_pull_runs_and_lands_model(client, models_dir, auth, stub_htrmopo):
    r = client.post("/models", json={"doi": "10.5281/zenodo.21788409"}, headers=auth)
    assert r.status_code == 202
    jid = r.json()["job_id"]
    # thread is daemon; poll the job file
    import time
    for _ in range(50):
        body = client.get(f"/models/jobs/{jid}", headers=auth).json()
        if body["status"] in ("finished", "failed"):
            break
        time.sleep(0.1)
    assert body["status"] == "finished", body
    assert (models_dir / "rec-21788409.mlmodel").exists()
    side = json.loads((models_dir / "rec-21788409.json").read_text())
    assert side["script"] == "Latn" and side["doi"] == "10.5281/zenodo.21788409"
    assert side["size_bytes"] > 0


def test_pull_validation_failure_leaves_no_model(client, models_dir, auth, monkeypatch, stub_htrmopo):
    import app as app_module
    monkeypatch.setattr(app_module, "_load_rec_for_validation",
                        lambda p: (_ for _ in ()).throw(RuntimeError("not a rec model")))
    r = client.post("/models", json={"doi": "10.5281/zenodo.21788409"}, headers=auth)
    jid = r.json()["job_id"]
    import time
    for _ in range(50):
        body = client.get(f"/models/jobs/{jid}", headers=auth).json()
        if body["status"] in ("finished", "failed"):
            break
        time.sleep(0.1)
    assert body["status"] == "failed"
    assert not (models_dir / "rec-21788409.mlmodel").exists()


def test_pull_requires_key(client):
    assert client.post("/models", json={"doi": "10.5281/zenodo.1"}).status_code == 403
```

Note: the implementer must confirm the real `htrmopo.get_description` record field names (`summary`, `script`, `keywords`, `license`, `model_type`) by running `python -c "import htrmopo; print(vars(htrmopo.get_description('10.5281/zenodo.21788409')))"` in the container/venv during Step 3, and adjust `_sidecar_from_record` + the test stub to match. If a field is absent on v0 records, fall back to `getattr(rec, name, None)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_pull.py -v`
Expected: FAIL — 404 (route missing).

- [ ] **Step 3: Implement**

`app.py` imports: `import re`, `import shutil`, `import tempfile`, `import threading`, `import htrmopo`, `from htrmopo.util import _doi_to_zenodo_id`, and `from pydantic import BaseModel`.

```python
_DOI_RE = re.compile(r"^10\.5281/zenodo\.\d+$")


class PullIn(BaseModel):
    doi: str


def _load_rec_for_validation(model_file: str) -> None:
    """Raises if the file is not a kraken-loadable recognition model. Extracted so
    tests can monkeypatch it (loading a real model needs torch + the file)."""
    from kraken.tasks import RecognitionTaskModel
    RecognitionTaskModel.load_model(model_file)


def _sidecar_from_record(rec, doi: str, size_bytes: int) -> dict:
    g = lambda n: getattr(rec, n, None)
    return {
        "doi": doi, "summary": g("summary") or "", "script": g("script"),
        "keywords": list(g("keywords") or []), "license": g("license"),
        "size_bytes": size_bytes, "pulled_at": _now_iso(),
    }


def _pull_model_job(job_id: str, doi: str) -> None:
    zid = _doi_to_zenodo_id(doi)
    dest = MODELS_DIR / f"rec-{zid}.mlmodel"
    tmp = None
    try:
        _write_job(job_id, status="started", progress=0)
        cache_dir = htrmopo.get_model(
            doi, callback=lambda total, adv: _write_job(
                job_id, progress=min(99, int(adv * 100 / total)) if total else 0))
        cache_dir = Path(cache_dir)
        cands = sorted(
            [p for p in cache_dir.iterdir() if p.suffix in (".mlmodel", ".safetensors")],
            key=lambda p: p.suffix != ".mlmodel")
        if not cands:
            raise RuntimeError("aucun fichier modèle dans le dépôt")
        model_file = cands[0]
        _load_rec_for_validation(str(model_file))
        shutil.copy(model_file, dest)
        try:
            rec = htrmopo.get_description(doi)
        except Exception:  # noqa: BLE001 — metadata is best-effort
            rec = None
        sidecar = _sidecar_from_record(rec, doi, dest.stat().st_size) if rec else {
            "doi": doi, "summary": "", "script": None, "keywords": [], "license": None,
            "size_bytes": dest.stat().st_size, "pulled_at": _now_iso()}
        _atomic_write(MODELS_DIR / f"rec-{zid}.json", json.dumps(sidecar))
        _write_job(job_id, status="finished", slug=f"rec-{zid}", progress=100)
    except Exception as exc:  # noqa: BLE001
        if dest.exists():
            dest.unlink(missing_ok=True)
        _write_job(job_id, status="failed", error=str(exc)[:500])
    finally:
        if tmp and Path(tmp).exists():
            shutil.rmtree(tmp, ignore_errors=True)
```

Route:
```python
@app.post("/models", status_code=202)
async def pull_model(payload: PullIn, api_key: str = Depends(verify_key)):
    doi = payload.doi.strip()
    if not _DOI_RE.match(doi) or _doi_to_zenodo_id(doi) is None:
        raise HTTPException(status_code=400, detail="DOI Zenodo invalide")
    zid = _doi_to_zenodo_id(doi)
    slug = f"rec-{zid}"
    if (MODELS_DIR / f"{slug}.mlmodel").exists():
        raise HTTPException(status_code=409, detail="Modèle déjà présent")
    if _active_job("pull", key=doi):
        raise HTTPException(status_code=409, detail="Téléchargement déjà en cours")
    job_id = uuid.uuid4().hex
    _write_job(job_id, kind="pull", doi=doi, slug=slug, status="started",
               error=None, progress=0, started_at=_now_iso())
    threading.Thread(target=_pull_model_job, args=(job_id, doi), daemon=True).start()
    return {"job_id": job_id, "slug": slug, "status": "started"}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_pull.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_pull.py
git commit -m "feat(models): POST /models — background pull-by-DOI with rec-model validation"
```

---

### Task 5: `DELETE /models/{slug}`

**Files:**
- Modify: `app.py`
- Test: `tests/test_delete.py` (create)

**Interfaces:**
- Consumes: `MODELS_DIR`, `PROTECTED`.
- Produces: `DELETE /models/{slug}` → 409 (`slug in PROTECTED`), 404 (`rec-<...>.mlmodel` missing), 200 `{"deleted": slug}` (removes `.mlmodel` + `.json`).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_delete.py
from tests.conftest import write_fake_model


def test_protected_slugs_409(client, models_dir, auth):
    write_fake_model(models_dir, "rec")
    write_fake_model(models_dir, "seg")
    assert client.delete("/models/rec", headers=auth).status_code == 409
    assert client.delete("/models/seg", headers=auth).status_code == 409


def test_missing_404(client, auth):
    assert client.delete("/models/rec-404", headers=auth).status_code == 404


def test_deletes_model_and_sidecar(client, models_dir, auth):
    write_fake_model(models_dir, "rec-21788409", sidecar={"doi": "10.5281/zenodo.21788409"})
    r = client.delete("/models/rec-21788409", headers=auth)
    assert r.status_code == 200 and r.json() == {"deleted": "rec-21788409"}
    assert not (models_dir / "rec-21788409.mlmodel").exists()
    assert not (models_dir / "rec-21788409.json").exists()


def test_delete_requires_key(client):
    assert client.delete("/models/rec-1").status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_delete.py -v`
Expected: FAIL — 405/404 (route missing).

- [ ] **Step 3: Implement**

```python
@app.delete("/models/{slug}")
async def delete_model(slug: str, api_key: str = Depends(verify_key)):
    if slug in PROTECTED:
        raise HTTPException(status_code=409, detail="Modèle protégé")
    model_file = MODELS_DIR / f"{slug}.mlmodel"
    if not slug.startswith("rec-") or not model_file.exists():
        raise HTTPException(status_code=404, detail="Modèle introuvable")
    model_file.unlink()
    (MODELS_DIR / f"{slug}.json").unlink(missing_ok=True)
    return {"deleted": slug}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_delete.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_delete.py
git commit -m "feat(models): DELETE /models/{slug} with protected-default guard"
```

---

### Task 6: Catalog — `_refresh_catalog_job`, `.catalog.json`, `GET /repo`, `POST /repo/refresh`

**Files:**
- Modify: `app.py`
- Test: `tests/test_catalog.py` (create)

**Interfaces:**
- Consumes: `_write_job`, `_active_job`, `_atomic_write`, `MODELS_DIR`, `_local_models`.
- Produces:
  - `_CATALOG = MODELS_DIR / ".catalog.json"`, `_CATALOG_TTL = 24 * 3600`.
  - `_refresh_catalog_job(job_id: str) -> None` — `htrmopo.get_listing()`, flatten newest version per concept DOI, keep `model_type == "recognition"`, write `.catalog.json` = `{"cached_at", "count", "models": [{doi, summary, script, keywords, license}]}` atomically, job `finished` with `count`.
  - `_ensure_catalog_fresh() -> None` — if `.catalog.json` missing or `cached_at` older than TTL and no live `refresh` job → spawn one.
  - `GET /repo?script=Latn&all=false` → `{cached_at, stale, refreshing, models}` — models filtered by `script` (case-insensitive) unless `all`, each annotated `already_local` (DOI matches a local sidecar).
  - `POST /repo/refresh` → 202 `{job_id, status}` (idempotent: returns the live job's id if one is running).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_catalog.py
import json
from datetime import datetime, timedelta, timezone
import types
import pytest


@pytest.fixture()
def stub_listing(monkeypatch):
    def fake_get_listing(callback=lambda t, a: None, **kw):
        rec_v0 = lambda doi, script, mt: types.SimpleNamespace(
            doi=doi, summary=f"model {doi}", script=script, keywords=["k"],
            license="CC-BY-4.0", model_type=mt)
        return {
            "10.5281/zenodo.1": {"v0": rec_v0("10.5281/zenodo.1", "Latn", "recognition")},
            "10.5281/zenodo.2": {"v0": rec_v0("10.5281/zenodo.2", "Grek", "recognition")},
            "10.5281/zenodo.3": {"v0": rec_v0("10.5281/zenodo.3", "Latn", "segmentation")},
        }
    import app as app_module
    monkeypatch.setattr(app_module.htrmopo, "get_listing", fake_get_listing, raising=False)


def _poll(client, auth, jid):
    import time
    for _ in range(50):
        b = client.get(f"/models/jobs/{jid}", headers=auth).json()
        if b["status"] in ("finished", "failed"):
            return b
        time.sleep(0.1)
    return b


def test_no_cache_returns_stale_and_triggers_refresh(client, models_dir, auth, stub_listing):
    r = client.get("/repo", headers=auth)
    assert r.status_code == 200
    body = r.json()
    assert body["stale"] is True and body["models"] == []


def test_refresh_writes_recognition_only_catalog(client, models_dir, auth, stub_listing):
    r = client.post("/repo/refresh", headers=auth)
    assert r.status_code == 202
    _poll(client, auth, r.json()["job_id"])
    cat = json.loads((models_dir / ".catalog.json").read_text())
    dois = {m["doi"] for m in cat["models"]}
    assert dois == {"10.5281/zenodo.1", "10.5281/zenodo.2"}  # segmentation excluded


def test_repo_filters_by_script(client, models_dir, auth, stub_listing):
    _poll(client, auth, client.post("/repo/refresh", headers=auth).json()["job_id"])
    latn = client.get("/repo?script=Latn", headers=auth).json()["models"]
    assert {m["doi"] for m in latn} == {"10.5281/zenodo.1"}
    allm = client.get("/repo?all=true", headers=auth).json()["models"]
    assert {m["doi"] for m in allm} == {"10.5281/zenodo.1", "10.5281/zenodo.2"}


def test_already_local_flag(client, models_dir, auth, stub_listing):
    from tests.conftest import write_fake_model
    write_fake_model(models_dir, "rec-1", sidecar={"doi": "10.5281/zenodo.1"})
    _poll(client, auth, client.post("/repo/refresh", headers=auth).json()["job_id"])
    m = [x for x in client.get("/repo?all=true", headers=auth).json()["models"]
         if x["doi"] == "10.5281/zenodo.1"][0]
    assert m["already_local"] is True


def test_repo_requires_key(client):
    assert client.get("/repo").status_code == 403
    assert client.post("/repo/refresh").status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_catalog.py -v`
Expected: FAIL — 404.

- [ ] **Step 3: Implement**

```python
_CATALOG = MODELS_DIR / ".catalog.json"
_CATALOG_TTL = 24 * 3600


def _local_dois() -> set[str]:
    return {m["doi"] for m in _local_models() if m["doi"]}


def _read_catalog() -> dict | None:
    if not _CATALOG.exists():
        return None
    try:
        return json.loads(_CATALOG.read_text())
    except (ValueError, OSError):
        return None


def _catalog_stale(cat: dict | None) -> bool:
    if not cat:
        return True
    try:
        ts = datetime.fromisoformat(cat["cached_at"])
        return (datetime.now(timezone.utc) - ts).total_seconds() > _CATALOG_TTL
    except (KeyError, ValueError):
        return True


def _refresh_catalog_job(job_id: str) -> None:
    try:
        _write_job(job_id, status="started")
        listing = htrmopo.get_listing()
        models = []
        for versions in listing.values():
            rec = versions.get("v1") or versions.get("v0")
            if rec is None or getattr(rec, "model_type", None) != "recognition":
                continue
            models.append({
                "doi": getattr(rec, "doi", None),
                "summary": getattr(rec, "summary", "") or "",
                "script": getattr(rec, "script", None),
                "keywords": list(getattr(rec, "keywords", []) or []),
                "license": getattr(rec, "license", None),
            })
        models = [m for m in models if m["doi"]]
        _atomic_write(_CATALOG, json.dumps(
            {"cached_at": _now_iso(), "count": len(models), "models": models}))
        _write_job(job_id, status="finished", count=len(models))
    except Exception as exc:  # noqa: BLE001
        _write_job(job_id, status="failed", error=str(exc)[:500])


def _spawn_refresh() -> str:
    live = _active_job("refresh")
    if live:
        return live["job_id"]
    job_id = uuid.uuid4().hex
    _write_job(job_id, kind="refresh", status="started", started_at=_now_iso())
    threading.Thread(target=_refresh_catalog_job, args=(job_id,), daemon=True).start()
    return job_id
```

Routes:
```python
@app.get("/repo")
async def repo_catalog(script: str = "Latn", all: bool = False,
                       api_key: str = Depends(verify_key)):
    cat = _read_catalog()
    stale = _catalog_stale(cat)
    refreshing = False
    if stale and not _active_job("refresh"):
        _spawn_refresh()
        refreshing = True
    elif _active_job("refresh"):
        refreshing = True
    local = _local_dois()
    models = (cat or {}).get("models", [])
    if not all:
        models = [m for m in models if (m.get("script") or "").lower() == script.lower()]
    models = [{**m, "already_local": m["doi"] in local} for m in models]
    return {"cached_at": (cat or {}).get("cached_at"), "stale": stale,
            "refreshing": refreshing, "models": models}


@app.post("/repo/refresh", status_code=202)
async def repo_refresh(api_key: str = Depends(verify_key)):
    return {"job_id": _spawn_refresh(), "status": "started"}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_catalog.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Full suite**

Run: `python -m pytest -q`
Expected: PASS (all tasks' tests)

- [ ] **Step 6: Commit**

```bash
git add app.py tests/test_catalog.py
git commit -m "feat(models): HTRMoPo catalog cache + GET /repo + POST /repo/refresh"
```

---

### Task 7: `Dockerfile.bake` → `/models-dist` + `entrypoint.sh` seeding

**Files:**
- Modify: `Dockerfile.bake`
- Create: `entrypoint.sh`
- Test: `tests/test_entrypoint.py` (create — a shell-level unit test of the seed logic)

**Interfaces:**
- Produces: bake steps write to `/models-dist/`; `entrypoint.sh` seeds `/models` from `/models-dist` when `/models` is empty, then execs the role command.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_entrypoint.py
import subprocess
from pathlib import Path


def test_entrypoint_seeds_empty_models(tmp_path):
    dist = tmp_path / "models-dist"
    dist.mkdir()
    (dist / "seg.mlmodel").write_bytes(b"S")
    (dist / "rec.mlmodel").write_bytes(b"R")
    models = tmp_path / "models"
    script = Path("entrypoint.sh").read_text()
    # run only the seeding block (strip the exec line for the test)
    seed = script.split("if [ \"$KRAKEN_ROLE\"")[0]
    subprocess.run(["sh", "-c", seed], cwd=tmp_path, check=True,
                   env={"PATH": "/usr/bin:/bin"})
    assert (models / "seg.mlmodel").read_bytes() == b"S"
    assert (models / "rec.mlmodel").read_bytes() == b"R"


def test_entrypoint_does_not_overwrite_populated_models(tmp_path):
    dist = tmp_path / "models-dist"; dist.mkdir()
    (dist / "rec.mlmodel").write_bytes(b"BAKED")
    models = tmp_path / "models"; models.mkdir()
    (models / "rec.mlmodel").write_bytes(b"PULLED")
    seed = Path("entrypoint.sh").read_text().split("if [ \"$KRAKEN_ROLE\"")[0]
    subprocess.run(["sh", "-c", seed], cwd=tmp_path, check=True, env={"PATH": "/usr/bin:/bin"})
    assert (models / "rec.mlmodel").read_bytes() == b"PULLED"
```

The test greps for the literal `if [ "$KRAKEN_ROLE"` to split the seed block from the exec block — keep that exact string in `entrypoint.sh`. The seed block must use paths relative to `$PWD` only via `/models` and `/models-dist` — so the test `cwd`s into `tmp_path` and the script must reference `./models` / `./models-dist`? No — the script uses absolute `/models`. **Adjust:** make the seed block honour a `MODELS_ROOT` prefix defaulting to empty, so the test can set `MODELS_ROOT=$PWD`. See Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_entrypoint.py -v`
Expected: FAIL — `entrypoint.sh` does not exist.

- [ ] **Step 3: Create `entrypoint.sh`**

```sh
#!/bin/sh
set -e

MODELS_ROOT="${MODELS_ROOT:-}"
MODELS="${MODELS_ROOT}/models"
DIST="${MODELS_ROOT}/models-dist"

mkdir -p "$MODELS"
if [ -z "$(ls -A "$MODELS" 2>/dev/null)" ] && [ -d "$DIST" ]; then
  cp -a "$DIST"/. "$MODELS"/
  echo "seeded $MODELS from baked defaults: $(ls "$MODELS")"
fi

if [ "$KRAKEN_ROLE" = "worker" ]; then
  exec python worker.py
else
  exec uvicorn app:app --host 0.0.0.0 --port 8000
fi
```

In the test, set `env={"PATH": "/usr/bin:/bin", "MODELS_ROOT": str(tmp_path)}` and the script resolves `${tmp_path}/models` / `${tmp_path}/models-dist`. Update the test env dicts accordingly (both cases).

In production `MODELS_ROOT` is unset → `/models` + `/models-dist` (absolute).

- [ ] **Step 4: Modify `Dockerfile.bake`**

- Lines 41-53: change every `'/models/...'` destination in the three bake `python -c` snippets to `'/models-dist/...'` (`seg.mlmodel` → `/models-dist/seg.mlmodel`, `rec.mlmodel` → `/models-dist/rec.mlmodel`, the legacy `MODEL_DOI` loop `'/models/'+p.name` → `'/models-dist/'+p.name`). Change `RUN mkdir -p /models` (line 40) to `RUN mkdir -p /models-dist`.
- Add before `EXPOSE 8000`:
```dockerfile
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
```
- Replace the `CMD ["sh", "-c", "if [ \"$KRAKEN_ROLE\" ...]` line with:
```dockerfile
ENTRYPOINT ["/entrypoint.sh"]
```
(no `CMD` — the entrypoint execs the role command itself).

- Do the equivalent change to the plain `Dockerfile` (non-bake) if Coolify might use it — check which Dockerfile Coolify's build config points at (`dockerfile_location` was `/Dockerfile` in the E2 investigation for palimora, but kraken's Coolify app uses `Dockerfile.bake` per the `MODEL_SEG_DOI` build args). **Ruling for the implementer:** update `Dockerfile.bake` (the one in use); leave the plain `Dockerfile` alone but add a one-line comment there pointing to `Dockerfile.bake` as the deployed build.

- [ ] **Step 5: Run test + full suite**

Run: `python -m pytest -q`
Expected: PASS (all)

- [ ] **Step 6: Commit**

```bash
git add Dockerfile.bake entrypoint.sh tests/test_entrypoint.py
git commit -m "feat(models): bake defaults to /models-dist, seed /models volume on empty"
```

---

### Task 8: Auth sweep + README + rollout notes

**Files:**
- Modify: `README.md` (document the new endpoints + the volume requirement)
- Create: `tests/test_auth_sweep.py`

- [ ] **Step 1: Write the auth sweep test**

```python
# tests/test_auth_sweep.py
import pytest

ROUTES = [
    ("GET", "/models"),
    ("GET", "/models/jobs/x"),
    ("POST", "/models"),
    ("DELETE", "/models/rec-1"),
    ("GET", "/repo"),
    ("POST", "/repo/refresh"),
]


@pytest.mark.parametrize("method,path", ROUTES)
def test_no_key_403(client, method, path):
    resp = client.request(method, path, json={} if method == "POST" else None)
    assert resp.status_code == 403


@pytest.mark.parametrize("method,path", ROUTES)
def test_wrong_key_403(client, method, path):
    resp = client.request(method, path, headers={"X-API-Key": "nope"},
                          json={} if method == "POST" else None)
    assert resp.status_code == 403
```

- [ ] **Step 2: Run — expect PASS** (routes already gated; this locks it in)

Run: `python -m pytest tests/test_auth_sweep.py -v`
Expected: PASS (12 cases). If any FAIL, add `Depends(verify_key)` to that route.

- [ ] **Step 3: Update `README.md`**

Add a "Model management (E3-A)" section: the six endpoints with example curl, the `/models` file layout, and a **"Deployment requirement"** callout — `/models` MUST be a shared persistent volume mounted at the same host path on the API and worker containers; on first boot the entrypoint seeds it from the baked `/models-dist`.

- [ ] **Step 4: Full suite**

Run: `python -m pytest -q`
Expected: PASS (all — expect ~35 tests)

- [ ] **Step 5: Commit**

```bash
git add README.md tests/test_auth_sweep.py
git commit -m "test(models): auth sweep on all model-management routes; README"
```

- [ ] **Step 6: STOP — hand back to the controller**

Report the branch (`feat/e3a-model-management` in `kraken-ocr-service`) and the manual/infra steps that are NOT in this plan (they are the user's / operator's to do):
1. Create the Coolify persistent storage, mount `/models` on Kraken API (`hjzovkwfthcaxqlfyzq5znex`) + Kraken Worker (`ifbxnsa0l46ph73bhr4dnfu0`), same host path.
2. Merge + push `kraken-ocr-service`; Coolify rebuilds both.
3. Verify per spec §8 (seed happened, `GET /models` works, OCR still works, catalog refresh, one test pull).
4. Only then start E3-B (`palimora-server`).

Do NOT push. Do NOT open a PR. Do NOT modify Coolify.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| §2.1 Coolify shared volume | Task 8 Step 6 (operator step, documented, not code) |
| §2.2 `Dockerfile.bake` → `/models-dist` + `entrypoint.sh` seed | Task 7 |
| §2.3 local file layout, slug, sidecar | Tasks 2, 4 |
| §3.1 `GET /models` | Task 2 |
| §3.2 `GET /repo` cache + filter + `already_local` | Task 6 |
| §3.3 `POST /models` validation + 400/409/202 | Task 4 |
| §3.4 `GET /models/jobs/{id}` + 30-min stale rule | Task 3 |
| §3.5 `DELETE /models/{slug}` protected guard | Task 5 |
| §3.6 `POST /repo/refresh` idempotent | Task 6 |
| §4 catalog cache `.catalog.json` atomic, 24 h TTL | Task 6 |
| §5.1 `_pull_model_job` — get_model → validate → copy → sidecar → cleanup | Task 4 |
| §5.2 `_refresh_catalog_job` — get_listing → filter recognition → atomic write | Task 6 |
| §6 no new runtime deps | all (dev deps in Task 1) |
| §7 pytest list | Tasks 1-8 |
| §8 rollout | Task 8 Step 6 |
| §9 risks | acknowledged; no code owed |

No gaps.

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to". Two explicit
verification notes (confirm `htrmopo.get_description` v0 field names by running a
one-liner in Task 4 Step 1; confirm which Dockerfile Coolify builds in Task 7 Step
4) — the surrounding code is complete, these are 1-line confirmations. `_pull_model_job`
has an unused `tmp` variable / `finally` (get_model uses its own cache, no tempdir
made) — **remove the `tmp` / `finally` block** in the implementation; it is a
leftover from an earlier design (spec §5.1 mentioned `mkdtemp`, but the get_model
cache approach makes it unnecessary). Flag corrected here so the implementer drops it.

**3. Type consistency:**
- `_write_job(job_id, **patch) -> dict` / `_read_job -> dict | None` / `_job_view(job) -> dict` / `_active_job(kind, key=None) -> dict | None` — defined Task 3, used Tasks 4, 6.
- job file shape `{job_id, kind, status, updated_at, doi?, slug?, error?, progress?, started_at?, count?}` — written in Tasks 3-6, read by `GET /models/jobs/{id}` (Task 3) + the SPA (E3-B).
- `_local_models() -> list[dict]` with keys `{slug, protected, doi, summary, script, keywords, license, size_bytes}` — Task 2, consumed by Task 6 (`_local_dois`) and E3-B.
- `GET /repo` response `{cached_at, stale, refreshing, models:[{doi,summary,script,keywords,license,already_local}]}` — Task 6, consumed by E3-B.
- `_DOI_RE` / `_doi_to_zenodo_id` — Task 4.
- `entrypoint.sh` literal `if [ "$KRAKEN_ROLE"` split marker — Task 7 test + script must agree.

Consistent.

## Execution Handoff

Plan complete, saved to `docs/superpowers/plans/2026-09-02-e3a-kraken-model-management.md` (palimora-server repo; **code target is `kraken-ocr-service`**). Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task (each dispatched with working dir `~/Documents/antigravity/kraken-ocr-service`), review between tasks, broad final review.
2. **Inline Execution** — tasks in this session.

Which approach?
