#!/usr/bin/env node
// Offline smoke test for the generated PhoneUse plugin module.
//
// A broken preset fails at mount time, which is exactly when a person is trying
// to start a session. This loads the module, calls `apply` against a stub
// context, and then EXECUTES EVERY TOOL once against canned shell output.
//
// Executing them matters: registering eight tools proves the module loads, not
// that the tools run. A leftover reference to a deleted variable is valid
// syntax, passes `node --check`, registers fine, and only explodes when someone
// calls the tool — which is exactly the bug this pass exists to catch.
//
// Usage: node phone-use/smoke.mjs [path/to/plugin/index.js]

import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(process.argv[2] ?? join(here, 'dsh-plugin-phone-use', 'index.js'))
const mod = await import(pathToFileURL(target).href)

// A 24-byte PNG header: signature + IHDR length/type + 100x200 dimensions, which
// is exactly what the screenshot tool reads out of the bytes.
const FAKE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x64,
  0x00, 0x00, 0x00, 0xc8,
])

const HIERARCHY = '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">'
  + '<node index="0" text="Hello" resource-id="com.example:id/btn" class="android.widget.Button"'
  + ' package="com.example" content-desc="" clickable="true" enabled="true" bounds="[10,20][110,120]" />'
  + '</hierarchy>'
const FOCUS = 'mCurrentFocus=Window{1 u0 com.example/com.example.Main}'
const DEVICES = 'List of devices attached\n127.0.0.1:39119\tdevice\n'
const PROBE = 'MODEL=TestPhone\nRELEASE=17\nSIZE=Physical size: 1156x2510\nDENSITY=Physical density: 480\n'
  + 'WAKE=mWakefulness=Awake\nFOCUS=' + FOCUS + '\n'

const REGISTERED = new Map()
const HANDLERS = []
const COMMANDS = []

/** Canned shell: ordered checks, because several tools share one command line. */
function canned(command) {
  if (command.includes('command -v adb')) return '/data/data/com.termux/files/usr/bin/adb'
  if (command.includes('getprop')) return PROBE
  if (command.includes('uiautomator dump')) return 'FOCUS=' + FOCUS + '\n<<UI>>\n' + HIERARCHY
  if (command.includes('screencap')) return '/tmp/phoneuse-fake.png 1234'
  if (command.includes('dumpsys window')) return FOCUS
  if (command.includes('wm size')) return 'Physical size: 1156x2510'
  if (command.includes('devices')) return DEVICES
  if (command.includes('pm list packages')) return 'package:com.example.app\n'
  if (command.includes('monkey')) return 'Events injected: 1\n'
  return ''
}

const stub = {
  tools: {
    register(definition) {
      REGISTERED.set(String(definition.name), definition)
    },
  },
  on(event, listener) {
    HANDLERS.push({ event: String(event), listener })
  },
  get(name) {
    if (name === 'shell') {
      return {
        resolve(request) {
          return { command: request.command, timeoutMs: request.timeoutMs }
        },
        run(spec) {
          COMMANDS.push(String(spec.command))
          return Promise.resolve({ exitCode: 0, timedOut: false, aborted: false, stdout: { text: canned(String(spec.command)) }, stderr: { text: '' } })
        },
      }
    }
    if (name === 'fs') {
      return {
        resolve(path) {
          return Promise.resolve({ displayPath: path, raw: path })
        },
        readBytes() {
          return Promise.resolve(FAKE_PNG)
        },
      }
    }
    if (name === 'attachments') {
      return {
        saveImage(input) {
          return Promise.resolve({ attachmentId: 'stub', mediaType: input.mediaType, bytes: input.data.length, width: 100, height: 200 })
        },
      }
    }
    return undefined
  },
}

mod.apply(stub)

const problems = []
const expected = [
  'phone_status', 'phone_screenshot', 'phone_ui', 'phone_tap',
  'phone_swipe', 'phone_key', 'phone_text', 'phone_app',
]
for (const name of expected) if (!REGISTERED.has(name)) problems.push('missing tool ' + name)

// ── the status-notification channel ────────────────────────────────────────
const pre = HANDLERS.find((entry) => entry.event === 'tools/pre-execute')
const status = HANDLERS.find((entry) => entry.event === 'agent/status')
if (pre === undefined) problems.push('tools/pre-execute listener missing')
if (status === undefined) problems.push('agent/status listener missing')
if (pre !== undefined) {
  let nexted = false
  pre.listener({ name: 'phone_tap' }, function () { nexted = true; return Promise.resolve() })
  if (!nexted) problems.push('tools/pre-execute listener did not call next()')
}
if (status !== undefined) {
  status.listener({ status: 'idle' })
  status.listener({ status: 'running' })
}
await new Promise((done) => setTimeout(done, 50))
const notification = COMMANDS.find((entry) => entry.includes('termux-notification'))
if (notification === undefined) problems.push('no termux-notification command was produced')
else {
  try {
    execFileSync('bash', ['-n', '-c', notification], { stdio: 'pipe' })
  } catch (error) {
    problems.push('notification command is not valid bash: ' + String(error.stderr ?? error.message))
  }
  if (!notification.includes("'运行中 · phone_tap'")) problems.push('missing the phone-tool status text')
  if (COMMANDS.find((entry) => entry.includes('已结束')) === undefined) problems.push('missing the ended status text')
}

// ── execute every tool once ────────────────────────────────────────────────
const calls = [
  ['phone_status', {}],
  ['phone_ui', { limit: 5 }],
  ['phone_screenshot', { max_width: 600 }],
  ['phone_tap', { x: 20, y: 30 }],
  ['phone_swipe', { x1: 20, y1: 30, x2: 40, y2: 300 }],
  ['phone_key', { key: 'BACK' }],
  ['phone_text', { text: 'hello world' }],
  ['phone_app', { action: 'current' }],
]
for (const [name, args] of calls) {
  const tool = REGISTERED.get(name)
  if (tool === undefined) continue
  try {
    const value = await tool.execute(args, { signal: undefined })
    const preview = typeof value === 'string' ? value.split('\n')[0] : JSON.stringify(value)
    console.log('  runs   ' + name.padEnd(18) + ' ' + preview.slice(0, 70))
  } catch (error) {
    problems.push('EXECUTE ' + name + ' threw: ' + String(error && error.message ? error.message : error))
  }
}

console.log('module:   ' + target)
console.log('tools:    ' + [...REGISTERED.keys()].join(', '))
console.log('handlers: ' + HANDLERS.map((entry) => entry.event).join(', '))

if (problems.length > 0) {
  console.error('\nSMOKE FAILED:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log('\nSMOKE OK')
