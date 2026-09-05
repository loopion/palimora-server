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
