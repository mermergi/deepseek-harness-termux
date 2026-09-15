// Android/Termux compatibility fixes for this dsh install.
// Idempotent: safe to run before every launch (the launcher script does).
//
// Three unrelated Android limitations are handled here; each is listed with the
// reason it exists and what it costs. `DSH_PERMISSION_MODE` is not a patch: the
// shipped profile already reads it, and the launcher sets it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const nodeModules = join(root, 'node_modules')
const problems = []

// 1. flock: @deepseek-ai/node-addon-system ships prebuilt bindings for
// linux/darwin only, so session write-open throws ERR_FLOCK_UNSUPPORTED_PLATFORM
// on android. Upstream stubs the same entry to immediate success for its
// single-process browser worker; do the same here. The lock only guards against
// two *processes* writing one session, and bionic offers no prebuilt to load.
const flockPath = join(nodeModules, '@deepseek-ai', 'node-addon-system', 'lib', 'flock.js')
if (existsSync(flockPath)) {
  const source = readFileSync(flockPath, 'utf8')
  if (!source.includes('ANDROID_STUB')) {
    const anchor = 'export async function tryLockExclusive(fd) {'
    if (source.includes(anchor)) {
      writeFileSync(
        flockPath,
        source.replace(
          anchor,
          `${anchor}\n    if (process.platform === 'android') return; // ANDROID_STUB: no bionic prebuilt; single-process host`,
        ),
      )
      console.log('flock: session write lock stubbed for android')
    } else {
      problems.push(`flock: anchor missing in ${flockPath}`)
    }
  }
} else {
  problems.push(`flock: ${flockPath} missing`)
}

// 2. Hard-link publication. Several writers publish a fully written temp file by
// hard-linking it onto its final name, which is atomic and refuses to clobber.
// Android denies hard links anywhere an app may write (SELinux, app data), so
// every one of them fails with EACCES. Platforms that permit hard links keep
// the original primitive untouched; where the link is refused, the fallback
// depends on whether the published name must outlive its source:
//
//   - the source is a temp this call is done with, and the target should appear
//     atomically  -> rename, after re-checking the target (see `helper`)
//   - the source must survive the call (an alias for an existing immutable
//     object, or a call site followed by unlink(source))  -> exclusive copy
//     (see `copyHelper`). Renaming there MOVES the source away, which either
//     destroys the canonical object or strands the follow-up unlink.
const helper = (signature, linkCall) => `/** ANDROID_PATCH: android denies hard links, so publish by rename instead. */
async function ${signature} {
        try {
                await ${linkCall};
                return;
        } catch (error) {
                const code = error?.code;
                if (code !== "EACCES" && code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS") throw error;
        }
        try {
                await lstat(target);
        } catch (error) {
                if (error?.code === "ENOENT") {
                        await rename(source, target);
                        return;
                }
                throw error;
        }
        throw Object.assign(new Error(\`EEXIST: file already exists, link '\${source}' -> '\${target}'\`), {
                code: "EEXIST",
                errno: -17,
                syscall: "link",
                path: target
        });
}
`

const copyHelper = `/** ANDROID_PATCH: android denies hard links; publish by exclusive copy that keeps the source. */
async function copyOrLink(source, target) {
        try {
                await link(source, target);
                return;
        } catch (error) {
                const code = error?.code;
                if (code !== "EACCES" && code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS") throw error;
        }
        await copyFile(source, target, constants.COPYFILE_EXCL);
        const handle = await open(target, "r");
        try {
                await handle.sync();
        } finally {
                await handle.close();
        }
}
`

