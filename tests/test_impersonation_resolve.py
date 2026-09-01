from tests.conftest import make_user, auth_headers


def _imp_headers(db, admin, target_id):
    return {**auth_headers(db, admin), "X-Impersonate": target_id}


def test_admin_sees_target_data(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    # target has a document; admin (impersonating) should see it via /api/documents
    r = client.post("/api/documents", json={"title": "T"},
                    headers=auth_headers(db, target))
    assert r.status_code == 200
    r = client.get("/api/documents", headers=_imp_headers(db, admin, target.id))
    assert r.status_code == 200
    assert any(d["title"] == "T" for d in r.json()["documents"])


def test_non_admin_impersonation_header_forbidden(client, db):
    u1 = make_user(db, email="u1@test.fr")
    u2 = make_user(db, email="u2@test.fr")
    r = client.get("/api/documents", headers=_imp_headers(db, u1, u2.id))
    assert r.status_code == 403


def test_unknown_target_404(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    r = client.get("/api/documents", headers=_imp_headers(db, admin, "nope"))
    assert r.status_code == 404


def test_inactive_target_404(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    target.is_active = False
    db.commit()
    r = client.get("/api/documents", headers=_imp_headers(db, admin, target.id))
    assert r.status_code == 404


def test_impersonating_another_admin_403(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    admin2 = make_user(db, email="admin2@test.fr", is_admin=True)
    r = client.get("/api/documents", headers=_imp_headers(db, admin, admin2.id))
    assert r.status_code == 403


def test_admin_routes_403_while_impersonating(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    r = client.get("/api/admin/users", headers=_imp_headers(db, admin, target.id))
    assert r.status_code == 403


def _scope(method, path, token, target_id):
    from starlette.requests import Request

    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "headers": [
            (b"authorization", f"Bearer {token}".encode()),
            (b"x-impersonate", target_id.encode()),
        ],
    }
    return Request(scope)


def test_impersonate_header_skipped_on_impersonate_paths(db):
    from app.auth import get_current_user, issue_device_token

    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    token = issue_device_token(db, admin, "t")
    req = _scope("DELETE", "/api/admin/impersonate", token, target.id)
    resolved = get_current_user(req, db)
    assert resolved.id == admin.id  # NOT target — path-skip active
    assert getattr(req.state, "impersonated_id", None) is None


def test_impersonate_header_active_on_normal_paths(db):
    from app.auth import get_current_user, issue_device_token

    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    token = issue_device_token(db, admin, "t")
    req = _scope("GET", "/api/documents", token, target.id)
    resolved = get_current_user(req, db)
    assert resolved.id == target.id
    assert req.state.impersonator_id == admin.id
