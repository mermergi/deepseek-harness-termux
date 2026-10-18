/**
 * Make sure `dsh web` is running, then print its process-token URL on stdout.
 *
 * Prints an empty line when no trustworthy URL can be produced — the app then
 * falls back to the clean URL and whatever browser-session cookie it already has.
 *
 * Mirrors the desktop launcher's environment so an app-started server behaves
 * exactly like a widget-started one (same permission mode, same Android patches).
 *
 * Logs live in ~/.dsh-app/, not $TMPDIR: Termux wipes $PREFIX/tmp whenever the
 * Termux app process restarts, and a running server keeps writing to the deleted
 * inode — which silently destroys the only copy of the launch token. The legacy
 * $TMPDIR/dsh_web.log is still read so a widget-started server is reused.
 *
 * Guard rails against bad upgrades
 * --------------------------------
 * A server keeps the code it loaded at boot but reads static assets from disk. If the
 * install tree is replaced underneath a running server, the browser gets a client shell
 * from one version talking to the API of another — the "Failed to load plugins / N entries
 * did not activate" page. Two guards here make that state impossible to keep serving:
 *
 *   1. Generation check. Every install tree carries `.tree-id`, and servers started by
 *      this script inherit it through `DSH_TREE_ID`. A server whose generation does not
 *      match the current tree (or which predates the tree on disk) is stale: it is
 *      stopped and replaced instead of being reused.
 *   2. Boot-failure auto-rollback. Two consecutive boots that never produce a usable
 *      token mark the tree as bad; `<dsh>.prev` (kept by upgrade.mjs) is restored
 *      automatically, so a failed upgrade heals itself on the next app launch.
 *
 * The upgrade script also writes `~/.dsh-app/upgrade.pause` while it holds the tree; this
 * script honours it and refuses to start a server mid-upgrade.
 *
 * Usage: node ensure-server.mjs [--restart]
 *   --restart  stop whatever is serving the port first, so a fresh token is minted.
 *              Only used when the app has no usable cookie and cannot otherwise log in.
 *
 * Environment: HOME, DSH_DIR, DSH_PORT, DSH_SERVER_LOG, DSH_APP_DIR (all optional).
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const PORT = Number(process.env.DSH_PORT ?? '3080')
const HOME = process.env.HOME ?? os.homedir()
const DSH_DIR = process.env.DSH_DIR ?? path.join(HOME, 'dsh')
const APP_DIR = process.env.DSH_APP_DIR ?? path.join(HOME, '.dsh-app')
const ENTRY = path.join(DSH_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const START_LOG = process.env.DSH_SERVER_LOG ?? path.join(APP_DIR, 'server.log')
const LEGACY_LOG = path.join(process.env.TMPDIR ?? '/tmp', 'dsh_web.log')
const WAIT_MS = Number(process.env.DSH_BRIDGE_WAIT_MS ?? '110000')
const RESTART = process.argv.includes('--restart')
const TREE_ID_FILE = path.join(DSH_DIR, '.tree-id')
const PAUSE_FILE = path.join(APP_DIR, 'upgrade.pause')
const FAILURE_FILE = path.join(APP_DIR, 'boot-failures.json')
const PREV_DIR = `${DSH_DIR}.prev`
const PATCH_SCRIPT = path.join(DSH_DIR, 'android-fix.mjs')
const MAX_CONSECUTIVE_FAILURES = 2
const PAUSE_MAX_AGE_MS = 30 * 60 * 1000

const URL_LINE = new RegExp(String.raw`^dsh web: (http://127\.0\.0\.1:${PORT}/\S+)`)

const log = (message) => process.stderr.write(`[ensure-server] ${message}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** @returns {Promise<boolean>} whether something is listening on the loopback port. */
function portOpen(port) {
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

/** How many historical token URLs one log may contribute, newest first. */
const MAX_CANDIDATES_PER_LOG = 8

/**
 * Every `dsh web:` line in one log file, newest first.
 *
 * The newest line is not automatically the live one: a process that lost the port race
 * still prints its token before reporting `startup failed`, and that line then sits at the
 * end of the log while a healthy server keeps running under an earlier one. Returning only
 * the last line made the bridge report "no usable token" (and the app fall back to a stale
 * cookie) for as long as that server lived. Callers validate each one in order.
 */
function urlsFromLog(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const urls = []
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0 && urls.length < MAX_CANDIDATES_PER_LOG; i -= 1) {
    const match = URL_LINE.exec(lines[i])
    if (match && !urls.includes(match[1])) urls.push(match[1])
  }
  return urls
}

