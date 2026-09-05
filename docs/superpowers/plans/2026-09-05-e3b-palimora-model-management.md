# E3-B — Palimora admin model management (Kraken proxy + UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace E2's static `KRAKEN_MODELS` env whitelist with a live model list proxied from the Kraken model-management endpoints (E3-A), and give the admin, inside the existing `/admin` "OCR / Modèles" panel: browse the HTRMoPo catalogue, pull a recognition model by DOI, delete a downloaded model, and switch the active model. The E2 timing panel (median/p95/errors aggregates + recent-pages table) is carried forward unchanged.

**Architecture:** `app/kraken.py` gains a generic `call()` helper (API-key header, `KrakenError` on transport failure / 5xx). `app/ocr_models.py` is rewritten to resolve the active model from `GET {kraken}/models` behind a 60 s process cache instead of from env. `app/main.py` gains a `_kraken_proxy()` helper and five new admin routes that relay E3-A's `GET /repo`, `POST /repo/refresh`, `POST /models`, `GET /models/jobs/{id}`, `DELETE /models/{slug}` — with Palimora holding the guard rails (active model can't be deleted; admin-gated; audit-logged — a pull is audited twice, once for the intent and once for the outcome the job-status proxy observes). The SPA's OCR panel becomes three blocks (active model + perf, downloaded models, HTRMoPo catalogue) built from the shadcn/ui components already in `web/src/components/ui/`.

**Tech Stack:** FastAPI, SQLAlchemy, `httpx` (already a dependency), pytest + `httpx.MockTransport` / monkeypatched `kraken.call`. Frontend: React 18 + TypeScript + Vite, shadcn/ui (`Button`, `Badge`, `Alert`, `Dialog`, `Table`, `Input` — all already installed), Tailwind tokens from `web/src/styles/tokens.css`. Tests: vitest + `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-09-02-e3b-palimora-model-management-design.md` (approved).

**Working directory for ALL tasks:** `/Users/loopion/Documents/antigravity/palimora-server`. Branch: `feat/e3b-model-management` off `main`.

---

## Preamble — dependency on E3-A

**This plan can be implemented and fully tested today, but must NOT be deployed to production before E3-A is merged and deployed.**

- Every Kraken call in this plan targets an endpoint that only exists after E3-A (`kraken-ocr-service`, branch `feat/e3a-model-management`, plan `docs/superpowers/plans/2026-09-02-e3a-kraken-model-management.md`) is merged **and** its Coolify `/models` shared volume is mounted on the Kraken API + Worker containers.
- The whole Palimora side is developed against **mocked `httpx` / monkeypatched `kraken.call`** — no test in this plan needs a live Kraken. So Tasks 1-9 can be executed in parallel with E3-A's implementation.
- Ship-order consequence: if E3-B were deployed first, `GET {kraken}/models` would 404, `_safe_list()` would return `[]`, and every OCR job would silently use Kraken's baked `rec` model — the current production behaviour, no breakage — but the admin panel would be non-functional (empty model list + a "Service Kraken injoignable" banner on catalogue actions). Do not do this on purpose; Task 9 restates the rollout order.
- The exact JSON shapes consumed here are **frozen by the E3-A plan** (Tasks 2, 3, 4, 5, 6 of that document). If E3-A's implementation deviates from its plan, the fixtures in Tasks 2/4/5/6 below and the TS types in Task 7 must be updated to match before the rollout verification in Task 9.

## Global Constraints

- **Recognition-only.** `resolve_active()` always returns `seg_path=None`; Kraken uses its baked `/models/seg.mlmodel`. No segmentation switching anywhere in this plan.
- **Palimora never touches the Kraken filesystem.** Every model operation is a proxied HTTP call to an E3-A endpoint.
- `AppSetting['ocr_model']` stores a **slug** (`rec`, `rec-21788409`, …), never an env label.
- `KRAKEN_MODELS`, `KRAKEN_MODELS_DEFAULT` and `_parse_kraken_models` are **deleted** — from `app/config.py` and from the test suite. No compatibility shim.
- The E2 timing panel (`aggregates`, `recent`) is **unchanged** in shape and in SQL. New UI sits beside it.
- All new admin routes are `Depends(get_admin_user)` → 403 for non-admins and 403 during E1 impersonation (no middleware change needed).
- All new UI uses the shadcn/ui components already in `web/src/components/ui/` and the tokens in `web/src/styles/tokens.css`. **No new npm dependency, no new route, no chart library.**
- French user-facing strings, consistent with the rest of the app.
- Commit style: `feat(ocr): …` / `test(ocr): …` / `refactor(ocr): …`. **Do not push. Do not open a PR. Do not touch Coolify.**
- Run the backend suite with `python3 -m pytest -q` from the repo root; the frontend suite with `cd web && npm test`.

---

### Task 1: `kraken.call()` helper + config cleanup

**Files:**
- Modify: `app/kraken.py`, `app/config.py`
- Create: `tests/test_kraken_call.py`
- Delete: `tests/test_ocr_config.py`

**Interfaces:**
- Produces: `kraken.call(method, path, *, json_body=None, params=None, timeout=30.0) -> httpx.Response`, and the injection seam `kraken._client(timeout) -> httpx.Client` that tests replace with a `MockTransport` client.
- Removes: `settings.kraken_models`, `settings.kraken_models_default`, `config._parse_kraken_models`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_kraken_call.py
import httpx
import pytest

from app import kraken
from app.config import settings


def _mock(handler):
    """Replace kraken._client with a MockTransport-backed client factory."""
    def factory(timeout: float) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(handler), timeout=timeout)
    return factory


def test_get_sends_api_key_header_and_params(monkeypatch):
    monkeypatch.setattr(settings, "kraken_api_url", "http://kraken:8000", raising=False)
    monkeypatch.setattr(settings, "kraken_api_key", "secret", raising=False)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("X-API-Key")
        seen["method"] = request.method
        return httpx.Response(200, json={"models": []})

    monkeypatch.setattr(kraken, "_client", _mock(handler))
    resp = kraken.call("GET", "/repo", params={"script": "Latn", "all": "false"})
    assert resp.status_code == 200 and resp.json() == {"models": []}
    assert seen["method"] == "GET"
    assert seen["key"] == "secret"
    assert seen["url"] == "http://kraken:8000/repo?script=Latn&all=false"


def test_post_sends_json_body(monkeypatch):
    monkeypatch.setattr(settings, "kraken_api_url", "http://kraken:8000", raising=False)
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["content"] = request.content
        return httpx.Response(202, json={"job_id": "j1", "slug": "rec-1", "status": "started"})

    monkeypatch.setattr(kraken, "_client", _mock(handler))
    resp = kraken.call("POST", "/models", json_body={"doi": "10.5281/zenodo.1"})
    assert resp.status_code == 202
    assert b'"doi"' in seen["content"]


def test_4xx_is_returned_not_raised(monkeypatch):
    monkeypatch.setattr(settings, "kraken_api_url", "http://kraken:8000", raising=False)
    monkeypatch.setattr(kraken, "_client",
                        _mock(lambda r: httpx.Response(409, json={"detail": "Modèle déjà présent"})))
    resp = kraken.call("POST", "/models", json_body={"doi": "10.5281/zenodo.1"})
    assert resp.status_code == 409
    assert resp.json()["detail"] == "Modèle déjà présent"


def test_5xx_raises_kraken_error(monkeypatch):
    monkeypatch.setattr(settings, "kraken_api_url", "http://kraken:8000", raising=False)
    monkeypatch.setattr(kraken, "_client", _mock(lambda r: httpx.Response(503, text="down")))
    with pytest.raises(kraken.KrakenError):
        kraken.call("GET", "/models")


def test_transport_failure_raises_kraken_error(monkeypatch):
    monkeypatch.setattr(settings, "kraken_api_url", "http://kraken:8000", raising=False)

    def boom(request):
        raise httpx.ConnectError("no route to host", request=request)

    monkeypatch.setattr(kraken, "_client", _mock(boom))
    with pytest.raises(kraken.KrakenError):
        kraken.call("GET", "/models")


def test_kraken_models_settings_are_gone():
    assert not hasattr(settings, "kraken_models")
    assert not hasattr(settings, "kraken_models_default")
    import app.config as config_module
    assert not hasattr(config_module, "_parse_kraken_models")
```

- [ ] **Step 2: Run the test, watch it fail**

Run: `python3 -m pytest tests/test_kraken_call.py -q`
Expected: FAIL — `AttributeError: module 'app.kraken' has no attribute '_client'` / `call`, and `test_kraken_models_settings_are_gone` fails because the settings still exist.

- [ ] **Step 3: Implement `kraken.call`**

In `app/kraken.py`, add below `_headers()`:

```python
def _client(timeout: float) -> httpx.Client:
    """Client factory — a seam so tests can inject an httpx.MockTransport."""
    return httpx.Client(timeout=timeout)


def call(method: str, path: str, *, json_body: dict | None = None,
         params: dict | None = None, timeout: float = 30.0) -> httpx.Response:
    """One call to the Kraken service with the API-key header. Raises KrakenError
    on transport failure or a 5xx; returns the Response otherwise (callers inspect
    4xx themselves)."""
    url = f"{settings.kraken_api_url}{path}"
    try:
        with _client(timeout) as client:
            resp = client.request(method, url, json=json_body, params=params,
                                  headers=_headers())
    except httpx.HTTPError as exc:
        raise KrakenError(f"Kraken {method} {path} injoignable: {exc}") from exc
    if resp.status_code >= 500:
        raise KrakenError(f"Kraken {method} {path} a répondu {resp.status_code}")
    return resp
```

- [ ] **Step 4: Remove the E2 env whitelist from `app/config.py`**

Delete lines 12-36 (the whole `_parse_kraken_models` function) and lines 61-62:

```python
    kraken_models: list = _parse_kraken_models(os.getenv("KRAKEN_MODELS", ""))
    kraken_models_default: str = os.getenv("KRAKEN_MODELS_DEFAULT", "")
```

Keep `kraken_api_url`, `kraken_api_key`, `kraken_timeout` exactly as they are.

- [ ] **Step 5: Delete the dead E2 test file**

```bash
git rm tests/test_ocr_config.py
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `python3 -m pytest tests/test_kraken_call.py -q`
Expected: PASS (6 tests).

`python3 -m pytest -q` will now FAIL in `tests/test_ocr_models.py`, `tests/test_admin_ocr_get.py`, `tests/test_admin_ocr_put.py`, `tests/test_ocr_timing.py` (they monkeypatch the removed settings). That is expected — Tasks 2, 3, 4 and 6 replace them. Do not "fix" them by re-adding the settings.

- [ ] **Step 7: Commit**

```bash
git checkout -b feat/e3b-model-management
git add app/kraken.py app/config.py tests/test_kraken_call.py tests/test_ocr_config.py
git commit -m "feat(ocr): generic kraken.call() helper; drop the KRAKEN_MODELS env whitelist

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01794AvRAdj2qajTHv6EmChu"
```

---

### Task 2: Rewrite `app/ocr_models.py` — live model list + slug resolution

**Files:**
- Rewrite: `app/ocr_models.py`
- Create: `tests/test_ocr_models_e3.py`
- Delete: `tests/test_ocr_models.py` (E2 env-whitelist version, superseded)

**Interfaces:**
- Consumes: `kraken.call` (Task 1).
- Produces:
  - `list_models(force=False) -> list[dict]` — `GET {kraken}/models`, 60 s process cache, raises `KrakenError` on failure.
  - `get_model(slug) -> dict | None`
  - `_safe_list() -> list[dict]` — `list_models()` swallowing `KrakenError` → `[]`.
  - `resolve_active(db) -> {"key": str, "rec_path": str | None, "seg_path": None}`
  - `active_slug(db) -> str`
  - `active_source(db) -> "setting" | "fallback"`
  - `set_active(db, slug, admin) -> None` (raises `ValueError` on unknown slug; does not commit; busts the cache)
  - `invalidate() -> None` — cache bust, used by `set_active`, the DELETE route, and the test fixtures.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_ocr_models_e3.py
import httpx
import pytest

from app import kraken, ocr_models
from app.models import AdminAuditLog, AppSetting
from tests.conftest import make_user

MODELS = [
    {"slug": "rec", "protected": True, "doi": None,
     "summary": "Modèle de reconnaissance baké par défaut", "script": None,
     "keywords": [], "license": None, "size_bytes": 4096},
    {"slug": "rec-21788409", "protected": False, "doi": "10.5281/zenodo.21788409",
     "summary": "French 18C cursive", "script": "Latn", "keywords": ["french"],
     "license": "CC-BY-4.0", "size_bytes": 128},
]


@pytest.fixture(autouse=True)
def _clean_cache():
    ocr_models.invalidate()
    yield
    ocr_models.invalidate()