const linkPatches = [
  {
    strategy: 'rename (source is a disposable temp)',
    path: join(nodeModules, '@deepseek-ai', 'dsh-session-persistence-jsonl', 'lib', 'index.js'),
    importFrom: ', readdir, realpath,',
    importTo: ', readdir, rename, realpath,',
    helper: helper('linkOrRename(source, target)', 'link(source, target)'),
    sites: [
      ['await internals.fs.link(staged, currentPath);', 'await linkOrRename(staged, currentPath);'],
      ['await link(tmp, finalPath);', 'await linkOrRename(tmp, finalPath);'],
    ],
  },
  {
    strategy: 'rename (source is a disposable temp)',
    path: join(nodeModules, '@deepseek-ai', 'dsh-fs-local', 'lib', 'index.js'),
    helper: helper('linkFileOrRename(linkFile, source, target)', 'linkFile(source, target)'),
    sites: [['await linkFile(tempPath, absolutePath);', 'await linkFileOrRename(linkFile, tempPath, absolutePath);']],
  },
  {
    strategy: 'exclusive copy (source must survive the call)',
    path: join(nodeModules, '@deepseek-ai', 'dsh-attachment-local', 'lib', 'index.js'),
    importFrom: '{ chmod, link, mkdir, open, readFile, rename, rm, unlink, writeFile }',
    importTo: '{ chmod, copyFile, link, mkdir, open, readFile, rename, rm, unlink, writeFile }',
    helper: copyHelper,
    sites: [
      ['await link(source, target);', 'await copyOrLink(source, target);'],
      ['await link(staged.path, target);', 'await copyOrLink(staged.path, target);'],
    ],
  },
]

for (const patch of linkPatches) {
  if (!existsSync(patch.path)) {
    problems.push(`hard links: ${patch.path} missing`)
    continue
  }
  const source = readFileSync(patch.path, 'utf8')
  if (source.includes('ANDROID_PATCH')) continue
  const missing = patch.sites.filter(([from]) => !source.includes(from)).map(([from]) => from)
  if (patch.importFrom !== undefined && !source.includes(patch.importFrom)) {
    missing.push(patch.importFrom)
  }
  if (missing.length > 0) {
    problems.push(`hard links: missing ${JSON.stringify(missing)} in ${patch.path}`)
    continue
  }
  let patched = source
  if (patch.importFrom !== undefined) patched = patched.replace(patch.importFrom, patch.importTo)
  for (const [from, to] of patch.sites) patched = patched.replace(from, to)
  // Function declarations hoist, so the helper can live past every call site.
  writeFileSync(patch.path, `${patched}\n${patch.helper}`)
  console.log(`hard links: ${patch.strategy} in ${patch.path.slice(root.length + 1)}`)
}

// 3. sharp: no android-arm64 prebuilt exists, so the WebAssembly build must be
// installed alongside it or the attachment plugin fails the whole boot.
if (!existsSync(join(nodeModules, '@img', 'sharp-wasm32'))) {
  problems.push(`sharp: run "npm install @img/sharp-wasm32 sharp" in ${root}`)
}

// 4. The shipped web profile defaults to patchReload "live", which loads
// cordis-plugin-hmr at boot. That plugin needs --expose-internals or the
// android-less node-addon-require-builtin, so it aborts the launch. "startup"
// drops the live watchers and the plugin with them.
const profilesDir = join(homedir(), '.dsh', 'profiles')
if (existsSync(profilesDir)) {
  for (const name of readdirSync(profilesDir)) {
    const manifest = join(profilesDir, name, 'package.json')
    if (!existsSync(manifest)) continue
    const source = readFileSync(manifest, 'utf8')
    const patched = source.replace(/"patchReload"\s*:\s*"live"/, '"patchReload": "startup"')
    if (patched !== source) {
      writeFileSync(manifest, patched)
      console.log(`profile ${name}: patchReload live -> startup`)
    }
  }
}

// 5. Attachment durability walk. Before an attachment is published, the store
// fsyncs every ancestor directory up to the filesystem root so a crash cannot
// drop a directory entry. Android's /data/data is mode 0771: an app may
// traverse it but not open it, so that walk dies with
// `EACCES: permission denied, open '/data/data'` and every image send is
// rejected. An ancestor we cannot open is not ours to sync — the OS created it
// long ago, and every directory the store actually creates is still synced —
// so treat an unopenable ancestor as already durable and keep walking.
const walkPath = join(nodeModules, '@deepseek-ai', 'dsh-attachment-local', 'lib', 'index.js')
const WALK_MARKER = 'ANDROID_PATCH_WALK'
if (existsSync(walkPath)) {
  const source = readFileSync(walkPath, 'utf8')
  if (!source.includes(WALK_MARKER)) {
    // The bundled file mixes tabs and spaces, so match on the trimmed statement
    // and rebuild the block using whatever indentation that line already had.
    const statement = 'const handle = await open(path, constants.O_RDONLY);'
    const lines = source.split('\n')
    const hits = lines
      .map((line, index) => (line.trim() === statement ? index : -1))
      .filter((index) => index >= 0)
    if (hits.length !== 1) {
      problems.push(`durability walk: expected 1 open() statement in ${walkPath}, found ${hits.length}`)
    } else {
      const at = hits[0]
      const line = lines[at]
      const indent = line.slice(0, line.length - line.trimStart().length)
      const unit = indent.includes('\t') ? '\t' : '    '
      const guard = [
        `${indent}// ${WALK_MARKER}: an ancestor the app cannot open is not ours to sync.`,
        `${indent}let handle;`,
        `${indent}try {`,
        `${indent}${unit}handle = await open(path, constants.O_RDONLY);`,
        `${indent}} catch (error) {`,
        `${indent}${unit}const code = error?.code;`,
        `${indent}${unit}if (code === "EACCES" || code === "EPERM") return;`,
        `${indent}${unit}throw error;`,
        `${indent}}`,
      ]
      lines.splice(at, 1, ...guard)
      writeFileSync(walkPath, lines.join('\n'))
      console.log('durability walk: unopenable ancestors no longer fail attachment writes')
    }
  }
} else {
  problems.push(`durability walk: ${walkPath} missing`)
}

