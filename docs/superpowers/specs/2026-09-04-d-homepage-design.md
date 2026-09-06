# Plan D — Palimora public homepage — design

Status: draft, pending user review
Author: Claude (session), with Emmanuel Pays
Date: 2026-09-04

## 1. Purpose

Palimora has no public-facing page today: `/` renders the authed "Station"
app. Plan D adds a public marketing surface — homepage plus pricing, about,
and legal pages — in French and English, aimed primarily at researchers and
archivists, driving self-serve signup (100 free credits already exist on
registration). Alongside the pages, Plan D produces Palimora's first visual
identity (wordmark, mark, favicon, token system) since none exists yet
(current UI uses a 📜 emoji as a placeholder mark).

## 2. Audience, use case, tone (design-context gate)

- **Audience**: researchers and archivists (historians, genealogists,
  academic/heritage archives) digitising handwritten and historical
  documents. Broader/institutional audiences are secondary, served by the
  pricing and about pages rather than the homepage's primary voice.
- **Primary action**: create an account (`/register`), landing on the
  100-free-credit signup bonus.
- **Tone**: warm and approachable — lowers the barrier for a lone
  genealogist without losing credibility with a scholarly/archival
  audience. Not playful/consumer; not utilitarian/dev-tool cold.

## 3. Domain / hosting

Interim hosting: the existing FastAPI app (same container, same deploy)
gains a Coolify domain alias `https://home.palimora.pays.fr.eu.org/`. The
homepage lives at `/` of that same app — this is **not** a host split; the
app is not moving. `SITE_URL` is a single constant used for canonical
links, Open Graph tags, and the sitemap, so the eventual move to
`https://palimora.fr` is a one-line change.

**Assumption flagged for review**: if the app is in fact moving to a
separate deployment for the public pages, section 5 (routing) and section 6
(prerender/server) need rework — confirm before implementation starts.

## 4. Proof content / honesty constraint

No real accuracy numbers, named customers, or testimonials exist yet. The
homepage sells on:
- factual tech credibility (Kraken OCR engine, handwriting + historical
  script support, per-page credit model, multi-format export)
- the product itself (a real Station screenshot, not a mockup)
- honest placeholders where a metric would normally go — a labelled empty
  slot for a future OCR accuracy figure (CER/WER), not an invented number.

Getting a real accuracy figure later: build a 20–50 page ground-truth set
representative of real material, run OCR, compute CER/WER per category
(print vs. handwriting, by era) with a tool such as `dinglehopper` or
`jiwer`. Out of scope for this plan; noted here so the homepage's stat slot
has a known future source.

## 5. Routes and shell

All new routes are public, wrapped in a shared `PublicLayout`
(`PublicNav` + `<Outlet/>` + `PublicFooter`). Existing app routes are
unaffected except Station's path.

| FR path | EN path | Page |
|---|---|---|
| `/` | `/en` | Homepage |
| `/tarifs` | `/en/pricing` | Pricing |
| `/a-propos` | `/en/about` | About + contact |
| `/confidentialite` | `/en/privacy` | Privacy policy |
| `/cgu` | `/en/terms` | Terms of service |

App routes: `/station` (was `/`, now behind `RequireAuth`), `/admin`,
`/billing`, `/login`, `/register` unchanged. Unmatched paths fall back to
`/` (was `/`, i.e. previously Station — now the homepage).

**Auth-redirect**: `PublicLayout` checks `getToken()`. On the homepage
routes (`/`, `/en`) only, an authed visitor is redirected client-side
(post-hydration, in a `useEffect`) to `/station`. On the other public
pages, authed visitors still see the page; the nav CTA swaps from
"Créer un compte" to "Ouvrir la station".

**Language toggle**: a `ROUTE_PAIRS` map (`fr path` ↔ `en path`) resolves
the counterpart of the current route; the nav toggle links to it.

## 6. Prerendering and server

Marketing pages must not render blank-then-hydrate for SEO/link-preview
purposes. Approach: a custom post-build prerender script (not a routing
library, not a puppeteer crawl).

