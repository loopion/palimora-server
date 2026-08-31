from app import migrations
from app.models import User, CreditTransaction


def _seed(db):
    from tests.conftest import make_user
    u = make_user(db, email="a@test.fr", credits=0)
    # simulate old points-era ledger: +100 signup, -10 page, -10 page  => balance 80
    for delta, after, reason in [(100, 100, "signup_bonus"), (-10, 90, "page_ocr"), (-10, 80, "page_ocr")]:
        db.add(CreditTransaction(user_id=u.id, delta=delta, balance_after=after, reason=reason))
    u.credit_balance = 80
    db.commit()
    return u


def test_rebase_divides_by_ten(db, _engine, monkeypatch):
    monkeypatch.setattr("app.config.settings.rebase_topup_to", 0)
    u = _seed(db)
    with _engine.begin() as conn:
        ran = migrations.run_once(conn, "rebase_credits_v2", migrations.rebase_credits_v2)
    assert ran is True
    db.expire_all()
    assert db.get(User, u.id).credit_balance == 8
    rows = db.query(CreditTransaction).filter_by(user_id=u.id).order_by(CreditTransaction.created_at, CreditTransaction.id).all()
    assert [r.delta for r in rows] == [10, -1, -1]
    assert [r.balance_after for r in rows] == [10, 9, 8]


def test_rebase_runs_once(db, _engine):
    _seed(db)
    with _engine.begin() as conn:
        assert migrations.run_once(conn, "rebase_credits_v2", migrations.rebase_credits_v2) is True
    with _engine.begin() as conn:
        assert migrations.run_once(conn, "rebase_credits_v2", migrations.rebase_credits_v2) is False
    db.expire_all()
    # balances not halved again
    assert db.query(User).first().credit_balance == 8


def test_rebase_topup(db, _engine, monkeypatch):
    monkeypatch.setattr("app.config.settings.rebase_topup_to", 100)
    u = _seed(db)  # post-rebase balance would be 8
    with _engine.begin() as conn:
        migrations.run_once(conn, "rebase_credits_v2", migrations.rebase_credits_v2)
    db.expire_all()
    assert db.get(User, u.id).credit_balance == 100
    topup = db.query(CreditTransaction).filter_by(reason="rebase_topup").one()
    assert topup.delta == 92
