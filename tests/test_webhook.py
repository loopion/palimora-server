import pytest
from app import billing, stripe_gateway
from app.models import CreditTransaction, StripeEvent, Subscription


def _event(evt_id, evt_type, obj):
    return {"id": evt_id, "type": evt_type, "data": {"object": obj}}


@pytest.fixture()
def _accept_sig(monkeypatch):
    holder = {}
    monkeypatch.setattr(stripe_gateway, "construct_event",
                        lambda payload, sig: holder["event"])
    return holder


def test_bad_signature(client, monkeypatch):
    monkeypatch.setattr(stripe_gateway, "construct_event",
                        lambda p, s: (_ for _ in ()).throw(stripe_gateway.GatewayError("bad")))
    r = client.post("/api/stripe/webhook", content=b"{}",
                    headers={"Stripe-Signature": "x"})
    assert r.status_code == 400


def test_payment_intent_succeeded_grants_credits(client, db, _accept_sig, monkeypatch):
    from tests.conftest import make_user
    u = make_user(db, credits=0)
    monkeypatch.setitem(billing.settings.stripe_price_ids, "starter", "price_s")
    _accept_sig["event"] = _event("evt_1", "payment_intent.succeeded", {
        "id": "pi_1", "metadata": {"user_id": u.id, "pack_id": "starter", "kind": "credit_pack"},
    })
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    assert r.status_code == 200
    db.expire_all()
    assert db.get(type(u), u.id).credit_balance == 300
    assert db.query(CreditTransaction).filter_by(ref_id="pi_1", reason="purchase").count() == 1


def test_duplicate_event_no_double_grant(client, db, _accept_sig, monkeypatch):
    from tests.conftest import make_user
    u = make_user(db, credits=0)
    _accept_sig["event"] = _event("evt_dup", "payment_intent.succeeded", {
        "id": "pi_9", "metadata": {"user_id": u.id, "pack_id": "starter", "kind": "credit_pack"},
    })
    for _ in range(2):
        assert client.post("/api/stripe/webhook", content=b"{}",
                           headers={"Stripe-Signature": "x"}).status_code == 200
    db.expire_all()
    assert db.get(type(u), u.id).credit_balance == 300


def test_invoice_paid_grants_and_upserts_subscription(client, db, _accept_sig, monkeypatch):
    from tests.conftest import make_user
    u = make_user(db, credits=0)
    db.add(Subscription(user_id=u.id, stripe_subscription_id="sub_1",
                        plan_id="atelier", status="incomplete"))
    db.commit()
    monkeypatch.setitem(billing.settings.stripe_price_ids, "atelier", "price_a")
    _accept_sig["event"] = _event("evt_inv", "invoice.paid", {
        "id": "in_1", "subscription": "sub_1", "billing_reason": "subscription_create",
        "lines": {"data": [{"price": {"id": "price_a"}}]},
        "period_end": 1893456000,
    })
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    assert r.status_code == 200
    db.expire_all()
    assert db.get(type(u), u.id).credit_balance == 500
    assert db.query(Subscription).filter_by(stripe_subscription_id="sub_1").one().status == "active"


def test_charge_refunded_clamps_at_zero(client, db, _accept_sig, monkeypatch):
    from tests.conftest import make_user
    from app import credits
    u = make_user(db, credits=0)
    credits.grant(db, u, 300, "purchase", ref_type="stripe_pi", ref_id="pi_r")
    db.commit()
    # user spends 250, leaving 50
    credits.charge(db, u, 250, "page_ocr")
    db.commit()
    _accept_sig["event"] = _event("evt_ref", "charge.refunded", {
        "id": "ch_1", "payment_intent": "pi_r", "amount_refunded": 2900,
        "metadata": {}, "refunds": {"data": []},
    })
    client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    db.expire_all()
    assert db.get(type(u), u.id).credit_balance == 0  # clamped, not -250


def test_unknown_event_ok(client, db, _accept_sig):
    _accept_sig["event"] = _event("evt_u", "customer.created", {"id": "cus_1"})
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    assert r.status_code == 200
    assert db.get(StripeEvent, "evt_u").processed_at is not None


def test_handler_error_returns_500_and_records(client, db, _accept_sig, monkeypatch):
    from tests.conftest import make_user
    make_user(db)
    _accept_sig["event"] = _event("evt_err", "payment_intent.succeeded", {
        "id": "pi_x", "metadata": {"user_id": "missing-user", "pack_id": "starter",
                                   "kind": "credit_pack"},
    })
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    assert r.status_code == 500
    row = db.get(StripeEvent, "evt_err")
    assert row.processed_at is None
    assert row.error != ""
