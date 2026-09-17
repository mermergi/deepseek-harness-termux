/**
 * DSH work-status endpoint for the Android app's floating bubble.
 *
 * `GET /status` (header `X-Dsh-Key`) answers with JSON:
 *   { "serverUp": true, "state": "working" | "idle" | "unknown", "marker": "turn/start", "ageMs": 1234 }
 *
 * How "working" is decided — the honest version:
 *
 *   The session log is a chain of concatenated zstd frames, one per append, each holding
 *   jsonl records. The newest session's *last* `turn/start` / `turn/end` wins: an open
 *   turn means the agent is still busy. That covers the three cases a naive "did the file
 *   change recently" heuristic gets wrong:
 *
 *     - waiting on the model (tens of seconds, no writes at all)
 *     - a long tool call (observed: 25s of total silence in the log)
 *     - streaming (writes constantly)
 *
 *   Measured with a 1 Hz probe: 03:04:06 -> 03:04:30 produced zero writes during one
 *   `sleep 25` tool call, so mtime recency alone is definitely not enough.
 *
 * Cost control, in three layers (each one was needed; the measurements are in the README):
 *
 *   1. Frames are located by scanning for the zstd magic and decompressing candidate
 *      frames; a wrong candidate fails its checksum and is skipped. A full decode of the
 *      live file is ~670 frames of compressed data and far too slow for a 2s poll.
 *   2. The first look at a file reads a 64 KB tail and doubles the window until a turn
 *      marker shows up. A fixed window is wrong: a long turn pushed its `turn/start`
 *      1 MB back, which a 64 KB tail reported as `unknown`.
 *   3. Afterwards only the newly appended bytes are scanned. Re-scanning the 1 MB window
 *      on every change measured 94 ms per poll — worse than not optimising at all.
 *      `scannedUpTo` is rewound to the last frame start seen, so a frame that was still
 *      being written is simply re-read next time instead of being skipped forever.
 *
 * Usage: node status.mjs <port> <key>
 * Self-terminates after 15 minutes without a request, so it costs nothing once the app
 * stops polling.
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const TAIL_BYTES = 64 * 1024
const MAX_WINDOW = 8 * 1024 * 1024

/** Per-file incremental state. Only the newest session is ever watched in practice. */
const cache = {
  file: null,
  size: -1,
  mtimeMs: -1,
  state: 'unknown',
  marker: null,
  /** Absolute offset worth re-reading from; the start of the last frame we saw. */
  scannedUpTo: -1,
}

/** Test hook: forget everything learned about the current file. */
export function resetCache() {
  cache.file = null
  cache.size = -1
  cache.mtimeMs = -1
  cache.state = 'unknown'
  cache.marker = null
  cache.scannedUpTo = -1
}

/** Every offset where a zstd frame could start, oldest first. */
function frameOffsets(buffer) {
  const offsets = []
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1]
        && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]) {
      offsets.push(i)
    }
  }
  return offsets
}

/** Record `"type"` values inside one decompressed frame, in order. */
function typesInFrame(text) {
  const types = []
  for (const line of text.split('\n')) {
    const at = line.indexOf('"type":"')
    if (at === -1) continue
    const end = line.indexOf('"', at + 8)
    if (end !== -1) types.push(line.slice(at + 8, end))
  }
  return types
}

/** Read `[start, end)` of a file. */
function readRange(file, start, end) {
  const length = Math.max(0, end - start)
  const buffer = Buffer.allocUnsafe(length)
  if (length === 0) return buffer
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, buffer, 0, length, start)
  } finally {
    fs.closeSync(fd)
  }
  return buffer
}

/**
 * Fold every turn marker in `buffer` into `previous`, oldest to newest, so the last one wins.
 * @returns {{state: string, marker: string|null}}
 */
function applyMarkers(buffer, previous) {
  let result = previous
  for (const offset of frameOffsets(buffer)) {
    let types
    try {
      types = typesInFrame(zlib.zstdDecompressSync(buffer.subarray(offset)).toString('utf8'))
    } catch {
      continue // a magic-shaped byte pattern inside compressed data, or a half-written frame
    }
    for (const type of types) {
      if (type === 'turn/start') result = { state: 'working', marker: 'turn/start' }
      else if (type === 'turn/end') result = { state: 'idle', marker: 'turn/end' }
    }
  }
  return result
}

/** Offset of the last frame start in `buffer`, or -1. */
function lastFrameOffset(buffer) {
  for (let i = buffer.length - 4; i >= 0; i -= 1) {
    if (buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1]
        && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]) {
      return i
    }
  }
  return -1
}

/**
 * The newest turn marker in a session log.
 * @returns {{state: string, marker: string|null}}
 */
export function turnState(file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return { state: 'unknown', marker: null }
  }

  if (cache.file === file && cache.size === stat.size && cache.mtimeMs === stat.mtimeMs) {
    return { state: cache.state, marker: cache.marker }
  }

  const known = { state: cache.state, marker: cache.marker }
  let result = null

  if (cache.file === file && cache.scannedUpTo >= 0 && stat.size > cache.scannedUpTo) {
    // Steady state: only the bytes appended since the last look.
    const start = cache.scannedUpTo
    const buffer = readRange(file, start, stat.size)
    result = applyMarkers(buffer, known)
    const last = lastFrameOffset(buffer)
    // Rewind to the last frame start: if that frame was still being written, the next
    // poll re-reads it complete instead of silently dropping its records.
    if (last >= 0) cache.scannedUpTo = start + last
  } else {
    // First sight, different file, or a shrink: widen the window until a marker appears.
    let window = TAIL_BYTES
    let base = Math.max(0, stat.size - Math.min(stat.size, window))
    let seeded = { state: 'unknown', marker: null }
    for (;;) {
      const size = Math.min(stat.size, window)
      base = stat.size - size
      let buffer
      try {
        buffer = readRange(file, base, stat.size)
      } catch {
        break
      }
      seeded = applyMarkers(buffer, { state: 'unknown', marker: null })
      const last = lastFrameOffset(buffer)
      if (last >= 0) cache.scannedUpTo = base + last
      if (seeded.marker !== null) break
      if (window >= stat.size || window >= MAX_WINDOW) break
      window *= 2
    }
    if (cache.scannedUpTo < 0) cache.scannedUpTo = base
    result = seeded
  }

  cache.file = file
  cache.size = stat.size
  cache.mtimeMs = stat.mtimeMs
  cache.state = result.state
  cache.marker = result.marker
  return result
}