- `web/scripts/prerender.mjs` runs after `vite build` (new `build` script:
  `tsc -b && vite build && node scripts/prerender.mjs`).
- A `publicRoutes` manifest lists each route's component, locale, and meta
  (`title`, `description`, `ogImage`, canonical path under `SITE_URL`).
- For each route: `renderToString` the page (wrapped in a static router
  and the resolved locale's `i18n` dict, no `BrowserRouter`), inject the
  markup into the `dist/index.html` template's `#root`, inject meta tags
  into `<head>`, set `<html lang>`, write to `dist/<path>/index.html`
  (root path writes `dist/index.html` directly).
- Public page components must be SSR-safe: no `window`/`localStorage`
  access at module-eval time or render time — only inside `useEffect`
  (the auth-redirect check already satisfies this by construction).
- One shared `public/og.png` (wordmark + tagline) is used for all pages'
  Open Graph image in v1; per-page images are a later enhancement.
- The same script generates `dist/sitemap.xml` and `dist/robots.txt` from
  the manifest, using `SITE_URL`.

**Server change** (`app/main.py`, `spa()`): currently serves a static file
only on an exact path match, else falls back to `index.html`. Add: if
`full_path` has no file extension and `<STATIC_DIR>/<full_path>/index.html`
exists, serve that file. This makes `/tarifs`, `/en/pricing`, etc. return
their prerendered HTML instead of the generic SPA shell. One `if` branch,
no other server change.

## 7. i18n

No i18n library is added. Custom, minimal:

- `web/src/i18n/fr.ts`, `web/src/i18n/en.ts` — nested plain objects, one
  namespace per page (`common`, `home`, `pricing`, `about`, `privacy`,
  `terms`).
- `web/src/i18n/index.ts` — exports `LOCALES = ['fr', 'en']`,
  `localeFromPath(pathname)`, `ROUTE_PAIRS`, and `useT(locale)` returning a
  `t('home.hero.title')` lookup function.
- Locale is derived from the URL prefix and passed down through
  `PublicLayout`; the prerender script passes locale explicitly per route
  rather than relying on a runtime context provider, so prerendered output
  doesn't depend on client-side routing state.
- Missing-key behaviour: throws in dev, falls back to the dotted key path
  and logs a warning in production.
- Legal copy (privacy/terms) lives as long-form strings in the same
  per-locale files. Content itself (RGPD basis, hosting, sub-processors,
  retention, rights) needs the user's confirmation — the plan ships a
  structured skeleton with the sections a French SaaS privacy
  policy/terms need, not final legal text.

## 8. Visual identity

First Hallmark run for this project (no `.hallmark/log.json`, no
`design.md`) — no diversification constraint; picks are justified by brief
fit.

- **Theme route**: custom (tuned) — named-identity work is Hallmark's
  custom-theme signal.
- **Palette**: warm parchment paper (high-L, low-C warm white, OKLCH),
  near-black sepia ink for text, single accent hue — a faded madder-red
  (~`oklch(45% 0.13 25)`), evoking archival rubrication rather than a
  corporate blue. Used sparingly: links, primary CTA, active/focus states.
- **Type pairing**: a warm roman serif for display, a humanist sans for
  body/UI. Exact faces selected from Google Fonts at build time and
  tokenised (`--font-display`, `--font-body`); no italic headers.
- **Mark**: an inline SVG glyph — a folio corner where an older line of
  text shows faintly through a newer one (literalising the "palimpsest"
  etymology of the product name). Simplifies to a favicon at small sizes.
  Replaces the current 📜 emoji placeholder.
- **Wordmark**: "Palimora" set in the display serif with one deliberate
  tracking/weight adjustment.
- **Tokens**: full `tokens.css` (`--color-*`, `--font-*`, `--space-*`,
  `--text-*`, `--ease-*`, `--dur-*`, `--radius-*`) committed at the web
  project root — the durable, reusable identity artifact. The existing app
  (Station/Admin/Billing, currently plain Tailwind slate) does not adopt
  these tokens as part of this plan; that's a future, separate decision.
- **Nav**: N6 Masthead archetype (editorial register).
- **Footer**: Ft5 Statement archetype (closing line + minimal link list).
- **Motion**: three primitives — scroll reveal (opacity/translate,
  ≤200ms), CTA hover lift, language-toggle crossfade. Ships with
  `prefers-reduced-motion` fallback (spatial motion collapses to a ≤150ms
  opacity crossfade).
- **Enrichment**: Tier A — a real Station screenshot in a bordered
  `<figure>` for the homepage's "workbench" section. No generated imagery,
  no stock photography, no re-drawn browser/app chrome.

## 9. Page content structure

### Homepage — macrostructure: Workbench

1. Masthead + hero: one-line promise, sub-line naming the audience, primary
   CTA ("Créer un compte — 100 pages offertes"), secondary CTA ("Voir
   comment ça marche").
2. Workbench strip: real Station screenshot (manuscript ↔ transcription),
   one honest caption.
3. How it works: 3 numbered steps (deposit → OCR → correct/export) —
   numbering is allowed here because the content is genuinely ordinal and
   the tag stacks vertically above its heading, not beside it.
4. What it handles: factual capability list (handwriting, historical
   scripts, multi-language, multi-page PDF, text/ALTO export); one
   labelled empty slot reserved for a future accuracy figure.
5. Pricing teaser: 3 pack cards (static copy, live price fetched from the
   billing catalogue after hydration), link to `/tarifs`.
6. FAQ: 4–5 real questions (formats, data/RGPD, credits, cancellation).
7. Closing CTA: repeats signup CTA with a warm sign-off line.
8. Ft5 footer.

### Pricing (`/tarifs`, `/en/pricing`)

Masthead, pack table sourced from the billing catalogue, a "how credits
work" explainer, an FAQ subset, closing CTA.

**Dependency**: the pack table needs the billing catalogue endpoint
readable without auth (prices aren't secret). Verify
`GET /api/billing/catalogue`'s current auth guard; if it requires a token,
add an unauthenticated read path. Flagged as an implementation-plan task,
not resolved in this spec.

### About (`/a-propos`, `/en/about`)

Letter-voice macrostructure: who's behind Palimora and why, contact via
`mailto:` link for institutional enquiries (no contact form, no backend
endpoint — explicit choice, avoids adding email infrastructure the app
doesn't have).

### Privacy / Terms (`/confidentialite`+`/cgu`, `/en/privacy`+`/en/terms`)

Long Document macrostructure. Structured skeleton only — the user supplies
or confirms final legal text (RGPD legal basis, hosting provider,
sub-processors, data retention, user rights) before launch.

## 10. Testing

- Vitest: `useT` missing-key behaviour; `PublicLayout` auth-redirect logic
  (authed → `/station`, anonymous → renders); `ROUTE_PAIRS` resolves
  correctly for all 5 pairs.
- Prerender smoke test (Node, run in CI after build): asserts
  `dist/index.html`, `dist/en/index.html`, `dist/tarifs/index.html`, etc.
  exist and each contains its expected `<title>` and a non-empty `#root`.
- `pytest`: a case hitting `/tarifs` and `/en/pricing` on the FastAPI app
  confirms the prerendered file is returned, not the generic SPA shell.
- Manual: Hallmark's 58-gate slop test run against the homepage before
  merge; mobile check at 320/375/414/768px.

## 11. Rollout

Additive change, ships with the normal deploy. `/station` replacing `/`
for the authed app is the only breaking path — old bookmarks to `/` now
hit the homepage, which is correct behaviour (authed users get redirected
client-side). No feature flag needed. Once merged, point the
`home.palimora.pays.fr.eu.org` Coolify domain alias at the app.

## 12. Explicitly out of scope for Plan D

- English/French parity beyond these 5 pages (no blog, no docs site).
- Contact form / transactional email infrastructure.
- Real OCR accuracy figures (methodology noted, not executed).
- Adopting the new token system in the existing authed app (Station,
  Admin, Billing keep their current Tailwind slate look).
- Per-page Open Graph images (one shared image for v1).
- Full brand identity exploration (multiple mark directions, lockup
  variants) — one wordmark + one mark, built and shipped.
