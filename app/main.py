"""Palimora Server — FastAPI app (API + static SPA)."""
import io
import os
from datetime import datetime, timezone

import pypdf
from fastapi import Depends, FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from . import ai, billing, credits, kraken, storage
from .auth import (
    create_auth_token, get_admin_user, get_current_user, hash_password,
    issue_device_token, new_id, send_email, verify_password, consume_auth_token,
)
from .config import settings
from .credits import InsufficientCredits
from .db import Base, SessionLocal, engine, get_db
from .models import (
    AISuggestion, CreditTransaction, Device, Document, GlossaryEntry, Page,
    PageJob, Segment, StripeEvent, Subscription, Transcription, User,
)
from .ocr_service import enqueue_page_ocr

app = FastAPI(title=settings.app_name, docs_url="/api/docs", openapi_url="/api/openapi.json")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(engine)
    _migrate()
    storage.ensure_bucket()


def _migrate() -> None:
    """Tiny in-place migrations for beta deployments (no Alembic yet)."""
    from sqlalchemy import text
    stmts = [
        "ALTER TABLE pages ADD COLUMN IF NOT EXISTS derivative_key VARCHAR(512)",
        "ALTER TABLE transcriptions ALTER COLUMN confidence_score TYPE double precision",
        "ALTER TABLE segments ALTER COLUMN confidence_score TYPE double precision",
        "ALTER TABLE ai_suggestions ALTER COLUMN confidence TYPE double precision",
        "ALTER TABLE documents ADD COLUMN IF NOT EXISTS tags JSON DEFAULT '[]'",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(64)",
    ]
    with engine.begin() as conn:
        for stmt in stmts:
            try:
                conn.execute(text(stmt))
            except Exception:
                pass  # already migrated (sqlite dev) or column already float

    from . import migrations as _mig
    with engine.begin() as conn:
        _mig.run_once(conn, "rebase_credits_v2", _mig.rebase_credits_v2)


# ---------------------------------------------------------------- health
@app.get("/health")
@app.get("/api/health")
def health():
    return {"status": "ok", "service": "palimora-server"}


# ---------------------------------------------------------------- schemas
class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10)
    display_name: str = ""


class LoginIn(BaseModel):
    email: EmailStr
    password: str
    device_name: str = "web"


class MeOut(BaseModel):
    id: str
    email: str
    display_name: str
    is_admin: bool
    credit_balance: int
    email_verified: bool