@pytest.fixture()
def kraken_models(monkeypatch):
    """Stub kraken.call for GET /models. `state` lets a test change the payload
    or make the call blow up, and counts the calls (for the cache tests)."""
    state = {"models": [dict(m) for m in MODELS], "error": None, "calls": 0}

    def fake_call(method, path, *, json_body=None, params=None, timeout=30.0):
        state["calls"] += 1
        if state["error"] is not None:
            raise state["error"]
        assert (method, path) == ("GET", "/models")
        return httpx.Response(200, json={"models": state["models"]})

    monkeypatch.setattr(kraken, "call", fake_call)
    return state


def test_list_models_hits_kraken(kraken_models):
    out = ocr_models.list_models()
    assert [m["slug"] for m in out] == ["rec", "rec-21788409"]
    assert kraken_models["calls"] == 1


def test_list_models_is_cached_for_60s(kraken_models):
    ocr_models.list_models()
    ocr_models.list_models()
    ocr_models.list_models()
    assert kraken_models["calls"] == 1


def test_force_bypasses_the_cache(kraken_models):
    ocr_models.list_models()
    ocr_models.list_models(force=True)
    assert kraken_models["calls"] == 2


def test_cache_expires_after_ttl(kraken_models, monkeypatch):
    ocr_models.list_models()
    now = ocr_models._CACHE["at"]
    monkeypatch.setattr(ocr_models.time, "monotonic", lambda: now + ocr_models._TTL + 1)
    ocr_models.list_models()
    assert kraken_models["calls"] == 2


def test_list_models_raises_on_kraken_error(kraken_models):
    kraken_models["error"] = kraken.KrakenError("down")
    with pytest.raises(kraken.KrakenError):
        ocr_models.list_models()


def test_list_models_raises_on_unexpected_status(monkeypatch):
    monkeypatch.setattr(kraken, "call",
                        lambda *a, **k: httpx.Response(404, json={"detail": "nope"}))
    with pytest.raises(kraken.KrakenError):
        ocr_models.list_models()


def test_get_model(kraken_models):
    assert ocr_models.get_model("rec-21788409")["script"] == "Latn"
    assert ocr_models.get_model("nope") is None


def test_resolve_active_falls_back_to_rec_when_unset(db, kraken_models):
    assert ocr_models.resolve_active(db) == {"key": "rec", "rec_path": None, "seg_path": None}
    assert ocr_models.active_slug(db) == "rec"
    assert ocr_models.active_source(db) == "fallback"


def test_resolve_active_uses_the_stored_slug(db, kraken_models):
    db.add(AppSetting(key="ocr_model", value="rec-21788409"))
    db.commit()
    assert ocr_models.resolve_active(db) == {
        "key": "rec-21788409",
        "rec_path": "/models/rec-21788409.mlmodel",
        "seg_path": None,
    }
    assert ocr_models.active_slug(db) == "rec-21788409"
    assert ocr_models.active_source(db) == "setting"


def test_stored_slug_that_vanished_falls_back(db, kraken_models):
    db.add(AppSetting(key="ocr_model", value="rec-deleted"))
    db.commit()
    assert ocr_models.resolve_active(db)["key"] == "rec"
    assert ocr_models.active_source(db) == "fallback"


def test_resolve_active_degrades_when_kraken_is_down(db, kraken_models):
    db.add(AppSetting(key="ocr_model", value="rec-21788409"))
    db.commit()
    kraken_models["error"] = kraken.KrakenError("down")
    assert ocr_models.resolve_active(db) == {"key": "rec", "rec_path": None, "seg_path": None}
    assert ocr_models.active_slug(db) == "rec"


def test_set_active_rejects_an_unknown_slug(db, kraken_models):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    with pytest.raises(ValueError):
        ocr_models.set_active(db, "rec-bogus", admin)


def test_set_active_writes_setting_and_audit_and_busts_cache(db, kraken_models):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    ocr_models.list_models()
    ocr_models.set_active(db, "rec-21788409", admin)
    db.commit()
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "rec-21788409"
    row = db.query(AdminAuditLog).filter_by(event="ocr.model_change").one()
    assert row.actor_user_id == admin.id
    assert row.path == "/api/admin/ocr/model"
    assert ocr_models._CACHE["models"] is None
    ocr_models.list_models()
    assert kraken_models["calls"] == 3  # list, set_active's validation, post-bust list


def test_set_active_upserts(db, kraken_models):
    admin = make_user(db, email="a@test.fr", is_admin=True)
    ocr_models.set_active(db, "rec-21788409", admin); db.commit()
    ocr_models.set_active(db, "rec", admin); db.commit()
    assert db.query(AppSetting).filter_by(key="ocr_model").count() == 1
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "rec"


def test_list_models_returns_copies(kraken_models):
    out = ocr_models.list_models()
    out[0]["slug"] = "mutated"
    assert ocr_models.list_models()[0]["slug"] == "rec"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 -m pytest tests/test_ocr_models_e3.py -q`
Expected: FAIL — `AttributeError: module 'app.ocr_models' has no attribute 'invalidate'`.

- [ ] **Step 3: Implement — replace `app/ocr_models.py` entirely**

```python
"""Live Kraken model list + active-model resolution (Phase E3-B).

The model list is whatever `GET {kraken}/models` returns (E3-A), cached 60 s in
process. `AppSetting['ocr_model']` stores a model slug; recognition only — the
segmentation model is always Kraken's baked default.
"""
import time

from sqlalchemy.orm import Session

from . import kraken
from .models import AdminAuditLog, AppSetting

_CACHE: dict = {"models": None, "at": 0.0}
_TTL = 60
_SETTING_KEY = "ocr_model"
_DEFAULT_SLUG = "rec"


def invalidate() -> None:
    _CACHE["models"] = None
    _CACHE["at"] = 0.0


def list_models(force: bool = False) -> list[dict]:
    """GET {kraken}/models, cached 60 s. Raises KrakenError on failure."""
    now = time.monotonic()
    if not force and _CACHE["models"] is not None and now - _CACHE["at"] < _TTL:
        return [dict(m) for m in _CACHE["models"]]
    resp = kraken.call("GET", "/models")
    if resp.status_code != 200:
        raise kraken.KrakenError(f"Kraken GET /models a répondu {resp.status_code}")
    models = resp.json().get("models") or []
    _CACHE["models"] = models
    _CACHE["at"] = now
    return [dict(m) for m in models]


def _safe_list() -> list[dict]:
    """list_models() but never raises — for the OCR enqueue path."""
    try:
        return list_models()
    except kraken.KrakenError as exc:
        print(f"ocr_models: liste Kraken indisponible ({exc}) — repli sur le modèle baké")
        return []


def get_model(slug: str) -> dict | None:
    return next((m for m in _safe_list() if m["slug"] == slug), None)


def _setting_value(db: Session) -> str | None:
    row = db.query(AppSetting).filter_by(key=_SETTING_KEY).one_or_none()
    return row.value if row else None


def _valid_stored_slug(db: Session) -> str | None:
    val = _setting_value(db)
    if not val:
        return None
    return val if any(m["slug"] == val for m in _safe_list()) else None


def resolve_active(db: Session) -> dict:
    """{key, rec_path, seg_path}. seg_path is always None (recognition-only)."""
    slug = _valid_stored_slug(db)
    if slug:
        return {"key": slug, "rec_path": f"/models/{slug}.mlmodel", "seg_path": None}
    return {"key": _DEFAULT_SLUG, "rec_path": None, "seg_path": None}


def active_slug(db: Session) -> str:
    return _valid_stored_slug(db) or _DEFAULT_SLUG


def active_source(db: Session) -> str:
    return "setting" if _valid_stored_slug(db) else "fallback"


def set_active(db: Session, slug: str, admin) -> None:
    """Validate against the live list, upsert AppSetting, audit. Does not commit."""
    if not any(m["slug"] == slug for m in list_models(force=True)):
        raise ValueError(f"Modèle inconnu: {slug}")
    row = db.query(AppSetting).filter_by(key=_SETTING_KEY).one_or_none()
    if row:
        row.value = slug
        row.updated_by = admin.id
    else:
        db.add(AppSetting(key=_SETTING_KEY, value=slug, updated_by=admin.id))
    db.add(AdminAuditLog(
        actor_user_id=admin.id, target_user_id=None,
        event="ocr.model_change", method="PUT",
        path="/api/admin/ocr/model", status_code=200))
    invalidate()
```

Note on `test_set_active_writes_setting_and_audit_and_busts_cache`'s call count: `list_models()` = 1, `set_active`'s `list_models(force=True)` = 2, the post-bust `list_models()` = 3. `set_active` uses `force=True` so a switch to a model pulled less than 60 s ago is never rejected by a stale cache.

- [ ] **Step 4: Delete the E2 test file**

```bash
git rm tests/test_ocr_models.py
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `python3 -m pytest tests/test_ocr_models_e3.py -q`
Expected: PASS (15 tests).

- [ ] **Step 6: Commit**

```bash
git add app/ocr_models.py tests/test_ocr_models_e3.py tests/test_ocr_models.py
git commit -m "feat(ocr): resolve the active model from the live Kraken list (slug-based, 60s cache)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01794AvRAdj2qajTHv6EmChu"
```

---

### Task 3: `ocr_service.py` — recognition-only enqueue payload

**Files:**
- Modify: `app/ocr_service.py` (comment only — the code already reads `model["seg_path"]`)
- Modify: `tests/test_ocr_timing.py` (E2 fixtures → the new shape)

**Interfaces:**
- Consumes: `ocr_models.resolve_active` (Task 2).
- Produces: no signature change. `enqueue_page_ocr` keeps emitting `{page_id, kind, model_key, seg_model_path, rec_model_path}`; `seg_model_path` is now always `None`, so `kraken.submit_ocr` drops the form field (it already filters falsy values at `app/kraken.py:19-20`).

- [ ] **Step 1: Update the E2 timing test to the new shape**

Replace the `_whitelist` autouse fixture at the top of `tests/test_ocr_timing.py`:

```python
import httpx
import pytest

from app import kraken, ocr_models, ocr_service
from app.models import AppSetting, Document, Page
from tests.conftest import make_user

_MODELS = [
    {"slug": "rec", "protected": True, "doi": None, "summary": "", "script": None,
     "keywords": [], "license": None, "size_bytes": 4096},
    {"slug": "rec-21788409", "protected": False, "doi": "10.5281/zenodo.21788409",
     "summary": "French 18C", "script": "Latn", "keywords": [], "license": None,
     "size_bytes": 128},
]


@pytest.fixture(autouse=True)
def _kraken_models(monkeypatch):
    ocr_models.invalidate()
    monkeypatch.setattr(
        kraken, "call",
        lambda method, path, **kw: httpx.Response(200, json={"models": _MODELS}))
    yield
    ocr_models.invalidate()
```

(Delete the old `from app.config import settings` import and the whole `_whitelist` fixture.)

Rewrite `test_enqueue_puts_model_in_payload` so it exercises both the stored-slug and fallback branches:

```python
def test_enqueue_puts_the_active_slug_in_the_payload(db, monkeypatch):
    captured = {}

    class _Q:
        def enqueue(self, fn, payload, **kw):
            captured.update(payload)

            class J:
                id = "j1"

            return J()

    monkeypatch.setattr("rq.Queue", lambda *a, **k: _Q())
    monkeypatch.setattr("redis.Redis.from_url", lambda *a, **k: object())
    db.add(AppSetting(key="ocr_model", value="rec-21788409"))
    db.commit()
    _, pages = _make_page(db)
    ocr_service.enqueue_page_ocr(db, pages[0])
    assert captured["model_key"] == "rec-21788409"
    assert captured["seg_model_path"] is None
    assert captured["rec_model_path"] == "/models/rec-21788409.mlmodel"


def test_enqueue_falls_back_to_the_baked_rec_model(db, monkeypatch):
    captured = {}

    class _Q:
        def enqueue(self, fn, payload, **kw):
            captured.update(payload)

            class J:
                id = "j1"

            return J()

    monkeypatch.setattr("rq.Queue", lambda *a, **k: _Q())
    monkeypatch.setattr("redis.Redis.from_url", lambda *a, **k: object())
    _, pages = _make_page(db)
    ocr_service.enqueue_page_ocr(db, pages[0])
    assert captured["model_key"] == "rec"
    assert captured["seg_model_path"] is None
    assert captured["rec_model_path"] is None
```

In the three `run_ocr_job` tests (`test_image_ocr_stamps_timing`, `test_pdf_ocr_stamps_all_siblings_with_batch_size`, `test_failed_ocr_still_stamps_timing_and_refunds`), change every hand-written payload from

