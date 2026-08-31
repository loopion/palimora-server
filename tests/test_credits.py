from app import credits
from app.models import CreditTransaction


def test_grant_zero_is_noop(db):
    from tests.conftest import make_user
    u = make_user(db, credits=5)
    tx = credits.grant(db, u, 0, "purchase")
    db.commit()
    assert tx is None
    assert u.credit_balance == 5
    assert db.query(CreditTransaction).count() == 0


def test_charge_zero_is_noop(db):
    from tests.conftest import make_user
    u = make_user(db, credits=5)
    tx = credits.charge(db, u, 0, "ai_correction")
    db.commit()
    assert tx is None
    assert u.credit_balance == 5


def test_grant_positive_writes_row(db):
    from tests.conftest import make_user
    u = make_user(db, credits=0)
    tx = credits.grant(db, u, 300, "purchase", ref_type="stripe_pi", ref_id="pi_1")
    db.commit()
    assert tx.delta == 300
    assert u.credit_balance == 300
    assert tx.balance_after == 300
