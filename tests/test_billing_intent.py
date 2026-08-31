import pytest
from app import billing, stripe_gateway


@pytest.fixture(autouse=True)
def _stub_gateway(monkeypatch):
    monkeypatch.setattr(stripe_gateway, "ensure_customer", lambda user: "cus_x")
    monkeypatch.setattr(
        stripe_gateway, "create_payment_intent",
        lambda **kw: ("pi_secret_x", 2900, "eur"))
    monkeypatch.setitem(billing.settings.stripe_price_ids, "starter", "price_s")


def test_intent_happy_path(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    r = client.post("/api/billing/intent", json={"pack_id": "starter"},
                    headers=auth_headers(db, u))
    assert r.status_code == 200
    assert r.json() == {"client_secret": "pi_secret_x", "amount": 2900, "currency": "eur"}


def test_intent_rejects_subscription(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    r = client.post("/api/billing/intent", json={"pack_id": "atelier"},
                    headers=auth_headers(db, u))
    assert r.status_code == 400


def test_intent_rejects_unknown(client, db):
    from tests.conftest import make_user, auth_headers
    u = make_user(db)
    r = client.post("/api/billing/intent", json={"pack_id": "nope"},
                    headers=auth_headers(db, u))
    assert r.status_code == 400


def test_intent_requires_auth(client):
    assert client.post("/api/billing/intent", json={"pack_id": "starter"}).status_code == 401
