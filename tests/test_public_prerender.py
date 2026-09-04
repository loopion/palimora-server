import os

import pytest
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.testclient import TestClient

# These tests build a small, self-contained FastAPI app that registers a
# route shaped exactly like app.main's spa() catch-all, but pointed at a
# tmp_path directory instead of the real app/static/. This keeps the tests
# fully isolated from the real static tree (no pollution, no cleanup
# needed) and independent of whether a web build has ever been run — the
# real spa() route is only registered at import time when app/static/
# already contains an index.html, so importing app.main here would make
# these tests silently depend on that.
#
# The route logic below must be kept in sync with app.main's spa()
# (app/main.py) — it exercises the same fallback chain: an exact static
# file, a prerendered directory's index.html, then the app shell
# (app.html) if present, else the plain index.html.


def _make_app(static_dir: str) -> FastAPI:
    app = FastAPI()

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        target = os.path.join(static_dir, full_path)
        if full_path and os.path.isfile(target):
            return FileResponse(target)
        prerendered = os.path.join(static_dir, full_path, "index.html")
        if full_path and os.path.isfile(prerendered):
            return FileResponse(prerendered)
        app_shell = os.path.join(static_dir, "app.html")
        if full_path and os.path.isfile(app_shell):
            return FileResponse(app_shell)
        return FileResponse(os.path.join(static_dir, "index.html"))

    return app


def _write(base: str, rel_path: str, content: str) -> None:
    full = os.path.join(base, rel_path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(content)


def test_serves_prerendered_directory_index(tmp_path):
    static_dir = str(tmp_path)
    _write(static_dir, "index.html", "<html><body>root shell</body></html>")
    _write(static_dir, "tarifs/index.html", "<html><body>tarifs prerendered</body></html>")
    client = TestClient(_make_app(static_dir))
    resp = client.get("/tarifs")
    assert resp.status_code == 200
    assert "tarifs prerendered" in resp.text


def test_serves_prerendered_nested_locale_directory(tmp_path):
    static_dir = str(tmp_path)
    _write(static_dir, "index.html", "<html><body>root shell</body></html>")
    _write(static_dir, "en/pricing/index.html", "<html><body>pricing prerendered</body></html>")
    client = TestClient(_make_app(static_dir))
    resp = client.get("/en/pricing")
    assert resp.status_code == 200
    assert "pricing prerendered" in resp.text


def test_falls_back_to_root_index_for_unknown_path(tmp_path):
    static_dir = str(tmp_path)
    _write(static_dir, "index.html", "<html><body>root shell</body></html>")
    client = TestClient(_make_app(static_dir))
    resp = client.get("/some/unknown/spa/path")
    assert resp.status_code == 200
    assert "root shell" in resp.text


def test_app_only_path_serves_app_shell_not_the_homepage(tmp_path):
    """Regression test for the prerendered homepage overwriting the SPA
    app-shell fallback: an app-only path like /station must never serve
    the prerendered marketing homepage's markup — it should get the
    plain app.html shell (empty #root, no data-prerendered-path)."""
    static_dir = str(tmp_path)
    _write(
        static_dir,
        "index.html",
        '<html><body><div id="root" data-prerendered-path="/">'
        '<h1>Vos manuscrits ont une histoire à raconter.</h1></div></body></html>',
    )
    _write(static_dir, "app.html", '<html><body><div id="root"></div></body></html>')
    client = TestClient(_make_app(static_dir))
    resp = client.get("/station")
    assert resp.status_code == 200
    assert "manuscrits ont une histoire" not in resp.text
    assert 'data-prerendered-path' not in resp.text
    assert '<div id="root"></div>' in resp.text


def test_root_path_serves_prerendered_homepage_not_app_shell(tmp_path):
    """Regression test: GET / (full_path == "") must serve the prerendered
    homepage (index.html), not the empty app.html shell, even when both
    files exist in the static directory."""
    static_dir = str(tmp_path)
    _write(
        static_dir,
        "index.html",
        '<html><body><div id="root" data-prerendered-path="/">'
        '<h1>Vos manuscrits ont une histoire à raconter.</h1></div></body></html>',
    )
    _write(static_dir, "app.html", '<html><body><div id="root"></div></body></html>')
    client = TestClient(_make_app(static_dir))
    resp = client.get("/")
    assert resp.status_code == 200
    assert "manuscrits ont une histoire" in resp.text
    assert 'data-prerendered-path="/"' in resp.text


def test_app_only_path_falls_back_to_root_index_without_app_shell(tmp_path):
    """Backward compatibility: an older build with no app.html still
    falls back to index.html (pre-fix behaviour), rather than erroring."""
    static_dir = str(tmp_path)
    _write(static_dir, "index.html", "<html><body>root shell only</body></html>")
    client = TestClient(_make_app(static_dir))
    resp = client.get("/station")
    assert resp.status_code == 200
    assert "root shell only" in resp.text
