import pytest
from app import billing, stripe_gateway
from app.models import Subscription


@pytest.fixture(autouse=True)
def _stub(monkeypatch):
    monkeypatch.setattr(stripe_gateway, "ensure_customer", lambda user: "cus_x")
    monkeypatch.setattr(stripe_gateway, "create_subscription",
                        lambda **kw: ("seti_secret_x", "sub_123"))
    monkeypatch.setattr(stripe_gateway, "cancel_subscription", lambda sid: None)
    monkeypatch.setitem(billing.settings.stripe_price_ids, "atelier", "price_a")


def test_subscribe_creates_incomplete_row(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    r = client.post("/api/billing/subscribe", json={"plan_id": "atelier"},
                    headers=auth_headers(db, u))
    assert r.status_code == 200
    assert r.json()["subscription_id"] == "sub_123"
    row = db.query(Subscription).filter_by(user_id=u.id).one()
    assert row.status == "incomplete"
    assert row.stripe_subscription_id == "sub_123"


def test_subscribe_conflict(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    db.add(Subscription(user_id=u.id, stripe_subscription_id="sub_old",
                        plan_id="atelier", status="active"))
    db.commit()
    r = client.post("/api/billing/subscribe", json={"plan_id": "atelier"},
                    headers=auth_headers(db, u))
    assert r.status_code == 409


def test_subscribe_rejects_one_shot(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    r = client.post("/api/billing/subscribe", json={"plan_id": "starter"},
                    headers=auth_headers(db, u))
    assert r.status_code == 400


def test_cancel(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    db.add(Subscription(user_id=u.id, stripe_subscription_id="sub_1",
                        plan_id="atelier", status="active"))
    db.commit()
    r = client.post("/api/billing/cancel", headers=auth_headers(db, u))
    assert r.status_code == 200
    db.expire_all()
    assert db.query(Subscription).filter_by(user_id=u.id).one().cancel_at_period_end is True


def test_cancel_without_subscription(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    assert client.post("/api/billing/cancel", headers=auth_headers(db, u)).status_code == 404