```python
        "model_key": "rapide",
        "seg_model_path": "/m/seg.mlmodel", "rec_model_path": "/m/rec-fast.mlmodel",
```
to
```python
        "model_key": "rec-21788409",
        "seg_model_path": None, "rec_model_path": "/models/rec-21788409.mlmodel",
```
and update the corresponding assertions (`p.ocr_model_key == "rec-21788409"`, `captured["seg_model_path"] is None`, `captured["rec_model_path"] == "/models/rec-21788409.mlmodel"`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 -m pytest tests/test_ocr_timing.py -q`
Expected: FAIL only on `test_enqueue_falls_back_to_the_baked_rec_model` / the slug assertions if Task 2 was skipped; with Task 2 done, this step should already be green — run it to confirm the E2 behaviour survived the rewrite. If anything fails, the bug is in Task 2's `resolve_active`, not here.

- [ ] **Step 3: Add the recognition-only note in `app/ocr_service.py`**

In `enqueue_page_ocr`, above the `payload = {` literal (currently `app/ocr_service.py:78`), add exactly one line:

```python
    # seg_path is always None since E3-B: Kraken uses its baked /models/seg.mlmodel.
```

No other change to this file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `python3 -m pytest tests/test_ocr_timing.py tests/test_kraken_submit_models.py -q`
Expected: PASS (`test_ocr_timing.py` 5 tests, `test_kraken_submit_models.py` 2 tests — the latter is unchanged and still proves a `None` seg path is dropped from the multipart body).

- [ ] **Step 5: Commit**

```bash
git add app/ocr_service.py tests/test_ocr_timing.py
git commit -m "refactor(ocr): recognition-only enqueue payload (seg model is always Kraken's baked one)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01794AvRAdj2qajTHv6EmChu"
```

---

### Task 4: `GET /api/admin/ocr` — `local_models`, `active_slug`, `kraken_error`

**Files:**
- Modify: `app/main.py`
- Create: `tests/test_admin_ocr_e3.py` (this task adds the panel cases; Tasks 5 and 6 append to the same file)
- Modify: `tests/test_admin_ocr_get.py` (E2 fixtures → new shape)

**Interfaces:**
- Consumes: `ocr_models.list_models`, `ocr_models.active_slug`, `ocr_models.resolve_active`, `ocr_models.active_source`.
- Produces: the `GET /api/admin/ocr` response gains `local_models` (replacing the E2 `models` key), `active_slug`, and `kraken_error`; `active_key`, `active_source`, `recent`, `aggregates` are byte-for-byte the E2 values.
- Produces: `_kraken_proxy(method, path, **kw) -> dict` in `app/main.py`, used by Tasks 5 and 6.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_admin_ocr_e3.py
import httpx
import pytest

from app import kraken, ocr_models
from app.models import AppSetting
from tests.conftest import auth_headers, make_user

LOCAL_MODELS = [
    {"slug": "rec", "protected": True, "doi": None,
     "summary": "Modèle de reconnaissance baké par défaut", "script": None,
     "keywords": [], "license": None, "size_bytes": 4096},
    {"slug": "rec-21788409", "protected": False, "doi": "10.5281/zenodo.21788409",
     "summary": "French 18C cursive", "script": "Latn", "keywords": ["french"],
     "license": "CC-BY-4.0", "size_bytes": 128},
]

CATALOG = {
    "cached_at": "2026-09-05T08:00:00+00:00", "stale": False, "refreshing": False,
    "models": [{"doi": "10.5281/zenodo.1", "summary": "m1", "script": "Latn",
                "keywords": ["k"], "license": "CC-BY-4.0", "already_local": False}],
}


@pytest.fixture(autouse=True)
def _clean_cache():
    ocr_models.invalidate()
    yield
    ocr_models.invalidate()


@pytest.fixture()
def kstub(monkeypatch):
    """Record every proxied call and serve canned Kraken responses.

    `routes[(method, path)]` is either an (status, json) tuple or an Exception
    to raise. Unregistered paths 404; `GET /models` is registered by default."""
    calls: list[dict] = []
    routes: dict[tuple[str, str], object] = {
        ("GET", "/models"): (200, {"models": LOCAL_MODELS}),
    }

    def fake_call(method, path, *, json_body=None, params=None, timeout=30.0):
        calls.append({"method": method, "path": path, "json": json_body,
                      "params": params})
        entry = routes.get((method, path))
        if isinstance(entry, Exception):
            raise entry
        if entry is None:
            return httpx.Response(404, json={"detail": "not found"})
        status, body = entry
        return httpx.Response(status, json=body)

    monkeypatch.setattr(kraken, "call", fake_call)

    class _Stub:
        pass

    stub = _Stub()
    stub.calls = calls
    stub.routes = routes
    return stub


def _admin(db):
    return make_user(db, email="a@test.fr", is_admin=True)


def test_panel_exposes_local_models_and_active_slug(client, db, kstub):
    admin = _admin(db)
    r = client.get("/api/admin/ocr", headers=auth_headers(db, admin))
    assert r.status_code == 200
    body = r.json()
    assert [m["slug"] for m in body["local_models"]] == ["rec", "rec-21788409"]
    assert body["active_slug"] == "rec"
    assert body["active_key"] == "rec"
    assert body["active_source"] == "fallback"
    assert body["kraken_error"] is None
    assert "models" not in body           # the E2 env-whitelist key is gone
    assert body["recent"] == [] and body["aggregates"] == []


def test_panel_reflects_the_stored_slug(client, db, kstub):
    admin = _admin(db)
    db.add(AppSetting(key="ocr_model", value="rec-21788409"))
    db.commit()
    body = client.get("/api/admin/ocr", headers=auth_headers(db, admin)).json()
    assert body["active_slug"] == "rec-21788409"
    assert body["active_source"] == "setting"


def test_panel_survives_a_kraken_outage(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("GET", "/models")] = kraken.KrakenError("down")
    r = client.get("/api/admin/ocr", headers=auth_headers(db, admin))
    assert r.status_code == 200
    body = r.json()
    assert body["local_models"] == []
    assert body["kraken_error"] == "Service Kraken injoignable"
    assert body["active_slug"] == "rec"
    assert "aggregates" in body and "recent" in body


def test_panel_requires_admin(client, db, kstub):
    u = make_user(db, email="u@test.fr")
    assert client.get("/api/admin/ocr", headers=auth_headers(db, u)).status_code == 403
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 -m pytest tests/test_admin_ocr_e3.py -q`
Expected: FAIL — `KeyError: 'local_models'` (the route still returns the E2 `models` key) and a 500 in the outage case (`list_models` raises through the route).

- [ ] **Step 3: Implement**

In `app/main.py`, add the proxy helper just above `@app.get("/api/admin/ocr")` (currently line 1080):

```python
def _kraken_proxy(method: str, path: str, **kw) -> dict:
    """Relay one call to the Kraken model-management API. Transport failure or a
    5xx → 502; a 4xx is relayed with Kraken's own status + detail."""
    try:
        resp = kraken.call(method, path, **kw)
    except kraken.KrakenError:
        raise HTTPException(status_code=502, detail="Service Kraken injoignable")
    try:
        body = resp.json()
    except ValueError:
        body = {"detail": resp.text[:300]}
    if resp.status_code >= 400:
        detail = body.get("detail") if isinstance(body, dict) else None
        raise HTTPException(status_code=resp.status_code,
                            detail=detail or f"Kraken a répondu {resp.status_code}")
    return body
```

In `admin_ocr`, replace the first statement after the `timedelta` import:

```python
    active = ocr_models.resolve_active(db)
```
with
```python
    try:
        local_models = ocr_models.list_models()
        kraken_error = None
    except kraken.KrakenError:
        local_models = []
        kraken_error = "Service Kraken injoignable"
    # Both read the (now warm or empty) 60 s cache — no second round trip.
    active = ocr_models.resolve_active(db)
```

and replace the return literal (currently lines 1170-1176) with:

```python
    return {
        "local_models": local_models,
        "active_key": active["key"],
        "active_slug": ocr_models.active_slug(db),
        "active_source": ocr_models.active_source(db),
        "kraken_error": kraken_error,
        "recent": recent,
        "aggregates": aggregates,
    }
```

Everything between (`recent_rows`, `_dur`, `conf_by_page`, `aggregates`) is untouched.

- [ ] **Step 4: Update the E2 panel test**

In `tests/test_admin_ocr_get.py`, replace the imports and the `_whitelist` fixture with:

```python
from datetime import datetime, timezone, timedelta
import httpx
import pytest
from app import kraken, ocr_models
from app.models import AppSetting, Page, Document, Transcription
from tests.conftest import make_user, auth_headers

_MODELS = [
    {"slug": "rec", "protected": True, "doi": None, "summary": "", "script": None,
     "keywords": [], "license": None, "size_bytes": 4096},
    {"slug": "rec-21788409", "protected": False, "doi": "10.5281/zenodo.21788409",
     "summary": "French 18C", "script": "Latn", "keywords": [], "license": None,
     "size_bytes": 128},
]


@pytest.fixture(autouse=True)
def _kraken_models(monkeypatch):
    ocr_models.invalidate()
    monkeypatch.setattr(
        kraken, "call",
        lambda method, path, **kw: httpx.Response(200, json={"models": _MODELS}))
    yield
    ocr_models.invalidate()
```

In `test_shape_and_active`, change the model keys used by `_page(...)` from `"défaut"` / `"rapide"` to `"rec"` / `"rec-21788409"`, and the assertions to:

```python
    assert [m["slug"] for m in body["local_models"]] == ["rec", "rec-21788409"]
    assert body["active_key"] == "rec"
    assert body["active_source"] == "fallback"
    ...
    agg = {a["model_key"]: a for a in body["aggregates"]}
    assert agg["rec"]["pages"] == 1
    assert agg["rec-21788409"]["median_s"] == 30.0
```

In the three remaining tests, replace every `key="défaut"` with `key="rec"` and every `key="rapide"` with `key="rec-21788409"` (and the matching `agg[...]` lookups). No other change — the timing/aggregation logic is untouched by E3-B and these tests are the regression guard proving it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python3 -m pytest tests/test_admin_ocr_e3.py tests/test_admin_ocr_get.py -q`
Expected: PASS (4 + 5 tests).

- [ ] **Step 6: Commit**

```bash
git add app/main.py tests/test_admin_ocr_e3.py tests/test_admin_ocr_get.py
git commit -m "feat(ocr): admin panel serves the live Kraken model list, degrades on outage

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01794AvRAdj2qajTHv6EmChu"
```

---

### Task 5: Catalogue proxy routes — `/catalog`, `/catalog/refresh`, `/models/jobs/{id}`

**Files:**
- Modify: `app/main.py`
- Modify: `tests/test_admin_ocr_e3.py` (append)

**Interfaces:**
- Consumes: `_kraken_proxy` (Task 4).
- Produces:
  - `GET /api/admin/ocr/catalog?script=Latn&all=false` → proxies `GET {kraken}/repo` with the same params, relays the body verbatim.
  - `POST /api/admin/ocr/catalog/refresh` → proxies `POST {kraken}/repo/refresh` → `{job_id, status}`, HTTP 202.
  - `GET /api/admin/ocr/models/jobs/{job_id}` → proxies `GET {kraken}/models/jobs/{job_id}`, relays a 404.

- [ ] **Step 1: Write the failing test (append to `tests/test_admin_ocr_e3.py`)**

```python
def test_catalog_proxies_repo_with_params(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("GET", "/repo")] = (200, CATALOG)
    r = client.get("/api/admin/ocr/catalog?script=Grek&all=false",
                   headers=auth_headers(db, admin))
    assert r.status_code == 200
    assert r.json() == CATALOG
    proxied = [c for c in kstub.calls if c["path"] == "/repo"][0]
    assert proxied["method"] == "GET"
    assert proxied["params"] == {"script": "Grek", "all": "false"}


def test_catalog_defaults_to_latn(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("GET", "/repo")] = (200, CATALOG)
    client.get("/api/admin/ocr/catalog", headers=auth_headers(db, admin))
    proxied = [c for c in kstub.calls if c["path"] == "/repo"][0]
    assert proxied["params"] == {"script": "Latn", "all": "false"}


def test_catalog_all_true_is_relayed(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("GET", "/repo")] = (200, CATALOG)
    client.get("/api/admin/ocr/catalog?all=true", headers=auth_headers(db, admin))
    proxied = [c for c in kstub.calls if c["path"] == "/repo"][0]
    assert proxied["params"]["all"] == "true"


def test_catalog_502_when_kraken_is_down(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("GET", "/repo")] = kraken.KrakenError("down")
    r = client.get("/api/admin/ocr/catalog", headers=auth_headers(db, admin))
    assert r.status_code == 502
    assert r.json()["detail"] == "Service Kraken injoignable"


def test_catalog_refresh_proxies_and_returns_202(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("POST", "/repo/refresh")] = (202, {"job_id": "j-ref", "status": "started"})
    r = client.post("/api/admin/ocr/catalog/refresh", headers=auth_headers(db, admin))
    assert r.status_code == 202
    assert r.json() == {"job_id": "j-ref", "status": "started"}
    assert ("POST", "/repo/refresh") in {(c["method"], c["path"]) for c in kstub.calls}


def test_job_status_is_proxied(client, db, kstub):
    admin = _admin(db)
    job = {"kind": "pull", "job_id": "j1", "status": "finished",
           "doi": "10.5281/zenodo.1", "slug": "rec-1", "error": None, "progress": 100}
    kstub.routes[("GET", "/models/jobs/j1")] = (200, job)
    r = client.get("/api/admin/ocr/models/jobs/j1", headers=auth_headers(db, admin))
    assert r.status_code == 200 and r.json() == job


def test_unknown_job_404_is_relayed(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("GET", "/models/jobs/nope")] = (404, {"detail": "Job introuvable"})
    r = client.get("/api/admin/ocr/models/jobs/nope", headers=auth_headers(db, admin))
    assert r.status_code == 404
    assert r.json()["detail"] == "Job introuvable"


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/admin/ocr/catalog"),
    ("POST", "/api/admin/ocr/catalog/refresh"),
    ("GET", "/api/admin/ocr/models/jobs/j1"),
])
def test_catalog_routes_require_admin(client, db, kstub, method, path):
    u = make_user(db, email="u@test.fr")
    assert client.request(method, path, headers=auth_headers(db, u)).status_code == 403
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 -m pytest tests/test_admin_ocr_e3.py -q`
Expected: FAIL — 404 on every new path (routes missing).

- [ ] **Step 3: Implement**

Add `Query` to the FastAPI import at `app/main.py:8`:

```python
from fastapi import Depends, FastAPI, HTTPException, Query, Request, UploadFile
```

Add the three routes immediately after `admin_ocr` (before `@app.put("/api/admin/ocr/model")`):

```python
@app.get("/api/admin/ocr/catalog")
def admin_ocr_catalog(script: str = "Latn", all_: bool = Query(False, alias="all"),
                      admin: User = Depends(get_admin_user)):
    return _kraken_proxy("GET", "/repo",
                         params={"script": script, "all": "true" if all_ else "false"})