function candidateUrls() {
  const urls = []
  const seenFiles = new Set()
  for (const file of [START_LOG, LEGACY_LOG]) {
    if (!file || seenFiles.has(file)) continue
    seenFiles.add(file)
    for (const url of urlsFromLog(file)) {
      if (!urls.includes(url)) urls.push(url)
    }
  }
  return urls
}

/**
 * A log line is only usable if the running server actually accepts it. Without
 * this check a stale log (server restarted by other means, or a wiped TMPDIR)
 * would hand the app a dead token and it would bounce off a 401.
 *
 * The timeout is not decoration: Android's cached-app freezer freezes Termux while
 * another app is on screen, and a frozen server keeps its listening socket but
 * answers nothing at all. Without a deadline this probe hangs inside the bridge —
 * past the handoff TTL and past the app's own wait — so the freeze presented as
 * "the app never gets past the splash" rather than as a slow start.
 */
async function tokenStillValid(candidate) {
  if (!candidate) return false
  try {
    const response = await fetch(candidate, {
      redirect: 'manual',
      signal: AbortSignal.timeout(Number(process.env.DSH_TOKEN_PROBE_MS ?? '5000')),
    })
    return response.status >= 300 && response.status < 400
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// install-tree generation
// ---------------------------------------------------------------------------

/**
 * Read this tree's generation marker.
 *
 * Trees installed before the marker existed have none. Writing one with
 * `installedAt: 0` keeps the timestamp rule from declaring the currently running
 * server stale (that would restart it for no reason); only servers started from
 * this script after that point carry a matching `DSH_TREE_ID`.
 */
function readGeneration() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TREE_ID_FILE, 'utf8'))
    if (parsed && typeof parsed.id === 'string' && parsed.id) return parsed
  } catch {
    /* no marker yet */
  }
  // Trees installed before the marker existed: derive the install time from the package
  // itself. It is written when the tree lands, so a server older than it must be serving
  // a replaced tree. (Using 0 here would disable the timestamp rule for exactly the trees
  // that were most likely to have been swapped by hand.)
  const installedAt = (() => {
    try {
      return fs.statSync(ENTRY.replace(/lib[\\/]bin\.js$/, 'package.json')).mtimeMs
    } catch {
      return 0
    }
  })()
  const version = (() => {
    try {
      return JSON.parse(fs.readFileSync(ENTRY.replace(/lib[\\/]bin\.js$/, 'package.json'), 'utf8')).version
    } catch {
      return undefined
    }
  })()
  const created = { id: crypto.randomUUID(), version, installedAt }
  try {
    fs.writeFileSync(TREE_ID_FILE, `${JSON.stringify(created, null, 2)}\n`)
    log(`tree-id: created a generation marker for a pre-existing tree (${created.id.slice(0, 8)}, installed ${new Date(installedAt).toISOString()})`)
  } catch (error) {
    log(`tree-id: could not write ${TREE_ID_FILE}: ${error.message}`)
  }
  return created
}

// ---------------------------------------------------------------------------
// process identity
// ---------------------------------------------------------------------------

/** pids running `dsh web` for this port (dsh defaults to 3080 without --port). */
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
    if ((portArg ? Number(portArg[1]) : 3080) === port) pids.push(pid)
  }
  return pids
}

