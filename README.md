Palimora Server — API SaaS + station de relecture web.

Voir le plan de projet (Phase A) pour l'architecture.

## Tests

    pip install -r requirements-dev.txt
    pytest -q                 # backend
    npm --prefix web test     # frontend (Vitest)

## Stripe (Phase D1)

Card payments for OCR credits (test mode). Operator checklist:
`docs/superpowers/plans/2026-08-31-d1-stripe-payments-DONE.md`.

Env vars the operator must set (server + worker):

| Var | Notes |
| --- | --- |
| `STRIPE_SECRET_KEY` | test-mode `sk_test_...`, never committed |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` for `/api/stripe/webhook` |
| `STRIPE_TAX_ENABLED` | `true` to send `automatic_tax` |
| `STRIPE_PRICE_STARTER` | Stripe Price id — starter pack (300 cr / €29) |
| `STRIPE_PRICE_CHERCHEUR` | Price id — chercheur (1500 cr / €119) |
| `STRIPE_PRICE_ARCHIVISTE` | Price id — archiviste (6000 cr / €399) |
| `STRIPE_PRICE_ATELIER` | Price id — atelier (500 cr/mo / €39/mo, recurring) |
| `BILLING_ENTITY_NAME` | receipts, default `Palimora` |
| `BILLING_ENTITY_ADDRESS` | receipts |
| `BILLING_ENTITY_COUNTRY` | default `FR` |
| `PAGE_COST_POINTS` | `1` (1 credit = 1 page) |
| `AI_CORRECTION_COST_POINTS` | `0` (AI correction is free) |
| `SIGNUP_BONUS_POINTS` | `100` |
| `REBASE_TOPUP_TO` | `0`; set to `100` for one deploy to top existing users up |
