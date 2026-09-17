#!/usr/bin/env node
// Offline smoke test for the generated PhoneUse plugin module.
//
// A broken preset fails at mount time, which is exactly when a person is trying
// to start a session. This loads the module, calls `apply` against a stub
// context, and validates the shell command it would post — so a mistake is
// caught here instead.
//
// Usage: node phone-use/smoke.mjs [path/to/plugin/index.js]

import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(process.argv[2] ?? join(here, 'dsh-plugin-phone-use', 'index.js'))
const mod = await import(pathToFileURL(target).href)

const HIERARCHY = '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"></hierarchy>'
const SCREEN = 'Physical size: 1156x2510'
const DEVICES = 'List of devices attached\n127.0.0.1:39119\tdevice\n'

const REGISTERED = []
const HANDLERS = []
const COMMANDS = []

const stub = {
  tools: {
    register(definition) {
      REGISTERED.push(String(definition.name))
    },
  },
  on(event, listener) {
    HANDLERS.push({ event: String(event), listener })
  },
  get(name) {
    if (name !== 'shell') return undefined
    return {
      resolve(request) {
        return { command: request.command, timeoutMs: request.timeoutMs }
      },
      run(spec) {
        const command = String(spec.command)
        COMMANDS.push(command)
        let text = ''
        if (command.includes('command -v adb')) text = '/data/data/com.termux/files/usr/bin/adb'
        else if (command.includes('uiautomator dump')) text = 'FOCUS=Window{1 u0 com.example/.Main}\n<<UI>>\n' + HIERARCHY
        else if (command.includes('wm size')) text = SCREEN
        else if (command.includes('devices')) text = DEVICES
        return Promise.resolve({ exitCode: 0, timedOut: false, aborted: false, stdout: { text }, stderr: { text: '' } })
      },
    }
  },
}

mod.apply(stub)

const problems = []
const expected = [
  'phone_status', 'phone_screenshot', 'phone_ui', 'phone_tap',
  'phone_swipe', 'phone_key', 'phone_text', 'phone_app',
]
if (REGISTERED.length !== expected.length) problems.push('expected ' + String(expected.length) + ' tools, registered ' + String(REGISTERED.length))
for (const name of expected) if (!REGISTERED.includes(name)) problems.push('missing tool ' + name)

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

await new Promise((done) => setTimeout(done, 100))

const command = COMMANDS.find((entry) => entry.includes('termux-notification'))
if (command === undefined) {
  problems.push('no termux-notification command was produced (saw ' + String(COMMANDS.length) + ' command(s))')
} else {
  try {
    execFileSync('bash', ['-n', '-c', command], { stdio: 'pipe' })
  } catch (error) {
    problems.push('notification command is not valid bash: ' + String(error.stderr ?? error.message))
  }
  if (!command.includes("'运行中 · phone_tap'")) problems.push('missing the phone-tool status text')
  if (!command.includes('--button1-action')) problems.push('missing the 打开会话 button')
  if (!command.includes('dsh-phoneuse')) problems.push('missing the stable notification id')
  if (COMMANDS.find((entry) => entry.includes('已结束')) === undefined) problems.push('missing the ended status text')
}

console.log('module:   ' + target)
console.log('tools:    ' + REGISTERED.join(', '))
console.log('handlers: ' + HANDLERS.map((entry) => entry.event).join(', '))
COMMANDS.forEach((entry, index) => {
  const at = entry.indexOf('termux-notification')
  console.log('cmd[' + String(index) + ']:  ' + entry.slice(at, at + 150))
})

if (problems.length > 0) {
  console.error('\nSMOKE FAILED:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log('\nSMOKE OK')
