#!/usr/bin/env node
/**
 * Guarded upgrade for the Termux/Android dsh install.
 *
 * Why this exists
 * ---------------
 * Two upgrades in a row broke the running app, both with the same cause: a server kept
 * serving from a tree that had been changed underneath it.
 *
 *   - 0.1.7-alpha.1 installed over a live tree: the browser kept running a client bundle
 *     whose server had just been replaced.
 *   - 0.2.1-rc.2 swapped in by hand while the OLD server was still bound to the port. The
 *     old process kept answering, but it reads static assets from disk — and disk now held
 *     the new version. The WebView got a 0.2.1 client shell talking to a 0.2.0 API:
 *     `web boot: 21 entries did not activate` and a plugin-load failure page.
 *
 * No version of dsh can defend against that; the upgrade procedure has to make it
 * impossible. This script does, in this order:
 *
 *   stage -> patch -> rehearsal boot -> stop the live server -> atomic swap
 *         -> patch at the final path -> start -> health check
 *         -> on any failure after the swap: roll back to the previous tree and start it
 *
 * The rehearsal runs on a spare loopback port against a throwaway copy of the profile, so a
 * broken release is rejected *before* the live server is touched — the user keeps their
 * working session. The previous tree is only renamed to `<dsh>.prev` after that, so a
 * rollback is two renames: no reinstall, no network.
 *
 * Usage
 *   node upgrade.mjs                      upgrade to the `next` dist-tag
 *   node upgrade.mjs 0.2.1-rc.2           upgrade to an explicit version
 *   node upgrade.mjs --to next --dry-run  resolve and print the plan, change nothing
 *   node upgrade.mjs --help
 *
 * Flags
 *   <version> | --to/--version <v|next|latest>  target release (default: next)
 *   --dry-run               resolve the target and print the plan only
 *   --stage-from <dir>      stage by copying an existing tree instead of running npm
 *                           (offline installs, and self-tests)
 *   --skip-rehearsal        skip the spare-port boot (not recommended)
 *   --keep-failed           keep the parked failed tree instead of deleting it
 *   --force-post-swap-failure  self-test hook: corrupt the staged entry after the swap so
 *                           the health check fails and the rollback path is exercised
 *
 * Environment (every path is overridable so the whole flow can run in a sandbox)
 *   HOME, DSH_DIR, DSH_HOME, DSH_APP_DIR, DSH_PORT
 *   DSH_UPGRADE_BOOT_TIMEOUT_MS (default 180000), DSH_UPGRADE_STAGE_TIMEOUT_MS (1800000)
 *
 * Exit codes
 *   0   upgraded, or already up to date
 *   10  rejected before touching the live install (stage or rehearsal failed)
 *   20  rolled back to the previous tree after a failed swap (live install intact)
 *   21  rollback itself failed — a manual restore command is printed
 *   30  bad usage or unexpected error
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = process.env.HOME ?? os.homedir()
const DSH_DIR = path.resolve(process.env.DSH_DIR ?? path.join(HOME, 'dsh'))
const DSH_HOME = path.resolve(process.env.DSH_HOME ?? path.join(HOME, '.dsh'))
const APP_DIR = path.resolve(process.env.DSH_APP_DIR ?? path.join(HOME, '.dsh-app'))
const PORT = Number(process.env.DSH_PORT ?? '3080')
const PACKAGE = '@deepseek-ai/dsh'
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'
const REHEARSAL_HOME = `${DSH_HOME}.upgrade-rehearsal`
const PREV_DIR = `${DSH_DIR}.prev`
const STAGING_DIR = `${DSH_DIR}.staging`
const PAUSE_FILE = path.join(APP_DIR, 'upgrade.pause')
const TREE_ID_FILE = '.tree-id'
const ENTRY_REL = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const BOOT_TIMEOUT_MS = Number(process.env.DSH_UPGRADE_BOOT_TIMEOUT_MS ?? `${3 * 60 * 1000}`)
const STAGE_TIMEOUT_MS = Number(process.env.DSH_UPGRADE_STAGE_TIMEOUT_MS ?? `${30 * 60 * 1000}`)

const argv = process.argv.slice(2)
const OPTION_NAMES = new Set(['to', 'version', 'stage-from'])
const flag = (name) => argv.includes(`--${name}`)
function option(name, fallback = undefined) {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1] ?? fallback
}
function positional() {
  const values = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      if (OPTION_NAMES.has(arg.slice(2))) i += 1
      continue
    }
    values.push(arg)
  }
  return values
}

const DRY_RUN = flag('dry-run')
const SKIP_REHEARSAL = flag('skip-rehearsal')
const KEEP_FAILED = flag('keep-failed')
const FORCE_POST_SWAP_FAILURE = flag('force-post-swap-failure')
const STAGE_FROM = option('stage-from')
const TARGET = option('to') ?? option('version') ?? positional()[0] ?? 'next'

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
const LOG_FILE = path.join(APP_DIR, `upgrade-${stamp()}.log`)
const logStream = (() => {
  try {
    fs.mkdirSync(APP_DIR, { recursive: true })
    return fs.createWriteStream(LOG_FILE, { flags: 'a' })
  } catch {
    return undefined
  }
})()

function log(message) {
  const line = `[upgrade] ${message}`
  process.stderr.write(`${line}\n`)
  logStream?.write(`${line}\n`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Run a child process, tee its output into the log, never throw. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: STAGE_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
  if (result.stdout) logStream?.write(result.stdout)
  if (result.stderr) logStream?.write(result.stderr)
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

// ---------------------------------------------------------------------------
// install-tree helpers
// ---------------------------------------------------------------------------

function readVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', PACKAGE, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

function readTreeId(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, TREE_ID_FILE), 'utf8'))
  } catch {
    return undefined
  }
}

/** Stamp a tree with a generation id; servers inherit it through DSH_TREE_ID. */
function writeTreeId(dir, version) {
  const generation = { id: crypto.randomUUID(), version, installedAt: Date.now() }
  fs.writeFileSync(path.join(dir, TREE_ID_FILE), `${JSON.stringify(generation, null, 2)}\n`)
  return generation
}

