import os

from fastapi.testclient import TestClient

from app.main import app, STATIC_DIR


def _write(rel_path: str, content: str) -> None:
    full = os.path.join(STATIC_DIR, rel_path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(content)


def test_serves_prerendered_directory_index(tmp_path, monkeypatch):
    _write("tarifs/index.html", "<html><body>tarifs prerendered</body></html>")
    client = TestClient(app)
    resp = client.get("/tarifs")
    assert resp.status_code == 200
    assert "tarifs prerendered" in resp.text


def test_serves_prerendered_nested_locale_directory(tmp_path, monkeypatch):
    _write("en/pricing/index.html", "<html><body>pricing prerendered</body></html>")
    client = TestClient(app)
    resp = client.get("/en/pricing")
    assert resp.status_code == 200
    assert "pricing prerendered" in resp.text


def test_falls_back_to_root_index_for_unknown_path(tmp_path, monkeypatch):
    client = TestClient(app)
    resp = client.get("/some/unknown/spa/path")
    assert resp.status_code == 200
    # root index.html is whatever the build produced — just confirm it's not 404
    assert resp.status_code != 404
