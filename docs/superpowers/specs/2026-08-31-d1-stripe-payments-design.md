# D1 — Stripe Payments + Credit Rebrand — Design

Date: 2026-08-31
Status: approved (design), pending spec review
Phase: D (monetisation). Sub-project 1 of 4 (D1 payments, D2 one-pager, D3 email, E admin).

## 1. Goal

Let a signed-in user buy OCR credits with a card, directly in the web SPA, and
optionally subscribe to a monthly credit plan. Credits land in the existing
immutable ledger automatically via Stripe webhooks. Sandbox / test-mode only for
now (test keys, fake billing entity).

Non-goals for D1 (tracked for later):
- GBP / USD pricing (EUR only now).
- VAT collection / OSS / branded invoices — the entity is a French
  micro-entreprise assumed under *franchise en base de TVA* (art. 293 B CGI):
  no VAT is charged; receipts carry the "TVA non applicable" mention. Stripe Tax
  is enabled but returns 0 because the account is registered nowhere.
- iOS in-app purchase. The iOS "Cloud" mode keeps spending server credits;
  buying is web-only in D1. StoreKit-vs-server arbitrage stays a Phase E/F topic.
- Dunning / failed-payment retry UX beyond what Stripe does on its own.
- Branded PDF invoices with the franchise mention (→ D3, needs Resend).

## 2. Credit model rebrand (Option A)

Today: integer "points", `PAGE_COST_POINTS=10`, `AI_CORRECTION_COST_POINTS=1`,
`SIGNUP_BONUS_POINTS=100` (so 100 free points = 10 pages).

After D1: **1 credit = 1 page. AI correction is free.**

- Config becomes `PAGE_COST_POINTS=1`, `AI_CORRECTION_COST_POINTS=0`,
  `SIGNUP_BONUS_POINTS=100` (100 free credits = 100 free pages).
  Keep the existing env names to avoid touching `config.py` semantics; only the
  values change. `credits.ai_cost()` may now return 0 — callers must treat a
  0-cost charge as a no-op (no ledger row) rather than writing a `delta=0` entry.
- **Migration `rebase_credits_v2`** (added to `_migrate()` in `app/main.py`,
  guarded so it runs exactly once — use a `schema_migrations(name PK)` marker
  row, because the existing "try/except pass" pattern is not idempotent for data
  rewrites):
  - `UPDATE users SET credit_balance = FLOOR(credit_balance / 10)`
  - `UPDATE credit_transactions SET delta = ..., balance_after = ...` — rewrite
    each row: `delta = trunc(delta/10)` toward zero, then recompute
    `balance_after` as a running sum per user ordered by `created_at, id`.
    Historical `reason` strings are kept.
  - Goodwill top-up toggle (`REBASE_TOPUP_TO=0` by default): if > 0, any active
    user left below that many credits is granted the difference with reason
    `rebase_topup`. Off for the first deploy; the operator can set it and
    redeploy.
- The rebase is **irreversible** and touches the "immutable" ledger. Acceptable
  here: test data, a handful of accounts, no real money has moved. The spec
  records this explicitly so the plan includes a DB dump before the deploy.

## 3. Catalogue

Static module `app/pricing.py` — the single source of truth, mapping an internal
pack id to a Stripe Price id (from env) and the credits granted. Prices are
created once in the Stripe **test** dashboard; their ids go in Coolify env.

| id           | kind         | credits | price (EUR) | €/page | Stripe env var              |
|--------------|--------------|---------|-------------|--------|-----------------------------|
| `starter`    | one-shot     | 300     | 29.00       | 0.097  | `STRIPE_PRICE_STARTER`      |
| `chercheur`  | one-shot     | 1500    | 119.00      | 0.079  | `STRIPE_PRICE_CHERCHEUR`    |
| `archiviste` | one-shot     | 6000    | 399.00      | 0.067  | `STRIPE_PRICE_ARCHIVISTE`   |
| `atelier`    | subscription | 500/mo  | 39.00/mo    | 0.078  | `STRIPE_PRICE_ATELIER`      |

- "Découverte": the 100-credit signup bonus. Not a Stripe object.
- `atelier` credits **accumulate** (no monthly reset): each paid invoice grants
  500 credits on top of the current balance. No rollover cap in D1.
