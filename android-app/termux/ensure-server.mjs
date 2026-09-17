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
const WAIT_MS = Number(process.env.DSH_BRIDGE_WAIT_MS ?? '90000')
const RESTART = process.argv.includes('--restart')

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

/** Last `dsh web:` line in one log file — the live process's token URL. */
function urlFromLog(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = URL_LINE.exec(lines[i])
    if (match) return match[1]
  }
  return ''
}

function candidateUrls() {
  const urls = []
  const seenFiles = new Set()
  for (const file of [START_LOG, LEGACY_LOG]) {
    if (!file || seenFiles.has(file)) continue
    seenFiles.add(file)
    const url = urlFromLog(file)
    if (url && !urls.includes(url)) urls.push(url)
  }
  return urls
}

/**
 * A log line is only usable if the running server actually accepts it. Without
 * this check a stale log (server restarted by other means, or a wiped TMPDIR)
 * would hand the app a dead token and it would bounce off a 401.
 */
async function tokenStillValid(candidate) {
  if (!candidate) return false
  try {
    const response = await fetch(candidate, { redirect: 'manual' })
    return response.status >= 300 && response.status < 400
  } catch {
    return false
  }
}

/** Stop whatever is serving the port — only on an explicit --restart. */
async function stopExistingServer() {
  const listing = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' })
  const victims = []
  for (const line of (listing.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const args = match[2]
    if (pid === process.pid) continue
    if (!args.includes(ENTRY) || !args.includes('web')) continue
    victims.push(pid)
  }
  if (victims.length === 0) {
    log('--restart requested but no matching server process was found')
    return
  }
  for (const pid of victims) {
    try {
      process.kill(pid, 'SIGTERM')
      log(`--restart: SIGTERM -> pid ${pid}`)
    } catch (error) {
      log(`--restart: could not signal pid ${pid}: ${error.message}`)
    }
  }
  const deadline = Date.now() + 10000
  while (Date.now() < deadline && (await portOpen(PORT))) await sleep(300)
  log((await portOpen(PORT)) ? '--restart: port still busy' : '--restart: port released')
}

function startServer() {
  if (!fs.existsSync(ENTRY)) {
    log(`entry not found: ${ENTRY}`)
    return false
  }
  // Re-apply the Android compatibility patches: they are idempotent and a dsh
  // upgrade silently wipes them. Same step the desktop launcher performs.
  const patch = path.join(DSH_DIR, 'android-fix.mjs')
  if (fs.existsSync(patch)) {
    const result = spawnSync(process.execPath, [patch], { cwd: DSH_DIR, stdio: 'ignore' })
    log(`android-fix.mjs exit ${result.status}`)
  }
  try {
    fs.mkdirSync(APP_DIR, { recursive: true })
  } catch {
    /* already there */
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
      },
    },
  )
  child.unref()
  log(`spawned dsh web as pid ${child.pid}; log ${START_LOG}`)
  return true
}

const alreadyRunning = await portOpen(PORT)
log(alreadyRunning ? `port ${PORT} already open` : `port ${PORT} closed`)

if (alreadyRunning && !RESTART) {
  const candidates = candidateUrls()
  log(`token candidates found in logs: ${candidates.length}`)
  for (const candidate of candidates) {
    if (await tokenStillValid(candidate)) {
      process.stdout.write(`${candidate}\n`)
      process.exit(0)
    }
  }
  log('server is up but no usable token in any log; app falls back to its cookie')
  process.stdout.write('\n')
  process.exit(0)
}

if (alreadyRunning && RESTART) await stopExistingServer()
if (!startServer()) {
  process.stdout.write('\n')
  process.exit(0)
}

const deadline = Date.now() + WAIT_MS
while (Date.now() < deadline) {
  for (const candidate of candidateUrls()) {
    if (await tokenStillValid(candidate)) {
      process.stdout.write(`${candidate}\n`)
      process.exit(0)
    }
  }
  await sleep(400)
}

log('timed out waiting for a usable token URL')
process.stdout.write('\n')
