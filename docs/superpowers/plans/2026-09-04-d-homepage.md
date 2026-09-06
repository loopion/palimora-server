# Plan D — Palimora public homepage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public, bilingual (FR/EN) marketing surface for Palimora — homepage, pricing, about, privacy, terms — with a first visual identity, driving self-serve signup, prerendered for SEO, served by the existing FastAPI app.

**Architecture:** New public React route tree (`PublicLayout` + 5 page components) added to the existing Vite SPA, sharing its build. A post-build Node script prerenders each public route to static HTML with per-page `<title>`/meta, written into `dist/`. A one-line addition to FastAPI's catch-all route serves those prerendered files by directory instead of falling back to the generic SPA shell. Station moves from `/` to `/station`; `/` and `/en` become the homepage, with a client-side redirect to `/station` for already-authed visitors.

**Tech Stack:** React 18, react-router-dom 6 (including `react-router-dom/server`'s `StaticRouter`), Vite 6, Tailwind v4, Vitest + Testing Library, `sharp` (dev-only, asset generation), FastAPI/pytest.

**Spec:** `docs/superpowers/specs/2026-09-04-d-homepage-design.md`

## Global Constraints

- Language: French is the default/primary locale; English is a full parallel (`/en/...` prefix). No third locale.
- No new runtime i18n library — hand-rolled lookup only (spec §7).
- No accuracy/metric claims without a real number; the homepage's capability section carries a labelled empty slot instead (spec §4).
- No contact form / email-sending backend; contact is `mailto:` only (spec §9).
- `SITE_URL` is a single constant: `https://home.palimora.pays.fr.eu.org` for now, swapped to `https://palimora.fr` later — never hardcode the domain elsewhere.
- Design tokens are OKLCH custom properties, referenced by name — no inline hex/oklch in component code (Hallmark token discipline, spec §8).
- No italic headings; no fake browser/app chrome; the one product image is a real Station screenshot, not a mock.
- Every interactive element (nav links, CTA buttons, language toggle) needs `:focus-visible` with a visible ring, keyboard-operable, no two-line clickable text.
- Existing app routes/behavior (`/station` content, `/admin`, `/billing`, `/login`, `/register`, auth flow) must keep working exactly as today — only their mount path may change (Station: `/` → `/station`).

---

## File Structure

```
web/
  src/
    styles/
      tokens.css                 # NEW — Hallmark design tokens
    i18n/
      fr.ts                      # NEW — French copy
      en.ts                      # NEW — English copy
      index.ts                   # NEW — useT, ROUTE_PAIRS, localeFromPath
      index.test.ts              # NEW
    components/
      public/
        Mark.tsx                 # NEW — identity glyph, inline SVG
        PublicLayout.tsx         # NEW — shell: nav + outlet + footer, auth redirect
        PublicLayout.test.tsx    # NEW
        PublicNav.tsx            # NEW
        PublicFooter.tsx         # NEW
    pages/
      public/
        Home.tsx                 # NEW
        Home.test.tsx            # NEW
        Pricing.tsx               # NEW
        Pricing.test.tsx          # NEW
        About.tsx                 # NEW
        About.test.tsx            # NEW
        Privacy.tsx                # NEW
        Terms.tsx                  # NEW
        LegalPage.tsx               # NEW — shared skeleton for Privacy/Terms
        LegalPage.test.tsx          # NEW
    index.css                    # MODIFY — import tokens.css
    main.tsx                     # MODIFY — Station -> /station, register public routes
  scripts/
    prerender.mjs                 # NEW
    prerender.smoke.test.mjs      # NEW
    generate-identity-assets.mjs   # NEW — one-off, run once, output committed
  public/
    favicon.svg                    # NEW (generated)
    apple-touch-icon.png            # NEW (generated)
    favicon-32.png                  # NEW (generated)
    og.png                          # NEW (generated)
    workbench-screenshot.png        # NEW (real Station screenshot, captured by hand)
  package.json                      # MODIFY — build script, new deps
app/
  main.py                            # MODIFY — spa() serves prerendered directories
tests/
  test_public_prerender.py           # NEW
```

---

### Task 1: Design tokens

**Files:**
- Create: `web/src/styles/tokens.css`
- Modify: `web/src/index.css`

**Interfaces:**
- Produces: CSS custom properties consumed by every later task —
  `--color-paper`, `--color-paper-2`, `--color-ink`, `--color-ink-soft`,
  `--color-accent`, `--color-accent-ink`, `--color-border`, `--color-focus`,
  `--font-display`, `--font-body`, `--space-1..24`, `--text-sm..display`,
  `--ease-out`, `--ease-in`, `--ease-in-out`, `--dur-fast`, `--dur-base`,
  `--dur-slow`, `--radius-sm..full`.

This is an asset/config task — no meaningful unit test for a CSS file, so it
skips the TDD step structure and is verified by the build succeeding.

- [ ] **Step 1: Write the tokens file**

```css
/* web/src/styles/tokens.css */
/* Hallmark · custom theme: Palimora warm-parchment
 * paper-band: light · display-style: warm-roman-serif · accent-hue: warm (madder-red ~25°)
 */
:root {
  /* colour */
  --color-paper: oklch(97% 0.015 80);
  --color-paper-2: oklch(94% 0.02 75);
  --color-ink: oklch(22% 0.02 40);
  --color-ink-soft: oklch(42% 0.02 40);
  --color-accent: oklch(45% 0.13 25);
  --color-accent-ink: oklch(98% 0.01 80);
  --color-border: oklch(85% 0.02 75);
  --color-focus: oklch(45% 0.13 25);

  /* type */
  --font-display: 'Fraunces', ui-serif, Georgia, 'Times New Roman', serif;
  --font-body: 'Public Sans', ui-sans-serif, system-ui, -apple-system, sans-serif;

  /* space (4pt scale) */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-12: 3rem;
  --space-16: 4rem;
  --space-24: 6rem;

  /* type scale */
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-lg: 1.25rem;
  --text-xl: 1.5rem;
  --text-2xl: 2rem;
  --text-display-s: 2.75rem;
  --text-display: 4rem;

  /* motion */
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --dur-fast: 120ms;
  --dur-base: 200ms;
  --dur-slow: 320ms;

  /* radius */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-full: 999px;
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-fast: 1ms;
    --dur-base: 1ms;
    --dur-slow: 150ms;
  }
}
```

- [ ] **Step 2: Import it and add the font packages**

```bash
npm --prefix web install @fontsource/fraunces @fontsource/public-sans
```

Add to the top of `web/src/index.css` (above the existing `@import "tailwindcss";`):

```css
@import '@fontsource/fraunces/400.css';
@import '@fontsource/fraunces/600.css';
@import '@fontsource/public-sans/400.css';
@import '@fontsource/public-sans/600.css';
@import './styles/tokens.css';
```

Leave the rest of `web/src/index.css` (the existing Tailwind import, `body`
rule, scrollbar/overlay rules) untouched — this only adds imports above it.

- [ ] **Step 3: Verify the build picks it up**

Run: `npm --prefix web run build`
Expected: build succeeds; no CSS import errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/styles/tokens.css web/src/index.css web/package.json web/package-lock.json
git commit -m "feat(web): add Palimora design tokens (Fraunces + Public Sans, warm-parchment palette)"
```

---

### Task 2: Identity assets (mark, favicon, OG image)

**Files:**
- Create: `web/src/components/public/Mark.tsx`
- Create: `web/scripts/generate-identity-assets.mjs`
- Create (generated, committed): `web/public/favicon.svg`, `web/public/apple-touch-icon.png`, `web/public/favicon-32.png`, `web/public/og.png`
- Test: `web/src/components/public/Mark.test.tsx`

**Interfaces:**
- Produces: `Mark` React component, `import Mark from '../components/public/Mark'`, props
  `{ size?: number; className?: string }`, renders an `<svg>` with
  `role="img"` and `aria-label="Palimora"`.

The mark: a folded-corner folio outline with two ink strokes — one solid
(the current transcription), one at reduced opacity offset behind it (the
older text showing through), literalising "palimpsest."

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/components/public/Mark.test.tsx
import { render, screen } from '@testing-library/react'
import Mark from './Mark'

test('renders an accessible svg mark', () => {
  render(<Mark />)
  const svg = screen.getByRole('img', { name: 'Palimora' })
  expect(svg.tagName.toLowerCase()).toBe('svg')
})

test('applies the requested size', () => {
  render(<Mark size={32} />)
  const svg = screen.getByRole('img', { name: 'Palimora' })
  expect(svg).toHaveAttribute('width', '32')
  expect(svg).toHaveAttribute('height', '32')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- Mark.test.tsx`
Expected: FAIL — `Failed to resolve import "./Mark"`

- [ ] **Step 3: Write the component**

```tsx
// web/src/components/public/Mark.tsx
export default function Mark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="Palimora"
      className={className}
    >
      {/* folio, folded corner */}
      <path
        d="M8 4h24l8 8v32a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
        fill="var(--color-paper-2)"
        stroke="var(--color-ink)"
        strokeWidth="1.5"
      />
      <path d="M32 4v8h8" fill="none" stroke="var(--color-ink)" strokeWidth="1.5" strokeLinejoin="round" />
      {/* older line, faint, offset — showing through */}
      <line x1="12" y1="24" x2="34" y2="24" stroke="var(--color-ink)" strokeWidth="2" strokeLinecap="round" opacity="0.28" />
      {/* newer line, solid, accent */}
      <line x1="12" y1="30" x2="30" y2="30" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web test -- Mark.test.tsx`
Expected: PASS

- [ ] **Step 5: Generate favicon + OG raster assets from the mark**

```bash
npm --prefix web install -D sharp
```

```js
// web/scripts/generate-identity-assets.mjs
// One-off asset generator — run manually when the mark changes, commit the
// output. Not part of the build pipeline.
import sharp from 'sharp'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(root, '..', 'public')
mkdirSync(publicDir, { recursive: true })

const INK = '#3a2e26'
const ACCENT = '#8a3324'
const PAPER = '#f6f1e7'
const PAPER_2 = '#efe6d4'

const markSvg = (size) => `
<svg width="${size}" height="${size}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
  <rect width="48" height="48" fill="${PAPER}"/>
  <path d="M8 4h24l8 8v32a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="${PAPER_2}" stroke="${INK}" stroke-width="1.5"/>
  <path d="M32 4v8h8" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>
  <line x1="12" y1="24" x2="34" y2="24" stroke="${INK}" stroke-width="2" stroke-linecap="round" opacity="0.28"/>
  <line x1="12" y1="30" x2="30" y2="30" stroke="${ACCENT}" stroke-width="2.5" stroke-linecap="round"/>
</svg>`

writeFileSync(path.join(publicDir, 'favicon.svg'), markSvg(48).trim())

const ogSvg = `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="${PAPER}"/>
  <g transform="translate(120,175) scale(5)">
    <path d="M8 4h24l8 8v32a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="${PAPER_2}" stroke="${INK}" stroke-width="1.5"/>
    <path d="M32 4v8h8" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>
    <line x1="12" y1="24" x2="34" y2="24" stroke="${INK}" stroke-width="2" stroke-linecap="round" opacity="0.28"/>
    <line x1="12" y1="30" x2="30" y2="30" stroke="${ACCENT}" stroke-width="2.5" stroke-linecap="round"/>
  </g>
  <text x="420" y="330" font-family="serif" font-size="88" fill="${INK}">Palimora</text>
  <text x="420" y="390" font-family="sans-serif" font-size="32" fill="${INK}" opacity="0.7">Vos manuscrits ont une histoire a raconter.</text>
</svg>`

async function run() {
  await sharp(Buffer.from(markSvg(180))).png().toFile(path.join(publicDir, 'apple-touch-icon.png'))
  await sharp(Buffer.from(markSvg(32))).png().toFile(path.join(publicDir, 'favicon-32.png'))
  await sharp(Buffer.from(ogSvg)).png().toFile(path.join(publicDir, 'og.png'))
  console.log('Identity assets written to web/public/')
}
run()
```

Run: `node web/scripts/generate-identity-assets.mjs`
Expected: creates `web/public/favicon.svg`, `apple-touch-icon.png`,
`favicon-32.png`, `og.png`. Open `web/public/og.png` and confirm it isn't
blank/corrupt (non-zero file size, opens in an image viewer). If the text
renders poorly on your platform's `sharp`/librsvg build, that's acceptable
for v1 — it's a maintenance script, rerun it after installing better font
support later.

- [ ] **Step 6: Wire favicon links into the HTML template**

In `web/index.html`, inside `<head>`, after the `<title>` line, add:

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="alternate icon" href="/favicon-32.png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
```

- [ ] **Step 7: Commit**

```bash
git add web/src/components/public/Mark.tsx web/src/components/public/Mark.test.tsx \
        web/scripts/generate-identity-assets.mjs web/public/favicon.svg \
        web/public/apple-touch-icon.png web/public/favicon-32.png web/public/og.png \
        web/index.html web/package.json web/package-lock.json
git commit -m "feat(web): Palimora mark component + generated favicon/OG assets"
```

---

### Task 3: i18n foundation

**Files:**
- Create: `web/src/i18n/fr.ts`
- Create: `web/src/i18n/en.ts`
- Create: `web/src/i18n/index.ts`
- Test: `web/src/i18n/index.test.ts`

**Interfaces:**
- Produces:
  - `type Locale = 'fr' | 'en'`
  - `LOCALES: Locale[]`
  - `ROUTE_PAIRS: Record<string, string>` — every public path maps to its
    counterpart in the other locale (both directions present as keys).
  - `localeFromPath(pathname: string): Locale`
  - `useT(locale: Locale): <T = string>(key: string) => T`
  - `CONTACT_EMAIL: string` and `SITE_URL: string` constants.
- Consumes: nothing (foundation task).

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/i18n/index.test.ts
import { describe, expect, test, vi } from 'vitest'
import { localeFromPath, ROUTE_PAIRS, useT } from './index'

describe('localeFromPath', () => {
  test('defaults to fr for french paths', () => {
    expect(localeFromPath('/')).toBe('fr')
    expect(localeFromPath('/tarifs')).toBe('fr')
  })
  test('detects en prefix', () => {
    expect(localeFromPath('/en')).toBe('en')
    expect(localeFromPath('/en/pricing')).toBe('en')
  })
})

describe('ROUTE_PAIRS', () => {
  test('every fr path maps to an en path and back', () => {
    const pairs: [string, string][] = [
      ['/', '/en'],
      ['/tarifs', '/en/pricing'],
      ['/a-propos', '/en/about'],
      ['/confidentialite', '/en/privacy'],
      ['/cgu', '/en/terms'],
    ]
    for (const [fr, en] of pairs) {
      expect(ROUTE_PAIRS[fr]).toBe(en)
      expect(ROUTE_PAIRS[en]).toBe(fr)
    }
  })
})

describe('useT', () => {
  test('resolves a dotted key to a string', () => {
    const t = useT('fr')
    expect(t('home.hero.cta_primary')).toBe('Créer un compte — 100 pages offertes')
  })
  test('resolves the same key in english', () => {
    const t = useT('en')
    expect(t('home.hero.cta_primary')).toBe('Create an account — 100 free pages')
  })
  test('returns raw arrays for list content', () => {
    const t = useT('fr')
    const steps = t<{ title: string; body: string }[]>('home.how.steps')
    expect(steps).toHaveLength(3)
    expect(steps[0].title).toBe('Déposez')
  })
  test('logs and falls back to the key path when missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = useT('fr')
    expect(t('home.nonexistent.key')).toBe('home.nonexistent.key')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix web test -- i18n/index.test.ts`
Expected: FAIL — `Failed to resolve import "./index"`

- [ ] **Step 3: Write the French copy**

```ts
// web/src/i18n/fr.ts
export const fr = {
  common: {
    nav: {
      home: 'Accueil',
      pricing: 'Tarifs',
      about: 'À propos',
      cta_signup: 'Créer un compte',
      cta_open_app: 'Ouvrir la station',
      lang_toggle: 'EN',
    },
    footer: {
      statement: 'Palimora transcrit vos archives, page après page.',
      links: {
        pricing: 'Tarifs',
        about: 'À propos',
        privacy: 'Confidentialité',
        terms: 'CGU',
        contact: 'Nous écrire',
      },
      copyright: '© 2026 Palimora',
    },
  },
  home: {
    hero: {
      title: 'Vos manuscrits ont une histoire à raconter.',
      subtitle:
        'Palimora transcrit vos documents manuscrits et imprimés anciens — écritures difficiles, PDF multipages, scripts historiques — pour que vous puissiez lire, chercher et citer, pas seulement archiver.',
      cta_primary: 'Créer un compte — 100 pages offertes',
      cta_secondary: 'Voir comment ça marche',
    },
    workbench: {
      caption: 'Une page de manuscrit, déposée dans Palimora, prête à corriger.',
    },
    how: {
      title: 'Comment ça marche',
      steps: [
        { title: 'Déposez', body: 'Glissez vos PDF ou images — manuscrits, imprimés, multi-pages.' },
        { title: 'Transcription', body: "Le moteur Kraken reconnaît l'écriture et produit un premier texte." },
        { title: 'Corrigez et exportez', body: 'Relisez page par page dans la Station, puis exportez en texte ou ALTO.' },
      ],
    },
    capabilities: {
      title: 'Ce que Palimora reconnaît',
      items: [
        'Écriture manuscrite, du XVIIIe siècle à aujourd’hui',
        'Imprimés anciens et scripts multiples',
        'PDF multipages, traités page par page',
        'Export en texte brut ou ALTO XML',
      ],
      stat_slot_label: 'Taux de reconnaissance : mesures publiées prochainement',
    },
    pricing_teaser: {
      title: '1 crédit = 1 page',
      body: 'Aucun abonnement obligatoire. Achetez des crédits quand vous en avez besoin.',
      cta: 'Voir les tarifs',
    },
    faq: {
      title: 'Questions fréquentes',
      items: [
        { q: 'Quels formats sont acceptés ?', a: 'PDF, JPEG, PNG, WebP, HEIC/HEIF. Les PDF multipages sont découpés automatiquement en pages.' },
        { q: 'Que deviennent mes documents ?', a: 'Vos fichiers et transcriptions vous appartiennent. Le détail du traitement est décrit dans notre politique de confidentialité.' },
        { q: 'Comment fonctionnent les crédits ?', a: '1 crédit = 1 page transcrite. 100 pages sont offertes à l’inscription ; au-delà, achetez un pack ou un abonnement mensuel.' },
        { q: 'Puis-je résilier à tout moment ?', a: "Oui. Les packs sont des achats uniques sans engagement ; l'abonnement Atelier se résilie à tout moment depuis votre compte." },
      ],
    },
    closing: {
      title: 'Prêt à faire parler vos archives ?',
      cta: 'Créer un compte gratuitement',
    },
  },
  pricing: {
    title: 'Des tarifs simples, à la page.',
    intro: '1 crédit Palimora = 1 page transcrite. Aucune page, aucun coût.',
    loading: 'Chargement des tarifs…',
    error: 'Tarifs momentanément indisponibles — réessayez dans un instant.',
    credits_explainer: {
      title: 'Comment fonctionnent les crédits',
      body: 'Chaque page transcrite consomme 1 crédit, manuscrite ou imprimée. La correction assistée par IA ne coûte rien de plus. Les crédits achetés n’expirent pas.',
    },
    faq: {
      items: [
        { q: 'Comment fonctionnent les crédits ?', a: '1 crédit = 1 page transcrite. 100 pages sont offertes à l’inscription.' },
        { q: 'Puis-je changer de pack ?', a: 'Oui, achetez un nouveau pack à tout moment ; les crédits se cumulent.' },
        { q: 'Puis-je résilier à tout moment ?', a: "Oui, l'abonnement Atelier se résilie à tout moment depuis votre compte." },
      ],
    },
    cta: 'Créer un compte',
  },
  about: {
    title: 'Pourquoi Palimora',
    paragraphs: [
      'Palimora est né d’un besoin très concret : lire des archives manuscrites sans y passer des mois.',
      'Le nom vient du palimpseste — ce parchemin qu’on grattait pour écrire par-dessus, et sous lequel le texte effacé finit toujours par ressurgir. C’est ce que fait Palimora : faire ressurgir le texte de vos documents.',
      'Le projet est développé en continu ; les retours de chercheurs, archivistes et généalogistes qui l’utilisent orientent directement ce qui est construit ensuite.',
    ],
    contact_title: 'Une question, un usage institutionnel ?',
    contact_body: 'Écrivez-moi directement :',
  },
  privacy: {
    title: 'Politique de confidentialité',
    intro: 'Cette politique est en cours de finalisation avec un conseil juridique ; la structure ci-dessous reflète ce qui sera couvert.',
    sections: [
      { heading: 'Responsable du traitement', body: 'Palimora, exploité par Emmanuel Pays.' },
      { heading: 'Données collectées', body: 'Compte (email), documents déposés et leurs transcriptions, données de facturation.' },
      { heading: 'Finalités', body: 'Fourniture du service de transcription, facturation, support.' },
      { heading: 'Base légale', body: 'Exécution du contrat de service et, pour la facturation, obligation légale.' },
      { heading: 'Hébergement et sous-traitants', body: 'Hébergement et paiement par des prestataires tiers, listés en détail dans la version finale de cette politique.' },
      { heading: 'Durée de conservation', body: 'Le temps de la relation contractuelle, puis selon les durées légales applicables.' },
      { heading: 'Vos droits', body: 'Accès, rectification, effacement, portabilité — exercables en écrivant à l’adresse de contact.' },
      { heading: 'Cookies', body: 'Cookies strictement nécessaires au fonctionnement du service uniquement.' },
      { heading: 'Contact', body: 'Pour toute question relative à vos données, écrivez à l’adresse de contact.' },
    ],
  },
  terms: {
    title: 'Conditions générales d’utilisation',
    intro: 'Ces CGU sont en cours de finalisation avec un conseil juridique ; la structure ci-dessous reflète ce qui sera couvert.',
    sections: [
      { heading: 'Objet', body: 'Les présentes CGU encadrent l’utilisation du service Palimora.' },
      { heading: 'Compte utilisateur', body: 'Un compte est nécessaire pour utiliser le service ; l’utilisateur est responsable de la confidentialité de ses identifiants.' },
      { heading: 'Crédits et paiement', body: '1 crédit = 1 page transcrite. Les tarifs et modalités de paiement sont détaillés sur la page Tarifs.' },
      { heading: 'Utilisation du service', body: 'L’utilisateur garantit disposer des droits nécessaires sur les documents déposés.' },
      { heading: 'Propriété des documents', body: 'Les documents déposés et leurs transcriptions restent la propriété de l’utilisateur.' },
      { heading: 'Résiliation', body: 'L’utilisateur peut supprimer son compte à tout moment ; l’abonnement Atelier se résilie depuis le compte.' },
      { heading: 'Responsabilité', body: 'Le service est fourni en l’état ; les limitations de responsabilité seront précisées dans la version finale.' },
      { heading: 'Droit applicable', body: 'Droit français.' },
    ],
  },
} as const
```

- [ ] **Step 4: Write the English copy**

```ts
// web/src/i18n/en.ts
export const en = {
  common: {
    nav: {
      home: 'Home',
      pricing: 'Pricing',
      about: 'About',
      cta_signup: 'Create an account',
      cta_open_app: 'Open the workbench',
      lang_toggle: 'FR',
    },
    footer: {
      statement: 'Palimora transcribes your archives, one page at a time.',
      links: {
        pricing: 'Pricing',
        about: 'About',
        privacy: 'Privacy',
        terms: 'Terms',
        contact: 'Get in touch',
      },
      copyright: '© 2026 Palimora',
    },
  },
  home: {
    hero: {
      title: 'Your manuscripts have a story to tell.',
      subtitle:
        'Palimora transcribes handwritten and historical printed documents — difficult hands, multi-page PDFs, historical scripts — so you can read, search, and cite, not just archive.',
      cta_primary: 'Create an account — 100 free pages',
      cta_secondary: 'See how it works',
    },
    workbench: {
      caption: 'A manuscript page, dropped into Palimora, ready to correct.',
    },
    how: {
      title: 'How it works',
      steps: [
        { title: 'Drop it in', body: 'Drag in your PDFs or images — manuscripts, print, multi-page.' },
        { title: 'Transcription', body: 'The Kraken engine recognises the handwriting and produces a first pass.' },
        { title: 'Correct and export', body: 'Review page by page in the workbench, then export as text or ALTO.' },
      ],
    },
    capabilities: {
      title: 'What Palimora recognises',
      items: [
        'Handwriting, from the 18th century to today',
        'Historical print and multiple scripts',
        'Multi-page PDFs, processed page by page',
        'Plain-text or ALTO XML export',
      ],
      stat_slot_label: 'Recognition rate: figures published soon',
    },
    pricing_teaser: {
      title: '1 credit = 1 page',
      body: 'No mandatory subscription. Buy credits when you need them.',
      cta: 'See pricing',
    },
    faq: {
      title: 'Frequently asked questions',
      items: [
        { q: 'What formats are supported?', a: 'PDF, JPEG, PNG, WebP, HEIC/HEIF. Multi-page PDFs are split into pages automatically.' },
        { q: 'What happens to my documents?', a: 'Your files and transcriptions belong to you. Handling is detailed in our privacy policy.' },
        { q: 'How do credits work?', a: '1 credit = 1 transcribed page. 100 pages are free on signup; beyond that, buy a pack or a monthly plan.' },
        { q: 'Can I cancel any time?', a: "Yes. Packs are one-off purchases with no commitment; the Atelier subscription can be cancelled any time from your account." },
      ],
    },
    closing: {
      title: 'Ready to make your archives speak?',
      cta: 'Create a free account',
    },
  },
  pricing: {
    title: 'Simple, per-page pricing.',
    intro: '1 Palimora credit = 1 transcribed page. No page, no cost.',
    loading: 'Loading pricing…',
    error: 'Pricing temporarily unavailable — try again in a moment.',
    credits_explainer: {
      title: 'How credits work',
      body: 'Every transcribed page uses 1 credit, handwritten or printed. AI-assisted correction costs nothing extra. Purchased credits never expire.',
    },
    faq: {
      items: [
        { q: 'How do credits work?', a: '1 credit = 1 transcribed page. 100 pages are free on signup.' },
        { q: 'Can I switch packs?', a: 'Yes, buy a new pack any time; credits stack.' },
        { q: 'Can I cancel any time?', a: 'Yes, the Atelier subscription can be cancelled any time from your account.' },
      ],
    },
    cta: 'Create an account',
  },
  about: {
    title: 'Why Palimora',
    paragraphs: [
      'Palimora came out of a very concrete need: reading handwritten archives without losing months to it.',
      'The name comes from palimpsest — parchment scraped clean to write over, where the erased text always resurfaces underneath. That is what Palimora does: bring the text of your documents back to the surface.',
      'The project is built continuously; feedback from the researchers, archivists, and genealogists using it directly shapes what gets built next.',
    ],
    contact_title: 'A question, or an institutional use case?',
    contact_body: 'Write to me directly:',
  },
  privacy: {
    title: 'Privacy policy',
    intro: 'This policy is being finalised with legal counsel; the structure below reflects what it will cover.',
    sections: [
      { heading: 'Data controller', body: 'Palimora, operated by Emmanuel Pays.' },
      { heading: 'Data collected', body: 'Account (email), uploaded documents and their transcriptions, billing data.' },
      { heading: 'Purposes', body: 'Providing the transcription service, billing, support.' },
      { heading: 'Legal basis', body: 'Performance of the service contract, and legal obligation for billing.' },
      { heading: 'Hosting and processors', body: 'Hosting and payment handled by third-party providers, listed in full in the final policy.' },
      { heading: 'Retention', body: 'For the duration of the contractual relationship, then per applicable legal retention periods.' },
      { heading: 'Your rights', body: 'Access, rectification, erasure, portability — exercised by writing to the contact address.' },
      { heading: 'Cookies', body: 'Strictly necessary cookies only.' },
      { heading: 'Contact', body: 'For any data question, write to the contact address.' },
    ],
  },
  terms: {
    title: 'Terms of service',
    intro: 'These terms are being finalised with legal counsel; the structure below reflects what they will cover.',
    sections: [
      { heading: 'Purpose', body: 'These terms govern use of the Palimora service.' },
      { heading: 'User account', body: 'An account is required to use the service; the user is responsible for keeping their credentials confidential.' },
      { heading: 'Credits and payment', body: '1 credit = 1 transcribed page. Pricing and payment terms are detailed on the Pricing page.' },
      { heading: 'Use of the service', body: 'The user warrants they hold the necessary rights over uploaded documents.' },
      { heading: 'Ownership of documents', body: 'Uploaded documents and their transcriptions remain the property of the user.' },
      { heading: 'Termination', body: 'The user may delete their account at any time; the Atelier subscription can be cancelled from the account.' },
      { heading: 'Liability', body: 'The service is provided as-is; liability limitations will be detailed in the final version.' },
      { heading: 'Governing law', body: 'French law.' },
    ],
  },
} as const
```

- [ ] **Step 5: Write the lookup module**

```ts
// web/src/i18n/index.ts
import { fr } from './fr'
import { en } from './en'

export type Locale = 'fr' | 'en'
export const LOCALES: Locale[] = ['fr', 'en']

export const SITE_URL = 'https://home.palimora.pays.fr.eu.org'
export const CONTACT_EMAIL = 'contact@palimora.fr'

const DICTS: Record<Locale, unknown> = { fr, en }

export const ROUTE_PAIRS: Record<string, string> = {
  '/': '/en',
  '/en': '/',
  '/tarifs': '/en/pricing',
  '/en/pricing': '/tarifs',
  '/a-propos': '/en/about',
  '/en/about': '/a-propos',
  '/confidentialite': '/en/privacy',
  '/en/privacy': '/confidentialite',
  '/cgu': '/en/terms',
  '/en/terms': '/cgu',
}

export function localeFromPath(pathname: string): Locale {
  return pathname === '/en' || pathname.startsWith('/en/') ? 'en' : 'fr'
}

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

export function useT(locale: Locale) {
  const dict = DICTS[locale]
  return function t<T = string>(key: string): T {
    const value = get(dict, key)
    if (value === undefined) {
      console.warn(`[i18n] missing key "${key}" for locale "${locale}"`)
      return key as unknown as T
    }
    return value as T
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm --prefix web test -- i18n/index.test.ts`
Expected: PASS (4 describe blocks, all tests green)

- [ ] **Step 7: Commit**

```bash
git add web/src/i18n
git commit -m "feat(web): i18n foundation — fr/en dictionaries, useT, route pairs"
```

---

### Task 4: PublicLayout, PublicNav, PublicFooter

**Files:**
- Create: `web/src/components/public/PublicLayout.tsx`
- Create: `web/src/components/public/PublicNav.tsx`
- Create: `web/src/components/public/PublicFooter.tsx`
- Test: `web/src/components/public/PublicLayout.test.tsx`

**Interfaces:**
- Consumes: `getToken` from `../../api`; `useT`, `localeFromPath`,
  `ROUTE_PAIRS`, `CONTACT_EMAIL` from `../../i18n`; `Mark` from `./Mark`.
- Produces: `PublicLayout` — a route element (renders `<Outlet/>`) that
  redirects authed visitors away from the two homepage paths (`/`, `/en`)
  to `/station`; exported default. `PublicNav`/`PublicFooter` take
  `{ locale: Locale }` and are used internally by `PublicLayout` (not
  exported for direct route use).

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/public/PublicLayout.test.tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'
import PublicLayout from './PublicLayout'

vi.mock('../../api', () => ({ getToken: vi.fn() }))
import { getToken } from '../../api'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route path="/" element={<div>home fr</div>} />
          <Route path="/en" element={<div>home en</div>} />
          <Route path="/tarifs" element={<div>pricing fr</div>} />
        </Route>
        <Route path="/station" element={<div>station</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

test('anonymous visitor sees the homepage', () => {
  vi.mocked(getToken).mockReturnValue(null)
  renderAt('/')
  expect(screen.getByText('home fr')).toBeInTheDocument()
})

test('authed visitor on the homepage is redirected to /station', () => {
  vi.mocked(getToken).mockReturnValue('tok')
  renderAt('/')
  expect(screen.getByText('station')).toBeInTheDocument()
})

test('authed visitor on a non-homepage public page is not redirected', () => {
  vi.mocked(getToken).mockReturnValue('tok')
  renderAt('/tarifs')
  expect(screen.getByText('pricing fr')).toBeInTheDocument()
})

test('renders the language toggle pointing at the route pair', () => {
  vi.mocked(getToken).mockReturnValue(null)
  renderAt('/tarifs')
  const toggle = screen.getByRole('link', { name: 'EN' })
  expect(toggle).toHaveAttribute('href', '/en/pricing')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix web test -- PublicLayout.test.tsx`
Expected: FAIL — `Failed to resolve import "./PublicLayout"`

- [ ] **Step 3: Write PublicNav**

```tsx
// web/src/components/public/PublicNav.tsx
import { Link, useLocation } from 'react-router-dom'
import Mark from './Mark'
import { ROUTE_PAIRS, useT, type Locale } from '../../i18n'

export default function PublicNav({ locale, authed }: { locale: Locale; authed: boolean }) {
  const t = useT(locale)
  const { pathname } = useLocation()
  const homePath = locale === 'fr' ? '/' : '/en'
  const pricingPath = locale === 'fr' ? '/tarifs' : '/en/pricing'
  const aboutPath = locale === 'fr' ? '/a-propos' : '/en/about'
  const otherLocalePath = ROUTE_PAIRS[pathname] ?? (locale === 'fr' ? '/en' : '/')

  return (
    <header className="border-b" style={{ borderColor: 'var(--color-border)', background: 'var(--color-paper)' }}>
      <nav
        className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4"
        aria-label={locale === 'fr' ? 'Navigation principale' : 'Main navigation'}
      >
        <Link to={homePath} className="flex items-center gap-2 font-semibold" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-ink)' }}>
          <Mark size={28} />
          Palimora
        </Link>
        <div className="flex items-center gap-6" style={{ fontFamily: 'var(--font-body)' }}>
          <Link to={pricingPath} style={{ color: 'var(--color-ink-soft)' }}>{t('common.nav.pricing')}</Link>
          <Link to={aboutPath} style={{ color: 'var(--color-ink-soft)' }}>{t('common.nav.about')}</Link>
          <Link
            to={otherLocalePath}
            aria-label={locale === 'fr' ? 'Switch to English' : 'Passer en français'}
            style={{ color: 'var(--color-ink-soft)' }}
          >
            {t('common.nav.lang_toggle')}
          </Link>
          <Link
            to={authed ? '/station' : '/register'}
            className="rounded-md px-4 py-2 font-medium"
            style={{
              background: 'var(--color-accent)',
              color: 'var(--color-accent-ink)',
              borderRadius: 'var(--radius-md)',
              transitionProperty: 'transform',
              transitionDuration: 'var(--dur-fast)',
              transitionTimingFunction: 'var(--ease-out)',
            }}
          >
            {authed ? t('common.nav.cta_open_app') : t('common.nav.cta_signup')}
          </Link>
        </div>
      </nav>
    </header>
  )
}
```

- [ ] **Step 4: Write PublicFooter**

```tsx
// web/src/components/public/PublicFooter.tsx
import { Link } from 'react-router-dom'
import { CONTACT_EMAIL, useT, type Locale } from '../../i18n'

export default function PublicFooter({ locale }: { locale: Locale }) {
  const t = useT(locale)
  const pricingPath = locale === 'fr' ? '/tarifs' : '/en/pricing'
  const aboutPath = locale === 'fr' ? '/a-propos' : '/en/about'
  const privacyPath = locale === 'fr' ? '/confidentialite' : '/en/privacy'
  const termsPath = locale === 'fr' ? '/cgu' : '/en/terms'

  return (
    <footer
      className="mt-24 border-t px-6 py-12"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-paper-2)', fontFamily: 'var(--font-body)' }}
    >
      <div className="mx-auto max-w-5xl">
        <p className="text-lg" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-ink)' }}>
          {t('common.footer.statement')}
        </p>
        <nav className="mt-6 flex flex-wrap gap-x-6 gap-y-2" style={{ color: 'var(--color-ink-soft)' }}>
          <Link to={pricingPath}>{t('common.footer.links.pricing')}</Link>
          <Link to={aboutPath}>{t('common.footer.links.about')}</Link>
          <Link to={privacyPath}>{t('common.footer.links.privacy')}</Link>
          <Link to={termsPath}>{t('common.footer.links.terms')}</Link>
          <a href={`mailto:${CONTACT_EMAIL}`}>{t('common.footer.links.contact')}</a>
        </nav>
        <p className="mt-8 text-sm" style={{ color: 'var(--color-ink-soft)' }}>{t('common.footer.copyright')}</p>
      </div>
    </footer>
  )
}
```

- [ ] **Step 5: Write PublicLayout**

```tsx
// web/src/components/public/PublicLayout.tsx
import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { getToken } from '../../api'
import { localeFromPath } from '../../i18n'
import PublicNav from './PublicNav'
import PublicFooter from './PublicFooter'

export default function PublicLayout() {
  const { pathname } = useLocation()
  const locale = localeFromPath(pathname)
  const [authed, setAuthed] = useState(false)

  // Client-only: prerendered HTML always renders the logged-out shell;
  // this runs after hydration only, so it never affects SSR output.
  useEffect(() => {
    setAuthed(!!getToken())
  }, [])

  const isHomepage = pathname === '/' || pathname === '/en'
  if (isHomepage && authed) {
    return <Navigate to="/station" replace />
  }

  return (
    <div style={{ background: 'var(--color-paper)', minHeight: '100%', fontFamily: 'var(--font-body)' }}>
      <PublicNav locale={locale} authed={authed} />
      <main>
        <Outlet />
      </main>
      <PublicFooter locale={locale} />
    </div>
  )
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm --prefix web test -- PublicLayout.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add web/src/components/public/PublicLayout.tsx web/src/components/public/PublicNav.tsx \
        web/src/components/public/PublicFooter.tsx web/src/components/public/PublicLayout.test.tsx
git commit -m "feat(web): PublicLayout shell — nav, footer, auth redirect, language toggle"
```

---

### Task 5: Homepage page component

**Files:**
- Create: `web/src/pages/public/Home.tsx`
- Test: `web/src/pages/public/Home.test.tsx`
- Create (captured by hand, see Step 4): `web/public/workbench-screenshot.png`

**Interfaces:**
- Consumes: `useT`, `localeFromPath` from `../../i18n`; `useLocation` from
  react-router-dom to derive locale (component takes no props — it's a
  route element, locale comes from the URL like `PublicLayout` does).
- Produces: default export `Home`, used by route wiring in Task 10.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/pages/public/Home.test.tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Home from './Home'

test('renders the french hero by default', () => {
  render(<MemoryRouter initialEntries={['/']}><Home /></MemoryRouter>)
  expect(screen.getByRole('heading', { level: 1, name: /manuscrits ont une histoire/i })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /100 pages offertes/i })).toHaveAttribute('href', '/register')
})

test('renders the english hero on /en', () => {
  render(<MemoryRouter initialEntries={['/en']}><Home /></MemoryRouter>)
  expect(screen.getByRole('heading', { level: 1, name: /story to tell/i })).toBeInTheDocument()
})

test('renders all three how-it-works steps', () => {
  render(<MemoryRouter initialEntries={['/']}><Home /></MemoryRouter>)
  expect(screen.getByText('Déposez')).toBeInTheDocument()
  expect(screen.getByText('Transcription')).toBeInTheDocument()
  expect(screen.getByText('Corrigez et exportez')).toBeInTheDocument()
})

test('renders the honest stat-slot label instead of a fabricated number', () => {
  render(<MemoryRouter initialEntries={['/']}><Home /></MemoryRouter>)
  expect(screen.getByText(/mesures publiées prochainement/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- pages/public/Home.test.tsx`
Expected: FAIL — `Failed to resolve import "./Home"`

- [ ] **Step 3: Write the component**

```tsx
// web/src/pages/public/Home.tsx
import { Link, useLocation } from 'react-router-dom'
import { localeFromPath, useT } from '../../i18n'

export default function Home() {
  const { pathname } = useLocation()
  const locale = localeFromPath(pathname)
  const t = useT(locale)
  const registerPath = '/register'
  const pricingPath = locale === 'fr' ? '/tarifs' : '/en/pricing'

  const steps = t<{ title: string; body: string }[]>('home.how.steps')
  const items = t<string[]>('home.capabilities.items')
  const faq = t<{ q: string; a: string }[]>('home.faq.items')

  return (
    <>
      <section className="mx-auto max-w-5xl px-6 pb-16 pt-20">
        <h1
          style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-display)', color: 'var(--color-ink)', overflowWrap: 'anywhere', minWidth: 0 }}
        >
          {t('home.hero.title')}
        </h1>
        <p className="mt-6 max-w-2xl" style={{ fontSize: 'var(--text-lg)', color: 'var(--color-ink-soft)' }}>
          {t('home.hero.subtitle')}
        </p>
        <div className="mt-8 flex flex-wrap gap-4">
          <Link
            to={registerPath}
            className="rounded-md px-6 py-3 font-medium"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)', borderRadius: 'var(--radius-md)' }}
          >
            {t('home.hero.cta_primary')}
          </Link>
          <a
            href="#comment-ca-marche"
            className="rounded-md px-6 py-3 font-medium"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-ink)', borderRadius: 'var(--radius-md)' }}
          >
            {t('home.hero.cta_secondary')}
          </a>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <figure style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          <img src="/workbench-screenshot.png" alt="" width={1200} height={750} style={{ display: 'block', width: '100%', height: 'auto' }} />
          <figcaption className="p-4 text-sm" style={{ color: 'var(--color-ink-soft)' }}>
            {t('home.workbench.caption')}
          </figcaption>
        </figure>
      </section>

      <section id="comment-ca-marche" className="mx-auto max-w-5xl px-6 pb-16">
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', color: 'var(--color-ink)' }}>
          {t('home.how.title')}
        </h2>
        <ol className="mt-8 grid gap-8 sm:grid-cols-3">
          {steps.map((step, i) => (
            <li key={step.title}>
              <span style={{ color: 'var(--color-accent)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>{`0${i + 1}`}</span>
              <h3 className="mt-2" style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', color: 'var(--color-ink)' }}>
                {step.title}
              </h3>
              <p className="mt-2" style={{ color: 'var(--color-ink-soft)' }}>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', color: 'var(--color-ink)' }}>
          {t('home.capabilities.title')}
        </h2>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <li key={item} style={{ color: 'var(--color-ink-soft)' }}>{item}</li>
          ))}
        </ul>
        <p className="mt-6 text-sm" style={{ color: 'var(--color-ink-soft)', fontStyle: 'italic' }}>
          {t('home.capabilities.stat_slot_label')}
        </p>
      </section>

      <section
        className="mx-auto max-w-5xl px-6 pb-16"
        style={{ background: 'var(--color-paper-2)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-8)' }}
      >
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', color: 'var(--color-ink)' }}>
          {t('home.pricing_teaser.title')}
        </h2>
        <p className="mt-2" style={{ color: 'var(--color-ink-soft)' }}>{t('home.pricing_teaser.body')}</p>
        <Link to={pricingPath} className="mt-4 inline-block font-medium" style={{ color: 'var(--color-accent)' }}>
          {t('home.pricing_teaser.cta')} →
        </Link>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', color: 'var(--color-ink)' }}>
          {t('home.faq.title')}
        </h2>
        <dl className="mt-6 space-y-6">
          {faq.map((item) => (
            <div key={item.q}>
              <dt style={{ fontWeight: 600, color: 'var(--color-ink)' }}>{item.q}</dt>
              <dd className="mt-1" style={{ color: 'var(--color-ink-soft)' }}>{item.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-24 text-center">
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', color: 'var(--color-ink)' }}>
          {t('home.closing.title')}
        </h2>
        <Link
          to={registerPath}
          className="mt-6 inline-block rounded-md px-6 py-3 font-medium"
          style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)', borderRadius: 'var(--radius-md)' }}
        >
          {t('home.closing.cta')}
        </Link>
      </section>
    </>
  )
}
```

- [ ] **Step 4: Capture the real Station screenshot**

This is a real asset, not a placeholder — do not skip it. With the app
running locally (`npm --prefix web run dev` and the API up), log into
`/station`, open a sample document with at least one segmented page, and
capture a browser screenshot of the workbench area at roughly 1200×750.
Crop out browser chrome. Save as `web/public/workbench-screenshot.png`. If
no sample document is available yet, use the emptiest realistic state
(upload panel + one page) rather than an invented mockup.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --prefix web test -- pages/public/Home.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/public/Home.tsx web/src/pages/public/Home.test.tsx web/public/workbench-screenshot.png
git commit -m "feat(web): homepage — Workbench macrostructure, FR/EN"
```

---

### Task 6: Pricing page component

**Files:**
- Create: `web/src/pages/public/Pricing.tsx`
- Test: `web/src/pages/public/Pricing.test.tsx`

**Interfaces:**
- Consumes: `api.billing.catalogue()` from `../../api` (existing,
  unauthenticated endpoint — verified in `app/billing.py:37`, no
  `Depends(get_current_user)`), returning `BillingCatalogue` (`packs`,
  `publishable_key`, `enabled`).
- Produces: default export `Pricing`.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/pages/public/Pricing.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import Pricing from './Pricing'

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api')
  return { ...actual, api: { ...actual.api, billing: { catalogue: vi.fn() } } }
})
import { api } from '../../api'

test('shows a loading state then the packs from the catalogue', async () => {
  vi.mocked(api.billing.catalogue).mockResolvedValue({
    packs: [
      { id: 'starter', kind: 'one_shot', credits: 300, amount_eur: 29, price_per_page: 0.0967, label: 'Starter', stripe_price_id: '' },
    ],
    publishable_key: '',
    enabled: true,
  })
  render(<MemoryRouter initialEntries={['/tarifs']}><Pricing /></MemoryRouter>)
  expect(screen.getByText('Chargement des tarifs…')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByText('Starter')).toBeInTheDocument())
  expect(screen.getByText(/300/)).toBeInTheDocument()
})

test('shows an error state if the catalogue fails to load', async () => {
  vi.mocked(api.billing.catalogue).mockRejectedValue(new Error('network'))
  render(<MemoryRouter initialEntries={['/tarifs']}><Pricing /></MemoryRouter>)
  await waitFor(() => expect(screen.getByText(/momentanément indisponibles/i)).toBeInTheDocument())
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- pages/public/Pricing.test.tsx`
Expected: FAIL — `Failed to resolve import "./Pricing"`

- [ ] **Step 3: Write the component**

```tsx
// web/src/pages/public/Pricing.tsx
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { api, BillingPack } from '../../api'
import { localeFromPath, useT } from '../../i18n'

export default function Pricing() {
  const { pathname } = useLocation()
  const locale = localeFromPath(pathname)
  const t = useT(locale)
  const [packs, setPacks] = useState<BillingPack[] | null>(null)
  const [error, setError] = useState(false)

  // Client-only fetch: prerendered HTML ships the static copy below plus
  // the loading state; live prices arrive after hydration.
  useEffect(() => {
    let cancelled = false
    api.billing
      .catalogue()
      .then((cat) => { if (!cancelled) setPacks(cat.packs) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [])

  const faq = t<{ q: string; a: string }[]>('pricing.faq.items')

  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-display-s)', color: 'var(--color-ink)' }}>
        {t('pricing.title')}
      </h1>
      <p className="mt-4 max-w-2xl" style={{ color: 'var(--color-ink-soft)' }}>{t('pricing.intro')}</p>

      <div className="mt-12">
        {error && <p style={{ color: 'var(--color-accent)' }}>{t('pricing.error')}</p>}
        {!error && !packs && <p style={{ color: 'var(--color-ink-soft)' }}>{t('pricing.loading')}</p>}
        {packs && (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {packs.map((pack) => (
              <li
                key={pack.id}
                style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-6)' }}
              >
                <p style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', color: 'var(--color-ink)' }}>{pack.label}</p>
                <p className="mt-2" style={{ fontSize: 'var(--text-2xl)', color: 'var(--color-ink)' }}>
                  {pack.amount_eur.toFixed(0)} €{pack.kind === 'subscription' ? '/mois' : ''}
                </p>
                <p className="mt-1 text-sm" style={{ color: 'var(--color-ink-soft)' }}>
                  {pack.credits} crédits · {pack.price_per_page.toFixed(3)} €/page
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <section className="mt-16" style={{ background: 'var(--color-paper-2)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-8)' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-xl)', color: 'var(--color-ink)' }}>
          {t('pricing.credits_explainer.title')}
        </h2>
        <p className="mt-2" style={{ color: 'var(--color-ink-soft)' }}>{t('pricing.credits_explainer.body')}</p>
      </section>

      <section className="mt-16">
        <dl className="space-y-6">
          {faq.map((item) => (
            <div key={item.q}>
              <dt style={{ fontWeight: 600, color: 'var(--color-ink)' }}>{item.q}</dt>
              <dd className="mt-1" style={{ color: 'var(--color-ink-soft)' }}>{item.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Link
        to="/register"
        className="mt-16 inline-block rounded-md px-6 py-3 font-medium"
        style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)', borderRadius: 'var(--radius-md)' }}
      >
        {t('pricing.cta')}
      </Link>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web test -- pages/public/Pricing.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/public/Pricing.tsx web/src/pages/public/Pricing.test.tsx
git commit -m "feat(web): pricing page — live packs from the billing catalogue"
```

---

### Task 7: About page component

**Files:**
- Create: `web/src/pages/public/About.tsx`
- Test: `web/src/pages/public/About.test.tsx`

**Interfaces:**
- Consumes: `useT`, `localeFromPath`, `CONTACT_EMAIL` from `../../i18n`.
- Produces: default export `About`.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/pages/public/About.test.tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import About from './About'

test('renders the about copy and a mailto contact link', () => {
  render(<MemoryRouter initialEntries={['/a-propos']}><About /></MemoryRouter>)
  expect(screen.getByRole('heading', { level: 1, name: 'Pourquoi Palimora' })).toBeInTheDocument()
  const link = screen.getByRole('link', { name: /contact@palimora\.fr/ })
  expect(link).toHaveAttribute('href', 'mailto:contact@palimora.fr')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- pages/public/About.test.tsx`
Expected: FAIL — `Failed to resolve import "./About"`

- [ ] **Step 3: Write the component**

```tsx
// web/src/pages/public/About.tsx
import { useLocation } from 'react-router-dom'
import { CONTACT_EMAIL, localeFromPath, useT } from '../../i18n'

export default function About() {
  const { pathname } = useLocation()
  const locale = localeFromPath(pathname)
  const t = useT(locale)
  const paragraphs = t<string[]>('about.paragraphs')

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-display-s)', color: 'var(--color-ink)' }}>
        {t('about.title')}
      </h1>
      <div className="mt-8 space-y-5" style={{ fontSize: 'var(--text-lg)', color: 'var(--color-ink-soft)' }}>
        {paragraphs.map((p) => <p key={p}>{p}</p>)}
      </div>
      <section className="mt-16">
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-xl)', color: 'var(--color-ink)' }}>
          {t('about.contact_title')}
        </h2>
        <p className="mt-2" style={{ color: 'var(--color-ink-soft)' }}>
          {t('about.contact_body')}{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: 'var(--color-accent)' }}>{CONTACT_EMAIL}</a>
        </p>
      </section>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web test -- pages/public/About.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/public/About.tsx web/src/pages/public/About.test.tsx
git commit -m "feat(web): about page — letter voice, mailto contact"
```

---

### Task 8: Legal pages (Privacy, Terms)

**Files:**
- Create: `web/src/pages/public/LegalPage.tsx`
- Create: `web/src/pages/public/Privacy.tsx`
- Create: `web/src/pages/public/Terms.tsx`
- Test: `web/src/pages/public/LegalPage.test.tsx`

**Interfaces:**
- Consumes: `useT`, `localeFromPath` from `../../i18n`.
- Produces: `LegalPage` takes `{ namespace: 'privacy' | 'terms' }` and
  renders `<namespace>.title`, `<namespace>.intro`,
  `<namespace>.sections[]`; `Privacy` and `Terms` are thin wrappers so the
  router has two distinct default exports.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/pages/public/LegalPage.test.tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LegalPage from './LegalPage'

test('renders every section heading for the given namespace', () => {
  render(
    <MemoryRouter initialEntries={['/confidentialite']}>
      <LegalPage namespace="privacy" />
    </MemoryRouter>,
  )
  expect(screen.getByRole('heading', { level: 1, name: 'Politique de confidentialité' })).toBeInTheDocument()
  expect(screen.getByText('Responsable du traitement')).toBeInTheDocument()
  expect(screen.getByText('Vos droits')).toBeInTheDocument()
})

test('renders the terms namespace on the same component', () => {
  render(
    <MemoryRouter initialEntries={['/cgu']}>
      <LegalPage namespace="terms" />
    </MemoryRouter>,
  )
  expect(screen.getByRole('heading', { level: 1, name: 'Conditions générales d’utilisation' })).toBeInTheDocument()
  expect(screen.getByText('Droit applicable')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- pages/public/LegalPage.test.tsx`
Expected: FAIL — `Failed to resolve import "./LegalPage"`

- [ ] **Step 3: Write the components**

```tsx
// web/src/pages/public/LegalPage.tsx
import { useLocation } from 'react-router-dom'
import { localeFromPath, useT } from '../../i18n'

export default function LegalPage({ namespace }: { namespace: 'privacy' | 'terms' }) {
  const { pathname } = useLocation()
  const locale = localeFromPath(pathname)
  const t = useT(locale)
  const sections = t<{ heading: string; body: string }[]>(`${namespace}.sections`)

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-display-s)', color: 'var(--color-ink)' }}>
        {t(`${namespace}.title`)}
      </h1>
      <p className="mt-4 text-sm italic" style={{ color: 'var(--color-ink-soft)' }}>{t(`${namespace}.intro`)}</p>
      <div className="mt-10 space-y-8">
        {sections.map((s) => (
          <section key={s.heading}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', color: 'var(--color-ink)' }}>{s.heading}</h2>
            <p className="mt-2" style={{ color: 'var(--color-ink-soft)' }}>{s.body}</p>
          </section>
        ))}
      </div>
    </div>
  )
}
```

```tsx
// web/src/pages/public/Privacy.tsx
import LegalPage from './LegalPage'
export default function Privacy() { return <LegalPage namespace="privacy" /> }
```

```tsx
// web/src/pages/public/Terms.tsx
import LegalPage from './LegalPage'
export default function Terms() { return <LegalPage namespace="terms" /> }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web test -- pages/public/LegalPage.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/public/LegalPage.tsx web/src/pages/public/LegalPage.test.tsx \
        web/src/pages/public/Privacy.tsx web/src/pages/public/Terms.tsx
git commit -m "feat(web): privacy + terms pages — structured legal skeleton, FR/EN"
```

---

### Task 9: Route wiring — Station moves, public routes registered

**Files:**
- Modify: `web/src/main.tsx`
- Test: `web/src/main.test.tsx`

**Interfaces:**
- Consumes: `PublicLayout` (Task 4), `Home`/`Pricing`/`About`/`Privacy`/`Terms`
  (Tasks 5-8), existing `Station`/`Admin`/`Billing`/`Login`/`Register`.
- Produces: the final route table other tasks (prerender manifest) read
  from — the path list in the table below is the source of truth.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/main.test.tsx
// Route-table smoke test: renders the same tree main.tsx builds, at a
// couple of key paths, without touching the DOM entry point.
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'

vi.mock('./api', () => ({ getToken: vi.fn(() => null) }))

import PublicLayout from './components/public/PublicLayout'
import Home from './pages/public/Home'
import Pricing from './pages/public/Pricing'

function Tree({ initialPath }: { initialPath: string }) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/en" element={<Home />} />
          <Route path="/tarifs" element={<Pricing />} />
        </Route>
        <Route path="/station" element={<div>station</div>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </MemoryRouter>
  )
}

test('root path renders the homepage', () => {
  render(<Tree initialPath="/" />)
  expect(screen.getByRole('heading', { level: 1, name: /manuscrits ont une histoire/i })).toBeInTheDocument()
})

test('unknown path falls back to the homepage', () => {
  render(<Tree initialPath="/nope" />)
  expect(screen.getByRole('heading', { level: 1, name: /manuscrits ont une histoire/i })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- main.test.tsx`
Expected: FAIL — `Cannot find module './components/public/PublicLayout'` only
if Task 4/5 weren't run first; if they were, this test should already pass
since it doesn't import `main.tsx` itself. If it fails for an unrelated
reason, fix before continuing — this test is the contract for Step 3.

- [ ] **Step 3: Rewrite `main.tsx`**

```tsx
// web/src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { getToken } from './api'
import ImpersonationBanner from './components/ImpersonationBanner'
import PublicLayout from './components/public/PublicLayout'
import Home from './pages/public/Home'
import Pricing from './pages/public/Pricing'
import About from './pages/public/About'
import Privacy from './pages/public/Privacy'
import Terms from './pages/public/Terms'
import Admin from './pages/Admin'
import Billing from './pages/Billing'
import Login from './pages/Login'
import Register from './pages/Register'
import Station from './pages/Station'
import './index.css'

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/en" element={<Home />} />
        <Route path="/tarifs" element={<Pricing />} />
        <Route path="/en/pricing" element={<Pricing />} />
        <Route path="/a-propos" element={<About />} />
        <Route path="/en/about" element={<About />} />
        <Route path="/confidentialite" element={<Privacy />} />
        <Route path="/en/privacy" element={<Privacy />} />
        <Route path="/cgu" element={<Terms />} />
        <Route path="/en/terms" element={<Terms />} />
      </Route>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/station" element={<RequireAuth><Station /></RequireAuth>} />
      <Route path="/admin" element={<RequireAuth><Admin /></RequireAuth>} />
      <Route path="/billing" element={<RequireAuth><Billing /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

const rootEl = document.getElementById('root')!
const app = (
  <React.StrictMode>
    <BrowserRouter>
      <ImpersonationBanner />
      <AppRoutes />
    </BrowserRouter>
  </React.StrictMode>
)

// Prerendered public pages ship real markup in #root; hydrate instead of
// clobbering it. App-only paths (no prerendered file) have an empty #root
// and get a normal client render.
if (rootEl.hasChildNodes()) {
  ReactDOM.hydrateRoot(rootEl, app)
} else {
  ReactDOM.createRoot(rootEl).render(app)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web test -- main.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full test suite to confirm nothing existing broke**

Run: `npm --prefix web test`
Expected: PASS — all suites, including the pre-existing
`Admin.impersonation.test.tsx`, `Admin.ocr.test.tsx`, `Billing.test.tsx`,
`PromptModal.test.tsx`, `ImpersonationBanner.test.tsx`, `api.*.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add web/src/main.tsx web/src/main.test.tsx
git commit -m "feat(web): wire public routes; Station moves from / to /station; hydrate on prerendered root"
```

---

### Task 10: Prerender script

**Files:**
- Create: `web/scripts/prerender.mjs`
- Create: `web/scripts/prerender.smoke.test.mjs`
- Modify: `web/package.json` (`build` script)

**Interfaces:**
- Consumes: the route table from Task 9 (duplicated here as a manifest —
  see the note in Step 3 about keeping them in sync); `Home`, `Pricing`,
  `About`, `Privacy`, `Terms`, `PublicLayout` compiled output.
- Produces: `dist/index.html`, `dist/en/index.html`, `dist/tarifs/index.html`,
  `dist/en/pricing/index.html`, `dist/a-propos/index.html`,
  `dist/en/about/index.html`, `dist/confidentialite/index.html`,
  `dist/en/privacy/index.html`, `dist/cgu/index.html`,
  `dist/en/terms/index.html`, `dist/sitemap.xml`, `dist/robots.txt`.

- [ ] **Step 1: Write the failing smoke test**

This test runs against a real build, so it's written first per TDD intent
but only turns green after Step 3's script exists *and* a build has run —
Step 4 below is "run the build", not "run the test standalone".

```js
// web/scripts/prerender.smoke.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const expected = [
  ['index.html', 'Vos manuscrits ont une histoire'],
  ['en/index.html', 'story to tell'],
  ['tarifs/index.html', 'tarifs simples'],
  ['en/pricing/index.html', 'Simple, per-page'],
  ['a-propos/index.html', 'Pourquoi Palimora'],
  ['en/about/index.html', 'Why Palimora'],
  ['confidentialite/index.html', 'Politique de confidentialité'],
  ['en/privacy/index.html', 'Privacy policy'],
  ['cgu/index.html', 'Conditions générales'],
  ['en/terms/index.html', 'Terms of service'],
]

for (const [file, needle] of expected) {
  test(`dist/${file} exists and contains its content`, () => {
    const full = path.join(dist, file)
    assert.ok(existsSync(full), `${full} missing — run the build first`)
    const html = readFileSync(full, 'utf-8')
    assert.match(html, /<div id="root">.+<\/div>/s, `${file} has an empty #root`)
    assert.ok(html.includes(needle), `${file} missing expected content "${needle}"`)
  })
}

test('sitemap.xml lists all ten public URLs', () => {
  const sitemap = readFileSync(path.join(dist, 'sitemap.xml'), 'utf-8')
  for (const [file] of expected) {
    const route = '/' + file.replace(/index\.html$/, '').replace(/\/$/, '')
    assert.ok(sitemap.includes(route === '/' ? 'home.palimora.pays.fr.eu.org/<' : route), `sitemap missing ${route}`)
  }
})
```

- [ ] **Step 2: Confirm it fails for the right reason**

Run: `node --test web/scripts/prerender.smoke.test.mjs`
Expected: FAIL — `dist/index.html` missing (no build has produced
prerendered output yet; the plain `vite build` output has an empty
`#root`, which also fails the `<div id="root">.+</div>` assertion).

- [ ] **Step 3: Write the prerender script**

Plain Node ESM cannot parse `.tsx` (JSX) files directly — the script needs
to run through Vite's own transform pipeline so it shares the project's
`tsconfig`/JSX settings. Install `vite-node` for this:

```bash
npm --prefix web install -D vite-node
```

```js
// web/scripts/prerender.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import React from 'react'

const root = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(root, '..', 'dist')

const { default: PublicLayout } = await import('../src/components/public/PublicLayout.tsx')
const { default: Home } = await import('../src/pages/public/Home.tsx')
const { default: Pricing } = await import('../src/pages/public/Pricing.tsx')
const { default: About } = await import('../src/pages/public/About.tsx')
const { default: Privacy } = await import('../src/pages/public/Privacy.tsx')
const { default: Terms } = await import('../src/pages/public/Terms.tsx')

const SITE_URL = 'https://home.palimora.pays.fr.eu.org'

// Keep this manifest's paths in sync with web/src/main.tsx's <Route> list —
// both are the same route table, one for the browser router, one for build-time
// static rendering.
const routes = [
  { path: '/', file: 'index.html', lang: 'fr', Page: Home, title: 'Palimora — Transcription de manuscrits et documents anciens', description: 'Palimora transcrit vos documents manuscrits et imprimés anciens. 100 pages offertes à l’inscription.' },
  { path: '/en', file: 'en/index.html', lang: 'en', Page: Home, title: 'Palimora — Manuscript and historical document transcription', description: 'Palimora transcribes handwritten and historical printed documents. 100 free pages on signup.' },
  { path: '/tarifs', file: 'tarifs/index.html', lang: 'fr', Page: Pricing, title: 'Tarifs — Palimora', description: '1 crédit Palimora = 1 page transcrite. Des tarifs simples, à la page.' },
  { path: '/en/pricing', file: 'en/pricing/index.html', lang: 'en', Page: Pricing, title: 'Pricing — Palimora', description: '1 Palimora credit = 1 transcribed page. Simple, per-page pricing.' },
  { path: '/a-propos', file: 'a-propos/index.html', lang: 'fr', Page: About, title: 'À propos — Palimora', description: 'Pourquoi Palimora existe, et comment nous contacter.' },
  { path: '/en/about', file: 'en/about/index.html', lang: 'en', Page: About, title: 'About — Palimora', description: 'Why Palimora exists, and how to reach us.' },
  { path: '/confidentialite', file: 'confidentialite/index.html', lang: 'fr', Page: Privacy, title: 'Confidentialité — Palimora', description: 'Politique de confidentialité de Palimora.' },
  { path: '/en/privacy', file: 'en/privacy/index.html', lang: 'en', Page: Privacy, title: 'Privacy — Palimora', description: "Palimora's privacy policy." },
  { path: '/cgu', file: 'cgu/index.html', lang: 'fr', Page: Terms, title: 'CGU — Palimora', description: "Conditions générales d'utilisation de Palimora." },
  { path: '/en/terms', file: 'en/terms/index.html', lang: 'en', Page: Terms, title: 'Terms — Palimora', description: "Palimora's terms of service." },
]

const template = readFileSync(path.join(distDir, 'index.html'), 'utf-8')

function pageHtml({ path: routePath, lang, Page, title, description }) {
  const markup = renderToString(
    React.createElement(
      StaticRouter,
      { location: routePath },
      React.createElement(PublicLayout, null, React.createElement(Page, null)),
    ),
  )
  const canonical = `${SITE_URL}${routePath === '/' ? '' : routePath}`
  let html = template
    .replace(/<html lang="[^"]*"/, `<html lang="${lang}"`)
    .replace(/<title>.*<\/title>/, `<title>${title}</title>`)
    .replace(
      '</head>',
      `  <meta name="description" content="${description}" />\n` +
      `  <link rel="canonical" href="${canonical}" />\n` +
      `  <meta property="og:title" content="${title}" />\n` +
      `  <meta property="og:description" content="${description}" />\n` +
      `  <meta property="og:image" content="${SITE_URL}/og.png" />\n` +
      `  <meta property="og:url" content="${canonical}" />\n` +
      `  </head>`,
    )
    .replace('<div id="root"></div>', `<div id="root">${markup}</div>`)
  return html
}

for (const route of routes) {
  const html = pageHtml(route)
  const outPath = path.join(distDir, route.file)
  mkdirSync(path.dirname(outPath), { recursive: true })
  writeFileSync(outPath, html)
  console.log(`prerendered ${route.file}`)
}

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${routes.map((r) => `  <url><loc>${SITE_URL}${r.path === '/' ? '/' : r.path}</loc></url>`).join('\n')}
</urlset>
`
writeFileSync(path.join(distDir, 'sitemap.xml'), sitemap)
writeFileSync(path.join(distDir, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`)
console.log('wrote sitemap.xml and robots.txt')
```

`PublicLayout` currently only accepts route-outlet children via `<Outlet/>`
— confirm at this step that it also works when given an explicit
`children` prop for the static-render case, or adjust `PublicLayout` to
render `children ?? <Outlet/>`:

```tsx
// web/src/components/public/PublicLayout.tsx — replace the export signature
export default function PublicLayout({ children }: { children?: React.ReactNode } = {}) {
  // ...unchanged body...
  return (
    <div style={{ background: 'var(--color-paper)', minHeight: '100%', fontFamily: 'var(--font-body)' }}>
      <PublicNav locale={locale} authed={authed} />
      <main>{children ?? <Outlet />}</main>
      <PublicFooter locale={locale} />
    </div>
  )
}
```

- [ ] **Step 4: Wire the build script**

In `web/package.json`, change the `build` script to run the prerender step
through `vite-node` (not plain `node`) so it can import `.tsx` files:

```json
"build": "tsc -b && vite build && vite-node scripts/prerender.mjs",
```

- [ ] **Step 5: Run the build and the smoke test**

Run: `npm --prefix web run build && node --test web/scripts/prerender.smoke.test.mjs`
Expected: build succeeds, prerender script logs 10 files + sitemap/robots,
smoke test PASS (11 tests). The smoke test itself stays plain Node (it only
reads the already-built `dist/*.html` files as text, no JSX involved).

- [ ] **Step 6: Commit**

```bash
git add web/scripts/prerender.mjs web/scripts/prerender.smoke.test.mjs \
        web/package.json web/package-lock.json web/src/components/public/PublicLayout.tsx
git commit -m "feat(web): prerender public routes to static HTML with per-page meta + sitemap"
```

---

### Task 11: Server — serve prerendered directories

**Files:**
- Modify: `app/main.py:1280-1290` (the `spa()` handler)
- Test: `tests/test_public_prerender.py`

**Interfaces:**
- Consumes: `STATIC_DIR` (already defined at `app/main.py:1281`).
- Produces: no new interface — behavioral change to the existing
  catch-all route.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_public_prerender.py
import os

from fastapi.testclient import TestClient

from app.main import app, STATIC_DIR


def _write(rel_path: str, content: str) -> None:
    full = os.path.join(STATIC_DIR, rel_path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(content)


def test_serves_prerendered_directory_index(tmp_path, monkeypatch):
    _write("tarifs/index.html", "<html><body>tarifs prerendered</body></html>")
    client = TestClient(app)
    resp = client.get("/tarifs")
    assert resp.status_code == 200
    assert "tarifs prerendered" in resp.text


def test_serves_prerendered_nested_locale_directory(tmp_path, monkeypatch):
    _write("en/pricing/index.html", "<html><body>pricing prerendered</body></html>")
    client = TestClient(app)
    resp = client.get("/en/pricing")
    assert resp.status_code == 200
    assert "pricing prerendered" in resp.text


def test_falls_back_to_root_index_for_unknown_path(tmp_path, monkeypatch):
    client = TestClient(app)
    resp = client.get("/some/unknown/spa/path")
    assert resp.status_code == 200
    # root index.html is whatever the build produced — just confirm it's not 404
    assert resp.status_code != 404
```

This test writes real files under the app's `STATIC_DIR` for the duration
of the test process — acceptable for this repo's existing test style
(`tests/` already runs against a built `app/static` in CI-adjacent setups);
if `STATIC_DIR` doesn't exist yet in your local checkout (no `web` build
has been run), run `npm --prefix web run build` first so `app/static/`
exists before running pytest.

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_public_prerender.py -v`
Expected: FAIL on the first two tests — `/tarifs` and `/en/pricing`
currently fall through to the generic `index.html`, not the file just
written, so `"tarifs prerendered" in resp.text` is False.

- [ ] **Step 3: Modify `spa()`**

At `app/main.py:1280`, replace the existing block:

```python
# ---------------------------------------------------------------- static SPA
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(STATIC_DIR) and os.path.exists(os.path.join(STATIC_DIR, "index.html")):
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        target = os.path.join(STATIC_DIR, full_path)
        if full_path and os.path.isfile(target):
            return FileResponse(target)
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))
```

with:

```python
# ---------------------------------------------------------------- static SPA
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(STATIC_DIR) and os.path.exists(os.path.join(STATIC_DIR, "index.html")):
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        target = os.path.join(STATIC_DIR, full_path)
        if full_path and os.path.isfile(target):
            return FileResponse(target)
        # Prerendered public pages (Plan D): a directory named after the
        # route holding its own index.html, e.g. static/tarifs/index.html
        # for /tarifs, static/en/pricing/index.html for /en/pricing.
        prerendered = os.path.join(STATIC_DIR, full_path, "index.html")
        if full_path and os.path.isfile(prerendered):
            return FileResponse(prerendered)
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_public_prerender.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the full backend test suite to confirm nothing broke**

Run: `pytest -q`
Expected: PASS — all existing suites unaffected (this change only adds a
branch that previously fell through to the same fallback).

- [ ] **Step 6: Commit**

```bash
git add app/main.py tests/test_public_prerender.py
git commit -m "feat(server): serve prerendered public-page directories from the SPA catch-all"
```

---

### Task 12: End-to-end verification

**Files:** none created — this task runs the full pipeline once, by hand,
and fixes anything it finds. No new commit unless a fix is needed.

- [ ] **Step 1: Full clean build**

```bash
rm -rf web/dist
npm --prefix web run build
node --test web/scripts/prerender.smoke.test.mjs
```

Expected: build succeeds, all 11 smoke-test assertions pass.

- [ ] **Step 2: Full test suites**

```bash
npm --prefix web test
pytest -q
```

Expected: both green.

- [ ] **Step 3: Manual serve check**

```bash
cp -r web/dist app/static
uvicorn app.main:app --port 8000 &
curl -s http://localhost:8000/ | grep -o '<title>[^<]*</title>'
curl -s http://localhost:8000/en | grep -o '<title>[^<]*</title>'
curl -s http://localhost:8000/tarifs | grep -o '<title>[^<]*</title>'
curl -s http://localhost:8000/nonexistent-path | grep -o '<title>[^<]*</title>'
kill %1
```

Expected: each of `/`, `/en`, `/tarifs` returns its own distinct `<title>`;
`/nonexistent-path` falls back to the app-shell title (Station's), since
it isn't a public route.

- [ ] **Step 4: Mobile + slop-test pass**

Open the built homepage in a browser at 320px, 375px, 414px, and 768px
widths (devtools responsive mode). Confirm: no horizontal scroll, no
two-line CTA buttons, the hero headline wraps inside long words, the
"how it works" 3-column grid collapses to one column on mobile, the
pricing card grid uses `minmax(0, 1fr)` tracks (already satisfied by the
`sm:grid-cols-2 lg:grid-cols-4` Tailwind classes in `Pricing.tsx`, which
default to `1fr` per column — if a horizontal scroll appears at 320px on
the pricing cards, change the grid to explicit
`grid-template-columns: repeat(auto-fit, minmax(0, 1fr))` inline style
instead of the Tailwind class).

Run the Hallmark slop test (58 gates) against the built homepage; fix any
failures found before considering Plan D done.

- [ ] **Step 5: Update the README**

Add a short section to `README.md` alongside the existing Stripe (Phase D1)
note, documenting the public homepage and the interim domain:

```markdown
## Public homepage (Plan D)

Public marketing pages (`/`, `/tarifs`, `/a-propos`, `/confidentialite`,
`/cgu` and their `/en/...` counterparts) are prerendered at build time —
see `web/scripts/prerender.mjs`. Interim domain:
`https://home.palimora.pays.fr.eu.org` (set as a Coolify domain alias on
the existing app; will move to `https://palimora.fr` once registered).
Design spec: `docs/superpowers/specs/2026-09-04-d-homepage-design.md`.
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: note the public homepage (Plan D) and interim domain in the README"
```