/** Generation a server was started from, via DSH_TREE_ID in its environment. */
function processGeneration(pid) {
  try {
    const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
    return /(?:^|\0)DSH_TREE_ID=([^\0]+)/.exec(environ)?.[1]
  } catch {
    return undefined
  }
}

/**
 * Wall-clock start time of a process.
 *
 * `/proc/<pid>/stat` field 22 is in clock ticks since boot, and boot time comes from
 * `os.uptime()` rather than `/proc/stat` — Android denies `/proc/stat` to app UIDs
 * (EACCES), which would leave this rule silently dead exactly where it is needed.
 * CLK_TCK is 100 on this device (verified against a freshly spawned process);
 * override with CLK_TCK if a future kernel disagrees.
 */
function processStartMs(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const startTicks = Number(fields[19]) // field 22 overall
    if (!Number.isFinite(startTicks)) return undefined
    const clockTicks = Number(process.env.CLK_TCK ?? '100') || 100
    const bootMs = Date.now() - os.uptime() * 1000
    return bootMs + (startTicks / clockTicks) * 1000
  } catch {
    return undefined
  }
}

/**
 * Servers serving the port that belong to a different install generation.
 *
 * Two ways to be stale, both meaning "this process predates the tree on disk":
 *   - it reports a generation id that is not the current one, or
 *   - it predates the tree's installation time (so it can only be reading a mix).
 */
function staleServerProcesses(generation) {
  const stale = []
  for (const pid of serverProcesses(PORT)) {
    const reported = processGeneration(pid)
    if (reported) {
      if (reported !== generation.id) stale.push({ pid, reason: `generation ${reported.slice(0, 8)} != ${generation.id.slice(0, 8)}` })
      continue
    }
    const started = processStartMs(pid)
    if (generation.installedAt > 0 && started && started < generation.installedAt) {
      stale.push({ pid, reason: `started ${new Date(started).toISOString()} before the tree was installed` })
    }
  }
  return stale
}

/** Stop the given pids and wait for the port to be released. */
async function stopPids(pids, label) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
      log(`${label}: SIGTERM -> pid ${pid}`)
    } catch (error) {
      log(`${label}: could not signal pid ${pid}: ${error.message}`)
    }
  }
  const deadline = Date.now() + 12000
  while (Date.now() < deadline && (await portOpen(PORT))) await sleep(300)
  if (await portOpen(PORT)) {
    for (const pid of serverProcesses(PORT)) {
      try {
        process.kill(pid, 'SIGKILL')
        log(`${label}: SIGKILL -> pid ${pid}`)
      } catch {
        /* already gone */
      }
    }
    const forced = Date.now() + 8000
    while (Date.now() < forced && (await portOpen(PORT))) await sleep(200)
  }
  const released = !(await portOpen(PORT))
  log(`${label}: port ${PORT} ${released ? 'released' : 'STILL OPEN'}`)
  return released
}

/** Stop whatever is serving the port — only on an explicit --restart. */
async function stopExistingServer() {
  const victims = serverProcesses(PORT)
  if (victims.length === 0) {
    log('--restart requested but no matching server process was found')
    return
  }
  await stopPids(victims, '--restart')
}

// ---------------------------------------------------------------------------
// upgrade coordination
// ---------------------------------------------------------------------------

/** True while upgrade.mjs holds the tree (a fresh pause file is authoritative). */
function upgradeInProgress() {
  let stat
  try {
    stat = fs.statSync(PAUSE_FILE)
  } catch {
    return false
  }
  const age = Date.now() - stat.mtimeMs
  if (age > PAUSE_MAX_AGE_MS) {
    log(`upgrade.pause is ${Math.round(age / 60000)} min old; ignoring it`)
    return false
  }
  let detail = ''
  try {
    detail = fs.readFileSync(PAUSE_FILE, 'utf8').trim()
  } catch {
    /* unreadable but present and fresh */
  }
  log(`upgrade in progress (${PAUSE_FILE}: ${detail}); refusing to start a server`)
  return true
}