class DocumentIn(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    subtitle: str = ""
    document_date: str = ""
    language_code: str = "fra"
    notes: str = ""
    tags: list[str] = []


class DocumentPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    subtitle: str | None = Field(default=None, max_length=255)
    document_date: str | None = Field(default=None, max_length=32)
    language_code: str | None = Field(default=None, max_length=10)
    notes: str | None = Field(default=None, max_length=10000)
    tags: list[str] | None = None


class UploadUrlIn(BaseModel):
    content_type: str
    size_bytes: int


class FinalizeIn(BaseModel):
    page_ids: list[str] = Field(min_length=1)


class TranscriptionPatch(BaseModel):
    edited_text: str | None = None
    segment_updates: list[dict] = []


class SuggestIn(BaseModel):
    text: str | None = None


class CreditsIn(BaseModel):
    delta: int
    note: str = ""


class GlossaryIn(BaseModel):
    term: str = Field(min_length=1, max_length=255)
    normalized_form: str = ""
    aliases: list[str] = []
    type: str = "free"
    note: str = ""
    is_preferred: bool = False


# ---------------------------------------------------------------- helpers
def _own_document(db: Session, user: User, document_id: str) -> Document:
    doc = db.query(Document).filter_by(id=document_id).one_or_none()
    if not doc or (doc.user_id != user.id and not user.is_admin):
        raise HTTPException(status_code=404, detail="Document introuvable")
    return doc


def _own_page(db: Session, user: User, page_id: str) -> Page:
    page = db.query(Page).filter_by(id=page_id).one_or_none()
    if not page:
        raise HTTPException(status_code=404, detail="Page introuvable")
    doc = db.query(Document).filter_by(id=page.document_id).one()
    if doc.user_id != user.id and not user.is_admin:
        raise HTTPException(status_code=404, detail="Page introuvable")
    page.document = doc
    return page


def _latest_transcription(db: Session, page_id: str) -> Transcription | None:
    return (
        db.query(Transcription)
        .filter_by(page_id=page_id)
        .order_by(Transcription.version_number.desc())
        .first()
    )


def _page_image_url(page: Page) -> str:
    """Presigned URL for the best displayable render (PNG derivative > original)."""
    if not page.storage_key:
        return ""
    if settings.storage_backend == "s3" and settings.s3_presign_public:
        target = page.derivative_key or page.storage_key
        if page.content_type.startswith("application/pdf") and not page.derivative_key:
            return ""  # PDF without derivative: not displayable in an <img>
        return storage.presign_get(target, ttl=3600) or ""
    return f"/api/pages/{page.id}/image"


def _page_out(db: Session, page: Page) -> dict:
    return {
        "id": page.id,
        "document_id": page.document_id,
        "page_number": page.page_number,
        "content_type": page.content_type,
        "processing_status": page.processing_status,
        "validation_status": page.validation_status,
        "error": page.error,
        "credits_charged": page.credits_charged,
    }


# ---------------------------------------------------------------- auth
@app.post("/api/auth/register")
def register(payload: RegisterIn, db: Session = Depends(get_db)):
    email = payload.email.lower().strip()
    if db.query(User).filter_by(email=email).one_or_none():
        raise HTTPException(status_code=409, detail="Un compte existe déjà avec cet email")
    user = User(
        id=new_id(),
        email=email,
        password_hash=hash_password(payload.password),
        display_name=payload.display_name[:120],
        is_admin=(email in settings.admin_emails)
        or db.query(User).count() == 0,  # first user is admin
    )
    db.add(user)
    db.flush()
    credits.grant(db, user, settings.signup_bonus, "signup_bonus",
                  note="Crédits de bienvenue")
    db.commit()

    verify_link = ""
    if settings.smtp_host:
        token = create_auth_token(db, user, "verify", ttl_minutes=60 * 24)
        link = f"{settings.base_url}/verify?token={token}"
        send_email(email, "Palimora — vérification de votre email",
                   f"Bienvenue sur Palimora ! Vérifiez votre email : {link}")
    else:
        # dev mode (no SMTP): auto-verify and expose the token link in the response
        user.email_verified = True
        db.commit()
    token = issue_device_token(db, user, "web")
    return {"token": token, "me": _me_out(user), "verify_link": verify_link}


@app.post("/api/auth/login")
def login(payload: LoginIn, db: Session = Depends(get_db)):
    user = db.query(User).filter_by(email=payload.email.lower().strip()).one_or_none()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Email ou mot de passe incorrect")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Compte désactivé")
    token = issue_device_token(db, user, payload.device_name[:120])
    return {"token": token, "me": _me_out(user)}


@app.get("/api/auth/me")
def me(user: User = Depends(get_current_user)):
    return _me_out(user)


@app.post("/api/auth/logout")
def logout(request: Request, db: Session = Depends(get_db),
           user: User = Depends(get_current_user)):
    from .auth import _hash_token, bearer_token
    token = bearer_token(request) or ""
    device = db.query(Device).filter_by(token_hash=_hash_token(token)).one_or_none()
    if device:
        device.revoked = True
        db.commit()
    return {"ok": True}


@app.post("/api/auth/request-reset")
def request_reset(payload: dict, db: Session = Depends(get_db)):
    email = str(payload.get("email", "")).lower().strip()
    user = db.query(User).filter_by(email=email).one_or_none()
    reset_link = ""
    if user:
        token = create_auth_token(db, user, "reset", ttl_minutes=60)
        link = f"{settings.base_url}/reset?token={token}"
        sent = send_email(email, "Palimora — réinitialisation",
                          f"Réinitialisez votre mot de passe : {link}")
        if not sent:
            reset_link = link  # dev mode: no SMTP configured
    # always 200 to avoid account enumeration
    return {"ok": True, "reset_link": reset_link}


@app.post("/api/auth/reset")
def reset(payload: dict, db: Session = Depends(get_db)):
    token = str(payload.get("token", ""))
    password = str(payload.get("password", ""))
    if len(password) < 10:
        raise HTTPException(status_code=422, detail="Mot de passe trop court (10 caractères min)")
    user = consume_auth_token(db, token, "reset")
    if not user:
        raise HTTPException(status_code=400, detail="Lien invalide ou expiré")
    user.password_hash = hash_password(password)
    for device in db.query(Device).filter_by(user_id=user.id).all():
        device.revoked = True  # force re-login everywhere
    db.commit()
    return {"ok": True}


def _me_out(user: User) -> MeOut:
    return MeOut(
        id=user.id, email=user.email, display_name=user.display_name,
        is_admin=user.is_admin, credit_balance=user.credit_balance,
        email_verified=user.email_verified,
    )


app.include_router(billing.router)
app.include_router(billing.webhook_router)


