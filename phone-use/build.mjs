#!/usr/bin/env node
// PhoneUse build step.
//
// The dynamic-host body (`host.js`) is the source of truth: it is the exact code
// that was run and verified through the Cordis toolset. This script turns it into
// a real Cordis plugin module for a durable preset, mechanically — the tools are
// never hand-copied, so the shipped plugin cannot drift from the verified body.
//
// The only transformation is the registration call: the sandbox hands a dynamic
// host `harness.registerTool(ctx, harness.defineTool(…))`, while a real plugin
// calls `ctx.tools.register(defineTool(…))` with the same definition object.
//
// `defineTool` is imported by absolute path because a preset-relative module
// lives outside any node_modules tree, so a bare `@deepseek-ai/dsh-tools`
// specifier would not resolve from there. The path is discovered at build time.
//
// Usage: node phone-use/build.mjs [--out <dir>]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Locate the harness's own `dsh-tools` build inside the deployment. */
function findDshTools() {
  const roots = [process.env.DSH_DIR, process.env.HOME === undefined ? undefined : join(process.env.HOME, 'dsh')]
  for (const root of roots) {
    if (root === undefined || root === '') continue
    const candidate = join(root, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
    if (existsSync(candidate)) return resolve(candidate)
  }
  throw new Error('build: cannot find @deepseek-ai/dsh-tools; set DSH_DIR to the harness install directory')
}

/** One tool registration in the dynamic body, rewritten for a real plugin. */
const REGISTRATION = /harness\.registerTool\(ctx, harness\.defineTool\(/g

function generate() {
  const body = readFileSync(join(here, 'host.js'), 'utf8')
  const rewritten = body.replace(REGISTRATION, 'ctx.tools.register(defineTool(')
  const rewrites = (body.match(REGISTRATION) ?? []).length
  if (rewrites === 0) {
    throw new Error('build: no dynamic tool registration found in host.js — refusing to emit a plugin with no tools')
  }
  const tools = findDshTools()
  const source = `// GENERATED FILE — do not edit here.
// Source of truth: phone-use/host.js. Rebuild: node phone-use/build.mjs
// ${String(rewrites)} tool registrations rewritten from the dynamic host form.
import { defineTool } from ${JSON.stringify(tools)}

/** The verified dynamic-host body, evaluated once into a plugin object. */
function build() {
${rewritten}
}

const plugin = build()

const name = 'phone-use'
const inject = ['tools']

function apply(ctx) {
  return plugin.apply(ctx)
}

export { apply, inject, name }
`
  return { source, rewrites, tools }
}

const outIndex = process.argv.indexOf('--out')
const outDir = outIndex === -1
  ? join(here, 'dsh-plugin-phone-use')
  : resolve(process.argv[outIndex + 1])

const { source, rewrites, tools } = generate()
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'index.js'), source)
writeFileSync(join(outDir, 'package.json'), JSON.stringify({
  name: 'dsh-plugin-phone-use',
  version: '1.0.0',
  private: true,
  type: 'module',
  main: 'index.js',
  description: 'PhoneUse: adb-backed Android screen, UI-tree, and touch tools for one DSH session.',
}, null, 2) + '\n')

console.log('phone-use build: ' + String(rewrites) + ' registrations rewritten')
console.log('  defineTool from ' + tools)
console.log('  wrote ' + join(outDir, 'index.js'))
