"""Thin, mockable wrapper around the Stripe SDK. Every public function raises
GatewayError (never a raw stripe.error.*) so callers map it to one HTTP status."""
import stripe

from .config import settings

stripe.api_key = settings.stripe_secret_key
stripe.api_version = "2024-12-18.acacia"


class GatewayError(Exception):
    pass


def _tax() -> dict:
    return {"enabled": settings.stripe_tax_enabled}


def ensure_customer(user) -> str:
    if user.stripe_customer_id:
        return user.stripe_customer_id
    try:
        cus = stripe.Customer.create(
            email=user.email,
            name=user.display_name or user.email,
            metadata={"user_id": user.id},
        )
    except stripe.error.StripeError as e:  # pragma: no cover - exercised via mock
        raise GatewayError(str(e)) from e
    user.stripe_customer_id = cus.id
    return cus.id


def retrieve_price_amount(price_id: str) -> tuple[int, str]:
    try:
        price = stripe.Price.retrieve(price_id)
    except stripe.error.StripeError as e:
        raise GatewayError(str(e)) from e
    return int(price.unit_amount), str(price.currency)


def create_payment_intent(*, customer_id: str, price_id: str, metadata: dict) -> tuple[str, int, str]:
    amount, currency = retrieve_price_amount(price_id)
    try:
        pi = stripe.PaymentIntent.create(
            amount=amount,
            currency=currency,
            customer=customer_id,
            automatic_tax=_tax(),
            metadata=metadata,
        )
    except stripe.error.StripeError as e:
        raise GatewayError(str(e)) from e
    return pi.client_secret, amount, currency


def create_subscription(*, customer_id: str, price_id: str, metadata: dict) -> tuple[str, str]:
    try:
        sub = stripe.Subscription.create(
            customer=customer_id,
            items=[{"price": price_id}],
            payment_behavior="default_incomplete",
            payment_settings={"save_default_payment_method": "on_subscription"},
            automatic_tax=_tax(),
            expand=["latest_invoice.payment_intent"],
            metadata=metadata,
        )
    except stripe.error.StripeError as e:
        raise GatewayError(str(e)) from e
    pi = sub.latest_invoice.payment_intent
    return pi.client_secret, sub.id


def cancel_subscription(stripe_subscription_id: str) -> None:
    try:
        stripe.Subscription.modify(stripe_subscription_id, cancel_at_period_end=True)
    except stripe.error.StripeError as e:
        raise GatewayError(str(e)) from e


def construct_event(payload: bytes, sig_header: str) -> dict:
    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, settings.stripe_webhook_secret)
    except (ValueError, stripe.error.SignatureVerificationError) as e:
        raise GatewayError("bad signature") from e
    return event