// 6. ripgrep for the glob/grep tools. dsh-tool-fs-search spawns the platform
// build that `@vscode/ripgrep` selects, and that package publishes macOS, Linux
// and Windows builds only — there is no @vscode/ripgrep-android-arm64, so the
// import throws and every `glob`/`grep` call fails with
// `SEARCH_FAILED: ... (ripgrep launch failed)`. Fall back to an `rg` on PATH
// (Termux ships an android-native one as `pkg install ripgrep`); platforms with
// a packaged build keep using the pinned binary exactly as before.
const searchPath = join(nodeModules, '@deepseek-ai', 'dsh-tool-fs-search', 'lib', 'index.js')
const SEARCH_MARKER = 'ANDROID_PATCH_RG'
if (existsSync(searchPath)) {
  const source = readFileSync(searchPath, 'utf8')
  if (!source.includes(SEARCH_MARKER)) {
    const importFrom = 'import { existsSync } from "node:fs";'
    const importTo = 'import { accessSync, constants, existsSync } from "node:fs";'
    const statement = 'return (await import("@vscode/ripgrep")).rgPath;'
    const lines = source.split('\n')
    const hits = lines
      .map((line, index) => (line.trim() === statement ? index : -1))
      .filter((index) => index >= 0)
    const problemsHere = []
    if (!source.includes(importFrom)) problemsHere.push('node:fs import')
    if (hits.length !== 1) problemsHere.push(`one packaged-rg return (found ${hits.length})`)
    if (problemsHere.length > 0) {
      problems.push(`ripgrep: missing ${JSON.stringify(problemsHere)} in ${searchPath}`)
    } else {
      const at = hits[0]
      const line = lines[at]
      const indent = line.slice(0, line.length - line.trimStart().length)
      const unit = indent.includes('\t') ? '\t' : '    '
      lines.splice(
        at,
        1,
        `${indent}try {`,
        `${indent}${unit}const packaged = (await import("@vscode/ripgrep")).rgPath;`,
        `${indent}${unit}if (existsSync(packaged)) return packaged;`,
        `${indent}} catch (error) {`,
        `${indent}${unit}/* ${SEARCH_MARKER}: no @vscode/ripgrep build exists for this platform. */`,
        `${indent}}`,
        `${indent}const hostRg = findHostRg();`,
        `${indent}if (hostRg !== undefined) return hostRg;`,
        `${indent}throw new Error("no usable ripgrep: this platform has no packaged build and no \`rg\` is on PATH (try: pkg install ripgrep)");`,
      )
      const helper = `/** ${SEARCH_MARKER}: first executable \`rg\` on PATH, or undefined. */
function findHostRg() {
        const separator = process.platform === "win32" ? ";" : ":";
        for (const dir of (process.env.PATH ?? "").split(separator)) {
                if (dir === "") continue;
                const candidate = join(dir, process.platform === "win32" ? "rg.exe" : "rg");
                try {
                        accessSync(candidate, constants.X_OK);
                        return candidate;
                } catch {
                        /* not executable, keep looking */
                }
        }
        return void 0;
}
`
      const patched = lines.join('\n').replace(importFrom, importTo)
      writeFileSync(searchPath, `${patched}\n${helper}`)
      console.log('ripgrep: falls back to a host `rg` when no packaged build exists')
    }
  }
} else {
  problems.push(`ripgrep: ${searchPath} missing`)
}

