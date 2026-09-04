// web/scripts/prerender.mjs
//
// Run via `vite-node --options.deps.external="/react-router|@remix-run\/router/" scripts/prerender.mjs`
// (see the `build` script in package.json), not plain `vite-node scripts/prerender.mjs`.
// react-router-dom/react-router/@remix-run/router each ship a CJS ("main")
// build and a separate ESM ("module") build. Without the flag above,
// vite-node's own resolver loads the "module" build for bare imports inside
// transformed .tsx files (e.g. useLocation() in a page component) while
// react-router-dom/server's internal `require()` calls load the "main"
// build — two distinct module instances with two distinct React Context
// objects, so useLocation() never sees the Provider StaticRouter sets up
// and throws "useLocation() may be used only in the context of a <Router>
// component." Forcing these packages external makes every import resolve
// through Node's own require cache instead, so there's only ever one copy.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import React from 'react'
import { ROUTE_PAIRS } from '../src/i18n/index.ts'

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

// Preserve the pristine Vite-built shell (empty #root, no prerendered
// markup) as app.html before the loop below overwrites index.html with
// the "/" route's rendered output. app/main.py's spa() catch-all serves
// app.html for every app-only path (/station, /login, /admin, …) so those
// pages get a clean client-side render instead of inheriting the
// homepage's markup, <title>, and meta tags.
writeFileSync(path.join(distDir, 'app.html'), template)

function pageHtml({ path: routePath, lang, Page, title, description }) {
  const markup = renderToString(
    React.createElement(
      StaticRouter,
      { location: routePath },
      React.createElement(PublicLayout, null, React.createElement(Page, null)),
    ),
  )
  const toUrl = (p) => `${SITE_URL}${p === '/' ? '' : p}`
  const canonical = toUrl(routePath)
  const otherPath = ROUTE_PAIRS[routePath]
  const frHref = lang === 'fr' ? canonical : toUrl(otherPath)
  const enHref = lang === 'en' ? canonical : toUrl(otherPath)
  let html = template
    .replace(/<html lang="[^"]*"/, `<html lang="${lang}"`)
    .replace(/<title>.*<\/title>/, `<title>${title}</title>`)
    .replace(
      '</head>',
      `  <meta name="description" content="${description}" />\n` +
      `  <link rel="canonical" href="${canonical}" />\n` +
      `  <link rel="alternate" hreflang="fr" href="${frHref}" />\n` +
      `  <link rel="alternate" hreflang="en" href="${enHref}" />\n` +
      `  <meta property="og:title" content="${title}" />\n` +
      `  <meta property="og:description" content="${description}" />\n` +
      `  <meta property="og:image" content="${SITE_URL}/og.png" />\n` +
      `  <meta property="og:url" content="${canonical}" />\n` +
      `  </head>`,
    )
    .replace('<div id="root"></div>', `<div id="root" data-prerendered-path="${routePath}">${markup}</div>`)
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
