// Live integration test for the INSTALLED PhoneUse plugin module.
//
// Same idea as smoke.mjs, but with a REAL shell: it loads the module that the
// preset actually mounts, hands it a stub ctx whose `shell` runs real bash, and
// drives the phone through the tools themselves. So the code under test is the
// installed artifact, not a re-typed copy.
//
// `fs` is real file IO and `attachments` is a stub (there is no attachment store
// outside the harness), which is enough to exercise screencap + downscale.
//
// Usage: node live-test.mjs [path/to/plugin/index.js]

import { execSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const BASH = '/data/data/com.termux/files/usr/bin/bash'
const target = resolve(process.argv[2] ?? '/data/data/com.termux/files/home/.dsh/.agent-presets/phone-use/plugin/index.js')

const results = []
function check(label, ok, detail) {
  results.push({ label, ok })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail === undefined ? '' : '  — ' + detail))
}

function runShell(spec) {
  try {
    const text = execSync(spec.command, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: spec.timeoutMs ?? 60000,
      shell: BASH,
    })
    return { exitCode: 0, timedOut: false, aborted: false, stdout: { text }, stderr: { text: '' } }
  } catch (error) {
    return {
      exitCode: typeof error.status === 'number' ? error.status : 1,
      timedOut: false,
      aborted: false,
      stdout: { text: String(error.stdout ?? '') },
      stderr: { text: String(error.stderr ?? error.message) },
    }
  }
}

const shellService = {
  resolve(request) {
    return { command: request.command, timeoutMs: request.timeoutMs, stdoutMaxBytes: request.stdoutMaxBytes }
  },
  run(spec) {
    return Promise.resolve(runShell(spec))
  },
}

const fsService = {
  resolve(path) {
    return Promise.resolve({ displayPath: path, raw: path })
  },
  readBytes(handle) {
    return Promise.resolve(readFileSync(handle.raw))
  },
}

let savedImage = null
const attachmentsService = {
  imageLimits: {
    maxImageBytes: 64 * 1024 * 1024,
    maxMessageImageBytes: 64 * 1024 * 1024,
    maxImageDimension: 20000,
    maxImagePixels: 1000000000,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  },
  saveImage(input) {
    savedImage = { mediaType: input.mediaType, bytes: input.data.length, name: input.name }
    return Promise.resolve({ attachmentId: 'stub-attachment', mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1, name: input.name })
  },
}

const tools = new Map()
const ctx = {
  tools: { register(definition) { tools.set(String(definition.name), definition) } },
  on() {},
  get(name) {
    if (name === 'shell') return shellService
    if (name === 'fs') return fsService
    if (name === 'attachments') return attachmentsService
    return undefined
  },
}

const mod = await import(pathToFileURL(target).href)
mod.apply(ctx)
console.log('module: ' + target)
console.log('tools:  ' + [...tools.keys()].join(', ') + '\n')

const exec = { signal: undefined }
const call = (name, args) => tools.get(name).execute(args ?? {}, exec)

// ── 1. status ───────────────────────────────────────────────────────────────
const status = await call('phone_status')
check('phone_status connected', status.connected === true, 'model=' + String(status.model) + ' screen=' + String(status.screen) + ' foreground=' + String(status.foreground).slice(0, 40))

// ── 2. ui ───────────────────────────────────────────────────────────────────
const uiBefore = await call('phone_ui', { limit: 8 })
check('phone_ui lists elements', /elements: [1-9]/.test(uiBefore), String(uiBefore).split('\n')[2])

// ── 3. app start ────────────────────────────────────────────────────────────
const started = await call('phone_app', { action: 'start', target: 'com.android.settings' })
check('phone_app start', started.ok === true)

// ── 4. tap by text: pick a label that is actually on screen ────────────────
let tapOk = false
let tapDetail = ''
try {
  const findLabel = (text) => (text.match(/^#\d+ tap=\(\d+,\d+\) "(搜索[^"]*)"/m) ?? [])[1]
  let listing = String(await call('phone_ui', { limit: 14 }))
  let label = findLabel(listing)
  if (label === undefined) {
    // Settings resumes on whatever sub-screen it was left on; get back first.
    await call('phone_key', { key: 'BACK' })
    listing = String(await call('phone_ui', { limit: 14 }))
    label = findLabel(listing)
  }
  if (label === undefined) {
    throw new Error('no search row on screen; listing reads: ' + listing.split('\n').slice(3, 5).join(' | ').slice(0, 80))
  }
  const tapped = await call('phone_tap', { text: label })
  tapOk = tapped.ok === true
  tapDetail = 'label=' + JSON.stringify(label) + ' at (' + tapped.tapped.x + ',' + tapped.tapped.y + ')'
} catch (error) {
  tapDetail = String(error.message).slice(0, 110)
}
check('phone_tap by text', tapOk, tapDetail)

// ── 5. text: the one tool never typed on a real device before ───────────────
const NEEDLE = 'phoneuse-ok'
let textOk = false
let textDetail = ''
try {
  const typed = await call('phone_text', { text: NEEDLE })
  const echo = await call('phone_ui', { filter: NEEDLE })
  // The needle must appear in an ELEMENT line, not in phone_ui's own filter echo.
  const elementLine = String(echo).split('\n').find((line) => /^#\d+ /.test(line) && line.includes(NEEDLE))
  textOk = elementLine !== undefined
  textDetail = 'route=' + String(typed.route) + '; field element: ' + String(elementLine ?? 'NOT FOUND').slice(0, 70)
} catch (error) {
  textDetail = String(error.message).slice(0, 110)
}
check('phone_text reaches a real field', textOk, textDetail)

// ── 6. screenshot (fs real, attachments stubbed) ────────────────────────────
let shotOk = false
let shotDetail = ''
try {
  const shot = await call('phone_screenshot', { max_width: 600 })
  const size = statSync(shot.path).size
  const signature = readFileSync(shot.path).subarray(0, 8).toString('hex')
  shotOk = signature === '89504e470d0a1a0a' && size > 0 && savedImage !== null
  shotDetail = shot.image_width + 'x' + shot.image_height + ', ' + size + ' bytes, png=' + (signature === '89504e470d0a1a0a')
} catch (error) {
  shotDetail = String(error.message).slice(0, 110)
}
check('phone_screenshot produces a PNG', shotOk, shotDetail)

// ── 7. key + restore ────────────────────────────────────────────────────────
try {
  await call('phone_key', { key: 'BACK' })
  await call('phone_app', { action: 'stop', target: 'com.android.settings' })
  await call('phone_app', { action: 'start', target: 'mark.via' })
  const after = await call('phone_app', { action: 'current' })
  check('restored browser to front', String(after.foreground).includes('mark.via'), String(after.foreground).slice(0, 50))
} catch (error) {
  check('restored browser to front', false, String(error.message).slice(0, 90))
}

const failed = results.filter((entry) => !entry.ok)
console.log('\n' + (failed.length === 0 ? 'LIVE TEST OK (' + String(results.length) + '/' + String(results.length) + ')' : 'LIVE TEST FAILED: ' + failed.map((entry) => entry.label).join(', ')))
process.exit(failed.length === 0 ? 0 : 1)
