/**
 * Render the launcher icon set from one inline SVG — no image editor needed.
 *
 * The mark is a chat bubble holding a terminal prompt: the app is a conversation
 * with a shell. Geometry only, so it stays font-free and rasterizes identically
 * wherever it runs.
 *
 * Usage: node make-icon.mjs   (writes into ../res)
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const res = path.resolve(here, '..', 'res')

const DSH_HOME = process.env.DSH_DIR ?? '/data/data/com.termux/files/home/dsh'
const require = createRequire(path.join(DSH_HOME, 'package.json'))
const sharp = require('sharp')

const ACCENT = '#4D6BFE'
const ACCENT_LIGHT = '#8FA8FF'
const INK = '#0B0B0F'

/** The mark, drawn in a 100x100 box so it can be rescaled freely. */
const GLYPH = `
  <g fill="none" stroke="url(#accent)" stroke-width="9"
     stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="15" width="82" height="64" rx="19" />
    <path d="M31 39 L45 50 L31 61" />
    <path d="M54 61 L71 61" />
  </g>`

const defs = `
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${ACCENT_LIGHT}" />
      <stop offset="1" stop-color="${ACCENT}" />
    </linearGradient>
  </defs>`

/** Adaptive foreground: 108x108 viewport, glyph kept inside the 72dp safe circle. */
function foregroundSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
    ${defs}
    <g transform="translate(24 24) scale(0.60)">${GLYPH}</g>
  </svg>`
}

/** Legacy / fallback icon: full-bleed rounded square with the same mark. */
function legacySvg() {
  const scale = 2.9
  const offset = (512 - 100 * scale) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    ${defs}
    <rect x="0" y="0" width="512" height="512" rx="112" fill="${INK}" />
    <g transform="translate(${offset} ${offset}) scale(${scale})">${GLYPH}</g>
  </svg>`
}

const targets = [
  { density: 'mdpi', legacy: 48, adaptive: 108 },
  { density: 'hdpi', legacy: 72, adaptive: 162 },
  { density: 'xhdpi', legacy: 96, adaptive: 216 },
  { density: 'xxhdpi', legacy: 144, adaptive: 324 },
  { density: 'xxxhdpi', legacy: 192, adaptive: 432 },
]

const foreground = Buffer.from(foregroundSvg())
const legacy = Buffer.from(legacySvg())

for (const target of targets) {
  const dir = path.join(res, `mipmap-${target.density}`)
  fs.mkdirSync(dir, { recursive: true })
  await sharp(legacy).resize(target.legacy, target.legacy).png().toFile(
    path.join(dir, 'ic_launcher.png'))
  await sharp(foreground).resize(target.adaptive, target.adaptive).png().toFile(
    path.join(dir, 'ic_launcher_foreground.png'))
  console.log(`wrote mipmap-${target.density}`)
}

// Preview at a readable size, so the result can be eyeballed without installing.
await sharp(legacy).resize(256, 256).png().toFile(path.join(here, 'icon-preview.png'))
console.log('wrote tools/icon-preview.png')