function readFailures() {
  try {
    return JSON.parse(fs.readFileSync(FAILURE_FILE, 'utf8'))
  } catch {
    return { count: 0, history: [] }
  }
}

function writeFailures(state) {
  try {
    fs.mkdirSync(APP_DIR, { recursive: true })
    fs.writeFileSync(FAILURE_FILE, `${JSON.stringify(state, null, 2)}\n`)
  } catch (error) {
    log(`could not write ${FAILURE_FILE}: ${error.message}`)
  }
}

function resetFailures() {
  try {
    fs.rmSync(FAILURE_FILE, { force: true })
  } catch {
    /* nothing to reset */
  }
}

function recordFailure(reason) {
  const state = readFailures()
  state.count = (state.count ?? 0) + 1
  state.history = [...(state.history ?? []), { at: new Date().toISOString(), reason: reason.slice(0, 300) }].slice(-10)
  writeFailures(state)
  log(`boot failure ${state.count}/${MAX_CONSECUTIVE_FAILURES}: ${reason.slice(0, 300)}`)
  return state
}

/**
 * Restore `<dsh>.prev`, re-patch it and start it.
 *
 * This is the last line of defence: if a tree cannot boot twice in a row, keeping the app
 * offline is worse than reverting to the previous version. upgrade.mjs normally rolls back
 * itself; this path covers trees installed by other means (npm, manual swap, plugin tooling).
 */
async function autoRollback(generation, reason) {
  if (!fs.existsSync(PREV_DIR)) {
    log('auto-rollback: no previous tree available')
    return undefined
  }
  log(`auto-rollback: ${reason}`)
  await stopPids(serverProcesses(PORT), 'auto-rollback')
  const failedDir = `${DSH_DIR}.failed-${Date.now()}`
  try {
    fs.renameSync(DSH_DIR, failedDir)
    fs.renameSync(PREV_DIR, DSH_DIR)
    log(`auto-rollback: failed tree parked at ${failedDir}`)
  } catch (error) {
    log(`auto-rollback: swap failed: ${error.message}`)
    return undefined
  }
  const previous = readGeneration()
  if (fs.existsSync(PATCH_SCRIPT)) {
    const patch = spawnSync(process.execPath, [PATCH_SCRIPT], { cwd: DSH_DIR, stdio: 'ignore' })
    log(`auto-rollback: android-fix.mjs exit ${patch.status}`)
  }
  const restoredPid = startServer(previous)
  if (!restoredPid) return undefined
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    for (const candidate of candidateUrls()) {
      if (await tokenStillValid(candidate)) {
        resetFailures()
        log(`auto-rollback: previous version is serving again (${candidate})`)
        return candidate
      }
    }
    await sleep(400)
  }
  log('auto-rollback: the restored tree did not produce a token either')
  return undefined
}

// ---------------------------------------------------------------------------
// server start
// ---------------------------------------------------------------------------

let startOffset = 0

function startServer(generation) {
  if (!fs.existsSync(ENTRY)) {
    log(`entry not found: ${ENTRY}`)
    return false
  }
  // Re-apply the Android compatibility patches: they are idempotent and a dsh
  // upgrade silently wipes them. Same step the desktop launcher performs.
  if (fs.existsSync(PATCH_SCRIPT)) {
    const result = spawnSync(process.execPath, [PATCH_SCRIPT], { cwd: DSH_DIR, stdio: 'ignore' })
    log(`android-fix.mjs exit ${result.status}`)
  }
  try {
    fs.mkdirSync(APP_DIR, { recursive: true })
  } catch {
    /* already there */
  }
  try {
    startOffset = fs.statSync(START_LOG).size
  } catch {
    startOffset = 0
  }
  const out = fs.openSync(START_LOG, 'a')
  // `detached` gives the server its own session, so Termux does not reap it when
  // this bridge command finishes.
  const child = spawn(
    process.execPath,
    [ENTRY, 'web', '--no-open', '--port', String(PORT)],
    {
      cwd: HOME,
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...process.env,
        DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? 'danger-full-access',
        DSH_TREE_ID: generation?.id ?? '',
      },
    },
  )
  child.unref()
  log(`spawned dsh web as pid ${child.pid} (generation ${(generation?.id ?? 'unset').slice(0, 8)}); log ${START_LOG}`)
  return child.pid
}

