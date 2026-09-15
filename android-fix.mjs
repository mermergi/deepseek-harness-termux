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

if (problems.length > 0) {
  console.error('unresolved:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