- The module also exposes a `pack_by_price_id` reverse lookup for the webhook and
  a serialisable list for `GET /api/billing/catalogue`.
- Amounts live in `pricing.py` only for display sanity-checks; Stripe is
  authoritative for what is actually charged.

### Break-even (recorded for context, not enforced in code)

Fixed cost ≈ €58/month (Hetzner 44.38 + palimora.eu 0.60 + ASC 8.25 + ~5 buffer).
Marginal cost per page ≈ 0 (Kraken + AI self-hosted, free). Break-even ≈ **720
paid pages/month**. Past that, margin per page ≈ 97 %.

## 4. Data model additions (`app/models.py`)

- `User.stripe_customer_id: Mapped[str | None]` — nullable, unique, indexed.
- New `Subscription`:
  - `id` (uuid PK), `user_id` FK→users (indexed),
  - `stripe_subscription_id` (unique), `plan_id` (`atelier`),
  - `status` (`incomplete|active|past_due|canceled|unpaid`),
  - `current_period_end: datetime | None`,
  - `cancel_at_period_end: bool`,
  - `created_at`, `updated_at`.
  - One active subscription per user assumed; a second `subscribe` call while an
    `active`/`past_due` row exists returns 409.
- New `StripeEvent` (webhook idempotency + audit):
  - `id` (Stripe event id, PK, `String(64)`),
  - `type` (`String(64)`), `payload_json` (JSON),
  - `received_at`, `processed_at: datetime | None`,
  - `error: str` (last handler error, empty when ok).
- New `schema_migrations(name: String(64) PK, applied_at)` — marker table for
  one-shot data migrations.
- `CreditTransaction.reason` new values: `purchase`, `subscription_grant`,
  `refund`, `rebase_topup`. Column is `String(40)`, fits.

All added via `_migrate()` `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` +
`CREATE TABLE IF NOT EXISTS` statements, matching the current no-Alembic style.

## 5. Backend endpoints (`app/billing.py`, mounted in `main.py`)

All under `/api/billing`, auth required (current-user dependency) except the
webhook.

- `GET /api/billing/catalogue` → packs + subscription plan, from `pricing.py`.
  Includes the publishable key so the SPA can init Stripe.js.
- `GET /api/billing/status` → user's `credit_balance`, active subscription (plan,
  status, renews-on, cancel-at-period-end), recent purchases (last 10 ledger
  rows with reason in the purchase set).
- `POST /api/billing/intent {pack_id}` (one-shot):
  - reject if `pack_id` is a subscription or unknown.
  - get-or-create Stripe Customer (store `stripe_customer_id`).
  - create `PaymentIntent`: `amount`/`currency` from the Stripe Price (retrieve
    it, do not trust the client), `customer`, `automatic_tax={enabled: true}`,
    `metadata={user_id, pack_id, kind: "credit_pack"}`, idempotency key
    `intent:{user_id}:{pack_id}:{minute-bucket}` to swallow double taps.
  - return `{client_secret, amount, currency}`.
