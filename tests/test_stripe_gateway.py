import pytest
from app import stripe_gateway as gw


class _FakeStripeError(Exception):
    pass


def test_ensure_customer_creates_and_sets(db, monkeypatch):
    from tests.conftest import make_user
    u = make_user(db)
    created = {}
    monkeypatch.setattr(gw.stripe.Customer, "create",
                        lambda **kw: created.update(kw) or type("C", (), {"id": "cus_x"}))
    cid = gw.ensure_customer(u)
    db.commit()
    assert cid == "cus_x"
    assert u.stripe_customer_id == "cus_x"
    assert created["email"] == u.email


def test_ensure_customer_idempotent(db, monkeypatch):
    from tests.conftest import make_user
    u = make_user(db)
    u.stripe_customer_id = "cus_existing"
    monkeypatch.setattr(gw.stripe.Customer, "create",
                        lambda **kw: pytest.fail("should not create"))
    assert gw.ensure_customer(u) == "cus_existing"


def test_create_payment_intent_uses_price_amount(monkeypatch):
    monkeypatch.setattr(gw.stripe.Price, "retrieve",
                        lambda pid: type("P", (), {"unit_amount": 2900, "currency": "eur"}))
    monkeypatch.setattr(gw.stripe.PaymentIntent, "create",
                        lambda **kw: type("PI", (), {"client_secret": "pi_secret_x"}))
    secret, amount, currency = gw.create_payment_intent(
        customer_id="cus_x", price_id="price_s", metadata={"user_id": "u1"})
    assert (secret, amount, currency) == ("pi_secret_x", 2900, "eur")


def test_gateway_wraps_stripe_error(monkeypatch):
    import stripe
    monkeypatch.setattr(gw.stripe.Price, "retrieve",
                        lambda pid: (_ for _ in ()).throw(stripe.error.APIConnectionError("boom")))
    with pytest.raises(gw.GatewayError):
        gw.retrieve_price_amount("price_s")
