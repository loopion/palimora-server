def test_events_failed_filter(client, db):
    from tests.conftest import make_user, auth_headers
    from app.models import StripeEvent
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    db.add(StripeEvent(id="evt_ok", type="x", payload_json={}, error="",
                       processed_at=__import__("datetime").datetime.now()))
    db.add(StripeEvent(id="evt_bad", type="payment_intent.succeeded",
                       payload_json={"id": "evt_bad", "type": "customer.created",
                                     "data": {"object": {}}}, error="boom"))
    db.commit()
    r = client.get("/api/admin/billing/events?failed=1", headers=auth_headers(db, admin))
    assert r.status_code == 200
    ids = [e["id"] for e in r.json()["events"]]
    assert ids == ["evt_bad"]


def test_replay_marks_processed(client, db):
    from tests.conftest import make_user, auth_headers
    from app.models import StripeEvent
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    db.add(StripeEvent(id="evt_r", type="customer.created", error="was down",
                       payload_json={"id": "evt_r", "type": "customer.created",
                                     "data": {"object": {"id": "cus_1"}}}))
    db.commit()
    r = client.post("/api/admin/billing/events/evt_r/replay", headers=auth_headers(db, admin))
    assert r.status_code == 200
    db.expire_all()
    assert db.get(StripeEvent, "evt_r").processed_at is not None


def test_events_requires_admin(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    assert client.get("/api/admin/billing/events", headers=auth_headers(db, u)).status_code == 403