- `POST /api/billing/subscribe {plan_id}`:
  - 409 if an active/past_due subscription row exists.
  - get-or-create Customer.
  - create Subscription: `items=[{price}]`,
    `payment_behavior="default_incomplete"`,
    `payment_settings={save_default_payment_method: "on_subscription"}`,
    `automatic_tax={enabled: true}`,
    `expand=["latest_invoice.payment_intent"]`,
    `metadata={user_id, plan_id}`.
  - insert local `Subscription` row `status="incomplete"`.
  - return `{client_secret, subscription_id}` (the invoice's PI secret).
- `POST /api/billing/cancel`:
  - `stripe.Subscription.modify(id, cancel_at_period_end=True)`.
  - reflect on the local row; credits already granted are kept.
- `POST /api/stripe/webhook` — see §6. Path is `/api/stripe/webhook` (matches the
  endpoint the user already created in the Stripe dashboard).

Stripe SDK: add `stripe` to `requirements.txt`. One module-level
`stripe.api_key = settings.stripe_secret_key`. All Stripe calls wrapped so a
`stripe.error.StripeError` becomes a 502 with a safe message (never leak raw).

### Address / tax

The SPA passes billing address (country + postal code minimum) collected by the
Stripe Address Element; the backend attaches it to the Customer before creating
the intent so `automatic_tax` can compute (it will resolve to 0). If the address
is missing, `automatic_tax` is still sent; Stripe may 400 — in that case retry
once without `automatic_tax` and log a warning (franchise → 0 tax anyway).

## 6. Webhook handler

1. Read raw body + `Stripe-Signature`; `stripe.Webhook.construct_event(body, sig,
   settings.stripe_webhook_secret)`. Bad signature → 400.
2. `INSERT INTO stripe_events (id, type, payload_json, received_at)` — if the id
   already exists (`IntegrityError`), return 200 immediately (idempotent replay).
3. Dispatch by `event.type` inside one DB transaction; on handler exception,
   store the message in `stripe_events.error`, leave `processed_at` NULL, return
   500 so Stripe retries. On success set `processed_at` and return 200.

Handled types:

- `payment_intent.succeeded`
  - only when `metadata.kind == "credit_pack"`.
  - look up user + pack; `credits.grant(user, pack.credits, reason="purchase",
    ref_type="stripe_pi", ref_id=pi.id, note=pack.id)`.
  - a second delivery is caught by the `stripe_events` id guard **and** by a
    secondary check: skip if a ledger row with `ref_id == pi.id` exists.
- `invoice.paid`
  - only when the invoice has a subscription.
  - resolve plan from the subscription's price id via `pricing.pack_by_price_id`.
  - grant `plan.credits`, `reason="subscription_grant"`, `ref_type="stripe_inv"`,
    `ref_id=invoice.id` (+ the same ledger-level dedupe on `ref_id`).
  - covers both the first invoice and renewals; `billing_reason` is logged but
    not branched on.
  - upsert the local `Subscription` row: `status="active"`,
    `current_period_end` from the subscription.
- `customer.subscription.updated`
  - sync `status`, `current_period_end`, `cancel_at_period_end` onto the local
    row.
- `customer.subscription.deleted`
  - local row `status="canceled"`. Credits already granted stay.
- `charge.refunded`
  - find the ledger grant by the charge's `payment_intent` (`ref_id`).
  - `credits.grant(user, -min(refunded_credits, current_balance), reason="refund",
    ref_type="stripe_refund", ref_id=charge.id)` — never drives the balance
    below 0; if clamped, record the shortfall in the ledger `note`.

Unhandled event types: insert the row, mark processed, return 200.

## 7. Config additions (`app/config.py`, all env-driven)

```
STRIPE_SECRET_KEY            sk_test_...          (Coolify secret)
STRIPE_PUBLISHABLE_KEY       pk_test_...          (served to SPA)
STRIPE_WEBHOOK_SECRET        whsec_...            (Coolify secret)
STRIPE_TAX_ENABLED           true
STRIPE_PRICE_STARTER         price_...
STRIPE_PRICE_CHERCHEUR       price_...
STRIPE_PRICE_ARCHIVISTE      price_...
STRIPE_PRICE_ATELIER         price_...
BILLING_ENTITY_NAME          Palimora
BILLING_ENTITY_ADDRESS       250 Chemin des Groux, 78670 Villennes-sur-Seine
BILLING_ENTITY_COUNTRY       FR
BILLING_VAT_NOTE             TVA non applicable, art. 293 B du CGI
PAGE_COST_POINTS             1        (changed from 10)
AI_CORRECTION_COST_POINTS    0        (changed from 1)
REBASE_TOPUP_TO              0
```

`settings.stripe_enabled` = bool(secret and webhook secret). When false, the
billing endpoints return 503 and the SPA hides the buy UI — keeps local dev and
CI working without Stripe.

## 8. Frontend (`web/`)

- Deps: `@stripe/stripe-js`, `@stripe/react-stripe-js`.
- `web/src/pages/Billing.tsx`, route `/billing`, nav entry "Crédits" next to the
  balance chip in the Station header.
  - Fetches `/api/billing/catalogue` + `/api/billing/status`.
  - Pack cards (3 one-shot + the subscription), each with €/page and a
    "meilleur rapport" badge on `chercheur`.
  - On select: call `intent` or `subscribe`, mount `<Elements>` with the returned
    `client_secret`, render `<PaymentElement>` + `<AddressElement mode="billing">`,
    `stripe.confirmPayment({ elements, confirmParams: { return_url:
    <billing>?done=1 } })`.
  - After redirect back (or inline success), poll `/api/billing/status` for ~15 s
    until the balance reflects the purchase (webhook lag), then show success.
  - Subscription section shows current plan + "Annuler" (calls `/cancel`, confirm
    dialog via a modal, not `window.confirm`).
- `web/src/api.ts`: add `BillingCatalogue`, `BillingStatus` types and the four
  calls.
- Replace the two remaining `window.prompt` uses (`newDocument`, `editTags` in
  `Station.tsx`) with a small reusable `<PromptModal>` — pulled into D1 because
  the billing flow needs a modal primitive anyway and blocking dialogs are a
  known defect.

## 9. Admin (small, `app/main.py` admin routes + `web` admin page)

- `GET /api/admin/billing/events?status=failed` — list `stripe_events` with
  `processed_at IS NULL AND error != ''`.
- `GET /api/admin/users/{id}/billing` — balance, subscription, purchase history.
- Web admin: a "Paiements" tab listing failed events (id, type, error, received)
  with a "Rejouer" button → `POST /api/admin/billing/events/{id}/replay` that
  re-runs the handler. Full impersonation is Phase E; this is just triage.

## 10. Testing

No test infra exists yet. Add:

- `requirements-dev.txt` (or a `[dev]` extra): `pytest`, `pytest-asyncio`,
  `httpx`, `respx` (mock Stripe HTTP) or the `stripe` lib's test helpers.
- `tests/conftest.py`: SQLite in-memory app fixture, a factory for users, a
  `stripe` mock.
- `tests/test_pricing.py` — catalogue integrity, reverse lookup.
- `tests/test_credits_rebase.py` — ÷10 migration: balances, running
  `balance_after`, marker table prevents re-run, top-up toggle.
- `tests/test_billing_endpoints.py` — intent rejects subscription id / unknown
  pack / unauthenticated; subscribe 409 on double; amount comes from Stripe not
  client.
- `tests/test_webhook.py` — bad signature 400; unknown event 200; duplicate event
  id 200 no double grant; `payment_intent.succeeded` grants exact credits and is
  idempotent on `ref_id`; `invoice.paid` grants plan credits + upserts
  subscription; `charge.refunded` clamps at 0; handler error → row.error set,
  processed_at NULL, 500.
- `web`: a Vitest test for the Billing catalogue render + a mocked confirm flow
  (light; the Element itself is Stripe's).
- Record `pytest` and `npm --prefix web test` as the project test commands in
  `.omc/project-memory.json` / README.

Manual: Stripe test cards (`4242…`, 3DS `4000 0027 6000 3184`), `stripe listen
--forward-to localhost:8000/api/stripe/webhook`, and the dashboard's "Send test
webhook".

## 11. Rollout

1. DB dump of the Postgres service (Coolify) before anything.
2. Create the 4 prices in Stripe test dashboard, fill Coolify env.
3. Deploy API+worker with new env (`PAGE_COST_POINTS=1`, etc.). `_migrate()` runs
   `rebase_credits_v2` once.
4. Verify: a known account's balance is exactly 1/10 of before; a fresh signup
   gets 100; OCR a page costs 1; AI correction costs 0.
5. Deploy SPA. Smoke-test each pack + the subscription with test cards; confirm
   the ledger via `/api/billing/status` and the admin view.
6. Confirm the dashboard webhook shows 2xx for every delivery.

## 12. Open questions / risks

- **VAT status unconfirmed.** Built for *franchise en base* (no collection). If
  the user later registers for VAT, Stripe Tax flips on with no code change but
  invoices/receipts need the D3 branded-invoice work and an OSS registration.
- The VAT number the user provided is not a valid FR format; treated as fake,
  stored only as an env string, not sent to Stripe as a registration.
- Ledger rewrite in the rebase migration — mitigated by the pre-deploy dump and
  the one-shot marker, accepted because the data is pre-revenue.
- `atelier` credits accumulating with no cap could let a user bank a large
  balance then cancel. Acceptable at this price/scale; revisit if abused.
- 100 free credits per account (= 100 free pages) is generous and abusable while
  email verification is auto (no SMTP). D3 (Resend) closes this; until then the
  admin can deactivate obvious multi-accounts.
