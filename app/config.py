"""Environment-driven configuration. Everything is set in Coolify, nothing hardcoded."""
import os


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


class Settings:
    # Core
    app_name: str = "Palimora Server"
    secret_key: str = os.getenv("SECRET_KEY", "dev-secret-change-me")
    base_url: str = os.getenv("BASE_URL", "http://localhost:8000")

    # Database
    database_url: str = os.getenv(
        "DATABASE_URL", "postgresql+psycopg://palimora:palimora@localhost:5432/palimora"
    )

    # Redis / queue (shared with the Kraken stack, dedicated queue names)
    redis_url: str = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    queue_name: str = os.getenv("PALIMORA_QUEUE", "palimora-ocr")

    # Internal API (worker → API file access for the local storage backend)
    internal_api_url: str = os.getenv("INTERNAL_API_URL", "http://localhost:8000")

    # Kraken OCR engine
    kraken_api_url: str = os.getenv("KRAKEN_API_URL", "http://localhost:8000")
    kraken_api_key: str = os.getenv("KRAKEN_API_KEY", "")
    kraken_timeout: int = _int("KRAKEN_TIMEOUT", 3600)

    # Object storage: 's3' (Backblaze B2 / MinIO via env) or 'local' (volume-backed, dev/interim)
    storage_backend: str = os.getenv("STORAGE_BACKEND", "local")
    storage_dir: str = os.getenv("STORAGE_DIR", "/data/palimora-storage")
    s3_endpoint_url: str = os.getenv("S3_ENDPOINT_URL", "")
    s3_region: str = os.getenv("S3_REGION", "us-east-005")
    s3_bucket: str = os.getenv("S3_BUCKET", "palimora")
    s3_access_key: str = os.getenv("S3_ACCESS_KEY", "")
    s3_secret_key: str = os.getenv("S3_SECRET_KEY", "")
    presign_ttl: int = _int("PRESIGN_TTL", 3600)
    # true when the S3 endpoint is publicly reachable (B2) so presigned image
    # URLs work in the browser; false (MinIO interim) routes images via the API.
    s3_presign_public: bool = os.getenv("S3_PRESIGN_PUBLIC", "false").lower() == "true"

    # Upload limits (matches the OCR engine limit)
    max_upload_mb: int = _int("MAX_UPLOAD_MB", 50)
    allowed_content_types: tuple[str, ...] = (
        "image/png", "image/jpeg", "image/tiff", "image/webp",
        "image/heic", "image/heif", "application/pdf",
    )

    # Credits (1 credit = 1 Kraken page; AI correction is free)
    page_cost: int = _int("PAGE_COST_POINTS", 1)
    ai_correction_cost: int = _int("AI_CORRECTION_COST_POINTS", 0)
    signup_bonus: int = _int("SIGNUP_BONUS_POINTS", 100)

    # AI correction (OpenAI-compatible)
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    openai_base_url: str = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

    # SMTP (optional in v1: when unset, verification/reset links are returned to the client)
    smtp_host: str = os.getenv("SMTP_HOST", "")
    smtp_port: int = _int("SMTP_PORT", 587)
    smtp_user: str = os.getenv("SMTP_USER", "")
    smtp_password: str = os.getenv("SMTP_PASSWORD", "")
    smtp_from: str = os.getenv("SMTP_FROM", "")

    # Bootstrap: these emails become admin on registration
    admin_emails: list[str] = [
        e.strip().lower()
        for e in os.getenv("ADMIN_EMAILS", "").split(",")
        if e.strip()
    ]
    # Stripe (test mode)
    stripe_secret_key: str = os.getenv("STRIPE_SECRET_KEY", "")
    stripe_publishable_key: str = os.getenv("STRIPE_PUBLISHABLE_KEY", "")
    stripe_webhook_secret: str = os.getenv("STRIPE_WEBHOOK_SECRET", "")
    stripe_tax_enabled: bool = os.getenv("STRIPE_TAX_ENABLED", "false").lower() == "true"
    stripe_price_ids: dict = {
        "starter": os.getenv("STRIPE_PRICE_STARTER", ""),
        "chercheur": os.getenv("STRIPE_PRICE_CHERCHEUR", ""),
        "archiviste": os.getenv("STRIPE_PRICE_ARCHIVISTE", ""),
        "atelier": os.getenv("STRIPE_PRICE_ATELIER", ""),
    }
    rebase_topup_to: int = _int("REBASE_TOPUP_TO", 0)

    # Billing entity (receipts / future invoices)
    billing_entity_name: str = os.getenv("BILLING_ENTITY_NAME", "Palimora")
    billing_entity_address: str = os.getenv("BILLING_ENTITY_ADDRESS", "")
    billing_entity_country: str = os.getenv("BILLING_ENTITY_COUNTRY", "FR")
    billing_vat_note: str = os.getenv("BILLING_VAT_NOTE", "TVA non applicable, art. 293 B du CGI")

    @property
    def stripe_enabled(self) -> bool:
        return bool(self.stripe_secret_key and self.stripe_webhook_secret)


settings = Settings()
