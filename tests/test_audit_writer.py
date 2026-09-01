from app import audit
from app.models import AdminAuditLog
from tests.conftest import make_user


def test_record_inserts_row(client, db, monkeypatch):
    # client fixture patches app.db.engine to the shared test engine
    import app.db as db_module
    monkeypatch.setattr(audit, "_db", db_module, raising=False)  # no-op if already the module
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")

    audit.record(actor_user_id=admin.id, target_user_id=target.id,
                 event="request", method="POST", path="/api/glossary", status_code=200)

    db.expire_all()
    row = db.query(AdminAuditLog).one()
    assert row.event == "request"
    assert row.actor_user_id == admin.id
    assert row.status_code == 200


def test_record_never_raises_on_bad_data(client, db):
    # event too long / bad FK should be swallowed, not raised
    audit.record(actor_user_id="does-not-exist", event="request",
                 method="GET", path="/x", status_code=200)
    # no assertion needed: absence of exception is the test
