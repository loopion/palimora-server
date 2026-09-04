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