function resolveTargetVersion() {
  if (/^\d/.test(TARGET)) return TARGET
  const tag = TARGET === 'next' || TARGET === 'latest' ? TARGET : 'next'
  log(`resolving dist-tag "${tag}" for ${PACKAGE}`)
  const result = run('npm', ['view', `${PACKAGE}@${tag}`, 'version'], { timeout: 120000 })
  const version = result.stdout.trim().split('\n').pop()?.trim()
  if (result.status !== 0 || !version || !/^\d/.test(version)) {
    throw new Error(`could not resolve dist-tag "${tag}": ${result.stderr.trim().slice(0, 300)}`)
  }
  return version
}

// ---------------------------------------------------------------------------
// loopback HTTP / RPC helpers
// ---------------------------------------------------------------------------

/** Newest `dsh web:` URL printed in `text` for the given port, if any. */
function tokenIn(text, port) {
  const pattern = new RegExp(String.raw`^dsh web: (http://127\.0\.0\.1:${port}/\S+)`, 'gm')
  let newest
  let match
  while ((match = pattern.exec(text)) !== null) newest = match[1]
  return newest
}

async function tokenAlive(url) {
  if (!url) return false
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    return response.status >= 300 && response.status < 400
  } catch {
    return false
  }
}

async function loginCookie(url) {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
  const cookie = (response.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ')
  if (!cookie) throw new Error(`token login produced no cookie (HTTP ${response.status})`)
  return cookie
}

async function rpcOn(url, port, endpoint, args = {}) {
  const cookie = await loginCookie(url)
  const rpcId = crypto.randomUUID()
  const response = await fetch(`http://127.0.0.1:${port}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    signal: AbortSignal.timeout(15000),
  })
  const body = await response.json()
  if (!body.result?.ok) throw new Error(`${endpoint}: ${JSON.stringify(body.result?.error ?? body).slice(0, 400)}`)
  return body.result.value
}

/** The client shell asset the server advertises must exist on disk in this tree. */
async function advertisedAssetOnDisk(url, port, treeDir) {
  const cookie = await loginCookie(url)
  const page = await fetch(`http://127.0.0.1:${port}/`, {
    headers: cookie ? { cookie } : {},
    signal: AbortSignal.timeout(8000),
  })
  const html = await page.text()
  const match = /(?:src|href)="\.?\/?(assets\/[A-Za-z0-9._/-]+\.(?:js|css))"/.exec(html)
  if (!match) return { ok: false, detail: `served HTML names no client asset (HTTP ${page.status})` }
  const asset = match[1]
  const vendors = path.join(treeDir, 'node_modules', '@deepseek-ai')
  let found = false
  try {
    for (const name of fs.readdirSync(vendors)) {
      for (const candidate of [
        path.join(vendors, name, 'dist', asset),
        path.join(vendors, name, asset),
        path.join(vendors, name, 'lib', asset),
      ]) {
        if (fs.existsSync(candidate)) {
          found = true
          break
        }
      }
      if (found) break
    }
  } catch {
    /* vendor directory missing entirely */
  }
  return { ok: found, detail: found ? asset : `${asset} is not on disk under ${treeDir}` }
}

