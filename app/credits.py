"""Credit ledger. users.credit_balance is denormalized and updated in the same
transaction as the ledger insert, guarded by a row lock (SELECT ... FOR UPDATE)."""
from sqlalchemy.orm import Session

from .config import settings
from .models import CreditTransaction, User


class InsufficientCredits(Exception):
    def __init__(self, needed: int, balance: int):
        self.needed = needed
        self.balance = balance
        super().__init__(f"Crédits insuffisants : {needed} requis, {balance} disponibles")


def record(db: Session, user: User, delta: int, reason: str,
           ref_type: str = "", ref_id: str = "", note: str = "") -> CreditTransaction:
    """Append a ledger entry and update the denormalized balance. Caller commits.
    The user row must already be locked (with_for_update) or the call is single-threaded."""
    user.credit_balance = user.credit_balance + delta
    tx = CreditTransaction(
        user_id=user.id,
        delta=delta,
        balance_after=user.credit_balance,
        reason=reason,
        ref_type=ref_type,
        ref_id=ref_id,
        note=note[:255],
    )
    db.add(tx)
    return tx


def charge(db: Session, user: User, amount: int, reason: str,
           ref_type: str = "", ref_id: str = "", note: str = "") -> CreditTransaction:
    """Charge points atomically; raises InsufficientCredits."""
    locked = db.query(User).filter_by(id=user.id).with_for_update().one()
    if locked.credit_balance < amount:
        db.rollback()
        raise InsufficientCredits(amount, locked.credit_balance)
    return record(db, locked, -amount, reason, ref_type, ref_id, note)


def grant(db: Session, user: User, amount: int, reason: str,
          ref_type: str = "", ref_id: str = "", note: str = "") -> CreditTransaction:
    locked = db.query(User).filter_by(id=user.id).with_for_update().one()
    return record(db, locked, amount, reason, ref_type, ref_id, note)


def page_cost() -> int:
    return settings.page_cost


def ai_cost() -> int:
    return settings.ai_correction_cost
