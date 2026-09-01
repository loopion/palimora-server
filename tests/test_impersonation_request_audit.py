from app.models import AdminAuditLog
from tests.conftest import make_user, auth_headers


def _imp(db, admin, target_id):
    return {**auth_headers(db, admin), "X-Impersonate": target_id}


def test_benign_mutation_writes_request_row(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    r = client.post("/api/glossary", json={"term": "abbé"},
                    headers=_imp(db, admin, target.id))
    assert r.status_code == 200
    db.expire_all()
    rows = db.query(AdminAuditLog).filter_by(event="request").all()
    assert len(rows) == 1
    assert rows[0].actor_user_id == admin.id
    assert rows[0].target_user_id == target.id
    assert rows[0].method == "POST"
    assert rows[0].path == "/api/glossary"
    assert rows[0].status_code == 200


def test_get_requests_not_logged(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    client.get("/api/documents", headers=_imp(db, admin, target.id))
    db.expire_all()
    assert db.query(AdminAuditLog).filter_by(event="request").count() == 0


def test_blocked_route_not_logged_as_request(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    client.post("/api/billing/intent", json={"pack_id": "starter"},
                headers=_imp(db, admin, target.id))
    db.expire_all()
    assert db.query(AdminAuditLog).filter_by(event="request").count() == 0


def test_non_admin_rejected_request_not_logged(client, db):
    u1 = make_user(db, email="u1@test.fr")
    u2 = make_user(db, email="u2@test.fr")
    client.post("/api/glossary", json={"term": "x"},
                headers=_imp(db, u1, u2.id))
    db.expire_all()
    assert db.query(AdminAuditLog).count() == 0