// ---------------------------------------------------------------------------
// process control
// ---------------------------------------------------------------------------

/** pids running `dsh web` for this port (default port when no --port is given). */
function serverProcesses(port = PORT) {
  const listing = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' })
  const pids = []
  for (const line of (listing.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const args = match[2]
    if (pid === process.pid) continue
    if (!/@deepseek-ai\/dsh\/lib\/bin\.js\s+web\b/.test(args)) continue
    const portArg = /--port\s+(\d+)/.exec(args)
    if ((portArg ? Number(portArg[1]) : 3080) !== port) continue
    pids.push(pid)
  }
  return pids
}

/** The generation a running server was started from (readable for our own uid). */
function processGeneration(pid) {
  try {
    const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
    return /(?:^|\0)DSH_TREE_ID=([^\0]+)/.exec(environ)?.[1]
  } catch {
    return undefined
  }
}

function portOpen(port = PORT) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const settle = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    socket.setTimeout(1000, () => settle(false))
  })
}

async function freePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve) => {
      const server = net.createServer()
      server.unref()
      server.once('error', () => resolve(0))
      server.listen(0, '127.0.0.1', () => {
        const { port: picked } = server.address()
        server.close(() => resolve(picked))
      })
    })
    if (port && !(await portOpen(port))) return port
  }
  throw new Error('could not find a free loopback port for the rehearsal')
}

async function stopServers({ port = PORT, label = 'live' } = {}) {
  const pids = serverProcesses(port)
  if (pids.length === 0) log(`stop(${label}): no server process on :${port}`)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
      log(`stop(${label}): SIGTERM -> pid ${pid} (generation ${(processGeneration(pid) ?? 'unknown').slice(0, 8)})`)
    } catch (error) {
      log(`stop(${label}): could not signal pid ${pid}: ${error.message}`)
    }
  }
  const graceful = Date.now() + 15000
  while (Date.now() < graceful && (await portOpen(port))) await sleep(300)
  if (await portOpen(port)) {
    for (const pid of serverProcesses(port)) {
      try {
        process.kill(pid, 'SIGKILL')
        log(`stop(${label}): SIGKILL -> pid ${pid}`)
      } catch {
        /* already gone */
      }
    }
    const forced = Date.now() + 8000
    while (Date.now() < forced && (await portOpen(port))) await sleep(200)
  }
  const released = !(await portOpen(port))
  log(`stop(${label}): port ${port} ${released ? 'released' : 'STILL OPEN'}`)
  return released
}

/**
 * Start a server from a tree. `logFile` is appended to — the caller records the byte
 * offset first so a failed boot from a previous run cannot be mistaken for this one.
 */