@app.post("/api/admin/ocr/catalog/refresh", status_code=202)
def admin_ocr_catalog_refresh(admin: User = Depends(get_admin_user)):
    return _kraken_proxy("POST", "/repo/refresh")


@app.get("/api/admin/ocr/models/jobs/{job_id}")
def admin_ocr_model_job(job_id: str, admin: User = Depends(get_admin_user)):
    return _kraken_proxy("GET", f"/models/jobs/{job_id}")
```

**Task 6 augments this last route** with the pull-completion audit (it gains a `db`
dependency there). Write it in its plain form here so this task's tests stay
focused on the proxying itself.

`all` is passed to Kraken as the literal string `"true"` / `"false"` because httpx serialises a Python `bool` query param as `True` / `False`, which FastAPI on the Kraken side rejects.

- [ ] **Step 4: Run the test to verify it passes**

Run: `python3 -m pytest tests/test_admin_ocr_e3.py -q`
Expected: PASS (4 from Task 4 + 10 here = 14 tests).

- [ ] **Step 5: Commit**

```bash
git add app/main.py tests/test_admin_ocr_e3.py
git commit -m "feat(ocr): proxy the HTRMoPo catalogue + model job status to Kraken

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01794AvRAdj2qajTHv6EmChu"
```

---

### Task 6: Pull, delete and switch — `POST /models`, `DELETE /models/{slug}`, `PUT /model`, pull-completion audit

**Files:**
- Modify: `app/main.py`
- Modify: `tests/test_admin_ocr_e3.py` (append)
- Modify: `tests/test_admin_ocr_put.py` (E2 fixtures → the live list)

**Interfaces:**
- Consumes: `_kraken_proxy`, `ocr_models.active_slug`, `ocr_models.invalidate`, `ocr_models.set_active`.
- Produces:
  - `POST /api/admin/ocr/models` body `{"doi": "..."}` → 202 `{job_id, slug, status}`; relays Kraken's 400/409; writes `AdminAuditLog(event="ocr.model_pull", status_code=202)` on success — the *intent*.
  - `GET /api/admin/ocr/models/jobs/{job_id}` (Task 5, augmented) → when the relayed job is a **terminal pull** (`kind == "pull"` and `status in ("finished", "failed")`), writes one `AdminAuditLog(event="ocr.model_pull_done")` — the *outcome*: `status_code=200` on `finished`, `500` on `failed`. Idempotent: at most one row per `job_id`. On `finished` it also busts the model cache so the new model shows up in the panel immediately.
  - `DELETE /api/admin/ocr/models/{slug}` → 409 when `slug` is the active one (before any Kraken call), else proxies, busts the cache, writes `AdminAuditLog(event="ocr.model_delete", status_code=200)`, returns `{"deleted": slug}`.
  - `PUT /api/admin/ocr/model` (E2, kept) → now validates against the live list; `ValueError` → 400, `KrakenError` → 502.
  - `class ModelPullIn(BaseModel): doi: str`.

**Why the audit lands in the job-status route, not elsewhere.** Three mechanisms were possible: (a) the SPA posts the outcome back, (b) a Kraken → Palimora webhook, (c) Palimora records it as it proxies the poll. (a) trusts a client-reported result for an audit row — unacceptable. (b) needs an E3-A change, and E3-A is frozen. (c) needs no new route and no Kraken change: the SPA already polls this endpoint every 3 s until the job resolves (Task 8's `pollJob`), so Palimora sees the terminal transition first-hand, in the proxied response body, and the row is written from Kraken's own payload. Idempotency comes from a uniqueness check on `path`, so refreshing the panel mid-poll or two admins watching the same pull still produce exactly one row.

**Caveat to state at handoff:** the outcome row is only written while somebody is polling. A pull whose admin closes the tab before it finishes gets its `ocr.model_pull` intent row but no `ocr.model_pull_done` row until someone next polls that `job_id` (E3-A keeps the job file, so a later poll still records it). Closing that gap entirely would need the webhook, i.e. an E3-A change — out of scope here.

- [ ] **Step 1: Write the failing test (append to `tests/test_admin_ocr_e3.py`)**

```python
def test_pull_proxies_and_audits(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("POST", "/models")] = (
        202, {"job_id": "j-pull", "slug": "rec-1", "status": "started"})
    r = client.post("/api/admin/ocr/models", json={"doi": "10.5281/zenodo.1"},
                    headers=auth_headers(db, admin))
    assert r.status_code == 202
    assert r.json() == {"job_id": "j-pull", "slug": "rec-1", "status": "started"}
    proxied = [c for c in kstub.calls if c["path"] == "/models" and c["method"] == "POST"][0]
    assert proxied["json"] == {"doi": "10.5281/zenodo.1"}
    db.expire_all()
    row = db.query(AdminAuditLog).filter_by(event="ocr.model_pull").one()
    assert row.actor_user_id == admin.id
    assert row.path == "/api/admin/ocr/models"
    assert row.status_code == 202


def test_pull_relays_a_409_and_writes_no_audit(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("POST", "/models")] = (409, {"detail": "Modèle déjà présent"})
    r = client.post("/api/admin/ocr/models", json={"doi": "10.5281/zenodo.1"},
                    headers=auth_headers(db, admin))
    assert r.status_code == 409
    assert r.json()["detail"] == "Modèle déjà présent"
    db.expire_all()
    assert db.query(AdminAuditLog).filter_by(event="ocr.model_pull").count() == 0


def test_pull_relays_a_400(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("POST", "/models")] = (400, {"detail": "DOI Zenodo invalide"})
    r = client.post("/api/admin/ocr/models", json={"doi": "nope"},
                    headers=auth_headers(db, admin))
    assert r.status_code == 400
    assert r.json()["detail"] == "DOI Zenodo invalide"


def test_finished_pull_job_writes_a_completion_audit_and_busts_the_cache(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("GET", "/models/jobs/j-ok")] = (200, {
        "kind": "pull", "job_id": "j-ok", "status": "finished",
        "doi": "10.5281/zenodo.1", "slug": "rec-1", "error": None, "progress": 100})
    ocr_models.list_models()  # warm the cache
    r = client.get("/api/admin/ocr/models/jobs/j-ok", headers=auth_headers(db, admin))
    assert r.status_code == 200 and r.json()["status"] == "finished"
    assert ocr_models._CACHE["models"] is None
    db.expire_all()
    row = db.query(AdminAuditLog).filter_by(event="ocr.model_pull_done").one()
    assert row.actor_user_id == admin.id
    assert row.path == "/api/admin/ocr/models/jobs/j-ok"
    assert row.status_code == 200


def test_failed_pull_job_writes_a_500_completion_audit(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("GET", "/models/jobs/j-bad")] = (200, {
        "kind": "pull", "job_id": "j-bad", "status": "failed",
        "doi": "10.5281/zenodo.1", "slug": "rec-1",
        "error": "pas un modèle de reconnaissance", "progress": 0})
    r = client.get("/api/admin/ocr/models/jobs/j-bad", headers=auth_headers(db, admin))
    assert r.status_code == 200
    db.expire_all()
    row = db.query(AdminAuditLog).filter_by(event="ocr.model_pull_done").one()
    assert row.status_code == 500
    assert row.path == "/api/admin/ocr/models/jobs/j-bad"


def test_completion_audit_is_written_once_per_job(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("GET", "/models/jobs/j-ok")] = (200, {
        "kind": "pull", "job_id": "j-ok", "status": "finished",
        "doi": "10.5281/zenodo.1", "slug": "rec-1", "error": None, "progress": 100})
    for _ in range(3):
        client.get("/api/admin/ocr/models/jobs/j-ok", headers=auth_headers(db, admin))
    db.expire_all()
    assert db.query(AdminAuditLog).filter_by(event="ocr.model_pull_done").count() == 1


def test_a_running_pull_job_writes_no_completion_audit(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("GET", "/models/jobs/j-run")] = (200, {
        "kind": "pull", "job_id": "j-run", "status": "started",
        "doi": "10.5281/zenodo.1", "slug": "rec-1", "error": None, "progress": 42})
    ocr_models.list_models()
    client.get("/api/admin/ocr/models/jobs/j-run", headers=auth_headers(db, admin))
    db.expire_all()
    assert db.query(AdminAuditLog).filter_by(event="ocr.model_pull_done").count() == 0
    assert ocr_models._CACHE["models"] is not None  # cache untouched mid-pull


def test_a_refresh_job_writes_no_pull_audit(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("GET", "/models/jobs/j-ref")] = (200, {
        "kind": "refresh", "job_id": "j-ref", "status": "finished",
        "error": None, "count": 12})
    client.get("/api/admin/ocr/models/jobs/j-ref", headers=auth_headers(db, admin))
    db.expire_all()
    assert db.query(AdminAuditLog).filter_by(event="ocr.model_pull_done").count() == 0


def test_delete_refuses_the_active_model_without_calling_kraken(client, db, kstub):
    admin = _admin(db)
    db.add(AppSetting(key="ocr_model", value="rec-21788409"))
    db.commit()
    r = client.delete("/api/admin/ocr/models/rec-21788409",
                      headers=auth_headers(db, admin))
    assert r.status_code == 409
    assert "actif" in r.json()["detail"].lower()
    assert ("DELETE", "/models/rec-21788409") not in {
        (c["method"], c["path"]) for c in kstub.calls}


def test_delete_proxies_audits_and_busts_the_cache(client, db, kstub):
    from app.models import AdminAuditLog
    admin = _admin(db)
    kstub.routes[("DELETE", "/models/rec-21788409")] = (200, {"deleted": "rec-21788409"})
    ocr_models.list_models()  # warm the cache
    r = client.delete("/api/admin/ocr/models/rec-21788409",
                      headers=auth_headers(db, admin))
    assert r.status_code == 200
    assert r.json() == {"deleted": "rec-21788409"}
    assert ocr_models._CACHE["models"] is None
    db.expire_all()
    row = db.query(AdminAuditLog).filter_by(event="ocr.model_delete").one()
    assert row.path == "/api/admin/ocr/models/rec-21788409"
    assert row.status_code == 200


def test_delete_relays_krakens_protected_409(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("DELETE", "/models/rec")] = (409, {"detail": "Modèle protégé"})
    db.add(AppSetting(key="ocr_model", value="rec-21788409"))
    db.commit()
    r = client.delete("/api/admin/ocr/models/rec", headers=auth_headers(db, admin))
    assert r.status_code == 409
    assert r.json()["detail"] == "Modèle protégé"


def test_delete_relays_a_404(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("DELETE", "/models/rec-404")] = (404, {"detail": "Modèle introuvable"})
    r = client.delete("/api/admin/ocr/models/rec-404", headers=auth_headers(db, admin))
    assert r.status_code == 404


def test_put_model_accepts_a_live_slug(client, db, kstub):
    admin = _admin(db)
    r = client.put("/api/admin/ocr/model", json={"key": "rec-21788409"},
                   headers=auth_headers(db, admin))
    assert r.status_code == 200
    assert r.json() == {"active_key": "rec-21788409"}
    db.expire_all()
    assert db.query(AppSetting).filter_by(key="ocr_model").one().value == "rec-21788409"


def test_put_model_rejects_an_unknown_slug(client, db, kstub):
    admin = _admin(db)
    r = client.put("/api/admin/ocr/model", json={"key": "rec-bogus"},
                   headers=auth_headers(db, admin))
    assert r.status_code == 400
    assert "rec-bogus" in r.json()["detail"]


def test_put_model_502_when_kraken_is_down(client, db, kstub):
    admin = _admin(db)
    kstub.routes[("GET", "/models")] = kraken.KrakenError("down")
    r = client.put("/api/admin/ocr/model", json={"key": "rec-21788409"},
                   headers=auth_headers(db, admin))
    assert r.status_code == 502


