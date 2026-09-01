from app.models import AdminAuditLog
from tests.conftest import make_user, auth_headers


def test_full_impersonation_flow(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr", credits=50)

    # 1. start
    r = client.post(f"/api/admin/impersonate/{target.id}", headers=auth_headers(db, admin))
    assert r.status_code == 200

    imp = {**auth_headers(db, admin), "X-Impersonate": target.id}

    # 2. benign mutation as target -> allowed + audited
    r = client.post("/api/documents", json={"title": "Doc de la cible"}, headers=imp)
    assert r.status_code == 200

    # 3. money action -> blocked
    r = client.post("/api/billing/subscribe", json={"plan_id": "atelier"}, headers=imp)
    assert r.status_code == 403

    # 4. admin route -> blocked (target is non-admin)
    assert client.get("/api/admin/users", headers=imp).status_code == 403

    # 5. stop
    r = client.request("DELETE", f"/api/admin/impersonate?user_id={target.id}",
                       headers=auth_headers(db, admin))
    assert r.status_code == 204

    # 6. audit trail: start, one request row (the POST /api/documents), stop
    db.expire_all()
    events = [x.event for x in db.query(AdminAuditLog).order_by(AdminAuditLog.created_at).all()]
    assert events == ["impersonation.start", "request", "impersonation.stop"]
    req_row = db.query(AdminAuditLog).filter_by(event="request").one()
    assert req_row.path == "/api/documents"
    assert req_row.status_code == 200
