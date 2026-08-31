"""Customer-facing billing: catalogue, purchase intents, subscription, webhook."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
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


class IntentIn(BaseModel):
    pack_id: str


@router.post("/intent")
def create_intent(payload: IntentIn, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    require_stripe()
    pack = pricing.get(payload.pack_id)
    if not pack or pack.kind != "one_shot":
        raise HTTPException(status_code=400, detail="Pack inconnu")
    price_id = settings.stripe_price_ids.get(pack.id)
    if not price_id:
        raise HTTPException(status_code=503, detail="Pack non configuré")
    try:
        customer_id = stripe_gateway.ensure_customer(user)
        db.commit()
        secret, amount, currency = stripe_gateway.create_payment_intent(
            customer_id=customer_id,
            price_id=price_id,
            metadata={"user_id": user.id, "pack_id": pack.id, "kind": "credit_pack"},
        )
    except stripe_gateway.GatewayError as e:
        raise HTTPException(status_code=502, detail="Paiement indisponible") from e
    return {"client_secret": secret, "amount": amount, "currency": currency}


_ACTIVE_SUB = ("active", "past_due", "incomplete")


class SubscribeIn(BaseModel):
    plan_id: str


@router.post("/subscribe")
def subscribe(payload: SubscribeIn, user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    require_stripe()
    pack = pricing.get(payload.plan_id)
    if not pack or pack.kind != "subscription":
        raise HTTPException(status_code=400, detail="Plan inconnu")
    price_id = settings.stripe_price_ids.get(pack.id)
    if not price_id:
        raise HTTPException(status_code=503, detail="Plan non configuré")
    existing = (db.query(Subscription)
                .filter(Subscription.user_id == user.id,
                        Subscription.status.in_(_ACTIVE_SUB)).first())
    if existing:
        raise HTTPException(status_code=409, detail="Abonnement déjà actif")
    try:
        customer_id = stripe_gateway.ensure_customer(user)
        db.commit()
        secret, sub_id = stripe_gateway.create_subscription(
            customer_id=customer_id, price_id=price_id,
            metadata={"user_id": user.id, "plan_id": pack.id},
        )
    except stripe_gateway.GatewayError as e:
        raise HTTPException(status_code=502, detail="Paiement indisponible") from e
    db.add(Subscription(user_id=user.id, stripe_subscription_id=sub_id,
                        plan_id=pack.id, status="incomplete"))
    db.commit()
    return {"client_secret": secret, "subscription_id": sub_id}


@router.post("/cancel")
def cancel(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    require_stripe()
    row = (db.query(Subscription)
           .filter(Subscription.user_id == user.id,
                   Subscription.status.in_(_ACTIVE_SUB))
           .order_by(Subscription.created_at.desc()).first())
    if not row:
        raise HTTPException(status_code=404, detail="Aucun abonnement")
    try:
        stripe_gateway.cancel_subscription(row.stripe_subscription_id)
    except stripe_gateway.GatewayError as e:
        raise HTTPException(status_code=502, detail="Paiement indisponible") from e
    row.cancel_at_period_end = True
    db.commit()
    return {"status": "canceling"}


webhook_router = APIRouter()


def _grant_once(db: Session, user: User, amount: int, reason: str,
                ref_type: str, ref_id: str) -> None:
    if amount == 0:
        return
    exists = (db.query(CreditTransaction)
              .filter(CreditTransaction.ref_id == ref_id,
                      CreditTransaction.reason == reason).first())
    if exists:
        return
    credits.grant(db, user, amount, reason, ref_type=ref_type, ref_id=ref_id)


def _user_or_raise(db: Session, user_id: str) -> User:
    user = db.get(User, user_id)
    if not user:
        raise ValueError(f"unknown user {user_id}")
    return user


def _on_payment_intent_succeeded(db: Session, obj: dict) -> None:
    meta = obj.get("metadata") or {}
    if meta.get("kind") != "credit_pack":
        return
    user = _user_or_raise(db, meta.get("user_id", ""))
    pack = pricing.get(meta.get("pack_id", ""))
    if not pack:
        raise ValueError(f"unknown pack {meta.get('pack_id')}")
    _grant_once(db, user, pack.credits, "purchase",
                ref_type="stripe_pi", ref_id=obj["id"])


def _on_invoice_paid(db: Session, obj: dict) -> None:
    sub_id = obj.get("subscription")
    if not sub_id:
        if obj.get("billing_reason", "").startswith("subscription"):
            raise ValueError(
                "invoice.paid for a subscription but no subscription id in payload")
        return
    price_id = obj["lines"]["data"][0]["price"]["id"]
    pack = pricing.pack_by_price_id(price_id)
    if not pack:
        raise ValueError(f"unknown price {price_id}")
    period_end = obj.get("period_end")
    period_end_dt = (datetime.fromtimestamp(period_end, tz=timezone.utc)
                     if period_end else None)
    row = (db.query(Subscription)
           .filter_by(stripe_subscription_id=sub_id).first())
    if row:
        user = _user_or_raise(db, row.user_id)
        row.status = "active"
        if period_end_dt:
            row.current_period_end = period_end_dt
    else:
        # No local row (dashboard-created, lost insert, DB restore) — upsert it.
        customer_id = obj.get("customer")
        user = (db.query(User).filter_by(stripe_customer_id=customer_id).first()
                if customer_id else None)
        if not user:
            raise ValueError(f"no local subscription {sub_id} and no user for customer {customer_id}")
        db.add(Subscription(user_id=user.id, stripe_subscription_id=sub_id,
                            plan_id=pack.id, status="active",
                            current_period_end=period_end_dt))
    _grant_once(db, user, pack.credits, "subscription_grant",
                ref_type="stripe_inv", ref_id=obj["id"])


def _on_subscription_updated(db: Session, obj: dict) -> None:
    row = db.query(Subscription).filter_by(stripe_subscription_id=obj["id"]).first()
    if not row:
        return
    row.status = obj.get("status", row.status)
    row.cancel_at_period_end = bool(obj.get("cancel_at_period_end"))
    period_end = obj.get("current_period_end")
    if period_end:
        row.current_period_end = datetime.fromtimestamp(period_end, tz=timezone.utc)


def _on_subscription_deleted(db: Session, obj: dict) -> None:
    row = db.query(Subscription).filter_by(stripe_subscription_id=obj["id"]).first()
    if row:
        row.status = "canceled"


def _on_charge_refunded(db: Session, obj: dict) -> None:
    pi = obj.get("payment_intent")
    if not pi:
        return
    grant = (db.query(CreditTransaction)
             .filter_by(ref_id=pi, reason="purchase").first())
    if not grant:
        return
    user = _user_or_raise(db, grant.user_id)
    # Stripe sends the charge object: amount_refunded is CUMULATIVE (total
    # refunded on this charge so far), not this refund's delta.
    total = obj.get("amount") or 0
    refunded = obj.get("amount_refunded") or 0
    target = round(grant.delta * refunded / total) if total else grant.delta
    # credits already revoked for this charge (refund deltas are negative)
    already = -(db.query(func.coalesce(func.sum(CreditTransaction.delta), 0))
                .filter(CreditTransaction.reason == "refund",
                        CreditTransaction.ref_id.like(f"{pi}:%")).scalar() or 0)
    # pick the new refund: first id with no existing ledger row for it
    refund_ids = [r["id"] for r in (obj.get("refunds") or {}).get("data", [])]
    new_refund_id = next(
        (rid for rid in refund_ids
         if not db.query(CreditTransaction)
                  .filter_by(ref_id=f"{pi}:{rid}", reason="refund").first()),
        None,
    )
    if new_refund_id is None:
        new_refund_id = refund_ids[0] if refund_ids else obj["id"]
    ref_id = f"{pi}:{new_refund_id}"
    take = min(target - already, user.credit_balance)
    if take <= 0:
        return
    _grant_once(db, user, -take, "refund", ref_type="stripe_refund", ref_id=ref_id)
    if take < target - already:
        # record the clamp for audit
        last = (db.query(CreditTransaction)
                .filter_by(ref_id=ref_id, reason="refund").first())
        if last:
            last.note = f"clamped: owed {target - already}, took {take}"


_HANDLERS = {
    "payment_intent.succeeded": _on_payment_intent_succeeded,
    "invoice.paid": _on_invoice_paid,
    "customer.subscription.updated": _on_subscription_updated,
    "customer.subscription.deleted": _on_subscription_deleted,
    "charge.refunded": _on_charge_refunded,
}


def _handle_event(db: Session, event: dict) -> None:
    handler = _HANDLERS.get(event["type"])
    if handler:
        handler(db, event["data"]["object"])


@webhook_router.post("/api/stripe/webhook")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    payload = await request.body()
    sig = request.headers.get("Stripe-Signature", "")
    try:
        event = stripe_gateway.construct_event(payload, sig)
    except stripe_gateway.GatewayError:
        raise HTTPException(status_code=400, detail="Signature invalide")

    row = db.get(StripeEvent, event["id"])
    if row and row.processed_at is not None:
        return {"received": True, "duplicate": True}
    if row is None:
        row = StripeEvent(id=event["id"], type=event["type"], payload_json=event)
        db.add(row)
        try:
            db.commit()
        except IntegrityError:
            # Concurrent first delivery raced us to the insert.
            db.rollback()
            row = db.get(StripeEvent, event["id"])
            if row is not None and row.processed_at is not None:
                return {"received": True, "duplicate": True}

    try:
        _handle_event(db, event)
        row.processed_at = datetime.now(timezone.utc)
        row.error = ""
        db.commit()
    except Exception as e:  # noqa: BLE001 - store + surface for Stripe retry
        db.rollback()
        row = db.get(StripeEvent, event["id"])
        row.error = str(e)[:500]
        row.processed_at = None
        db.commit()
        raise HTTPException(status_code=500, detail="Traitement échoué") from e
    return {"received": True}