// The patch only adds a fallback: the install still needs something to run.
// Either the packaged platform build exists, or an `rg` must be on PATH.
{
  const packaged = existsSync(join(nodeModules, '@vscode', `ripgrep-${process.platform}-${process.arch}`))
  const hostRg = (process.env.PATH ?? "")
    .split(":")
    .filter((dir) => dir !== "")
    .map((dir) => join(dir, "rg"))
    .find((candidate) => existsSync(candidate))
  if (!packaged && hostRg === undefined) {
    problems.push('ripgrep: no packaged build for this platform and no `rg` on PATH — install one with "pkg install ripgrep"')
  }
}

// 7. Portrait layout for the settings dialog. The settings shell is a desktop
// dialog: an 800px panel (capped to 100vw - 48px) holding a fixed 188px
// navigation column beside the content, and the package ships no media query at
// all. On a 412px phone the panel is ~364px, leaving the content ~176px —
// cramped on the right. Below 720px, stack the navigation above the content and
// let it scroll sideways, which hands the content the full width.
//
// The class names are CSS-module hashes that change whenever the app is rebuilt,
// so they are read from the installed bundle and the generated block is
// rewritten in place. Selectors double the class name to outrank the plugin's
// own runtime-injected rules regardless of document order.
const settingsShellPath = join(nodeModules, '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib', 'client.js')
const shellIndexPath = join(nodeModules, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
const UI_START = '<!-- ANDROID_PATCH_UI -->'
const UI_END = '<!-- /ANDROID_PATCH_UI -->'
if (!existsSync(settingsShellPath) || !existsSync(shellIndexPath)) {
  problems.push(`settings layout: missing ${existsSync(settingsShellPath) ? shellIndexPath : settingsShellPath}`)
} else {
  const shellSource = readFileSync(settingsShellPath, 'utf8')
  const shellPrefix = /\.([A-Za-z0-9]+)_nav\{/.exec(shellSource)?.[1]
  if (shellPrefix === undefined) {
    problems.push(`settings layout: no class prefix found in ${settingsShellPath}`)
  } else {
    const wanted = ['panel', 'nav', 'navTitle', 'navList', 'navCell', 'navLabel', 'content', 'header', 'options']
    const absent = wanted.filter((name) => !shellSource.includes(`.${shellPrefix}_${name}{`))
    if (absent.length > 0) {
      problems.push(`settings layout: classes missing from the bundle: ${absent.join(', ')}`)
    } else {
      const sel = (name) => `.${shellPrefix}_${name}.${shellPrefix}_${name}`
      const block = [
        UI_START,
        '<style>',
        '/* Android/Termux portrait fix for the settings dialog — written by android-fix.mjs. */',
        '@media (max-width: 720px) {',
        `  ${sel('panel')} { flex-direction: column; max-width: calc(100vw - 16px); height: min(800px, 100vh - 16px); height: min(800px, 100dvh - 16px); }`,
        `  ${sel('nav')} { flex-direction: row; width: auto; max-width: 100%; gap: 6px; padding: 10px 10px 0; overflow-x: auto; }`,
        `  ${sel('navTitle')} { display: none; }`,
        `  ${sel('navList')} { flex-direction: row; gap: 4px; }`,
        `  ${sel('navCell')} { flex: none; height: 34px; padding: 6px 10px; }`,
        `  ${sel('navLabel')} { flex: none; white-space: nowrap; }`,
        `  ${sel('content')} { min-height: 0; }`,
        `  ${sel('header')} { height: auto; padding: 12px 12px 6px; }`,
        `  ${sel('options')} { padding: 0 12px 16px; }`,
        '}',
        '</style>',
        UI_END,
      ].join('\n')
      const html = readFileSync(shellIndexPath, 'utf8')
      const from = html.indexOf(UI_START)
      const to = html.indexOf(UI_END)
      let patched
      if (from >= 0 && to > from) {
        patched = `${html.slice(0, from)}${block}${html.slice(to + UI_END.length)}`
      } else if (html.includes('</head>')) {
        patched = html.replace('</head>', `${block}\n  </head>`)
      } else {
        patched = `${html}\n${block}\n`
      }
      if (patched !== html) {
        writeFileSync(shellIndexPath, patched)
        console.log('settings layout: navigation stacks above the content below 720px')
      }
    }
  }
}

if (problems.length > 0) {
  console.error('unresolved:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

