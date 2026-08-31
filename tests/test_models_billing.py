from datetime import datetime, timezone
from app.models import Subscription, StripeEvent, User


def test_subscription_roundtrip(db):
    from tests.conftest import make_user
    u = make_user(db)
    s = Subscription(user_id=u.id, stripe_subscription_id="sub_1", plan_id="atelier",
                     status="active", cancel_at_period_end=False)
    db.add(s)
    db.commit()
    assert db.query(Subscription).filter_by(user_id=u.id).one().status == "active"


def test_stripe_event_default_unprocessed(db):
    e = StripeEvent(id="evt_1", type="payment_intent.succeeded", payload_json={})
    db.add(e)
    db.commit()
    got = db.get(StripeEvent, "evt_1")
    assert got.processed_at is None
    assert got.error == ""


def test_user_customer_id_nullable(db):
    from tests.conftest import make_user
    u = make_user(db)
    assert u.stripe_customer_id is None
    u.stripe_customer_id = "cus_1"
    db.commit()