/** Newest session log anywhere under ~/.dsh/sessions (the one the user is driving). */
export function newestSessionLog(sessionsDir) {
  let best = null
  let projects
  try {
    projects = fs.readdirSync(sessionsDir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let sessions
    try {
      sessions = fs.readdirSync(path.join(sessionsDir, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const file = path.join(sessionsDir, project.name, session.name, 'session.v3.jsonl.zstd')
      try {
        const stat = fs.statSync(file)
        if (best === null || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs }
      } catch {
        /* not every session directory has a log */
      }
    }
  }
  return best
}

// ------------------------------------------------------------------ server

/** @returns {Promise<boolean>} whether the dsh web server is listening on loopback. */
function serverUp(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const settle = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
    socket.setTimeout(500, () => settle(false))
  })
}

async function main() {
  const port = Number(process.argv[2] ?? '3098')
  const key = process.argv[3] ?? ''
  const home = process.env.HOME ?? os.homedir()
  const sessionsDir = process.env.DSH_SESSIONS_DIR ?? path.join(home, '.dsh', 'sessions')
  const dshPort = Number(process.env.DSH_PORT ?? '3080')
  const idleExitMs = Number(process.env.DSH_STATUS_TTL_MS ?? '900000')

  const log = (message) => {
    const stamp = new Date().toTimeString().slice(0, 8)
    process.stderr.write(`[status ${stamp}] ${message}\n`)
  }

  if (!key) {
    log('refusing to start without a shared key')
    process.exit(2)
  }

  // The app posts a diagnostic line on every touch, so this log only grows. Bound it: keep the
  // recent tail and drop the rest. The shell holds the file open in append mode, which is fine —
  // O_APPEND always writes at the new end.
  try {
    const logFile = path.join(home, '.dsh-app', 'status.log')
    const stat = fs.statSync(logFile)
    if (stat.size > 256 * 1024) {
      const buffer = fs.readFileSync(logFile)
      fs.writeFileSync(logFile, buffer.subarray(buffer.length - 64 * 1024))
    }
  } catch {
    /* first run, or no permission — nothing to trim */
  }

  async function computeStatus() {
    const up = await serverUp(dshPort)
    const newest = newestSessionLog(sessionsDir)
    if (!newest) return { serverUp: up, state: 'unknown', marker: null, ageMs: null }
    const turn = turnState(newest.file)
    return {
      serverUp: up,
      state: turn.state,
      marker: turn.marker,
      ageMs: Date.now() - newest.mtimeMs,
      session: path.basename(path.dirname(newest.file)),
    }
  }

  let idleTimer = null
  let lastLogged = null
  let requests = 0
  const armIdleExit = () => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      log(`no requests for ${Math.round(idleExitMs / 1000)}s; exiting`)
      process.exit(0)
    }, idleExitMs)
    idleTimer.unref?.()
  }

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    // Diagnostic sink: the app has no readable log of its own (logcat only exposes Termux's
    // own processes, /sdcard/Android/data is off limits), so the bubble posts the numbers that
    // drive its snap decision here and they land in this log.
    if (requestUrl.pathname === '/diag') {
      if (request.headers['x-dsh-key'] !== key) {
        response.writeHead(403).end()
        return
      }
      armIdleExit()
      log(`diag: ${requestUrl.searchParams.get('msg') ?? ''}`)
      response.writeHead(204).end()
      return
    }
    if (request.method !== 'GET' || !(request.url ?? '').startsWith('/status')) {
      response.writeHead(404).end()
      return
    }
    if (request.headers['x-dsh-key'] !== key) {
      response.writeHead(403).end()
      return
    }
    armIdleExit()
    let status
    try {
      status = await computeStatus()
    } catch (error) {
      status = { serverUp: false, state: 'unknown', error: String(error?.message ?? error) }
    }
    // Only transitions and a rare heartbeat are logged: polling is every 2s.
    const summary = `${status.state}${status.serverUp ? '' : ' (server down)'}`
    requests += 1
    if (summary !== lastLogged) {
      log(`state -> ${summary}${status.marker ? ` [${status.marker}]` : ''}`)
      lastLogged = summary
    } else if (requests % 30 === 0) {
      log(`heartbeat: ${requests} requests, still ${summary}`)
    }
    const body = JSON.stringify(status)
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
  })

  server.on('error', (error) => {
    // Two starts can race (a foreground nudge plus the poller's first retry). Losing that
    // race just means another instance is already serving; that is a success, not a failure.
    if (error.code === 'EADDRINUSE') {
      log(`port ${port} already served by another instance; exiting quietly`)
      process.exit(0)
    }
    log(error.message)
    process.exit(1)
  })

  server.listen(port, '127.0.0.1', () => {
    log(`listening on 127.0.0.1:${port}`)
    armIdleExit()
  })
}

const entry = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href
if (import.meta.url === entry) main()
