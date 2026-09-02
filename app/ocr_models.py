"""Kraken model whitelist + active-model resolution (Phase E2)."""
from sqlalchemy.orm import Session

from .config import settings
from .models import AdminAuditLog, AppSetting

_FALLBACK = {"key": "défaut", "seg_path": None, "rec_path": None}
_SETTING_KEY = "ocr_model"


def list_models() -> list[dict]:
    return [dict(m) for m in settings.kraken_models]


def get_model(key: str) -> dict | None:
    return next((m for m in settings.kraken_models if m["key"] == key), None)


def _setting_value(db: Session) -> str | None:
    row = db.query(AppSetting).filter_by(key=_SETTING_KEY).one_or_none()
    return row.value if row else None


def resolve_active(db: Session) -> dict:
    val = _setting_value(db)
    if val and (m := get_model(val)):
        return dict(m)
    if settings.kraken_models_default and (m := get_model(settings.kraken_models_default)):
        return dict(m)
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
