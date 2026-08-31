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
        "id": "ch_1", "payment_intent": "pi_r", "amount": 2900, "amount_refunded": 2900,
        "metadata": {}, "refunds": {"data": [{"id": "re_1"}]},
    })
    client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    db.expire_all()
    assert db.get(type(u), u.id).credit_balance == 0  # clamped, not -250


def test_charge_partial_refund_prorates(client, db, _accept_sig, monkeypatch):
    from tests.conftest import make_user
    from app import credits
    u = make_user(db, credits=0)
    credits.grant(db, u, 6000, "purchase", ref_type="stripe_pi", ref_id="pi_pr")
    db.commit()
    _accept_sig["event"] = _event("evt_pr1", "charge.refunded", {
        "id": "ch_pr", "payment_intent": "pi_pr", "amount": 39900, "amount_refunded": 2000,
        "metadata": {}, "refunds": {"data": [{"id": "re_a"}]},
    })
    client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    db.expire_all()
    assert db.get(type(u), u.id).credit_balance == 6000 - 301  # round(6000*2000/39900)

    # a second, distinct partial refund on the same charge is not deduped away
    _accept_sig["event"] = _event("evt_pr2", "charge.refunded", {
        "id": "ch_pr", "payment_intent": "pi_pr", "amount": 39900, "amount_refunded": 2000,
        "metadata": {}, "refunds": {"data": [{"id": "re_a"}, {"id": "re_b"}]},
    })
    client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    db.expire_all()
    assert db.get(type(u), u.id).credit_balance == 6000 - 301 - 301
    assert db.query(CreditTransaction).filter_by(reason="refund").count() == 2


def test_invoice_paid_subscription_without_sub_id_fails_loudly(client, db, _accept_sig):
    _accept_sig["event"] = _event("evt_inv_nosub", "invoice.paid", {
        "id": "in_nosub", "billing_reason": "subscription_cycle",
        "lines": {"data": []},
    })
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    assert r.status_code == 500
    assert db.get(StripeEvent, "evt_inv_nosub").processed_at is None


def test_invoice_paid_non_subscription_invoice_returns_quietly(client, db, _accept_sig):
    _accept_sig["event"] = _event("evt_inv_manual", "invoice.paid", {
        "id": "in_manual", "billing_reason": "manual",
        "lines": {"data": []},
    })
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    assert r.status_code == 200
    assert db.get(StripeEvent, "evt_inv_manual").processed_at is not None


def test_invoice_paid_upserts_missing_local_subscription(client, db, _accept_sig, monkeypatch):
    from tests.conftest import make_user
    u = make_user(db, credits=0)
    u.stripe_customer_id = "cus_upsert"
    db.commit()
    monkeypatch.setitem(billing.settings.stripe_price_ids, "atelier", "price_a")
    _accept_sig["event"] = _event("evt_inv_up", "invoice.paid", {
        "id": "in_up", "subscription": "sub_new", "customer": "cus_upsert",
        "billing_reason": "subscription_create",
        "lines": {"data": [{"price": {"id": "price_a"}}]},
        "period_end": 1893456000,
    })
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    assert r.status_code == 200
    db.expire_all()
    row = db.query(Subscription).filter_by(stripe_subscription_id="sub_new").one()
    assert row.status == "active"
    assert row.user_id == u.id
    assert db.get(type(u), u.id).credit_balance == 500


def test_secondary_dedupe_by_payment_intent(client, db, _accept_sig, monkeypatch):
    from tests.conftest import make_user
    u = make_user(db, credits=0)
    monkeypatch.setitem(billing.settings.stripe_price_ids, "starter", "price_s")
    meta = {"user_id": u.id, "pack_id": "starter", "kind": "credit_pack"}
    for evt_id in ("evt_a", "evt_b"):  # distinct events, same payment_intent
        _accept_sig["event"] = _event(evt_id, "payment_intent.succeeded",
                                      {"id": "pi_shared", "metadata": meta})
        assert client.post("/api/stripe/webhook", content=b"{}",
                           headers={"Stripe-Signature": "x"}).status_code == 200
    db.expire_all()
    assert db.get(type(u), u.id).credit_balance == 300
    assert db.query(CreditTransaction).filter_by(ref_id="pi_shared", reason="purchase").count() == 1


def test_subscription_updated_syncs_local_row(client, db, _accept_sig):
    from tests.conftest import make_user
    u = make_user(db)
    db.add(Subscription(user_id=u.id, stripe_subscription_id="sub_up",
                        plan_id="atelier", status="active"))
    db.commit()
    _accept_sig["event"] = _event("evt_su", "customer.subscription.updated", {
        "id": "sub_up", "status": "past_due", "cancel_at_period_end": True,
        "current_period_end": 1893456000,
    })
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    assert r.status_code == 200
    db.expire_all()
    row = db.query(Subscription).filter_by(stripe_subscription_id="sub_up").one()
    assert row.status == "past_due"
    assert row.cancel_at_period_end is True
    assert row.current_period_end is not None


def test_subscription_deleted_marks_canceled(client, db, _accept_sig):
    from tests.conftest import make_user
    u = make_user(db)
    db.add(Subscription(user_id=u.id, stripe_subscription_id="sub_del",
                        plan_id="atelier", status="active"))
    db.commit()
    _accept_sig["event"] = _event("evt_sd", "customer.subscription.deleted",
                                  {"id": "sub_del", "status": "canceled"})
    r = client.post("/api/stripe/webhook", content=b"{}", headers={"Stripe-Signature": "x"})
    assert r.status_code == 200
    db.expire_all()
    assert db.query(Subscription).filter_by(stripe_subscription_id="sub_del").one().status == "canceled"


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
