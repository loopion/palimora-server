"""HTTP client for the Kraken OCR engine (loopion/kraken-ocr-service)."""
import httpx

from .config import settings


class KrakenError(Exception):
    pass


def _headers() -> dict:
    return {"X-API-Key": settings.kraken_api_key} if settings.kraken_api_key else {}


def submit_ocr(client: httpx.Client, file_bytes: bytes, ext: str, *,
               seg_model_path: str | None = None,
               rec_model_path: str | None = None) -> str:
    """POST /jobs — returns the Kraken job id."""
    data = {k: v for k, v in (("seg_model_path", seg_model_path),
                              ("rec_model_path", rec_model_path)) if v}
    resp = client.post(
        f"{settings.kraken_api_url}/jobs",
        files={"file": (f"page{ext}", file_bytes)},
        data=data or None,
        headers=_headers(),
        timeout=300,
    )
    if resp.status_code != 200:
        raise KrakenError(f"Kraken /jobs a répondu {resp.status_code}: {resp.text[:300]}")
    job_id = resp.json().get("job_id")
    if not job_id:
        raise KrakenError("Réponse Kraken sans job_id")
    return job_id


def fetch_result(client: httpx.Client, job_id: str) -> dict:
    """GET /jobs/{id} — returns the full job payload."""
    resp = client.get(
        f"{settings.kraken_api_url}/jobs/{job_id}",
        headers=_headers(),
        timeout=60,
    )
    if resp.status_code != 200:
        raise KrakenError(f"Kraken /jobs/{job_id} a répondu {resp.status_code}")
    return resp.json()


def wait_for_result(client: httpx.Client, job_id: str,
                    poll_seconds: int = 5, timeout_seconds: int | None = None) -> dict:
    """Poll until finished; raises on failure/timeout. Returns the result payload."""
    import time

    deadline = time.monotonic() + (timeout_seconds or settings.kraken_timeout)
    while time.monotonic() < deadline:
        data = fetch_result(client, job_id)
        status = data.get("status")
        if status == "finished":
            result = data.get("result") or {}
            if result.get("error"):
                raise KrakenError(f"Erreur Kraken: {result['error'][:500]}")
            return result
        if status in ("failed", "stopped"):
            raise KrakenError(f"Job Kraken en échec: {str(data)[:400]}")
        time.sleep(poll_seconds)
    raise KrakenError(f"Timeout Kraken après {timeout_seconds or settings.kraken_timeout}s")
