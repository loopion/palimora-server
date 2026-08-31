# D1 shipped — operator actions

D1 (Stripe payments + credit rebrand) is implemented on `feat/d1-stripe-payments`.
Backend suite: 46 passed. Frontend: 7 passed, `vite build` OK.

## Before deploying
1. `pg_dump` the Palimora-Postgres service (Coolify) — the rebase migration
   (`rebase_credits_v2`) rewrites the credit ledger irreversibly and runs exactly
   once (marker row in `schema_migrations`).
2. Rebase arithmetic caveat: after `rebase_credits_v2` runs, a user's
   `credit_balance` becomes the sum of the per-row `trunc(delta/10)` of their
   ledger entries. For accounts with many small (sub-10-point) entries this can
   differ from a naive `floor(old_balance/10)` by 1–2 credits. If you want to
   avoid support questions, set `REBASE_TOPUP_TO=100` for the first deploy so
   every active user is brought up to at least 100 credits; revert it to `0`
   afterward.

## Stripe test dashboard
3. Create 4 Prices (EUR): starter €29 one-shot, chercheur €119 one-shot,
   archiviste €399 one-shot, atelier €39/month recurring.
4. Confirm the webhook endpoint points at
   `https://api.palimora.pays.fr.eu.org/api/stripe/webhook` and sends
   `payment_intent.succeeded`, `invoice.paid`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `charge.refunded`.

## Coolify env (Palimora Server + Worker)

```
STRIPE_SECRET_KEY
STRIPE_PUBLISHABLE_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_TAX_ENABLED=true
STRIPE_PRICE_STARTER
STRIPE_PRICE_CHERCHEUR
STRIPE_PRICE_ARCHIVISTE
STRIPE_PRICE_ATELIER
BILLING_ENTITY_NAME=Palimora
BILLING_ENTITY_ADDRESS=250 Chemin des Groux, 78670 Villennes-sur-Seine
BILLING_ENTITY_COUNTRY=FR
PAGE_COST_POINTS=1
AI_CORRECTION_COST_POINTS=0
SIGNUP_BONUS_POINTS=100
REBASE_TOPUP_TO=0   # set to 100 for one deploy to top existing users up (see above)
```

## After deploy — smoke test
- A known account's balance is `floor(old/10)` (± the rebase caveat above).
- New signup → 100 credits.
- OCR one page → costs 1 credit; AI correction → costs 0.
- Buy Starter with test card `4242 4242 4242 4242` → balance +300, ledger row
  `purchase`, Stripe dashboard webhook shows 2xx.
- Subscribe to Atelier → first invoice paid → +500, subscription row `active`.
- Refund the Starter charge in Stripe → balance drops (clamped at 0).
- Run `stripe trigger invoice.paid` (Stripe CLI) against the deployed webhook and
  confirm the subscription's local row goes `active` and 500 credits are granted.
  The invoice payload shape (`lines[].price.id`, `period_end`) is assumed to match
  the account's Stripe API version and has only been tested against synthetic
  payloads.

## Known simplifications
- The gateway always sends `automatic_tax`; if Stripe 400s in test the operator
  sees a 502 (no retry-without-tax fallback). Acceptable for sandbox.

## Still open (not D1)
- VAT status confirmation; GBP/USD; branded invoices → D3.
- palimora.app domain switch.
