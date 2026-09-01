"""ORM models — ported from the Palimora iOS SwiftData schema, server-side."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def uid() -> str:
    return str(uuid.uuid4())


def now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(120), default="")
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    credit_balance: Mapped[int] = mapped_column(Integer, default=0)
    stripe_customer_id: Mapped[str | None] = mapped_column(
        String(64), unique=True, index=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    documents: Mapped[list["Document"]] = relationship(back_populates="user")
    devices: Mapped[list["Device"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Device(Base):
    """Login sessions — one per browser / iPhone, token stored hashed."""
    __tablename__ = "devices"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)

    user: Mapped[User] = relationship(back_populates="devices")


class AuthToken(Base):
    """Email verification / password reset tokens (hashed, single use)."""
    __tablename__ = "auth_tokens"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    purpose: Mapped[str] = mapped_column(String(20))  # 'verify' | 'reset'
    token_hash: Mapped[str] = mapped_column(String(64), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class CreditTransaction(Base):
    """Immutable credit ledger."""
    __tablename__ = "credit_transactions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    delta: Mapped[int] = mapped_column(Integer)  # negative = spend, positive = grant/refund
    balance_after: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(40))
    ref_type: Mapped[str] = mapped_column(String(20), default="")
    ref_id: Mapped[str] = mapped_column(String(128), default="")
    note: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


class Subscription(Base):
    __tablename__ = "subscriptions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    stripe_subscription_id: Mapped[str] = mapped_column(String(64), unique=True)
    plan_id: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="incomplete")
    current_period_end: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)
    cancel_at_period_end: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, onupdate=now)


class StripeEvent(Base):
    __tablename__ = "stripe_events"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    type: Mapped[str] = mapped_column(String(64))
    payload_json: Mapped[dict] = mapped_column(JSON, default=dict)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    processed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True)
    error: Mapped[str] = mapped_column(String(500), default="")


class AdminAuditLog(Base):
    """Impersonation session boundaries + every mutating request made while an
    admin is impersonating a user. Written by app.audit.record (own session)."""
    __tablename__ = "admin_audit_log"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    actor_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True)
    target_user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=True)
    event: Mapped[str] = mapped_column(String(20))  # impersonation.start|stop|request
    method: Mapped[str | None] = mapped_column(String(10), nullable=True)
    path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now, index=True)


class SchemaMigration(Base):
    __tablename__ = "schema_migrations"
    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    applied_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Document(Base):
    __tablename__ = "documents"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str] = mapped_column(String(255))
    subtitle: Mapped[str] = mapped_column(String(255), default="")
    document_date: Mapped[str] = mapped_column(String(40), default="")
    language_code: Mapped[str] = mapped_column(String(10), default="fra")
    notes: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    # draft | processing | to_review | validated
    status: Mapped[str] = mapped_column(String(20), default="draft")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

    user: Mapped[User] = relationship(back_populates="documents")
    pages: Mapped[list["Page"]] = relationship(back_populates="document", order_by="Page.page_number")


class Page(Base):
    __tablename__ = "pages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id"), index=True)
    page_number: Mapped[int] = mapped_column(Integer, default=1)
    storage_key: Mapped[str] = mapped_column(String(512), default="")
    derivative_key: Mapped[str | None] = mapped_column(String(512), nullable=True)  # PNG render (PDF pages)
    content_type: Mapped[str] = mapped_column(String(60), default="")
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    # idle | queued | transcribing | done | error
    processing_status: Mapped[str] = mapped_column(String(20), default="idle")
    # unreviewed | in_progress | validated
    validation_status: Mapped[str] = mapped_column(String(20), default="unreviewed")
    error: Mapped[str] = mapped_column(Text, default="")
    kraken_job_id: Mapped[str] = mapped_column(String(64), default="")
    credits_charged: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

    document: Mapped[Document] = relationship(back_populates="pages")
    transcriptions: Mapped[list["Transcription"]] = relationship(
        back_populates="page", cascade="all, delete-orphan", order_by="Transcription.version_number.desc()"
    )


class Transcription(Base):
    __tablename__ = "transcriptions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    page_id: Mapped[str] = mapped_column(ForeignKey("pages.id"), index=True)
    raw_htr_text: Mapped[str] = mapped_column(Text, default="")
    edited_text: Mapped[str] = mapped_column(Text, default="")
    normalized_text: Mapped[str] = mapped_column(Text, default="")
    markdown_text: Mapped[str] = mapped_column(Text, default="")
    confidence_score: Mapped[float] = mapped_column(Float, default=0.0)
    source: Mapped[str] = mapped_column(String(20), default="htr")  # htr | manual | ai
    version_number: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)

    page: Mapped[Page] = relationship(back_populates="transcriptions")
    segments: Mapped[list["Segment"]] = relationship(
        back_populates="transcription", cascade="all, delete-orphan", order_by="Segment.reading_order"
    )


class Segment(Base):
    __tablename__ = "segments"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    transcription_id: Mapped[str] = mapped_column(ForeignKey("transcriptions.id"), index=True)
    type: Mapped[str] = mapped_column(String(20), default="line")
    source_text: Mapped[str] = mapped_column(Text, default="")
    edited_text: Mapped[str] = mapped_column(Text, default="")
    confidence_score: Mapped[float] = mapped_column(Float, default=0.0)
    bbox_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    reading_order: Mapped[int] = mapped_column(Integer, default=0)
    is_uncertain: Mapped[bool] = mapped_column(Boolean, default=False)
    is_validated: Mapped[bool] = mapped_column(Boolean, default=False)

    transcription: Mapped[Transcription] = relationship(back_populates="segments")


class AISuggestion(Base):
    __tablename__ = "ai_suggestions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    page_id: Mapped[str] = mapped_column(ForeignKey("pages.id"), index=True)
    transcription_id: Mapped[str] = mapped_column(String(36), default="")
    segment_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    original_text: Mapped[str] = mapped_column(Text, default="")
    suggested_text: Mapped[str] = mapped_column(Text, default="")
    explanation: Mapped[str] = mapped_column(Text, default="")
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|accepted|rejected
    model: Mapped[str] = mapped_column(String(80), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class GlossaryEntry(Base):
    __tablename__ = "glossary_entries"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    term: Mapped[str] = mapped_column(String(255))
    normalized_form: Mapped[str] = mapped_column(String(255), default="")
    aliases: Mapped[list] = mapped_column(JSON, default=list)
    type: Mapped[str] = mapped_column(String(30), default="free")  # person|surname|place|abbreviation|historical|free
    note: Mapped[str] = mapped_column(String(500), default="")
    is_preferred: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    __table_args__ = (UniqueConstraint("user_id", "term", name="uq_glossary_user_term"),)


class PageJob(Base):
    """Mirror of RQ jobs for queue visibility and retries."""
    __tablename__ = "page_jobs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    page_id: Mapped[str] = mapped_column(ForeignKey("pages.id"), index=True)
    rq_job_id: Mapped[str] = mapped_column(String(64), default="")
    # queued | running | completed | failed | cancelled
    status: Mapped[str] = mapped_column(String(20), default="queued")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
