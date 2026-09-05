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