@pytest.mark.parametrize("method,path,body", [
    ("POST", "/api/admin/ocr/models", {"doi": "10.5281/zenodo.1"}),
    ("DELETE", "/api/admin/ocr/models/rec-1", None),
    ("PUT", "/api/admin/ocr/model", {"key": "rec"}),
])
def test_write_routes_require_admin(client, db, kstub, method, path, body):
    u = make_user(db, email="u@test.fr")
    r = client.request(method, path, json=body, headers=auth_headers(db, u))
    assert r.status_code == 403


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/admin/ocr", None),
    ("GET", "/api/admin/ocr/catalog", None),
    ("POST", "/api/admin/ocr/catalog/refresh", None),
    ("POST", "/api/admin/ocr/models", {"doi": "10.5281/zenodo.1"}),
    ("DELETE", "/api/admin/ocr/models/rec-1", None),
    ("PUT", "/api/admin/ocr/model", {"key": "rec"}),
])
def test_every_ocr_route_403_during_impersonation(client, db, kstub, method, path, body):
    admin = _admin(db)
    target = make_user(db, email="t@test.fr")
    headers = {**auth_headers(db, admin), "X-Impersonate": target.id}
    assert client.request(method, path, json=body, headers=headers).status_code == 403
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 -m pytest tests/test_admin_ocr_e3.py -q`
Expected: FAIL — 404/405 on `POST /api/admin/ocr/models` and `DELETE /api/admin/ocr/models/{slug}`; the five completion-audit cases fail with `NoResultFound` (no row is written); `test_put_model_502_when_kraken_is_down` returns 500 (the `KrakenError` escapes the PUT handler).

- [ ] **Step 3: Implement**

Add the pull payload model next to `OcrModelIn` (`app/main.py:225`):

```python
class ModelPullIn(BaseModel):
    doi: str
```

Replace the Task 5 `admin_ocr_model_job` route with the audited version:

```python
@app.get("/api/admin/ocr/models/jobs/{job_id}")
def admin_ocr_model_job(job_id: str, db: Session = Depends(get_db),
                        admin: User = Depends(get_admin_user)):
    job = _kraken_proxy("GET", f"/models/jobs/{job_id}")
    _audit_pull_outcome(db, admin, job_id, job)
    return job
```

and add its helper just below `_kraken_proxy`:

```python
def _audit_pull_outcome(db: Session, admin: User, job_id: str, job: dict) -> None:
    """Record the real outcome of a pull, once, as the SPA polls it through us.

    The pull's 202 only logs the intent; this is the counter-entry. Written from
    Kraken's own job payload (never from a client-reported result), and guarded
    on the audit path so repeated polls, a page refresh, or two admins watching
    the same pull still produce exactly one row."""
    if not isinstance(job, dict) or job.get("kind") != "pull":
        return
    status = job.get("status")
    if status not in ("finished", "failed"):
        return
    path = f"/api/admin/ocr/models/jobs/{job_id}"
    already = (
        db.query(AdminAuditLog)
        .filter_by(event="ocr.model_pull_done", path=path)
        .first()
    )
    if already:
        return
    if status == "finished":
        # The new model is on the volume now — don't make the panel wait out the TTL.
        ocr_models.invalidate()
    db.add(AdminAuditLog(
        actor_user_id=admin.id, target_user_id=None,
        event="ocr.model_pull_done", method="GET", path=path,
        status_code=200 if status == "finished" else 500))
    db.commit()
```

Add the two new routes after `admin_ocr_model_job`, and replace the existing `admin_set_ocr_model` body:

```python
@app.post("/api/admin/ocr/models", status_code=202)
def admin_pull_ocr_model(payload: ModelPullIn, db: Session = Depends(get_db),
                         admin: User = Depends(get_admin_user)):
    body = _kraken_proxy("POST", "/models", json_body={"doi": payload.doi.strip()},
                         timeout=60.0)
    db.add(AdminAuditLog(
        actor_user_id=admin.id, target_user_id=None,
        event="ocr.model_pull", method="POST",
        path="/api/admin/ocr/models", status_code=202))
    db.commit()
    return body


@app.delete("/api/admin/ocr/models/{slug}")
def admin_delete_ocr_model(slug: str, db: Session = Depends(get_db),
                           admin: User = Depends(get_admin_user)):
    if slug == ocr_models.active_slug(db):
        raise HTTPException(
            status_code=409,
            detail="Modèle actif, impossible de supprimer. "
                   "Change le modèle actif d'abord.")
    body = _kraken_proxy("DELETE", f"/models/{slug}")
    ocr_models.invalidate()
    db.add(AdminAuditLog(
        actor_user_id=admin.id, target_user_id=None,
        event="ocr.model_delete", method="DELETE",
        path=f"/api/admin/ocr/models/{slug}", status_code=200))
    db.commit()
    return body


@app.put("/api/admin/ocr/model")
def admin_set_ocr_model(payload: OcrModelIn, db: Session = Depends(get_db),
                        admin: User = Depends(get_admin_user)):
    try:
        ocr_models.set_active(db, payload.key, admin)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except kraken.KrakenError:
        raise HTTPException(status_code=502, detail="Service Kraken injoignable")
    db.commit()
    return {"active_key": payload.key}
```

`_kraken_proxy` raises `HTTPException` before the audit row is added, so a relayed 400/409 leaves no audit trace — which is what `test_pull_relays_a_409_and_writes_no_audit` locks in. The pull proxy uses a 60 s timeout because E3-A's `POST /models` does its DOI validation and job-file write before returning 202.

- [ ] **Step 4: Update the E2 PUT test**

Replace the `_whitelist` fixture at the top of `tests/test_admin_ocr_put.py`:

```python
import httpx
import pytest
from app import kraken, ocr_models
from app.models import AppSetting, AdminAuditLog
from tests.conftest import make_user, auth_headers

_MODELS = [
    {"slug": "rec", "protected": True, "doi": None, "summary": "", "script": None,
     "keywords": [], "license": None, "size_bytes": 4096},
    {"slug": "rec-21788409", "protected": False, "doi": "10.5281/zenodo.21788409",
     "summary": "", "script": "Latn", "keywords": [], "license": None,
     "size_bytes": 128},
]


@pytest.fixture(autouse=True)
def _kraken_models(monkeypatch):
    ocr_models.invalidate()
    monkeypatch.setattr(
        kraken, "call",
        lambda method, path, **kw: httpx.Response(200, json={"models": _MODELS}))
    yield
    ocr_models.invalidate()
```

and swap `"rapide"` → `"rec-21788409"` in the three tests (`test_valid_key_sets_active_and_audits`, `test_requires_admin`); `test_invalid_key_400` keeps `"bogus"` and still asserts the 400 + zero audit rows.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python3 -m pytest tests/test_admin_ocr_e3.py tests/test_admin_ocr_put.py -q`
Expected: PASS (14 from Tasks 4-5 + 21 here = 35, plus 3 in `test_admin_ocr_put.py`). Task 5's `test_job_status_is_proxied` and `test_unknown_job_404_is_relayed` must still be green — the audited route is a superset of the plain one.

- [ ] **Step 6: Full backend suite**

Run: `python3 -m pytest -q`
Expected: PASS. If `tests/test_config.py` references the removed settings, fix it here (it should not — it covers `_int` and the storage/Stripe settings).

- [ ] **Step 7: Commit**

```bash
git add app/main.py tests/test_admin_ocr_e3.py tests/test_admin_ocr_put.py
git commit -m "feat(ocr): admin pull / delete / switch of Kraken recognition models

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01794AvRAdj2qajTHv6EmChu"
```

---

### Task 7: Frontend API types

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/api.ocr.test.ts`

**Interfaces:**
- Produces: `LocalModel`, `CatalogModel`, `CatalogResponse`, `ModelJob`; `OcrPanelData` reshaped (`models` → `local_models`, plus `active_slug` and `kraken_error`). `OcrModel` (the E2 `{key, seg_path, rec_path}` type) is deleted.
- Consumed by: Task 8.

- [ ] **Step 1: Write the failing test**

Replace `web/src/api.ocr.test.ts` with:

```ts
import { beforeEach, expect, it, vi } from 'vitest'
import { api, setToken } from './api'
import type { CatalogResponse, LocalModel, ModelJob, OcrPanelData } from './api'

beforeEach(() => { localStorage.clear(); setToken('tok'); vi.restoreAllMocks() })

it('api.put issues a PUT with a JSON body', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ active_key: 'rec-21788409' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const out = await api.put('/api/admin/ocr/model', { key: 'rec-21788409' })
  expect(out).toEqual({ active_key: 'rec-21788409' })
  const [, opts] = fetchMock.mock.calls[0]
  expect(opts.method).toBe('PUT')
  expect(JSON.parse(opts.body)).toEqual({ key: 'rec-21788409' })
  expect(opts.headers['Content-Type']).toBe('application/json')
})

it('api.delete issues a DELETE with no body', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ deleted: 'rec-21788409' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const out = await api.delete('/api/admin/ocr/models/rec-21788409')
  expect(out).toEqual({ deleted: 'rec-21788409' })
  const [url, opts] = fetchMock.mock.calls[0]
  expect(url).toBe('/api/admin/ocr/models/rec-21788409')
  expect(opts.method).toBe('DELETE')
  expect(opts.body).toBeUndefined()
})

it('api.get on the catalogue keeps the query string', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ cached_at: null, stale: true, refreshing: false, models: [] }),
      { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const out = await api.get<CatalogResponse>('/api/admin/ocr/catalog?script=Grek&all=false')
  expect(out.stale).toBe(true)
  expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/ocr/catalog?script=Grek&all=false')
})

it('a relayed 409 surfaces the Kraken detail', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ detail: 'Modèle déjà présent' }), { status: 409 })))
  await expect(api.post('/api/admin/ocr/models', { doi: '10.5281/zenodo.1' }))
    .rejects.toThrow('Modèle déjà présent')
})

it('the E3-B panel types compile against a realistic payload', () => {
  const model: LocalModel = {
    slug: 'rec-21788409', protected: false, doi: '10.5281/zenodo.21788409',
    summary: 'French 18C', script: 'Latn', keywords: ['french'],
    license: 'CC-BY-4.0', size_bytes: 128,
  }
  const job: ModelJob = {
    kind: 'pull', job_id: 'j1', status: 'finished',
    doi: '10.5281/zenodo.21788409', slug: 'rec-21788409', error: null, progress: 100,
  }
  const panel: OcrPanelData = {
    local_models: [model], active_key: 'rec-21788409', active_slug: 'rec-21788409',
    active_source: 'setting', kraken_error: null, recent: [], aggregates: [],
  }
  expect(panel.local_models[0].slug).toBe(job.slug)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/api.ocr.test.ts`
Expected: FAIL — TypeScript cannot resolve `LocalModel` / `CatalogResponse` / `ModelJob`, and `OcrPanelData` has no `local_models`.

- [ ] **Step 3: Implement**

In `web/src/api.ts`, delete `export interface OcrModel { key: string; seg_path: string; rec_path: string }` (line 190) and replace the `OcrPanelData` block (lines 201-207) so the OCR section reads:

```ts
export interface LocalModel {
  slug: string
  protected: boolean
  doi: string | null
  summary: string
  script: string | null
  keywords: string[]
  license: string | null
  size_bytes: number
}
export interface CatalogModel {
  doi: string
  summary: string
  script: string | null
  keywords: string[]
  license: string | null
  already_local: boolean
}
export interface CatalogResponse {
  cached_at: string | null
  stale: boolean
  refreshing: boolean
  models: CatalogModel[]
}
export interface ModelJob {
  kind: 'pull' | 'refresh'
  job_id: string
  status: 'started' | 'finished' | 'failed'
  doi?: string
  slug?: string
  error: string | null
  progress?: number
}
export interface OcrRecentRow {
  page_id: string; document_id: string; document_title: string
  processing_status: string
  duration_s: number | null; per_page_s: number | null
  model_key: string; avg_confidence: number | null; submitted_at: string | null
}
export interface OcrAggregate {
  model_key: string; pages: number; errors: number
  median_s: number | null; p95_s: number | null; avg_confidence: number | null
}
export interface OcrPanelData {
  local_models: LocalModel[]
  active_key: string
  active_slug: string
  active_source: 'setting' | 'fallback'
  kraken_error?: string | null
  recent: OcrRecentRow[]
  aggregates: OcrAggregate[]
}
```

`OcrRecentRow` and `OcrAggregate` are unchanged from E2 — they are reproduced above only so the block is contiguous.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/api.ocr.test.ts`
Expected: PASS (5 tests). `npm run build` will still fail on `Admin.tsx` (it references `ocr.models`) — Task 8 fixes that.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/api.ocr.test.ts
git commit -m "feat(web): E3-B OCR model types (local models, catalogue, jobs)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01794AvRAdj2qajTHv6EmChu"
```

---

### Task 8: Admin SPA — three-block "OCR / Modèles" panel

**Files:**
- Modify: `web/src/pages/Admin.tsx`
- Modify: `web/src/pages/Admin.ocr.test.tsx`

**Interfaces:**
- Consumes: the Task 7 types and every route from Tasks 4-6.
- Produces: Block 1 (active model + E2 aggregates + E2 recent table), Block 2 (downloaded models with a Dialog-confirmed delete), Block 3 (collapsible HTRMoPo catalogue with script filter, refresh and pull).

- [ ] **Step 1: Write the failing test**

Replace `web/src/pages/Admin.ocr.test.tsx` with:

```tsx
import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Admin from './Admin'

const navigate = vi.fn()
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<any>()), useNavigate: () => navigate }))

