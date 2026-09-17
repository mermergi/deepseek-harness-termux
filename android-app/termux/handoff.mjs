/**
 * One-shot loopback endpoint that hands the process-token URL to the DSH app.
 *
 * Usage: node handoff.mjs <url> <key> [port]
 *
 * GET /handoff with `X-Dsh-Key: <key>` answers with the URL (or `NO_TOKEN` when
 * the bridge could not obtain one). The endpoint stops after the first
 * successful hand-off, or after 90 seconds, whichever comes first — it must not
 * become a permanent way for any local app to read the token.
 */
import fs from 'node:fs'
import http from 'node:http'

const url = process.argv[2] ?? ''
const key = process.argv[3] ?? ''
const port = Number(process.argv[4] ?? '3099')
const ttlMs = Number(process.env.DSH_HANDOFF_TTL_MS ?? '90000')

if (!key) {
  process.stderr.write('[handoff] refusing to start without a shared key\n')
  process.exit(2)
}

const pidFile = process.env.DSH_HANDOFF_PID_FILE
if (pidFile) {
  try {
    fs.writeFileSync(pidFile, String(process.pid))
  } catch {
    /* best effort */
  }
}

let served = false
const finish = () => {
  if (pidFile) {
    try {
      fs.unlinkSync(pidFile)
    } catch {
      /* best effort */
    }
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
}

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' || !(request.url ?? '').startsWith('/handoff')) {
    response.writeHead(404).end()
    return
  }
  if (request.headers['x-dsh-key'] !== key) {
    response.writeHead(403).end()
    return
  }
  served = true
  response.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(url || 'NO_TOKEN'),
  })
  response.end(url || 'NO_TOKEN')
  setTimeout(finish, 300).unref()
})

server.on('error', (error) => {
  process.stderr.write(`[handoff] ${error.message}\n`)
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`[handoff] listening on 127.0.0.1:${port} (has url: ${url ? 'yes' : 'no'})\n`)
})

setTimeout(() => {
  if (!served) process.stderr.write('[handoff] expiring without a hand-off\n')
  finish()
}, ttlMs).unref()