function startServer({ treeDir, logFile, port = PORT, generation }) {
  const entry = path.join(treeDir, ENTRY_REL)
  if (!fs.existsSync(entry)) throw new Error(`entry not found: ${entry}`)
  const offset = (() => {
    try {
      return fs.statSync(logFile).size
    } catch {
      return 0
    }
  })()
  const out = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, [entry, 'web', '--no-open', '--port', String(port)], {
    cwd: HOME,
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      DSH_HOME,
      DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? 'danger-full-access',
      DSH_TREE_ID: generation?.id ?? '',
    },
  })
  child.unref()
  log(`start: pid ${child.pid} from ${treeDir} on :${port} (generation ${(generation?.id ?? '').slice(0, 8)})`)
  return { pid: child.pid, offset }
}

/** Read only the bytes this boot produced. */
function bootLogText(logFile, offset) {
  try {
    const fd = fs.openSync(logFile, 'r')
    try {
      const size = fs.fstatSync(fd).size
      if (size <= offset) return ''
      const buffer = Buffer.alloc(size - offset)
      fs.readSync(fd, buffer, 0, buffer.length, offset)
      return buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// health check
// ---------------------------------------------------------------------------

/**
 * Wait for a freshly started server and judge whether it is safe to keep.
 * Every check reports its own verdict; the overall result is their conjunction.
 */
async function waitForHealth({ treeDir, generation, logFile, offset, port = PORT }) {
  const checks = {}
  const startedAt = Date.now()
  const deadline = startedAt + BOOT_TIMEOUT_MS
  let url
  while (Date.now() < deadline) {
    const text = bootLogText(logFile, offset)
    if (/dsh: startup failed/.test(text)) {
      const diagnostic = (/startup failed[\s\S]{0,1000}/.exec(text)?.[0] ?? 'startup failed').replace(/\s+/g, ' ').slice(0, 500)
      return { ok: false, checks: { boot: { ok: false, detail: diagnostic } } }
    }
    url = tokenIn(text, port) ?? url
    if (url && (await tokenAlive(url))) break
    // A tree whose entry crashes exits immediately and never prints a token; waiting out the
    // full boot budget would stall the rollback for minutes.
    if (Date.now() - startedAt > 15000 && serverProcesses(port).length === 0) {
      const tail = text.trim().split('\n').slice(-4).join(' ').slice(0, 400)
      return { ok: false, checks: { boot: { ok: false, detail: `server process exited before producing a token${tail ? ` — ${tail}` : ''}` } } }
    }
    await sleep(400)
  }
  if (!url || !(await tokenAlive(url))) {
    return { ok: false, checks: { token: { ok: false, detail: 'never became valid' } } }
  }
  checks.token = { ok: true, detail: 'accepted' }

  const pids = serverProcesses(port)
  const generations = pids.map((pid) => processGeneration(pid))
  checks.generation = {
    ok: pids.length > 0 && generations.every((value) => value === generation.id),
    detail: pids.length === 0
      ? 'no server process on the port'
      : `pids ${pids.map((pid, index) => `${pid}:${(generations[index] ?? 'unset').slice(0, 8)}`).join(', ')} vs ${generation.id.slice(0, 8)}`,
  }

  try {
    const inventory = await rpcOn(url, port, 'pluginInventory/list')
    const entries = inventory.entries ?? inventory
    const failed = entries.filter((entry) => entry.error || entry.fiberPhase === 'failed')
    const stalled = entries.filter((entry) => entry.enabled && entry.fiberPhase && entry.fiberPhase !== 'active')
    checks.plugins = {
      ok: failed.length === 0 && stalled.length === 0,
      detail: `${entries.length} entries, ${failed.length} failed, ${stalled.length} stalled${failed.length || stalled.length ? ` (${[...failed, ...stalled].map((entry) => entry.entryId).slice(0, 6).join(', ')})` : ''}`,
    }
  } catch (error) {
    checks.plugins = { ok: false, detail: `inventory failed: ${error.message.slice(0, 200)}` }
  }

  try {
    const asset = await advertisedAssetOnDisk(url, port, treeDir)
    checks.asset = asset
  } catch (error) {
    checks.asset = { ok: false, detail: `asset check failed: ${error.message.slice(0, 200)}` }
  }

  return { ok: Object.values(checks).every((check) => check.ok), url, checks }
}

function printChecks(checks) {
  for (const [name, check] of Object.entries(checks)) {
    log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${name}: ${check.detail}`)
  }
}

// ---------------------------------------------------------------------------
// pause file: keep bridge.sh and ensure-server.mjs from racing us
// ---------------------------------------------------------------------------

function writePause(version) {
  try {
    fs.mkdirSync(APP_DIR, { recursive: true })
    fs.writeFileSync(PAUSE_FILE, `${JSON.stringify({ pid: process.pid, at: Date.now(), version }, null, 2)}\n`)
    log(`pause: wrote ${PAUSE_FILE}`)
  } catch (error) {
    log(`pause: could not write ${PAUSE_FILE}: ${error.message}`)
  }
}

function clearPause() {
  try {
    fs.rmSync(PAUSE_FILE, { force: true })
    log('pause: cleared')
  } catch {
    /* nothing to clear */
  }
}

let pauseWritten = false

// ---------------------------------------------------------------------------
// upgrade steps
// ---------------------------------------------------------------------------

function stagePackageJson(version) {
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(path.join(DSH_DIR, 'package.json'), 'utf8'))
  } catch {
    /* fresh tree */
  }
  return {
    name: 'dsh-install',
    private: true,
    dependencies: {
      [PACKAGE]: version,
      [PRIMITIVES]: version,
      '@img/sharp-wasm32': current.dependencies?.['@img/sharp-wasm32'] ?? '^0.35.4',
      sharp: current.dependencies?.sharp ?? '^0.35.4',
    },
  }
}

function stage(version) {
  log(`stage: preparing ${STAGING_DIR} for ${PACKAGE}@${version}`)
  fs.rmSync(STAGING_DIR, { recursive: true, force: true })
  fs.mkdirSync(STAGING_DIR, { recursive: true })

  if (STAGE_FROM) {
    const source = path.resolve(STAGE_FROM)
    log(`stage: copying ${source} (--stage-from)`)
    const copy = run('cp', ['-a', `${source}/.`, STAGING_DIR])
    if (copy.status !== 0) throw new Error(`copy from ${source} failed: ${copy.stderr.trim().slice(0, 300)}`)
  } else {
    fs.writeFileSync(path.join(STAGING_DIR, 'package.json'), `${JSON.stringify(stagePackageJson(version), null, 2)}\n`)
    const install = () =>
      run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
        cwd: STAGING_DIR,
        timeout: STAGE_TIMEOUT_MS,
        env: { ...process.env, npm_config_update_notifier: 'false' },
      })
    // `--ignore-scripts` is not optional on Termux: koffi's postinstall tries to build a
    // native addon with CMake and fails, which makes npm abandon the whole install. The
    // package is unused on this host (the running install carries no koffi binaries either).
    let result = install()
    if (result.status !== 0) {
      log(`stage: npm install failed (exit ${result.status}); retrying once`)
      result = install()
    }
    if (result.status !== 0) {
      throw new Error(`npm install failed (exit ${result.status}): ${result.stderr.trim().split('\n').slice(-6).join(' ')}`)
    }
  }

  const actual = readVersion(STAGING_DIR)
  if (actual !== version) throw new Error(`staged tree is ${actual}, expected ${version}`)

  // The compatibility patch and the widget launcher live beside the install, not inside the
  // package, so they have to travel with the tree.
  for (const file of ['android-fix.mjs', 'start_dsh-terminal.sh']) {
    const source = path.join(DSH_DIR, file)
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(STAGING_DIR, file))
  }
  const generation = writeTreeId(STAGING_DIR, version)
  log(`stage: ${PACKAGE}@${version} ready, generation ${generation.id.slice(0, 8)}`)
  return generation
}

/** Patch a tree against a throwaway DSH_HOME so the live profile is never pointed at staging. */
function patchTree(treeDir, home, label) {
  const patch = path.join(treeDir, 'android-fix.mjs')
  if (!fs.existsSync(patch)) throw new Error(`${label}: android-fix.mjs missing in ${treeDir}`)
  log(`${label}: applying compatibility patches (DSH_HOME=${home})`)
  const result = run(process.execPath, [patch], {
    cwd: treeDir,
    env: { ...process.env, DSH_HOME: home },
    timeout: 10 * 60 * 1000,
  })
  for (const line of result.stdout.trim().split('\n').slice(-6)) if (line) log(`${label}: ${line}`)
  if (result.status !== 0) {
    throw new Error(`${label}: android-fix.mjs exit ${result.status}${result.stderr.trim() ? ` — ${result.stderr.trim().slice(0, 500)}` : ''}`)
  }
  log(`${label}: all compatibility patches applied`)
}

/** Copy just enough of the live home for a rehearsal boot to compose the real profile. */
function prepareRehearsalHome() {
  fs.rmSync(REHEARSAL_HOME, { recursive: true, force: true })
  fs.mkdirSync(REHEARSAL_HOME, { recursive: true })
  for (const name of ['.credentials.yaml', '.anonymous-user-id', 'skills']) {
    const source = path.join(DSH_HOME, name)
    if (fs.existsSync(source)) run('cp', ['-a', source, path.join(REHEARSAL_HOME, name)])
  }
  const profiles = path.join(DSH_HOME, 'profiles')
  if (!fs.existsSync(profiles)) throw new Error(`no profiles directory in ${DSH_HOME}`)
  const copy = run('cp', ['-a', profiles, path.join(REHEARSAL_HOME, 'profiles')])
  if (copy.status !== 0) throw new Error(`could not copy profiles for the rehearsal: ${copy.stderr.trim().slice(0, 300)}`)
  // The module farm is regenerated by android-fix against the staged tree; keeping the live
  // one would make the rehearsal resolve the live packages instead of the staged ones.
  fs.rmSync(path.join(REHEARSAL_HOME, 'profiles', 'node_modules'), { recursive: true, force: true })
  log(`rehearsal: home prepared at ${REHEARSAL_HOME}`)
}

async function rehearsalBoot(treeDir, generation) {
  if (SKIP_REHEARSAL) {
    log('rehearsal: skipped (--skip-rehearsal)')
    return
  }
  const port = await freePort()
  const logFile = path.join(APP_DIR, `upgrade-rehearsal-${stamp()}.log`)
  log(`rehearsal: booting on :${port} with DSH_HOME=${REHEARSAL_HOME}`)
  const entry = path.join(treeDir, ENTRY_REL)
  const out = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, [entry, 'web', '--no-open', '--port', String(port)], {
    cwd: HOME,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      DSH_HOME: REHEARSAL_HOME,
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TREE_ID: generation.id,
    },
  })
  try {
    const startedAt = Date.now()
    const deadline = startedAt + BOOT_TIMEOUT_MS
    let url
    while (Date.now() < deadline) {
      const text = bootLogText(logFile, 0)
      if (/dsh: startup failed/.test(text)) {
        const diagnostic = (/startup failed[\s\S]{0,1000}/.exec(text)?.[0] ?? 'startup failed').replace(/\s+/g, ' ').slice(0, 500)
        throw new Error(`rehearsal boot failed: ${diagnostic}`)
      }
      url = tokenIn(text, port) ?? url
      if (url && (await tokenAlive(url))) break
      if (Date.now() - startedAt > 15000 && child.exitCode !== null) {
        const tail = text.trim().split('\n').slice(-4).join(' ').slice(0, 400)
        throw new Error(`rehearsal server exited (code ${child.exitCode}) before producing a token${tail ? ` — ${tail}` : ''}`)
      }
      await sleep(400)
    }
    if (!url || !(await tokenAlive(url))) throw new Error('rehearsal boot never produced a usable token')
    const inventory = await rpcOn(url, port, 'pluginInventory/list')
    const entries = inventory.entries ?? inventory
    const failed = entries.filter((entry) => entry.error || entry.fiberPhase === 'failed')
    const stalled = entries.filter((entry) => entry.enabled && entry.fiberPhase && entry.fiberPhase !== 'active')
    if (failed.length || stalled.length) {
      throw new Error(`rehearsal plugins: ${failed.length} failed / ${stalled.length} stalled (${[...failed, ...stalled].map((entry) => entry.entryId).slice(0, 6).join(', ')})`)
    }
    const asset = await advertisedAssetOnDisk(url, port, treeDir)
    if (!asset.ok) throw new Error(`rehearsal asset: ${asset.detail}`)
    log(`rehearsal: booted cleanly — ${entries.length} plugin entries active, client asset ${asset.detail}`)
  } finally {
    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && (await portOpen(port))) await sleep(300)
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    log(`rehearsal: stopped (log ${logFile})`)
  }
}

function swapIn() {
  log(`swap: ${DSH_DIR} -> ${PREV_DIR}; ${STAGING_DIR} -> ${DSH_DIR}`)
  const older = `${PREV_DIR}-older`
  if (fs.existsSync(PREV_DIR)) {
    fs.rmSync(older, { recursive: true, force: true })
    fs.renameSync(PREV_DIR, older)
    log(`swap: older previous tree parked at ${older}`)
  }
  fs.renameSync(DSH_DIR, PREV_DIR)
  fs.renameSync(STAGING_DIR, DSH_DIR)
}

function parkFailedTree() {
  const failed = `${DSH_DIR}.failed-${stamp()}`
  try {
    fs.renameSync(DSH_DIR, failed)
    log(`failed tree parked at ${failed}`)
    return failed
  } catch (error) {
    log(`could not park the failed tree: ${error.message}`)
    return undefined
  }
}

async function startAndVerify({ treeDir, generation, label, logFile }) {
  const { offset } = startServer({ treeDir, logFile, generation, port: PORT })
  const health = await waitForHealth({ treeDir, generation, logFile, offset })
  printChecks(health.checks)
  return health
}

/** Restore the previous tree, patch it against the live home, start it, verify it. */
async function rollback({ logFile, reason }) {
  log(`ROLLBACK: ${reason}`)
  await stopServers({ label: 'new-tree' })
  const failed = parkFailedTree()
  if (!fs.existsSync(PREV_DIR)) {
    log('rollback: no previous tree available')
    return { ok: false, failed }
  }
  fs.renameSync(PREV_DIR, DSH_DIR)
  const generation = readTreeId(DSH_DIR) ?? writeTreeId(DSH_DIR, readVersion(DSH_DIR) ?? 'unknown')
  try {
    patchTree(DSH_DIR, DSH_HOME, 'rollback')
  } catch (error) {
    log(`rollback: patching the restored tree failed: ${error.message}`)
  }
  const health = await startAndVerify({ treeDir: DSH_DIR, generation, label: 'rollback', logFile })
  if (health.ok) log(`rollback: ${generation.version} is serving again (${health.url})`)
  else log('rollback: the restored tree did not come back healthy either')
  return { ok: health.ok, failed, url: health.url }
}

function recordLastKnownGood(dir, generation) {
  try {
    fs.mkdirSync(APP_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(APP_DIR, 'last-known-good.json'),
      `${JSON.stringify({ dir, version: generation.version, generation: generation.id, at: new Date().toISOString() }, null, 2)}\n`,
    )
    log('lkg: recorded last-known-good state')
  } catch (error) {
    log(`lkg: could not record: ${error.message}`)
  }
}

function manualRestoreHint(failed) {
  const steps = [
    `cd ${HOME}`,
    failed ? `rm -rf ${DSH_DIR}` : '# nothing was swapped',
    `[ -d ${PREV_DIR} ] && mv ${PREV_DIR} ${DSH_DIR}`,
    `node ${path.join(DSH_DIR, 'android-fix.mjs')}`,
    `node ${path.join(APP_DIR, 'ensure-server.mjs')} --restart`,
  ]
  log('manual restore:')
  for (const step of steps) log(`  ${step}`)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  if (flag('help') || argv.includes('-h')) {
    const header = /\/\*\*([\s\S]*?)\*\//.exec(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'))?.[1] ?? ''
    process.stdout.write(header.replace(/^ \* ?/gm, '').trimStart())
    return 0
  }
  log(`log file: ${LOG_FILE}`)
  log(`install ${DSH_DIR} | home ${DSH_HOME} | app dir ${APP_DIR} | port ${PORT}`)

  const current = readVersion(DSH_DIR)
  if (!current) throw new Error(`no ${PACKAGE} under ${DSH_DIR}/node_modules — is DSH_DIR right?`)
  const target = resolveTargetVersion()
  log(`version: ${current} -> ${target}`)
  if (current === target) {
    log('already up to date; nothing to do')
    return 0
  }
  if (DRY_RUN) {
    log('dry run: would prepare a rehearsal home, stage, patch, rehearse, stop the live server, swap, patch, start and verify')
    log('dry run: nothing was changed')
    return 0
  }

  writePause(target)
  pauseWritten = true
  prepareRehearsalHome()
  const generation = stage(target)
  patchTree(STAGING_DIR, REHEARSAL_HOME, 'staging')
  await rehearsalBoot(STAGING_DIR, generation)

  if (FORCE_POST_SWAP_FAILURE) {
    log('self-test: corrupting the staged entry after the rehearsal (--force-post-swap-failure)')
    fs.writeFileSync(path.join(STAGING_DIR, ENTRY_REL), 'throw new Error("self-test post-swap failure")\n')
  }

  // From here on the live server must be down: a swap under a serving process is exactly
  // the failure this script exists to prevent.
  if (!(await stopServers({ label: 'live' }))) {
    throw new Error(`port ${PORT} did not free up; refusing to swap`)
  }
  swapIn()
  let swapped = true
  try {
    patchTree(DSH_DIR, DSH_HOME, 'final')
    const finalGeneration = readTreeId(DSH_DIR) ?? writeTreeId(DSH_DIR, target)
    const logFile = path.join(APP_DIR, 'server.log')
    const health = await startAndVerify({ treeDir: DSH_DIR, generation: finalGeneration, label: 'final', logFile })
    if (!health.ok) {
      const restored = await rollback({ logFile, reason: 'post-swap health check failed' })
      swapped = false
      if (restored.ok) {
        log('done: upgrade rejected and rolled back; the previous version is serving')
        clearPause()
        return 20
      }
      log('done: ROLLBACK FAILED — manual restore required')
      manualRestoreHint(restored.failed)
      clearPause()
      return 21
    }
    recordLastKnownGood(DSH_DIR, finalGeneration)
    fs.rmSync(`${PREV_DIR}-older`, { recursive: true, force: true })
    log(`done: ${current} -> ${target}; previous tree kept at ${PREV_DIR} for instant rollback`)
    log(`server url: ${health.url}`)
    process.stdout.write(`${health.url}\n`)
    clearPause()
    return 0
  } catch (error) {
    log(`FAILED after swap: ${error.message}`)
    if (swapped) {
      const restored = await rollback({ logFile: path.join(APP_DIR, 'server.log'), reason: `exception after swap: ${error.message}` })
      if (restored.ok) {
        clearPause()
        return 20
      }
      manualRestoreHint(restored.failed)
      clearPause()
      return 21
    }
    throw error
  }
}

let code = 30
try {
  code = await main()
} catch (error) {
  log(`FAILED: ${error.message}`)
  // A failure before the swap means the live install was never touched; clean the staging
  // tree so the next attempt starts from a clean slate.
  try {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true })
    fs.rmSync(REHEARSAL_HOME, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  if (!KEEP_FAILED) {
    for (const name of fs.readdirSync(HOME)) {
      if (name.startsWith('dsh.failed-')) {
        try {
          fs.rmSync(path.join(HOME, name), { recursive: true, force: true })
        } catch {
          /* best effort */
        }
      }
    }
  }
  code = 10
} finally {
  if (pauseWritten) clearPause()
  logStream?.end()
}
process.exitCode = code
