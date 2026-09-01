import hashlib
import secrets
import smtplib
import uuid
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import AuthToken, Device, User

_ph = PasswordHasher()


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _ph.verify(password_hash, password)
    except VerifyMismatchError:
        return False


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue_device_token(db: Session, user: User, name: str) -> str:
    token = secrets.token_urlsafe(32)
    device = Device(user_id=user.id, name=name[:120], token_hash=_hash_token(token))
    db.add(device)
    db.commit()
    return token


def get_user_by_token(db: Session, token: str) -> User | None:
    device = db.query(Device).filter_by(token_hash=_hash_token(token), revoked=False).first()
    if not device:
        return None
    device.last_used_at = datetime.now(timezone.utc)
    db.commit()
    return db.query(User).filter_by(id=device.user_id, is_active=True).first()


def bearer_token(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    # iOS-style compatibility: X-API-Key carries the device token
    return request.headers.get("X-Api-Key") or None


def resolve_impersonation_target(db: Session, target_id: str) -> User:
    target = db.query(User).filter_by(id=target_id).one_or_none()
    if not target or not target.is_active:
        raise HTTPException(status_code=404, detail="Utilisateur introuvable")
    if target.is_admin:
        raise HTTPException(
            status_code=403, detail="Impersonation d'un administrateur interdite"
        )
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
            raise HTTPException(
                status_code=403,
                detail="Impersonation réservée aux administrateurs",
            )
        target = resolve_impersonation_target(db, impersonate)
        request.state.impersonator_id = user.id
        request.state.impersonated_id = target.id
        return target
    return user


def get_admin_user(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Accès administrateur requis")
    return user


def create_auth_token(db: Session, user: User, purpose: str, ttl_minutes: int) -> str:
    token = secrets.token_urlsafe(32)
    row = AuthToken(
        user_id=user.id,
        purpose=purpose,
        token_hash=_hash_token(token),
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=ttl_minutes),
    )
    db.add(row)
    db.commit()
    return token


def consume_auth_token(db: Session, token: str, purpose: str) -> User | None:
    row = db.query(AuthToken).filter_by(
        token_hash=_hash_token(token), purpose=purpose, used_at=None
    ).first()
    if not row or row.expires_at < datetime.now(timezone.utc):
        return None
    row.used_at = datetime.now(timezone.utc)
    db.commit()
    return db.query(User).filter_by(id=row.user_id).first()


def send_email(to: str, subject: str, body: str) -> bool:
    """Send via SMTP when configured; returns False when SMTP is unset (dev mode)."""
    if not settings.smtp_host:
        return False
    msg = EmailMessage()
    msg["From"] = settings.smtp_from or settings.smtp_user
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as smtp:
        smtp.starttls()
        if settings.smtp_user:
            smtp.login(settings.smtp_user, settings.smtp_password)
        smtp.send_message(msg)
    return True


def new_id() -> str:
    return str(uuid.uuid4())
