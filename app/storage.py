"""Object storage abstraction. STORAGE_BACKEND selects:
- 'local': files on a volume (STORAGE_DIR) — dev / interim, no presigned URLs
- 's3':    any S3-compatible endpoint (Backblaze B2 in production) with presigned PUT/GET
"""
import os
import tempfile

import boto3
from botocore.client import Config as BotoConfig

from .config import settings

_client = None


def client():
    global _client
    if _client is None:
        if not settings.s3_access_key:
            raise RuntimeError("Stockage S3 non configuré (S3_ACCESS_KEY manquant)")
        _client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url or None,
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            config=BotoConfig(signature_version="s3v4"),
        )
    return _client


def storage_configured() -> bool:
    if settings.storage_backend == "local":
        return True
    return bool(settings.s3_access_key and settings.s3_bucket)


def ensure_bucket() -> None:
    """Create the bucket when missing (MinIO interim; B2 keys may be restricted)."""
    if settings.storage_backend != "s3":
        return
    try:
        buckets = {b["Name"] for b in client().list_buckets().get("Buckets", [])}
        if settings.s3_bucket not in buckets:
            client().create_bucket(Bucket=settings.s3_bucket)
    except Exception:
        pass  # restricted keys: assume the bucket exists


def object_key(user_id: str, document_id: str, page_id: str, ext: str) -> str:
    ext = (ext or "bin").lstrip(".")
    return f"originals/{user_id}/{document_id}/{page_id}.{ext}"


def _local_path(key: str) -> str:
    return os.path.join(settings.storage_dir, key)


def presign_put(key: str, content_type: str) -> str | None:
    """Presigned PUT for s3 backend; None for local (client uploads through the API)."""
    if settings.storage_backend == "local":
        return None
    return client().generate_presigned_url(
        "put_object",
        Params={"Bucket": settings.s3_bucket, "Key": key, "ContentType": content_type},
        ExpiresIn=settings.presign_ttl,
    )


def presign_get(key: str, ttl: int | None = None) -> str | None:
    if settings.storage_backend == "local":
        return None  # served through the authenticated /image route instead
    return client().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.s3_bucket, "Key": key},
        ExpiresIn=ttl or settings.presign_ttl,
    )


def object_exists(key: str) -> bool:
    if settings.storage_backend == "local":
        return os.path.isfile(_local_path(key))
    try:
        client().head_object(Bucket=settings.s3_bucket, Key=key)
        return True
    except Exception:
        return False


def object_size(key: str) -> int | None:
    if settings.storage_backend == "local":
        path = _local_path(key)
        return os.path.getsize(path) if os.path.isfile(path) else None
    try:
        return client().head_object(Bucket=settings.s3_bucket, Key=key)["ContentLength"]
    except Exception:
        return None


def download_to_temp(key: str) -> str:
    if settings.storage_backend == "local":
        import shutil
        src = _local_path(key)
        fd, path = tempfile.mkstemp(suffix=os.path.splitext(key)[1] or ".bin")
        os.close(fd)
        shutil.copyfile(src, path)
        return path
    fd, path = tempfile.mkstemp(suffix=os.path.splitext(key)[1] or ".bin")
    os.close(fd)
    client().download_file(settings.s3_bucket, key, path)
    return path


def upload_file(local_path: str, key: str, content_type: str) -> None:
    """Used by the API-backed upload path (local backend)."""
    if settings.storage_backend == "local":
        dest = _local_path(key)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        import shutil
        shutil.copyfile(local_path, dest)
        return
    client().upload_file(
        local_path, settings.s3_bucket, key,
        ExtraArgs={"ContentType": content_type},
    )


def read_bytes(key: str) -> bytes:
    if settings.storage_backend == "local":
        with open(_local_path(key), "rb") as f:
            return f.read()
    import io
    buf = io.BytesIO()
    client().download_fileobj(settings.s3_bucket, key, buf)
    return buf.getvalue()


def delete_object(key: str) -> None:
    if settings.storage_backend == "local":
        try:
            os.remove(_local_path(key))
        except OSError:
            pass
        return
    try:
        client().delete_object(Bucket=settings.s3_bucket, Key=key)
    except Exception:
        pass