/** Output only from the boot this invocation started. */
function bootLogText() {
  try {
    const size = fs.statSync(START_LOG).size
    if (size <= startOffset) return ''
    const fd = fs.openSync(START_LOG, 'r')
    try {
      const buffer = Buffer.alloc(size - startOffset)
      fs.readSync(fd, buffer, 0, buffer.length, startOffset)
      return buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

/**
 * Wait for a usable token, bailing out early when this boot already printed a fatal
 * startup diagnostic or its process died — no point burning the app's whole wait on a
 * known-bad tree, and the failure counter has to advance while the user is still waiting.
 */
async function waitForToken(pid) {
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    const text = bootLogText()
    if (/dsh: startup failed/.test(text)) {
      return { url: undefined, failure: (/startup failed[\s\S]{0,600}/.exec(text)?.[0] ?? 'startup failed').replace(/\s+/g, ' ').slice(0, 400) }
    }
    if (pid && !processRunning(pid)) {
      const tail = text.trim().split('\n').slice(-4).join(' ').slice(0, 300)
      return { url: undefined, failure: `server process exited before producing a token${tail ? ` — ${tail}` : ''}` }
    }
    for (const candidate of candidateUrls()) {
      if (await tokenStillValid(candidate)) return { url: candidate }
    }
    await sleep(400)
  }
  return { url: undefined, failure: 'timed out waiting for a usable token URL' }
}

/** Whether a pid still exists (signal 0 probe). */
function processRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const generation = readGeneration()
log(`install ${DSH_DIR} (generation ${generation.id.slice(0, 8)})`)

if (upgradeInProgress()) {
  // The app must not race the upgrade script for the port or the tree.
  process.stdout.write('\n')
  process.exit(0)
}

const alreadyRunning = await portOpen(PORT)
log(alreadyRunning ? `port ${PORT} already open` : `port ${PORT} closed`)

if (alreadyRunning && !RESTART) {
  const stale = staleServerProcesses(generation)
  if (stale.length > 0) {
    for (const entry of stale) log(`stale server pid ${entry.pid}: ${entry.reason}`)
    await stopPids(stale.map((entry) => entry.pid), 'stale-generation')
  } else {
    const candidates = candidateUrls()
    log(`token candidates found in logs: ${candidates.length}`)
    for (const candidate of candidates) {
      if (await tokenStillValid(candidate)) {
        resetFailures()
        process.stdout.write(`${candidate}\n`)
        process.exit(0)
      }
    }
    log('server is up but no usable token in any log; app falls back to its cookie')
    process.stdout.write('\n')
    process.exit(0)
  }
}

if (alreadyRunning && RESTART) await stopExistingServer()
const serverPid = startServer(generation)
if (!serverPid) {
  process.stdout.write('\n')
  process.exit(0)
}

const outcome = await waitForToken(serverPid)
if (outcome.url) {
  resetFailures()
  process.stdout.write(`${outcome.url}\n`)
  process.exit(0)
}

log(`boot failed: ${outcome.failure}`)
const failures = recordFailure(outcome.failure ?? 'unknown')
if (failures.count >= MAX_CONSECUTIVE_FAILURES) {
  const restored = await autoRollback(generation, `tree failed to boot ${failures.count} times in a row`)
  if (restored) {
    process.stdout.write(`${restored}\n`)
    process.exit(0)
  }
}
process.stdout.write('\n')
