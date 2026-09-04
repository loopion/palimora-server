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
    // Scope to the <main> element specifically — not the whole document —
    // so this can't pass on nav/footer boilerplate or a needle that also
    // happens to appear in <meta name="description">.
    const mainMatch = html.match(/<main>([\s\S]*?)<\/main>/)
    assert.ok(mainMatch, `${file} has no <main> element`)
    const mainContent = mainMatch[1].trim()
    assert.notEqual(mainContent, '', `${file} has an empty <main>`)
    assert.ok(mainContent.includes(needle), `${file} <main> missing expected content "${needle}"`)
  })
}

test('sitemap.xml lists all ten public URLs', () => {
  const sitemap = readFileSync(path.join(dist, 'sitemap.xml'), 'utf-8')
  for (const [file] of expected) {
    const route = '/' + file.replace(/index\.html$/, '').replace(/\/$/, '')
    assert.ok(sitemap.includes(route === '/' ? 'home.palimora.pays.fr.eu.org/<' : route), `sitemap missing ${route}`)
  }
})
