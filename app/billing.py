"""Customer-facing billing: catalogue, purchase intents, subscription, webhook."""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from . import credits, pricing, stripe_gateway
from .auth import get_current_user
from .config import settings
from .db import get_db
from .models import CreditTransaction, StripeEvent, Subscription, User

router = APIRouter(prefix="/api/billing", tags=["billing"])

PURCHASE_REASONS = ("purchase", "subscription_grant", "refund", "rebase_topup")


def require_stripe() -> None:
    if not settings.stripe_enabled:
        raise HTTPException(status_code=503, detail="Paiements indisponibles")


def _sub_dict(s: Subscription | None) -> dict | None:
    if not s:
        return None
    return {
        "plan_id": s.plan_id,
        "status": s.status,
        "current_period_end": s.current_period_end.isoformat() if s.current_period_end else None,
        "cancel_at_period_end": s.cancel_at_period_end,
    }


@router.get("/catalogue")
def catalogue():
    return {
        "packs": pricing.catalogue(),
        "publishable_key": settings.stripe_publishable_key,
        "enabled": settings.stripe_enabled,
    }


@router.get("/status")
def status(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sub = (db.query(Subscription)
           .filter(Subscription.user_id == user.id,
                   Subscription.status.in_(("active", "past_due", "incomplete")))
           .order_by(Subscription.created_at.desc()).first())
    purchases = (db.query(CreditTransaction)
                 .filter(CreditTransaction.user_id == user.id,
                         CreditTransaction.reason.in_(PURCHASE_REASONS))
                 .order_by(CreditTransaction.created_at.desc()).limit(10).all())
    return {
        "credit_balance": user.credit_balance,
        "subscription": _sub_dict(sub),
        "purchases": [
            {"reason": p.reason, "delta": p.delta,
             "created_at": p.created_at.isoformat() if p.created_at else None,
             "note": p.note}
            for p in purchases
        ],
    }
