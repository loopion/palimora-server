from app.models import AdminAuditLog
from tests.conftest import make_user


def test_admin_audit_log_row_roundtrips(db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    row = AdminAuditLog(
        actor_user_id=admin.id,
        target_user_id=target.id,
        event="request",
        method="PATCH",
        path="/api/pages/abc/transcription",
        status_code=200,
    )
    db.add(row)
    db.commit()
    db.expire_all()

    saved = db.query(AdminAuditLog).one()
    assert saved.id  # uuid default applied
    assert saved.actor_user_id == admin.id
    assert saved.target_user_id == target.id
    assert saved.event == "request"
    assert saved.method == "PATCH"
    assert saved.status_code == 200
    assert saved.created_at is not None


def test_admin_audit_log_start_row_has_null_method_path(db):
    admin = make_user(db, email="a2@test.fr", is_admin=True)
    target = make_user(db, email="u2@test.fr")
    db.add(AdminAuditLog(actor_user_id=admin.id, target_user_id=target.id,
                         event="impersonation.start"))
    db.commit()
    db.expire_all()
    saved = db.query(AdminAuditLog).filter_by(event="impersonation.start").one()
    assert saved.method is None
    assert saved.path is None
    assert saved.status_code is None