# ---------------------------------------------------------------- usage
@app.get("/api/usage")
def usage(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    txs = (
        db.query(CreditTransaction)
        .filter_by(user_id=user.id)
        .order_by(CreditTransaction.created_at.desc())
        .limit(30)
        .all()
    )
    return {
        "balance": user.credit_balance,
        "page_cost": credits.page_cost(),
        "ai_correction_cost": credits.ai_cost(),
        "stripe_publishable_key": settings.stripe_publishable_key,
        "credits_per_page": credits.page_cost(),
        "transactions": [
            {"delta": t.delta, "balance_after": t.balance_after, "reason": t.reason,
             "note": t.note, "created_at": t.created_at.isoformat()}
            for t in txs
        ],
    }


# ---------------------------------------------------------------- documents
@app.post("/api/documents")
def create_document(payload: DocumentIn, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    doc = Document(user_id=user.id, **payload.model_dump())
    db.add(doc)
    db.commit()
    return {"id": doc.id, "status": doc.status}


@app.patch("/api/documents/{document_id}")
def update_document(document_id: str, payload: DocumentPatch, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    doc = _own_document(db, user, document_id)
    fields = payload.model_dump(exclude_unset=True)
    if "tags" in fields:
        seen: set[str] = set()
        cleaned: list[str] = []
        for t in fields["tags"] or []:
            t = t.strip()
            if t and t not in seen:
                seen.add(t)
                cleaned.append(t)
        fields["tags"] = cleaned
    for key, value in fields.items():
        # Ne pas écraser une colonne NOT NULL avec un null explicite.
        if value is None and key in ("title",):
            continue
        setattr(doc, key, value)
    db.commit()
    return {"id": doc.id, "title": doc.title, "tags": doc.tags or []}


@app.get("/api/documents")
def list_documents(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    docs = (
        db.query(Document)
        .filter_by(user_id=user.id)
        .order_by(Document.created_at.desc())
        .all()
    )
    out = []
    for doc in docs:
        pages = db.query(Page).filter_by(document_id=doc.id).order_by(Page.page_number).all()
        done = sum(1 for p in pages if p.processing_status == "done")
        failed = sum(1 for p in pages if p.processing_status == "error")
        validated = sum(1 for p in pages if p.validation_status == "validated")
        out.append({
            "id": doc.id, "title": doc.title, "subtitle": doc.subtitle,
            "document_date": doc.document_date, "status": doc.status,
            "pages": len(pages), "pages_done": done, "pages_failed": failed,
            "pages_validated": validated,
            "created_at": doc.created_at.isoformat(),
        })
    return {"documents": out}


@app.get("/api/documents/{document_id}")
def get_document(document_id: str, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)):
    doc = _own_document(db, user, document_id)
    pages = db.query(Page).filter_by(document_id=doc.id).order_by(Page.page_number).all()
    return {
        "id": doc.id, "title": doc.title, "subtitle": doc.subtitle,
        "document_date": doc.document_date, "language_code": doc.language_code,
        "notes": doc.notes, "status": doc.status,
        "created_at": doc.created_at.isoformat(),
        "pages": [_page_out(db, p) for p in pages],
    }


@app.post("/api/documents/{document_id}/pages/upload-url")
def create_upload_url(document_id: str, payload: UploadUrlIn,
                      db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    doc = _own_document(db, user, document_id)
    if payload.content_type not in settings.allowed_content_types:
        raise HTTPException(status_code=415, detail="Type de fichier non supporté")
    if payload.size_bytes > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(status_code=413,
                            detail=f"Fichier trop volumineux (max {settings.max_upload_mb} Mo)")
    if not storage.storage_configured():
        raise HTTPException(status_code=503, detail="Stockage non configuré")

    max_num = db.query(func.max(Page.page_number)).filter_by(document_id=doc.id).scalar() or 0
    page = Page(document_id=doc.id, page_number=max_num + 1,
                content_type=payload.content_type, size_bytes=payload.size_bytes)
    db.add(page)
    db.flush()
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/tiff": "tif",
           "image/webp": "webp", "image/heic": "heic", "image/heif": "heif",
           "application/pdf": "pdf"}.get(payload.content_type, "bin")
    page.storage_key = storage.object_key(doc.user_id, doc.id, page.id, ext)
    db.commit()
    return {
        "page_id": page.id,
        "page_number": page.page_number,
        "storage_key": page.storage_key,
        "upload_url": storage.presign_put(page.storage_key, payload.content_type),
        # null with the local backend → POST the bytes to /api/pages/{id}/upload
    }


@app.post("/api/pages/{page_id}/upload")
async def upload_page_bytes(page_id: str, file: UploadFile,
                            db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Direct upload through the API (used with the local storage backend)."""
    page = _own_page(db, user, page_id)
    if file.content_type and file.content_type not in settings.allowed_content_types:
        raise HTTPException(status_code=415, detail="Type de fichier non supporté")
    payload = await file.read()
    if len(payload) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(status_code=413,
                            detail=f"Fichier trop volumineux (max {settings.max_upload_mb} Mo)")
    import tempfile as _tempfile
    fd, local = _tempfile.mkstemp()
    with os.fdopen(fd, "wb") as f:
        f.write(payload)
    try:
        storage.upload_file(local, page.storage_key, file.content_type or "application/octet-stream")
    finally:
        try:
            os.remove(local)
        except OSError:
            pass
    page.size_bytes = len(payload)
    if file.content_type:
        page.content_type = file.content_type
    db.commit()
    return {"ok": True}


@app.get("/api/pages/{page_id}/image")
def get_page_image(page_id: str, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    page = _own_page(db, user, page_id)
    key = page.derivative_key or page.storage_key
    if not key or not storage.object_exists(key):
        raise HTTPException(status_code=404, detail="Image non trouvée")
    from fastapi.responses import Response
    media = "image/png" if page.derivative_key else (page.content_type or "application/octet-stream")
    return Response(content=storage.read_bytes(key), media_type=media)


@app.get("/api/internal/pages/{page_id}/file")
def internal_page_file(page_id: str, request: Request, db: Session = Depends(get_db)):
    """Worker-only file access for the local storage backend (no shared volume)."""
    from fastapi.responses import Response
    from .config import settings as _s
    if request.headers.get("X-Internal-Key") != _s.secret_key:
        raise HTTPException(status_code=403, detail="Clé interne invalide")
    page = db.query(Page).filter_by(id=page_id).one_or_none()
    if not page or not page.storage_key:
        raise HTTPException(status_code=404, detail="Page introuvable")
    return Response(content=storage.read_bytes(page.storage_key),
                    media_type=page.content_type or "application/octet-stream")


@app.post("/api/documents/{document_id}/finalize")
def finalize_document(document_id: str, payload: FinalizeIn,
                      db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    doc = _own_document(db, user, document_id)
    pages = db.query(Page).filter_by(document_id=doc.id).all()
    by_id = {p.id: p for p in pages}
    ordered = [by_id[pid] for pid in payload.page_ids if pid in by_id]
    # finalize is not re-runnable: only idle/errored pages are processed (use /reocr)
    ordered = [p for p in ordered if p.processing_status in ("idle", "error")]
    if not ordered:
        raise HTTPException(status_code=400,
                            detail="Aucune page à traiter (déjà en file ou traitée — utilisez ré-OCR)")

    # PDF: expand to one page row per PDF page (same storage_key, once)
    pdf_pages = [p for p in ordered if p.content_type == "application/pdf"]
    if pdf_pages:
        _expand_pdf_pages(db, ordered, pdf_pages)
        # billing + queue must cover every sibling row of each PDF
        final: list[Page] = []
        seen_keys: set[str] = set()
        for p in ordered:
            if p.content_type == "application/pdf":
                if p.storage_key in seen_keys:
                    continue
                seen_keys.add(p.storage_key)
                final.extend(
                    db.query(Page)
                    .filter_by(document_id=p.document_id, storage_key=p.storage_key)
                    .order_by(Page.id)
                    .all()
                )
            else:
                final.append(p)
        ordered = final

    total_pages = len(ordered)
    cost = total_pages * credits.page_cost()
    try:
        credits.charge(db, user, cost, "page_ocr", ref_type="document", ref_id=doc.id,
                       note=f"{total_pages} page(s)")
    except InsufficientCredits as exc:
        raise HTTPException(status_code=402, detail=str(exc))

    spread = cost // max(1, total_pages)
    remainder = cost - spread * max(1, total_pages)
    job_pages: list[Page] = []
    for idx, page in enumerate(ordered):
        page.credits_charged = spread + (remainder if idx == 0 else 0)
        page.processing_status = "queued"
    # keep ordered page_number final
    for idx, page in enumerate(ordered):
        page.page_number = idx + 1

    for page in ordered:
        if page.content_type == "application/pdf":
            if page.storage_key not in {p.storage_key for p in job_pages}:
                job_pages.append(page)  # one job per distinct PDF
        else:
            job_pages.append(page)

    for page in job_pages:
        enqueue_page_ocr(db, page)

    doc.status = "processing"
    db.commit()
    return {"ok": True, "pages": len(ordered), "credits_charged": cost,
            "balance": user.credit_balance}


def _expand_pdf_pages(db: Session, ordered: list[Page], pdf_pages: list[Page]) -> None:
    """A PDF row becomes N page rows sharing the same storage_key."""
    for pdf in pdf_pages:
        existing = db.query(Page).filter_by(
            document_id=pdf.document_id, storage_key=pdf.storage_key).count()
        if existing > 1:
            continue  # already expanded by a previous finalize attempt
        if pdf.size_bytes <= 0:
            size = storage.object_size(pdf.storage_key)
            pdf.size_bytes = size or 0
        local = storage.download_to_temp(pdf.storage_key)
        try:
            reader = pypdf.PdfReader(io.BytesIO(open(local, "rb").read()))
            count = len(reader.pages)
        except Exception as exc:
            raise HTTPException(status_code=422,
                                detail=f"PDF illisible ({exc})") from exc
        finally:
            try:
                os.remove(local)
            except OSError:
                pass
        if count < 1:
            raise HTTPException(status_code=422, detail="PDF sans page")
        for extra in range(1, count):
            db.add(Page(
                document_id=pdf.document_id, page_number=0,  # renumbered at finalize
                storage_key=pdf.storage_key, content_type=pdf.content_type,
                size_bytes=pdf.size_bytes,
            ))
        db.flush()  # new rows must be visible to the sibling query (autoflush off)
        # reload the page list including the new rows
        siblings = db.query(Page).filter_by(
            document_id=pdf.document_id, storage_key=pdf.storage_key
        ).order_by(Page.id).all()
        for s in siblings:
            if s not in ordered:
                ordered.append(s)


@app.post("/api/documents/{document_id}/validate")
def validate_document(document_id: str, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    doc = _own_document(db, user, document_id)
    doc.status = "validated"
    for page in db.query(Page).filter_by(document_id=doc.id).all():
        page.validation_status = "validated"
        page.processing_status = "done" if page.processing_status == "done" else page.processing_status
    db.commit()
    return {"ok": True}


@app.delete("/api/documents/{document_id}")
def delete_document(document_id: str, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    doc = _own_document(db, user, document_id)
    for page in db.query(Page).filter_by(document_id=doc.id).all():
        if page.storage_key:
            storage.delete_object(page.storage_key)
        db.query(PageJob).filter_by(page_id=page.id).delete()
        db.query(AISuggestion).filter_by(page_id=page.id).delete()
        db.query(Transcription).filter_by(page_id=page.id).delete()
        db.delete(page)
    db.delete(doc)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- pages
@app.get("/api/pages/{page_id}")
def get_page(page_id: str, db: Session = Depends(get_db),
             user: User = Depends(get_current_user)):
    page = _own_page(db, user, page_id)
    transcription = _latest_transcription(db, page.id)
    segments = []
    if transcription:
        segments = [
            {
                "id": s.id, "reading_order": s.reading_order, "type": s.type,
                "source_text": s.source_text, "edited_text": s.edited_text,
                "confidence": s.confidence_score, "bbox": s.bbox_json,
                "is_uncertain": s.is_uncertain, "is_validated": s.is_validated,
            }
            for s in transcription.segments
        ]
    suggestions = db.query(AISuggestion).filter_by(page_id=page.id).order_by(
        AISuggestion.created_at.desc()).all()
    return {
        **_page_out(db, page),
        "image_url": _page_image_url(page),
        "transcription": {
            "id": transcription.id,
            "raw_htr_text": transcription.raw_htr_text,
            "edited_text": transcription.edited_text,
            "confidence": transcription.confidence_score,
            "version": transcription.version_number,
        } if transcription else None,
        "segments": segments,
        "suggestions": [
            {"id": s.id, "original_text": s.original_text, "suggested_text": s.suggested_text,
             "explanation": s.explanation, "confidence": s.confidence, "status": s.status,
             "model": s.model}
            for s in suggestions
        ],
    }


@app.post("/api/pages/{page_id}/reocr")
def reocr_page(page_id: str, db: Session = Depends(get_db),
               user: User = Depends(get_current_user)):
    page = _own_page(db, user, page_id)
    doc = page.document
    if page.content_type.startswith("application/pdf"):
        busy = db.query(Page).filter(
            Page.document_id == doc.id,
            Page.storage_key == page.storage_key,
            Page.processing_status.in_(("queued", "transcribing")),
        ).count()
        if busy:
            raise HTTPException(status_code=409,
                                detail="Ce PDF est déjà en cours de traitement")
    try:
        credits.charge(db, user, credits.page_cost(), "page_ocr",
                       ref_type="page", ref_id=page.id, note="Ré-OCR")
    except InsufficientCredits as exc:
        raise HTTPException(status_code=402, detail=str(exc))
    page.credits_charged += credits.page_cost()
    page.processing_status = "queued"
    page.error = ""
    enqueue_page_ocr(db, page)
    doc.status = "processing"
    db.commit()
    return {"ok": True, "balance": user.credit_balance}


@app.patch("/api/pages/{page_id}/transcription")
def patch_transcription(page_id: str, payload: TranscriptionPatch,
                        db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    page = _own_page(db, user, page_id)
    transcription = _latest_transcription(db, page.id)
    if not transcription:
        raise HTTPException(status_code=404, detail="Aucune transcription sur cette page")
    if payload.edited_text is not None:
        transcription.edited_text = payload.edited_text
        transcription.source = "manual" if not transcription.raw_htr_text else transcription.source
    for update in payload.segment_updates:
        seg = next((s for s in transcription.segments if s.id == update.get("segment_id")), None)
        if not seg:
            continue
        if "edited_text" in update:
            seg.edited_text = str(update["edited_text"])
        if update.get("is_validated") is not None:
            seg.is_validated = bool(update["is_validated"])
    page.validation_status = "in_progress" if page.validation_status == "unreviewed" else page.validation_status
    db.commit()
    return {"ok": True, "version": transcription.version_number}


@app.post("/api/pages/{page_id}/validate")
def validate_page(page_id: str, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    page = _own_page(db, user, page_id)
    page.validation_status = "validated"
    if page.processing_status == "done":
        transcription = _latest_transcription(db, page.id)
        if transcription and not transcription.edited_text:
            transcription.edited_text = transcription.raw_htr_text
        doc = page.document
        others = db.query(Page).filter(
            Page.document_id == doc.id, Page.validation_status != "validated").count()
        if others == 0:
            doc.status = "validated"
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- AI correction
@app.post("/api/pages/{page_id}/ai-suggest")
def ai_suggest(page_id: str, payload: SuggestIn,
               db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    page = _own_page(db, user, page_id)
    transcription = _latest_transcription(db, page.id)
    if not transcription:
        raise HTTPException(status_code=404, detail="Aucune transcription à corriger")
    text = (payload.text or transcription.edited_text or transcription.raw_htr_text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Page vide")
    try:
        # ai_cost() is 0 in the current pricing (AI correction free) -> no-op.
        credits.charge(db, user, credits.ai_cost(), "ai_correction",
                       ref_type="page", ref_id=page.id, note="Correction IA")
    except InsufficientCredits as exc:
        raise HTTPException(status_code=402, detail=str(exc))
    try:
        entries = db.query(GlossaryEntry).filter_by(user_id=user.id).all()
        suggestions = ai.suggest_corrections(text, entries)
    except Exception as exc:  # noqa: BLE001
        credits.grant(db, user, credits.ai_cost(), "ai_correction_refund",
                      ref_type="page", ref_id=page.id, note="Échec correction IA")
        db.commit()
        raise HTTPException(status_code=502, detail=f"Correction IA indisponible : {exc}")
    db.query(AISuggestion).filter_by(page_id=page.id, status="pending").delete()
    rows = [AISuggestion(
        page_id=page.id, transcription_id=transcription.id,
        original_text=s["originalText"], suggested_text=s["suggestedText"],
        explanation=s["explanation"], confidence=s["confidenceScore"],
        status="pending", model=settings.openai_model,
    ) for s in suggestions]
    db.add_all(rows)
    db.flush()  # ids must exist before returning them to the client
    out = [{"id": r.id, "original_text": r.original_text,
            "suggested_text": r.suggested_text, "explanation": r.explanation,
            "confidence": r.confidence, "status": r.status} for r in rows]
    db.commit()
    return {"suggestions": out, "balance": user.credit_balance}


@app.post("/api/suggestions/{suggestion_id}/accept")
def accept_suggestion(suggestion_id: str, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    suggestion = _own_suggestion(db, user, suggestion_id)
    transcription = _latest_transcription(db, suggestion.page_id)
    if transcription:
        target = transcription.edited_text or transcription.raw_htr_text
        updated = target.replace(suggestion.original_text, suggestion.suggested_text, 1)
        if updated != target:
            transcription.edited_text = updated
        for seg in transcription.segments:
            current = seg.edited_text or seg.source_text
            if suggestion.original_text in current:
                seg.edited_text = current.replace(suggestion.original_text,
                                                  suggestion.suggested_text, 1)
    suggestion.status = "accepted"
    db.commit()
    return {"ok": True}


@app.post("/api/suggestions/{suggestion_id}/reject")
def reject_suggestion(suggestion_id: str, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    suggestion = _own_suggestion(db, user, suggestion_id)
    suggestion.status = "rejected"
    db.commit()
    return {"ok": True}


def _own_suggestion(db: Session, user: User, suggestion_id: str) -> AISuggestion:
    suggestion = db.query(AISuggestion).filter_by(id=suggestion_id).one_or_none()
    if not suggestion:
        raise HTTPException(status_code=404, detail="Suggestion introuvable")
    doc = db.query(Document).filter_by(
        id=db.query(Page).filter_by(id=suggestion.page_id).one().document_id).one()
    if doc.user_id != user.id and not user.is_admin:
        raise HTTPException(status_code=404, detail="Suggestion introuvable")
    return suggestion


# ---------------------------------------------------------------- glossary
@app.get("/api/glossary")
def list_glossary(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    entries = db.query(GlossaryEntry).filter_by(user_id=user.id).order_by(GlossaryEntry.term).all()
    return {"entries": [
        {"id": e.id, "term": e.term, "normalized_form": e.normalized_form,
         "aliases": e.aliases, "type": e.type, "note": e.note, "is_preferred": e.is_preferred}
        for e in entries
    ]}


@app.post("/api/glossary")
def add_glossary(payload: GlossaryIn, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)):
    if db.query(GlossaryEntry).filter_by(user_id=user.id, term=payload.term).one_or_none():
        raise HTTPException(status_code=409, detail="Terme déjà présent")
    entry = GlossaryEntry(user_id=user.id, **payload.model_dump())
    db.add(entry)
    db.commit()
    return {"id": entry.id}


@app.delete("/api/glossary/{entry_id}")
def delete_glossary(entry_id: str, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    entry = db.query(GlossaryEntry).filter_by(id=entry_id, user_id=user.id).one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Entrée introuvable")
    db.delete(entry)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- exports (v1: markdown)
@app.get("/api/documents/{document_id}/export/markdown")
def export_markdown(document_id: str, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    doc = _own_document(db, user, document_id)
    pages = db.query(Page).filter_by(document_id=doc.id).order_by(Page.page_number).all()
    lines_out = [
        "---", f"title: {doc.title}", f"date: {doc.document_date}",
        f"exported: {datetime.now(timezone.utc).isoformat()}", "---", "", f"# {doc.title}", "",
    ]
    for page in pages:
        transcription = _latest_transcription(db, page.id)
        lines_out.append(f"## Page {page.page_number}")
        lines_out.append("")
        if transcription:
            text = transcription.edited_text or transcription.raw_htr_text
            lines_out.extend(text.splitlines() or [""])
        else:
            lines_out.append("_(non transcrite)_")
        lines_out.append("")
    return PlainTextResponse("\n".join(lines_out), media_type="text/markdown; charset=utf-8")


# ---------------------------------------------------------------- queue view
@app.get("/api/queue")
def queue_view(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    docs = db.query(Document).filter_by(user_id=user.id).order_by(Document.updated_at.desc()).all()
    items = []
    for doc in docs[:50]:
        pages = db.query(Page).filter_by(document_id=doc.id).order_by(Page.page_number).all()
        counts = {"done": 0, "error": 0, "validated": 0}
        for p in pages:
            if p.processing_status == "done":
                counts["done"] += 1
            if p.processing_status == "error":
                counts["error"] += 1
            if p.validation_status == "validated":
                counts["validated"] += 1
        items.append({
            "id": doc.id, "title": doc.title, "status": doc.status,
            "tags": doc.tags or [],
            "pages": len(pages), **counts,
            "updated_at": doc.updated_at.isoformat(),
        })
    return {"queue": items}


# ---------------------------------------------------------------- admin
@app.get("/api/admin/users")
def admin_users(db: Session = Depends(get_db), admin: User = Depends(get_admin_user)):
    users = db.query(User).order_by(User.created_at.desc()).all()
    return {"users": [
        {"id": u.id, "email": u.email, "display_name": u.display_name,
         "credit_balance": u.credit_balance, "is_admin": u.is_admin,
         "is_active": u.is_active, "created_at": u.created_at.isoformat()}
        for u in users
    ]}


@app.post("/api/admin/users/{user_id}/credits")
def admin_grant_credits(user_id: str, payload: CreditsIn, db: Session = Depends(get_db),
                        admin: User = Depends(get_admin_user)):
    target = db.query(User).filter_by(id=user_id).one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="Utilisateur introuvable")
    credits.grant(db, target, payload.delta, "admin_grant", note=payload.note or "Crédit admin")
    db.commit()
    return {"ok": True, "balance": target.credit_balance}


@app.post("/api/admin/users/{user_id}/toggle-active")
def admin_toggle_active(user_id: str, db: Session = Depends(get_db),
                        admin: User = Depends(get_admin_user)):
    target = db.query(User).filter_by(id=user_id).one_or_none()
    if not target:
        raise HTTPException(status_code=404, detail="Utilisateur introuvable")
    if target.id == admin.id:
        raise HTTPException(status_code=400, detail="Impossible de se désactiver soi-même")
    target.is_active = not target.is_active
    db.commit()
    return {"ok": True, "is_active": target.is_active}


@app.get("/api/admin/stats")
def admin_stats(db: Session = Depends(get_db), admin: User = Depends(get_admin_user)):
    return {
        "users": db.query(User).count(),
        "documents": db.query(Document).count(),
        "pages_done": db.query(Page).filter_by(processing_status="done").count(),
        "pages_error": db.query(Page).filter_by(processing_status="error").count(),
        "pages_total": db.query(Page).count(),
        "credits_in_circulation": db.query(func.sum(User.credit_balance)).scalar() or 0,
    }


@app.get("/api/admin/billing/events")
def admin_billing_events(failed: int = 0, db: Session = Depends(get_db),
                         admin: User = Depends(get_admin_user)):
    q = db.query(StripeEvent)
    if failed:
        q = q.filter(StripeEvent.processed_at.is_(None), StripeEvent.error != "")
    rows = q.order_by(StripeEvent.received_at.desc()).limit(100).all()
    return {"events": [
        {"id": e.id, "type": e.type, "error": e.error,
         "received_at": e.received_at.isoformat() if e.received_at else None,
         "processed": e.processed_at is not None}
        for e in rows
    ]}


@app.post("/api/admin/billing/events/{event_id}/replay")
def admin_billing_replay(event_id: str, db: Session = Depends(get_db),
                         admin: User = Depends(get_admin_user)):
    row = db.get(StripeEvent, event_id)
    if not row:
        raise HTTPException(status_code=404, detail="Événement inconnu")
    try:
        billing._handle_event(db, row.payload_json)
        row.processed_at = datetime.now(timezone.utc)
        row.error = ""
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        row = db.get(StripeEvent, event_id)
        row.error = str(e)[:500]
        row.processed_at = None
        db.commit()
        raise HTTPException(status_code=500, detail=str(e)[:200]) from e
    return {"status": "processed"}


@app.get("/api/admin/users/{user_id}/billing")
def admin_user_billing(user_id: str, db: Session = Depends(get_db),
                       admin: User = Depends(get_admin_user)):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Utilisateur inconnu")
    sub = (db.query(Subscription).filter_by(user_id=user_id)
           .order_by(Subscription.created_at.desc()).first())
    purchases = (db.query(CreditTransaction).filter_by(user_id=user_id)
                 .order_by(CreditTransaction.created_at.desc()).limit(20).all())
    return {
        "credit_balance": target.credit_balance,
        "subscription": billing._sub_dict(sub),
        "purchases": [{"reason": p.reason, "delta": p.delta, "note": p.note,
                       "created_at": p.created_at.isoformat() if p.created_at else None}
                      for p in purchases],
    }


# ---------------------------------------------------------------- search
@app.get("/api/search")
def search(q: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    needle = f"%{q.strip()}%"
    if len(q.strip()) < 2:
        return {"results": []}
    rows = (
        db.query(Segment, Transcription, Page, Document)
        .join(Transcription, Segment.transcription_id == Transcription.id)
        .join(Page, Transcription.page_id == Page.id)
        .join(Document, Page.document_id == Document.id)
        .filter(Document.user_id == user.id)
        .filter(
            (Segment.source_text.ilike(needle))
            | (Segment.edited_text.ilike(needle))
        )
        .order_by(Document.title, Page.page_number, Segment.reading_order)
        .limit(60)
        .all()
    )
    results = []
    for segment, transcription, page, document in rows:
        text = (segment.edited_text or segment.source_text or "").strip()
        low = text.lower()
        pos = low.find(q.strip().lower())
        start = max(0, pos - 40)
        snippet = ("…" if start > 0 else "") + text[start:start + 120] + ("…" if start + 120 < len(text) else "")
        results.append({
            "document_id": document.id, "document_title": document.title,
            "page_id": page.id, "page_number": page.page_number,
            "segment_id": segment.id, "snippet": snippet,
        })
    return {"results": results}


# ---------------------------------------------------------------- static SPA
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(STATIC_DIR) and os.path.exists(os.path.join(STATIC_DIR, "index.html")):
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        target = os.path.join(STATIC_DIR, full_path)
        if full_path and os.path.isfile(target):
            return FileResponse(target)
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))
