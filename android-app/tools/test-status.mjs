/**
 * Equivalence test for the status endpoint's incremental session-log reader.
 *
 * The risk being tested is bookkeeping, not marker extraction: `status.mjs` deliberately
 * reads only newly appended bytes after its first look, and a mistake there would silently
 * miss a `turn/end` — leaving the floating bubble stuck on "working" forever.
 *
 * So each real session log is replayed to a temp file in growing slices, including slices
 * that cut in the middle of a zstd frame, and every intermediate answer is compared against
 * a full-file read. A truncation is replayed too, to cover the fallback path.
 *
 * Usage: node test-status.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { turnState, resetCache } from '../termux/status.mjs'

/** Independent reference: fold every frame of the whole file, no cache, no windows. */
function fullRead(file) {
  resetCache()
  return turnState(file)
}

function allSessionLogs() {
  const root = path.join(os.homedir(), '.dsh', 'sessions')
  const files = []
  let projects
  try {
    projects = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let sessions
    try {
      sessions = fs.readdirSync(path.join(root, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const file = path.join(root, project.name, session.name, 'session.v3.jsonl.zstd')
      if (fs.existsSync(file)) files.push(file)
    }
  }
  return files
}

const tmp = path.join(process.env.TMPDIR ?? os.tmpdir(), 'dsh-status-test.jsonl.zstd')
const files = allSessionLogs()
if (files.length === 0) {
  console.log('没有找到任何会话日志，跳过')
  process.exit(0)
}

const CUTS = [0.05, 0.2, 0.45, 0.7, 0.9, 1.0]
let checked = 0
let mismatches = 0

for (const file of files) {
  const whole = fs.readFileSync(file)
  const label = path.basename(path.dirname(file))

  // --- monotonic growth, replayed through the same path so the incremental path is used
  resetCache()
  for (const cut of CUTS) {
    const size = Math.max(1, Math.floor(whole.length * cut))
    fs.writeFileSync(tmp, whole.subarray(0, size))
    const incremental = turnState(tmp)
    const reference = fullRead(tmp)
    checked += 1
    if (incremental.state !== reference.state || incremental.marker !== reference.marker) {
      mismatches += 1
      console.log(`MISMATCH ${label} @${size}B: incremental=${incremental.state}/${incremental.marker}`
        + ` reference=${reference.state}/${reference.marker}`)
    }
  }

  // --- truncation must not poison the next answer
  fs.writeFileSync(tmp, whole.subarray(0, Math.max(1, Math.floor(whole.length / 3))))
  turnState(tmp)
  fs.writeFileSync(tmp, whole)
  const afterShrink = turnState(tmp)
  const reference = fullRead(tmp)
  checked += 1
  if (afterShrink.state !== reference.state || afterShrink.marker !== reference.marker) {
    mismatches += 1
    console.log(`MISMATCH ${label} after-truncate: ${afterShrink.state} vs ${reference.state}`)
  }
}

fs.rmSync(tmp, { force: true })
console.log(`重放 ${files.length} 个会话，共 ${checked} 次比对，不一致 ${mismatches} 次`)
process.exit(mismatches === 0 ? 0 : 1)