const localModels = [
  {
    slug: 'rec', protected: true, doi: null,
    summary: 'Modèle de reconnaissance baké par défaut', script: null,
    keywords: [], license: null, size_bytes: 4194304,
  },
  {
    slug: 'rec-21788409', protected: false, doi: '10.5281/zenodo.21788409',
    summary: 'French 18C cursive', script: 'Latn', keywords: ['french'],
    license: 'CC-BY-4.0', size_bytes: 1048576,
  },
]

const ocrData = {
  local_models: localModels,
  active_key: 'rec', active_slug: 'rec', active_source: 'fallback', kraken_error: null,
  recent: [{
    page_id: 'p1', document_id: 'd1', document_title: 'Doc A', processing_status: 'done',
    duration_s: 92.4, per_page_s: 92.4, model_key: 'rec', avg_confidence: 0.71,
    submitted_at: '2026-09-02T10:00:00Z',
  }],
  aggregates: [
    { model_key: 'rec', pages: 10, errors: 0, median_s: 90, p95_s: 140, avg_confidence: 0.7 },
    { model_key: 'rec-21788409', pages: 4, errors: 2, median_s: 30, p95_s: 45, avg_confidence: 0.65 },
  ],
}

const catalogData = {
  cached_at: '2026-09-05T08:00:00Z', stale: false, refreshing: false,
  models: [
    {
      doi: '10.5281/zenodo.999', summary: 'Latin medieval', script: 'Latn',
      keywords: ['latin', 'medieval'], license: 'CC-BY-4.0', already_local: false,
    },
    {
      doi: '10.5281/zenodo.21788409', summary: 'French 18C cursive', script: 'Latn',
      keywords: ['french'], license: 'CC-BY-4.0', already_local: true,
    },
  ],
}

/** Base router: every non-OCR admin call succeeds; `over` patches specific paths. */
function stubFetch(over: (url: string, opts: any) => Response | undefined = () => undefined) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts: any) => {
    const patched = over(url, opts)
    if (patched) return patched
    if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ is_admin: true }), { status: 200 })
    if (url.endsWith('/api/admin/users')) return new Response(JSON.stringify({ users: [] }), { status: 200 })
    if (url.endsWith('/api/admin/stats')) return new Response(JSON.stringify({ users: 0, documents: 0, pages_done: 0, pages_error: 0, pages_total: 0, credits_in_circulation: 0 }), { status: 200 })
    if (url.includes('/api/admin/audit')) return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    if (url.endsWith('/api/admin/ocr')) return new Response(JSON.stringify(ocrData), { status: 200 })
    if (url.includes('/api/admin/ocr/catalog')) return new Response(JSON.stringify(catalogData), { status: 200 })
    if (url.endsWith('/api/admin/ocr/model')) return new Response(JSON.stringify({ active_key: 'rec-21788409' }), { status: 200 })
    return new Response('{}', { status: 200 })
  }))
}

const calls = () => (fetch as any).mock.calls as any[][]
const callTo = (pred: (u: string) => boolean, method?: string) =>
  calls().find((c) => pred(c[0]) && (!method || c[1]?.method === method))

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('palimora_token', 'tok'); navigate.mockClear()
  stubFetch()
})

it('renders the three blocks with the live model list', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  expect(await screen.findByText(/OCR \/ Modèles/i)).toBeInTheDocument()
  expect(screen.getByText(/Modèles téléchargés/i)).toBeInTheDocument()
  expect(screen.getByText(/Catalogue HTRMoPo/i)).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('combobox', { name: /modèle actif/i })).toHaveValue('rec'))
  expect(screen.getByText('Doc A')).toBeInTheDocument()        // E2 recent table
  expect(screen.getByText(/fallback/)).toBeInTheDocument()     // source badge
  expect(screen.getByText('10.5281/zenodo.21788409')).toBeInTheDocument()
})

it('activating a model issues the PUT and refreshes', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  const select = await screen.findByRole('combobox', { name: /modèle actif/i })
  await userEvent.selectOptions(select, 'rec-21788409')
  await userEvent.click(screen.getByRole('button', { name: /activer/i }))
  await waitFor(() => {
    const put = callTo((u) => u.endsWith('/api/admin/ocr/model'), 'PUT')
    expect(put).toBeTruthy()
    expect(JSON.parse(put![1].body)).toEqual({ key: 'rec-21788409' })
  })
})

it('disables delete for a protected model and for the active one', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await screen.findByText(/Modèles téléchargés/i)
  const recRow = screen.getByTestId('local-model-rec')
  expect(within(recRow).getByRole('button', { name: /supprimer/i })).toBeDisabled()
  const pulledRow = screen.getByTestId('local-model-rec-21788409')
  expect(within(pulledRow).getByRole('button', { name: /supprimer/i })).toBeEnabled()
})

it('the active model cannot be deleted from the UI', async () => {
  stubFetch((url) => url.endsWith('/api/admin/ocr')
    ? new Response(JSON.stringify({ ...ocrData, active_key: 'rec-21788409', active_slug: 'rec-21788409', active_source: 'setting' }), { status: 200 })
    : undefined)
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await screen.findByText(/Modèles téléchargés/i)
  const row = screen.getByTestId('local-model-rec-21788409')
  expect(within(row).getByRole('button', { name: /supprimer/i })).toBeDisabled()
})

it('deleting goes through a confirm dialog, not window.confirm', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm')
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await screen.findByText(/Modèles téléchargés/i)
  const row = screen.getByTestId('local-model-rec-21788409')
  await userEvent.click(within(row).getByRole('button', { name: /supprimer/i }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(/rec-21788409/)).toBeInTheDocument()
  expect(callTo((u) => u.includes('/api/admin/ocr/models/'), 'DELETE')).toBeFalsy()
  await userEvent.click(within(dialog).getByRole('button', { name: /confirmer/i }))
  await waitFor(() =>
    expect(callTo((u) => u.endsWith('/api/admin/ocr/models/rec-21788409'), 'DELETE')).toBeTruthy())
  expect(confirmSpy).not.toHaveBeenCalled()
})

it('a relayed delete 409 shows the Kraken detail', async () => {
  stubFetch((url, opts) => url.endsWith('/api/admin/ocr/models/rec-21788409') && opts?.method === 'DELETE'
    ? new Response(JSON.stringify({ detail: 'Modèle protégé' }), { status: 409 })
    : undefined)
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await screen.findByText(/Modèles téléchargés/i)
  await userEvent.click(within(screen.getByTestId('local-model-rec-21788409'))
    .getByRole('button', { name: /supprimer/i }))
  await userEvent.click(within(await screen.findByRole('dialog'))
    .getByRole('button', { name: /confirmer/i }))
  expect(await screen.findByText(/Modèle protégé/)).toBeInTheDocument()
})

it('the catalogue is lazy: no fetch until it is expanded', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await screen.findByText(/Catalogue HTRMoPo/i)
  expect(callTo((u) => u.includes('/api/admin/ocr/catalog'))).toBeFalsy()
  await userEvent.click(screen.getByRole('button', { name: /catalogue htrmopo/i }))
  await waitFor(() => {
    const get = callTo((u) => u.includes('/api/admin/ocr/catalog'))
    expect(get).toBeTruthy()
    expect(get![0]).toContain('script=Latn')
  })
  expect(await screen.findByText('Latin medieval')).toBeInTheDocument()
})

it('changing the script refetches the catalogue', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await userEvent.click(await screen.findByRole('button', { name: /catalogue htrmopo/i }))
  await screen.findByText('Latin medieval')
  await userEvent.selectOptions(screen.getByRole('combobox', { name: /écriture/i }), 'Grek')
  await waitFor(() =>
    expect(calls().some((c) => String(c[0]).includes('script=Grek'))).toBe(true))
})

it('pulling a model polls the job then refreshes the panel', async () => {
  stubFetch((url, opts) => {
    if (url.endsWith('/api/admin/ocr/models') && opts?.method === 'POST') {
      return new Response(JSON.stringify({ job_id: 'j-pull', slug: 'rec-999', status: 'started' }), { status: 202 })
    }
    if (url.endsWith('/api/admin/ocr/models/jobs/j-pull')) {
      return new Response(JSON.stringify({ kind: 'pull', job_id: 'j-pull', status: 'finished', slug: 'rec-999', error: null, progress: 100 }), { status: 200 })
    }
    return undefined
  })
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await userEvent.click(await screen.findByRole('button', { name: /catalogue htrmopo/i }))
  const row = await screen.findByTestId('catalog-10.5281/zenodo.999')
  await userEvent.click(within(row).getByRole('button', { name: /télécharger/i }))
  await waitFor(() =>
    expect(callTo((u) => u.endsWith('/api/admin/ocr/models/jobs/j-pull'))).toBeTruthy())
  expect(await screen.findByText(/Modèle téléchargé/i)).toBeInTheDocument()
})

it('a failed pull job surfaces its error', async () => {
  stubFetch((url, opts) => {
    if (url.endsWith('/api/admin/ocr/models') && opts?.method === 'POST') {
      return new Response(JSON.stringify({ job_id: 'j-bad', slug: 'rec-999', status: 'started' }), { status: 202 })
    }
    if (url.endsWith('/api/admin/ocr/models/jobs/j-bad')) {
      return new Response(JSON.stringify({ kind: 'pull', job_id: 'j-bad', status: 'failed', error: 'pas un modèle de reconnaissance', progress: 0 }), { status: 200 })
    }
    return undefined
  })
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await userEvent.click(await screen.findByRole('button', { name: /catalogue htrmopo/i }))
  const row = await screen.findByTestId('catalog-10.5281/zenodo.999')
  await userEvent.click(within(row).getByRole('button', { name: /télécharger/i }))
  expect(await screen.findByText(/pas un modèle de reconnaissance/)).toBeInTheDocument()
})

it('an already-local catalogue entry cannot be pulled', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await userEvent.click(await screen.findByRole('button', { name: /catalogue htrmopo/i }))
  const row = await screen.findByTestId('catalog-10.5281/zenodo.21788409')
  expect(within(row).getByRole('button', { name: /télécharger|déjà local/i })).toBeDisabled()
})

it('refreshing the catalogue polls the refresh job and refetches', async () => {
  stubFetch((url, opts) => {
    if (url.endsWith('/api/admin/ocr/catalog/refresh') && opts?.method === 'POST') {
      return new Response(JSON.stringify({ job_id: 'j-ref', status: 'started' }), { status: 202 })
    }
    if (url.endsWith('/api/admin/ocr/models/jobs/j-ref')) {
      return new Response(JSON.stringify({ kind: 'refresh', job_id: 'j-ref', status: 'finished', error: null }), { status: 200 })
    }
    return undefined
  })
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await userEvent.click(await screen.findByRole('button', { name: /catalogue htrmopo/i }))
  await screen.findByText('Latin medieval')
  await userEvent.click(screen.getByRole('button', { name: /rafraîchir/i }))
  await waitFor(() =>
    expect(callTo((u) => u.endsWith('/api/admin/ocr/models/jobs/j-ref'))).toBeTruthy())
  expect(await screen.findByText(/Catalogue rafraîchi/i)).toBeInTheDocument()
})

it('a kraken_error renders a banner and still shows the aggregates', async () => {
  stubFetch((url) => url.endsWith('/api/admin/ocr')
    ? new Response(JSON.stringify({ ...ocrData, local_models: [], kraken_error: 'Service Kraken injoignable' }), { status: 200 })
    : undefined)
  render(<MemoryRouter><Admin /></MemoryRouter>)
  expect(await screen.findByText(/gestion des modèles indisponible/i)).toBeInTheDocument()
  expect(screen.getByText('Doc A')).toBeInTheDocument()
  expect(screen.getByText('140')).toBeInTheDocument()  // p95 from the aggregates table
})

