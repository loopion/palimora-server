from app.models import AdminAuditLog
from tests.conftest import make_user, auth_headers


def test_start_impersonation_writes_row_and_returns_target(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    r = client.post(f"/api/admin/impersonate/{target.id}", headers=auth_headers(db, admin))
    assert r.status_code == 200
    assert r.json() == {"id": target.id, "email": "user@test.fr",
                        "display_name": target.display_name}
    db.expire_all()
    row = db.query(AdminAuditLog).filter_by(event="impersonation.start").one()
    assert row.actor_user_id == admin.id
    assert row.target_user_id == target.id


def test_start_impersonation_of_admin_403(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    admin2 = make_user(db, email="admin2@test.fr", is_admin=True)
    r = client.post(f"/api/admin/impersonate/{admin2.id}", headers=auth_headers(db, admin))
    assert r.status_code == 403


def test_start_impersonation_unknown_404(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    r = client.post("/api/admin/impersonate/nope", headers=auth_headers(db, admin))
    assert r.status_code == 404


def test_start_impersonation_requires_admin(client, db):
    u = make_user(db, email="u@test.fr")
    other = make_user(db, email="o@test.fr")
    r = client.post(f"/api/admin/impersonate/{other.id}", headers=auth_headers(db, u))
    assert r.status_code == 403


def test_stop_impersonation_writes_row(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    r = client.request("DELETE", f"/api/admin/impersonate?user_id={target.id}",
                       headers=auth_headers(db, admin))
    assert r.status_code == 204
    db.expire_all()
    row = db.query(AdminAuditLog).filter_by(event="impersonation.stop").one()
    assert row.actor_user_id == admin.id
    assert row.target_user_id == target.id


def test_audit_list_newest_first_and_target_filter(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    a = make_user(db, email="a@test.fr")
    b = make_user(db, email="b@test.fr")
    client.post(f"/api/admin/impersonate/{a.id}", headers=auth_headers(db, admin))
    client.post(f"/api/admin/impersonate/{b.id}", headers=auth_headers(db, admin))

    r = client.get("/api/admin/audit?limit=10", headers=auth_headers(db, admin))
    assert r.status_code == 200
    rows = r.json()["rows"]
    assert len(rows) == 2
    assert rows[0]["target_email"] == "b@test.fr"  # newest first
    assert rows[0]["actor_email"] == "admin@test.fr"

    r = client.get(f"/api/admin/audit?target={a.id}", headers=auth_headers(db, admin))
    rows = r.json()["rows"]
    assert len(rows) == 1
    assert rows[0]["target_email"] == "a@test.fr"


def test_audit_requires_admin(client, db):
    u = make_user(db, email="u@test.fr")
    r = client.get("/api/admin/audit", headers=auth_headers(db, u))
    assert r.status_code == 403