it('still renders the console when /api/admin/ocr errors', async () => {
  stubFetch((url) => {
    if (url.endsWith('/api/admin/ocr')) return new Response('boom', { status: 500 })
    if (url.endsWith('/api/admin/users')) return new Response(JSON.stringify({ users: [{ id: 'u1', email: 'x@y.fr', display_name: 'X', credit_balance: 0, is_admin: false, is_active: true, created_at: '' }] }), { status: 200 })
    return undefined
  })
  render(<MemoryRouter><Admin /></MemoryRouter>)
  expect(await screen.findByText('x@y.fr')).toBeInTheDocument()
  expect(screen.queryByText(/OCR \/ Modèles/i)).toBeNull()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/Admin.ocr.test.tsx`
Expected: FAIL — `Admin.tsx` still reads `ocr.models`, there is no accessible "Modèle actif" combobox, no "Modèles téléchargés" block and no catalogue.

- [ ] **Step 3: Implement**

**3a — imports and helpers.** In `web/src/pages/Admin.tsx`, extend the imports:

```tsx
import { api, setImpersonation, setToken } from '../api'
import type { CatalogResponse, LocalModel, ModelJob, OcrPanelData } from '../api'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../components/ui/dialog'
```

Add above `export default function Admin()`:

```tsx
const SCRIPTS = ['Latn', 'Grek', 'Arab', 'Hebr', 'Cyrl', 'Syrc', 'Deva']
const JOB_POLL_MS = 3000
// Native <select> on purpose (as in E2): the Radix Select renders its listbox in
// a portal, which the panel's tests drive with selectOptions/toHaveValue.
const selectClass =
  'h-8 rounded-lg border border-input bg-card px-2 text-sm outline-none ' +
  'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

function formatBytes(n: number): string {
  if (!n) return '—'
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`
}

async function pollJob(jobId: string, onTick: (j: ModelJob) => void): Promise<ModelJob> {
  for (;;) {
    const job = await api.get<ModelJob>(`/api/admin/ocr/models/jobs/${jobId}`)
    onTick(job)
    if (job.status === 'finished' || job.status === 'failed') return job
    await new Promise((r) => setTimeout(r, JOB_POLL_MS))
  }
}
```

**3b — state and handlers.** Inside `Admin()`, keep `ocr`, `modelKey`, `savingModel` and add:

```tsx
  const [deleteTarget, setDeleteTarget] = useState<LocalModel | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [catalogScript, setCatalogScript] = useState('Latn')
  const [catalogAll, setCatalogAll] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [pullJobs, setPullJobs] = useState<Record<string, ModelJob>>({})
```

Replace the OCR fetch inside `refresh()` (line 50-52) with:

```tsx
    api.get<OcrPanelData>('/api/admin/ocr')
      .then((o) => { setOcr(o); setModelKey(o.active_slug) })
      .catch(() => setOcr(null))
```

Add a `toast` helper next to the existing inline `setToast(...)/setTimeout(...)` pairs and use it in the new handlers (leave the existing call sites alone):

```tsx
  const say = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3500)
  }, [])

  const loadCatalog = useCallback(async (script: string, all: boolean) => {
    setCatalogLoading(true)
    try {
      const params = new URLSearchParams({ script, all: all ? 'true' : 'false' })
      setCatalog(await api.get<CatalogResponse>(`/api/admin/ocr/catalog?${params}`))
    } catch (e: any) {
      setCatalog(null)
      say(e?.message || 'Catalogue indisponible')
    } finally {
      setCatalogLoading(false)
    }
  }, [say])

  function toggleCatalog() {
    const next = !catalogOpen
    setCatalogOpen(next)
    if (next && catalog === null) loadCatalog(catalogScript, catalogAll)
  }

  function changeScript(value: string) {
    const all = value === 'all'
    const script = all ? catalogScript : value
    setCatalogAll(all)
    if (!all) setCatalogScript(value)
    loadCatalog(script, all)
  }

  async function refreshCatalog() {
    setRefreshingCatalog(true)
    try {
      const { job_id } = await api.post<{ job_id: string }>('/api/admin/ocr/catalog/refresh')
      const job = await pollJob(job_id, () => {})
      if (job.status === 'failed') say(job.error || 'Rafraîchissement en échec')
      else { say('Catalogue rafraîchi'); await loadCatalog(catalogScript, catalogAll) }
    } catch (e: any) {
      say(e?.message || 'Rafraîchissement impossible')
    } finally {
      setRefreshingCatalog(false)
    }
  }

  async function pullModel(doi: string) {
    try {
      const started = await api.post<{ job_id: string }>('/api/admin/ocr/models', { doi })
      const job = await pollJob(started.job_id, (j) => setPullJobs((p) => ({ ...p, [doi]: j })))
      if (job.status === 'failed') {
        say(job.error || 'Téléchargement en échec')
      } else {
        say('Modèle téléchargé')
        await loadCatalog(catalogScript, catalogAll)
        refresh()
      }
    } catch (e: any) {
      say(e?.message || 'Téléchargement impossible')
    } finally {
      setPullJobs((p) => { const { [doi]: _drop, ...rest } = p; return rest })
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.delete(`/api/admin/ocr/models/${deleteTarget.slug}`)
      say('Modèle supprimé')
      setDeleteTarget(null)
      refresh()
    } catch (e: any) {
      say(e?.message || 'Suppression impossible')
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }
```

Replace the E2 `effectiveKey` / `saveModel` pair with:

```tsx
  // '' when the stored slug is no longer in the live list: don't pretend the
  // first listed model is selected.
  const effectiveKey =
    ocr && ocr.local_models.some((m) => m.slug === modelKey) ? modelKey : ''

  async function saveModel() {
    setSavingModel(true)
    try {
      await api.put('/api/admin/ocr/model', { key: effectiveKey })
      say('Modèle OCR mis à jour')
      refresh()
    } catch (e: any) {
      say(e?.message || 'Erreur mise à jour modèle')
    } finally {
      setSavingModel(false)
    }
  }
```

**3c — markup.** Replace the whole `{ocr && ( … )}` OCR section (lines 221-298) with:

```tsx
      {ocr && (
        <div className="px-4 pb-12 space-y-6">
          <h2 className="font-display font-semibold">OCR / Modèles</h2>

          {ocr.kraken_error && (
            <Alert variant="destructive">
              <AlertTitle>Service Kraken injoignable</AlertTitle>
              <AlertDescription>
                Gestion des modèles indisponible. Les statistiques ci-dessous
                proviennent de la base et restent à jour.
              </AlertDescription>
            </Alert>
          )}

          {/* ── Block 1 — Modèle actif & performance ───────────────────── */}
          <section className="space-y-3">
            <h3 className="font-display text-sm font-semibold">Modèle actif</h3>
            {ocr.local_models.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aucun modèle local — Kraken indisponible ou volume vide.
              </p>
            ) : (
              <div className="flex items-center gap-2 text-sm">
                <label className="sr-only" htmlFor="active-model">Modèle actif</label>
                <select id="active-model" aria-label="Modèle actif" className={selectClass}
                        value={effectiveKey} onChange={(e) => setModelKey(e.target.value)}>
                  {effectiveKey === '' && (
                    <option value="" disabled>— rec (défaut Kraken) —</option>
                  )}
                  {ocr.local_models.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.summary ? `${m.slug} — ${m.summary}` : m.slug}
                    </option>
                  ))}
                </select>
                <Button disabled={savingModel || effectiveKey === '' || effectiveKey === ocr.active_slug}
                        onClick={saveModel}>
                  Activer
                </Button>
                <Badge variant="outline">source&nbsp;: {ocr.active_source}</Badge>
              </div>
            )}

            <div className="bg-card rounded-lg border overflow-hidden">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Modèle</TableHead><TableHead>Pages</TableHead>
                  <TableHead>Erreurs</TableHead>
                  <TableHead>Médiane (s)</TableHead><TableHead>p95 (s)</TableHead>
                  <TableHead>Confiance moy.</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {ocr.aggregates.map((a) => (
                    <TableRow key={a.model_key || '—'}>
                      <TableCell>{a.model_key || '—'}</TableCell>
                      <TableCell>{a.pages}</TableCell>
                      <TableCell>{a.errors}</TableCell>
                      <TableCell>{a.median_s ?? '—'}</TableCell>
                      <TableCell>{a.p95_s ?? '—'}</TableCell>
                      <TableCell>{a.avg_confidence ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          {/* ── Block 2 — Modèles téléchargés ──────────────────────────── */}
          <section className="space-y-2">
            <h3 className="font-display text-sm font-semibold">Modèles téléchargés</h3>
            <div className="bg-card rounded-lg border overflow-hidden">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Slug</TableHead><TableHead>DOI</TableHead>
                  <TableHead>Écriture</TableHead><TableHead>Taille</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {ocr.local_models.map((m) => (
                    <TableRow key={m.slug} data-testid={`local-model-${m.slug}`}>
                      <TableCell className="font-mono text-xs">{m.slug}</TableCell>
                      <TableCell className="font-mono text-xs">{m.doi || '—'}</TableCell>
                      <TableCell>{m.script || '—'}</TableCell>
                      <TableCell>{formatBytes(m.size_bytes)}</TableCell>
                      <TableCell>
                        <Button size="xs" variant="destructive"
                                disabled={m.protected || m.slug === ocr.active_slug}
                                onClick={() => setDeleteTarget(m)}>
                          Supprimer
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          {/* ── Block 3 — Catalogue HTRMoPo (lazy) ─────────────────────── */}
          <section className="space-y-2">
            <Button variant="ghost" size="sm" onClick={toggleCatalog}
                    aria-expanded={catalogOpen}>
              {catalogOpen ? '▾' : '▸'} Catalogue HTRMoPo
            </Button>

            {catalogOpen && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="sr-only" htmlFor="catalog-script">Écriture</label>
                  <select id="catalog-script" aria-label="Écriture" className={selectClass}
                          value={catalogAll ? 'all' : catalogScript}
                          onChange={(e) => changeScript(e.target.value)}>
                    {SCRIPTS.map((s) => <option key={s} value={s}>{s}</option>)}
                    <option value="all">tous</option>
                  </select>
                  <Button size="sm" variant="outline" disabled={refreshingCatalog}
                          onClick={refreshCatalog}>
                    {refreshingCatalog ? 'Rafraîchissement…' : 'Rafraîchir'}
                  </Button>
                  {catalog?.cached_at && (
                    <span className="text-xs text-muted-foreground">
                      cache&nbsp;: {new Date(catalog.cached_at).toLocaleString('fr-FR')}
                    </span>
                  )}
                  {catalog?.stale && <Badge variant="outline">obsolète</Badge>}
                  {catalog?.refreshing && <Badge variant="outline">en cours…</Badge>}
                </div>

                {catalogLoading && (
                  <p className="text-sm text-muted-foreground">Chargement du catalogue…</p>
                )}

                <div className="grid gap-2 md:grid-cols-2">
                  {(catalog?.models || []).map((m) => {
                    const job = pullJobs[m.doi]
                    return (
                      <div key={m.doi} data-testid={`catalog-${m.doi}`}
                           className="bg-card rounded-lg border p-3 space-y-1.5">
                        <p className="text-sm font-medium">{m.summary || m.doi}</p>
                        <p className="font-mono text-xs text-muted-foreground">{m.doi}</p>
                        <div className="flex flex-wrap gap-1">
                          {m.script && <Badge variant="outline">{m.script}</Badge>}
                          {m.keywords.map((k) => <Badge key={k} variant="outline">{k}</Badge>)}
                          {m.license && <Badge variant="outline">{m.license}</Badge>}
                        </div>
                        {job && (
                          <div className="h-1.5 w-full rounded bg-muted overflow-hidden">
                            <div className="h-full bg-primary transition-all"
                                 style={{ width: `${job.progress ?? 0}%` }} />
                          </div>
                        )}
                        <Button size="xs" disabled={m.already_local || Boolean(job)}
                                onClick={() => pullModel(m.doi)}>
                          {m.already_local ? 'Déjà local'
                            : job ? 'Téléchargement…' : 'Télécharger'}
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </section>

          {/* ── E2 recent-pages table (unchanged) ──────────────────────── */}
          <div className="bg-card rounded-lg border overflow-hidden">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Date</TableHead><TableHead>Document</TableHead>
                <TableHead>Statut</TableHead><TableHead>Durée (s)</TableHead>
                <TableHead>Durée/page (s)</TableHead><TableHead>Modèle</TableHead>
                <TableHead>Confiance</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {ocr.recent.map((r) => (
                  <TableRow key={r.page_id}>
                    <TableCell>
                      {r.submitted_at ? new Date(r.submitted_at).toLocaleString('fr-FR') : '—'}
                    </TableCell>
                    <TableCell>{r.document_title}</TableCell>
                    <TableCell>{r.processing_status}</TableCell>
                    <TableCell>{r.duration_s ?? '—'}</TableCell>
                    <TableCell>{r.per_page_s ?? '—'}</TableCell>
                    <TableCell>{r.model_key || '—'}</TableCell>
                    <TableCell>{r.avg_confidence ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <Dialog open={deleteTarget !== null}
              onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer le modèle</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{deleteTarget?.slug}</span> sera supprimé
              du volume Kraken. Les pages déjà transcrites ne changent pas.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Annuler</Button>
            <Button variant="destructive" disabled={deleting} onClick={confirmDelete}>
              Confirmer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

The `<Dialog>` sits outside the `{ocr && …}` guard so it is not unmounted mid-delete when `refresh()` momentarily nulls `ocr`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/pages/Admin.ocr.test.tsx`
Expected: PASS (14 tests).

Then the whole frontend suite and the type-check:

Run: `cd web && npm test && npm run build`
Expected: PASS — in particular `Admin.impersonation.test.tsx` and `Billing.test.tsx` still green, and `tsc -b` clean (the deleted `OcrModel` type has no remaining referent).

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Admin.tsx web/src/pages/Admin.ocr.test.tsx
git commit -m "feat(web): three-block OCR panel — active model, downloaded models, HTRMoPo catalogue

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01794AvRAdj2qajTHv6EmChu"
```

---

### Task 9: Full-suite sweep, docs, rollout handoff

**Files:**
- Modify: `README.md` (if it documents `KRAKEN_MODELS`), `.env.example` (same condition)

- [ ] **Step 1: Grep for every remaining reference to the removed env vars**

Run:
```bash
grep -rn "kraken_models\|KRAKEN_MODELS\|_parse_kraken_models\|seg_path" app tests web README.md .env.example 2>/dev/null
```
Expected: **no hits** except `app/ocr_models.py`'s `"seg_path": None` in `resolve_active`, `app/ocr_service.py`'s `model["seg_path"]` read, and `tests/test_ocr_timing.py`'s `seg_model_path is None` assertions. Any other hit is dead E2 code — delete it. If `README.md` or `.env.example` documents `KRAKEN_MODELS` / `KRAKEN_MODELS_DEFAULT`, remove those lines.

- [ ] **Step 2: Full backend suite**

Run: `python3 -m pytest -q`
Expected: PASS. Test-count delta vs. E2: `-5` (`test_ocr_config.py` deleted), `-9` (`test_ocr_models.py` deleted), `+6` (`test_kraken_call.py`), `+15` (`test_ocr_models_e3.py`), `+35` (`test_admin_ocr_e3.py`), `+1` (the extra enqueue-fallback case in `test_ocr_timing.py`).

- [ ] **Step 3: Full frontend suite + build**

Run: `cd web && npm test && npm run build`
Expected: PASS, `tsc -b` clean.

- [ ] **Step 4: Placeholder scan on the diff**

Run: `git diff main --stat && git grep -n "TODO\|FIXME\|test.skip\|test.only\|it.skip\|it.only\|xit(" -- app tests web/src`
Expected: no new hits. Any `TODO` left in the diff is a blocker, not a note.

- [ ] **Step 5: STOP — hand back to the controller**

Report the branch (`feat/e3b-model-management`) and the steps that are **not** in this plan because they are the operator's:

1. **E3-A must be merged and deployed first** — `kraken-ocr-service` on `main`, the Coolify persistent `/models` volume mounted on the Kraken API (`hjzovkwfthcaxqlfyzq5znex`) and Worker (`ifbxnsa0l46ph73bhr4dnfu0`) at the same host path, and E3-A's own §8 verification green.
2. Merge + push `palimora-server`. Coolify auto-deploys Server + Worker. `_migrate()` has nothing new — no schema change (`AppSetting` and the `pages.ocr_*` columns already exist from E2).
3. Verify `/admin` → "OCR / Modèles":
   - Block 1: the selector lists `rec` (plus anything pulled during E3-A testing); source badge reads `fallback`.
   - Block 3: expand → catalogue loads; "Rafraîchir" completes and the `cache:` timestamp moves.
   - Pull a Latin recognition model → progress bar → it appears in Block 2 as soon as the job reports `finished` (the completion audit busts the model cache).
   - Force a failure (pull a *segmentation* DOI) → error toast carrying Kraken's message, and an `ocr.model_pull_done` audit row with `status_code=500`.
   - Activate it → source badge flips to `setting`; OCR one page → an aggregates row appears for that slug with a real duration; compare against `rec`.
   - Try to delete the active model → 409 toast; switch back to `rec`, delete → gone from Block 2.
   - Check `/admin` → "Journal d'impersonation" for the `ocr.model_pull` (intent, 202), `ocr.model_pull_done` (outcome, 200/500), `ocr.model_delete` and `ocr.model_change` audit rows.
   - **Known gap to accept:** `ocr.model_pull_done` is written while the panel polls the job. An admin who closes the tab mid-pull gets the intent row now and the outcome row only when someone next opens that job's status. Closing it would need a Kraken → Palimora webhook, i.e. an E3-A change.
4. `KRAKEN_MODELS` / `KRAKEN_MODELS_DEFAULT` were never set in the Palimora Coolify env (E2 shipped with them unset), so there is nothing to delete — confirm and move on.

Do NOT push. Do NOT open a PR. Do NOT modify Coolify.

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| §2 remove `kraken_models` / `kraken_models_default` / `_parse_kraken_models`; keep `kraken_api_url` / `_key` / `_timeout` | Task 1 Steps 4-5 |
| §2 Coolify env deletion (no-op — never set) | Task 9 Step 5.4 (operator note) |
| §3 `kraken.call()` with the exact signature; `KrakenError` on transport failure / 5xx; 4xx returned | Task 1 Step 3 |
| §4 `_CACHE` / `_TTL` 60 s / `_SETTING_KEY` | Task 2 Step 3 |
| §4 `list_models(force)` — GET `/models`, cached, raises | Task 2 |
| §4 `get_model(slug)` / `_safe_list()` | Task 2 |
| §4 `resolve_active` — stored slug → `/models/<slug>.mlmodel`, else `{rec, None}`, `seg_path` always `None` | Task 2 |
| §4 `active_slug` / `active_source` (`setting` \| `fallback`) | Task 2 |
| §4 `set_active` — validate, upsert, audit, no commit, bust cache | Task 2 |
| §4 outage must not break the enqueue path | Task 2 (`_safe_list`) + Task 3 |
| §4 `ocr_service.py` passes `seg_model_path=None` unconditionally; `submit_ocr` signature unchanged; slug stamped on the page | Task 3 |
| §5 `_kraken_proxy` — 502 mapping + 4xx relay | Task 4 Step 3 |
| §5.1 `GET /api/admin/ocr` + `local_models` + `active_slug`; E2 keys intact; outage → 200 + `kraken_error` | Task 4 |
| §5.2 `GET /api/admin/ocr/catalog?script&all` | Task 5 |
| §5.3 `POST /api/admin/ocr/catalog/refresh` | Task 5 |
| §5.4 `POST /api/admin/ocr/models` + `ocr.model_pull` audit + 400/409 relay | Task 6 |
| §5.5 `GET /api/admin/ocr/models/jobs/{job_id}` | Task 5 |
| **operator decision 2026-09-05** — pull *completion* audit (`ocr.model_pull_done`), idempotent, written as the SPA polls through the proxy | Task 6 |
| §5.6 `DELETE /api/admin/ocr/models/{slug}` — active guard 409, proxy, cache bust, `ocr.model_delete` audit | Task 6 |
| §5.7 `PUT /api/admin/ocr/model` kept, validated against the live list | Task 6 |
| §5 every route admin-gated + 403 during impersonation | Task 6 Step 1 (two parametrized sweeps) |
| §6.1 `LocalModel` / `CatalogModel` / `CatalogResponse` / `ModelJob`; `OcrPanelData` reshaped | Task 7 |
| §6.2 Block 1 — selector + `effectiveKey` guard + Activer + in-flight guard + source badge + E2 aggregates | Task 8 |
| §6.2 Block 2 — table, delete disabled for `protected` / active, confirm dialog (not `window.confirm`), 409 relay toast | Task 8 |
| §6.2 Block 3 — lazy expand, script select + "tous", Rafraîchir + job poll, `cached_at` / `stale` / `refreshing`, pull + progress + `already_local` | Task 8 |
| §6.2 `kraken_error` banner above the blocks, aggregates still rendered | Task 8 |
| §6.2 isolated OCR fetch (`.catch(() => setOcr(null))`) preserved | Task 8 Step 3b |
| §6 no new npm dep, no new route, no chart library | Task 8 (shadcn `Alert`/`Dialog`/`Badge`/`Button`/`Table` only) |
| §7.1 pytest file list | Tasks 1, 2, 4, 5, 6 |
| §7.1 delete `test_ocr_config.py`; rewrite `test_admin_ocr_put.py`'s invalid-key path; update `test_ocr_timing.py` | Tasks 1, 6, 3 |
| §7.2 vitest — `Admin.ocr.test.tsx` + `api.ocr.test.ts` | Tasks 8, 7 |
| §7.3 files touched | Tasks 1-8 (exactly the listed set) |
| §8 rollout order + verification checklist | Task 9 Step 5 |
| §9 risks | acknowledged below; one code decision taken |

No gaps.

**2. Deviations from the spec, taken deliberately:**

- **Pull completion is audited, beyond spec §5.4.** The operator asked (2026-09-05) for the real outcome, not just the intent. `ocr.model_pull_done` is written by the job-status proxy route (Task 6). This is the only mechanism that needs neither a client-reported result nor an E3-A change; its one gap — an admin who closes the tab before the pull resolves gets no outcome row until someone next polls that `job_id` — is stated in Task 6 and repeated at handoff.
- **§9's "60 s cache vs. a just-finished pull" risk is closed, not deferred.** Two places: `set_active` calls `list_models(force=True)` (Task 2 Step 3), so activating a model pulled seconds earlier is never rejected by a stale cache; and the completion audit busts the cache on `finished` (Task 6), so the new model appears in Block 2 on the next `refresh()` instead of up to 60 s later. Task 9's verification wording is updated accordingly.
- **`E2's "Enregistrer" button is renamed "Activer"`** per spec §6.2's wording. The E2 vitest case that looked for `/enregistrer/i` is rewritten accordingly in Task 8.
- **The `all` query param is stringified** (`"true"` / `"false"`) before being handed to httpx, because httpx serialises a Python bool as `True`/`False` and E3-A's FastAPI `all: bool = False` would reject that. Noted inline in Task 5 Step 3.
- **`_kraken_proxy` returns a plain dict**, not a `JSONResponse`; the 202 status comes from the route decorator. Simpler, and it keeps FastAPI's response serialisation.

**3. Type consistency:**

- `kraken.call(method, path, *, json_body, params, timeout) -> httpx.Response` — Task 1; used by Task 2 (`list_models`) and Task 4 (`_kraken_proxy`).
- `ocr_models.resolve_active(db) -> {"key": str, "rec_path": str|None, "seg_path": None}` — Task 2; consumed by `ocr_service.enqueue_page_ocr` (Task 3) and `admin_ocr` (Task 4). Key names match E2's contract, so `app/ocr_service.py:81-83` needs no edit.
- `ocr_models.list_models() -> list[{slug, protected, doi, summary, script, keywords, license, size_bytes}]` — Task 2; matches E3-A plan Task 2's `_local_models()` output exactly; serialised as `local_models` (Task 4) and typed as `LocalModel` (Task 7).
- `GET /repo` response `{cached_at, stale, refreshing, models:[{doi, summary, script, keywords, license, already_local}]}` — E3-A plan Task 6; relayed verbatim (Task 5); typed as `CatalogResponse` / `CatalogModel` (Task 7).
- Job file shape `{job_id, kind, status, updated_at, doi?, slug?, error?, progress?}` — E3-A plan Task 3; relayed verbatim (Task 5); typed as `ModelJob` (Task 7); consumed by `pollJob` (Task 8).
- `AdminAuditLog.event` values `ocr.model_change` (16) / `ocr.model_pull` (14) / `ocr.model_pull_done` (19) / `ocr.model_delete` (16) — all fit the existing `String(20)` column, no migration. `ocr.model_pull_done` is the longest and has 1 char of headroom: do not rename it longer.
- `data-testid` contract between Task 8's markup and its tests: `local-model-<slug>`, `catalog-<doi>`.

Consistent.

## Open questions — all resolved 2026-09-05

The three points raised against the design were answered by the operator. Nothing is left open; execute as written.

1. **Pull audit — resolved: audit the outcome, not just the intent.** The 202 keeps its `ocr.model_pull` intent row, and a second `ocr.model_pull_done` row records the real result (`status_code` 200 on `finished`, 500 on `failed`). Implemented in Task 6 inside the job-status proxy route the SPA already polls — no seventh route, no E3-A change, and the row is written from Kraken's payload rather than a client-reported result. Known gap, accepted: the outcome row lands only when somebody polls that `job_id`.
2. **Catalogue script list — resolved: confirmed as proposed.** `Latn, Grek, Arab, Hebr, Cyrl, Syrc, Deva` + "tous" (`SCRIPTS` in Task 8 Step 3a).
3. **No Palimora-side catalogue cache — resolved: confirmed acceptable.** Kraken already caches `.catalog.json` for 24 h; `GET /api/admin/ocr/catalog` stays a plain live proxy (Task 5).

## Execution Handoff

Plan complete, saved to `docs/superpowers/plans/2026-09-05-e3b-palimora-model-management.md`. Nine tasks. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, broad final review. Tasks 1→2→3 and 4→5→6 are strictly sequential; Task 7 depends only on the design (it can start in parallel with Task 4); Task 8 depends on Task 7; Task 9 is last.
2. **Inline Execution** — tasks in this session.

Which approach?
