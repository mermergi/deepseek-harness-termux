// Android/Termux compatibility fixes for this dsh install.
// Idempotent: safe to run before every launch (the launcher script does).
//
// Three unrelated Android limitations are handled here; each is listed with the
// reason it exists and what it costs. `DSH_PERMISSION_MODE` is not a patch: the
// shipped profile already reads it, and the launcher sets it.
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
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
const profilesDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles')
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
// and Windows builds only: there is no @vscode/ripgrep-android-arm64, so the
// import throws and every `glob`/`grep` call fails with
// `SEARCH_FAILED: ... (ripgrep launch failed)`.
//
// Editing that resolution proved fragile — 0.1.6 reshaped the code it lived in —
// so supply the missing platform package instead: a two-line shim that execs
// the host `rg` (Termux ships an android-native one). Upstream resolution, the
// argv it builds and its electron/asar fixups then stay untouched, and a
// platform that has a real build never gets a shim.
const rgPlatformPackage = join(nodeModules, '@vscode', `ripgrep-${process.platform}-${process.arch}`)
const SEARCH_MARKER = 'ANDROID_PATCH_RG'
if (process.platform === 'android') {
  const rgName = 'rg'
  const hostRg = (process.env.PATH ?? '')
    .split(':')
    .filter((dir) => dir !== '')
    .map((dir) => join(dir, rgName))
    .find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK)
        return true
      } catch {
        return false
      }
    })
  if (hostRg === undefined) {
    problems.push('ripgrep: no packaged build for android and no `rg` on PATH — install one with "pkg install ripgrep"')
  } else {
    const shimDir = join(rgPlatformPackage, 'bin')
    const shimFile = join(shimDir, rgName)
    const shell = join(dirname(process.execPath), 'sh')
    const body = `#!${shell}\n# ${SEARCH_MARKER}: forward to the host ripgrep.\nexec "${hostRg}" "$@"\n`
    // Rewritten whenever it differs, so a stale shim follows a moved `rg` and a
    // re-run on an up-to-date install stays silent.
    if (!existsSync(shimFile) || readFileSync(shimFile, 'utf8') !== body) {
      mkdirSync(shimDir, { recursive: true })
      writeFileSync(
        join(rgPlatformPackage, 'package.json'),
        `${JSON.stringify(
          {
            name: `@vscode/ripgrep-${process.platform}-${process.arch}`,
            version: '0.0.0-android-shim',
            private: true,
            description: `Written by android-fix.mjs; forwards to ${hostRg}`,
            os: ['android'],
            cpu: [process.arch],
          },
          null,
          2,
        )}\n`,
      )
      writeFileSync(shimFile, body)
      chmodSync(shimFile, 0o755)
      console.log(`ripgrep: shimmed ${rgPlatformPackage} to the host rg`)
    }
  }
}

// 7. Portrait layout for the settings dialog. The settings shell is a desktop
// dialog: an 800px panel (capped to 100vw - 48px) holding a fixed 188px
// navigation column beside the content, and the package ships no media query at
// all. On a 412px phone the panel is ~364px, leaving the content ~176px —
// cramped on the right. Below 720px, stack the navigation above the content and
// let it scroll sideways, which hands the content the full width.
//
// 0.2.1 laid that out with flex (`panel` column, `content` a flex child); 0.2.2
// replaced it with a two-column CSS grid whose areas are named after the classes
// (`title`/`header`/`nav`/`options`) and dropped `content`. Same intent, different
// lever: the 0.2.2 block rewrites `grid-template-areas` and grid tracks.
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
    // 0.2.2 rebuilt this dialog as a CSS grid with named areas
    // (`title header` / `nav options`) and dropped the `content` wrapper the 0.2.1
    // flex layout had, so the portrait fix has to rewrite the area template instead
    // of flipping one flex direction. Which shape to write is read from the bundle,
    // because an install can legitimately be either release.
    const gridShell = new RegExp(`\\.${shellPrefix}_panel\\{[^}]*display:grid`).test(shellSource)
    const wanted = gridShell
      ? ['panel', 'nav', 'navTitle', 'navList', 'navCell', 'navLabel', 'header', 'options']
      : ['panel', 'nav', 'navTitle', 'navList', 'navCell', 'navLabel', 'content', 'header', 'options']
    const absent = wanted.filter((name) => !shellSource.includes(`.${shellPrefix}_${name}{`))
    if (absent.length > 0) {
      problems.push(`settings layout: classes missing from the bundle: ${absent.join(', ')}`)
    } else {
      const sel = (name) => `.${shellPrefix}_${name}.${shellPrefix}_${name}`
      // The area names are the ones the child rules already name (`grid-area: <prefix>_nav`),
      // not the class names: the dialog calls its title area `<prefix>_title`.
      const area = (name) => `${shellPrefix}_${name}`
      const block = [
        UI_START,
        '<style>',
        '/* Android/Termux portrait fix for the settings dialog — written by android-fix.mjs. */',
        '@media (max-width: 720px) {',
        ...(gridShell
          ? [
              `  ${sel('panel')} {`,
              `    grid-template-areas: "${area('title')} ${area('header')}" "${area('nav')} ${area('nav')}" "${area('options')} ${area('options')}";`,
              '    grid-template-columns: minmax(0, 1fr) auto;',
              '    grid-template-rows: auto auto minmax(0, 1fr);',
              '    max-width: calc(100vw - 16px);',
              '    height: min(800px, calc(100vh - 16px));',
              '    height: min(800px, calc(100dvh - 16px));',
              '  }',
              `  ${sel('navTitle')} { padding: 14px 8px 6px 16px; }`,
              `  ${sel('header')} { height: auto; padding: 4px 10px 2px 0; }`,
              `  ${sel('nav')} { padding: 4px 10px 0; }`,
              `  ${sel('navList')} { flex-direction: row; gap: 4px; overflow-x: auto; overflow-y: hidden; }`,
              `  ${sel('navCell')} { flex: none; height: 34px; padding: 6px 10px; }`,
              `  ${sel('navLabel')} { flex: none; }`,
              `  ${sel('options')} { padding: 0 12px 16px; }`,
            ]
          : [
              `  ${sel('panel')} { flex-direction: column; max-width: calc(100vw - 16px); height: min(800px, 100vh - 16px); height: min(800px, 100dvh - 16px); }`,
              `  ${sel('nav')} { flex-direction: row; width: auto; max-width: 100%; gap: 6px; padding: 10px 10px 0; overflow-x: auto; }`,
              `  ${sel('navTitle')} { display: none; }`,
              `  ${sel('navList')} { flex-direction: row; gap: 4px; }`,
              `  ${sel('navCell')} { flex: none; height: 34px; padding: 6px 10px; }`,
              `  ${sel('navLabel')} { flex: none; white-space: nowrap; }`,
              `  ${sel('content')} { min-height: 0; }`,
              `  ${sel('header')} { height: auto; padding: 12px 12px 6px; }`,
              `  ${sel('options')} { padding: 0 12px 16px; }`,
            ]),
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

// 8. Handing a path to an external app. dsh-native-command backs the settings
// header's "Open configuration file" button (the settings controller gates it on
// canOpenNativePath and opens it with openNativePath), and it knows darwin,
// win32 and linux only. On Android `canOpenNativePath()` answers false and
// `openNativePath()` throws `native path opener is unsupported on android`, so
// the button cannot work at all. Termux ships `termux-open`, which hands a file
// to an Android app, so wire it in as the android launcher.
//
// Reveal-in-file-manager is deliberately left unsupported: Android has no
// equivalent gesture, and the surfaces then show the path as text instead of
// offering a button that could only fail.
const nativeCommandPath = join(nodeModules, '@deepseek-ai', 'dsh-native-command', 'lib', 'index.js')
const NATIVE_MARKER = 'ANDROID_PATCH_OPEN'
if (existsSync(nativeCommandPath)) {
  const source = readFileSync(nativeCommandPath, 'utf8')
  if (!source.includes(`${NATIVE_MARKER}_TYPE`)) {
    const lines = source.split('\n')
    // An earlier run of this patcher inserted a plain `termux-open <path>`; drop
    // that block so the content-type aware form below can take its place.
    const staleAt = lines.findIndex((line) => line.includes(`${NATIVE_MARKER}: `))
    if (staleAt >= 0) {
      let staleEnd = staleAt
      while (staleEnd < lines.length && lines[staleEnd].trim() !== '}') staleEnd += 1
      lines.splice(staleAt, staleEnd - staleAt + 1)
    }
    const hitsOf = (text) =>
      lines.map((line, index) => (line.trim() === text ? index : -1)).filter((index) => index >= 0)
    const throwLine = 'throw new Error(`native path opener is unsupported on ${platform}`);'
    const canLine = 'if (platform !== "linux") return false;'
    const throwHits = hitsOf(throwLine)
    const canHits = hitsOf(canLine)
    if (throwHits.length !== 1 || canHits.length !== 1) {
      problems.push(`open in app: anchors not unique in ${nativeCommandPath} (throw ${throwHits.length}, can ${canHits.length})`)
    } else {
      const indentOf = (index) => {
        const line = lines[index]
        return line.slice(0, line.length - line.trimStart().length)
      }
      const unitOf = (indent) => (indent.includes('\t') ? '\t' : '    ')
      const throwIndent = indentOf(throwHits[0])
      const throwUnit = unitOf(throwIndent)
      lines.splice(
        throwHits[0],
        0,
        `${throwIndent}if (platform === "android") { /* ${NATIVE_MARKER}: Termux hands the path to an Android app. */`,
        `${throwIndent}${throwUnit}const contentType = androidOpenContentType(path);`,
        `${throwIndent}${throwUnit}await run("termux-open", contentType === void 0 ? [path] : ["--content-type", contentType, path], signal);`,
        `${throwIndent}${throwUnit}return;`,
        `${throwIndent}}`,
      )
      const canIndex = canHits[0] < throwHits[0] ? canHits[0] : canHits[0] + 5
      const canIndent = indentOf(canIndex)
      lines.splice(canIndex, 0, `${canIndent}if (platform === "android") return true; /* ${NATIVE_MARKER} */`)
      const helper = `/**
* ${NATIVE_MARKER}_TYPE: the content type to hand termux-open on Android.
*
* Left to itself, termux-open asks Android's MimeTypeMap for the extension, and
* formats it does not know — .yaml among them — degrade to the wildcard type.
* The chooser then lists apps that merely accept anything and cannot read the
* shared URI, which looks like "none of these work". Naming the type up front
* narrows the chooser to apps that can actually open the file.
* @param path - the path about to be handed to termux-open.
* @returns a MIME type, or undefined to let termux-open derive one.
*/
function androidOpenContentType(path) {
        const dot = path.lastIndexOf(".");
        const extension = dot < 0 ? "" : path.slice(dot).toLowerCase();
        const text = {
                ".txt": 1, ".text": 1, ".log": 1, ".md": 1, ".markdown": 1, ".csv": 1, ".tsv": 1,
                ".json": 1, ".jsonc": 1, ".yaml": 1, ".yml": 1, ".toml": 1, ".ini": 1, ".cfg": 1,
                ".conf": 1, ".env": 1, ".properties": 1, ".sh": 1, ".bash": 1, ".zsh": 1, ".fish": 1,
                ".py": 1, ".rb": 1, ".pl": 1, ".lua": 1, ".php": 1, ".go": 1, ".rs": 1, ".swift": 1,
                ".c": 1, ".h": 1, ".cc": 1, ".cpp": 1, ".hpp": 1, ".cs": 1, ".java": 1, ".kt": 1,
                ".js": 1, ".mjs": 1, ".cjs": 1, ".ts": 1, ".tsx": 1, ".jsx": 1, ".vue": 1,
                ".css": 1, ".scss": 1, ".less": 1, ".xml": 1, ".sql": 1, ".diff": 1, ".patch": 1
        };
        if (text[extension] === 1) return "text/plain";
        const exact = {
                ".html": "text/html", ".htm": "text/html", ".svg": "image/svg+xml",
                ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
                ".pdf": "application/pdf", ".zip": "application/zip", ".gz": "application/gzip",
                ".tar": "application/x-tar", ".mp3": "audio/mpeg", ".wav": "audio/wav",
                ".mp4": "video/mp4", ".webm": "video/webm"
        };
        return exact[extension];
}
`
      writeFileSync(nativeCommandPath, `${lines.join('\n')}\n${helper}`)
      console.log('open in app: android uses termux-open with an explicit content type')
    }
  }
} else {
  problems.push(`open in app: ${nativeCommandPath} missing`)
}

// client-modules: memoize per-record combo artifacts. The graph is recomposed
// once per plugin-registration wave at startup, so without a cache every wave
// re-assembles every individual client bundle (measured: 435 builds / ~10 s of
// an ~11 s boot on this phone). A per-record artifact is pure in
// (entry.id, revision) and `rebuilt()` allocates a new revision on content
// change, so the cache can never serve stale bytes. Best effort on purpose: a
// missing anchor only costs boot time, it must never block startup.
const clientModulesPath = join(nodeModules, '@deepseek-ai', 'dsh-client-modules', 'lib', 'index.js')
if (existsSync(clientModulesPath)) {
  const source = readFileSync(clientModulesPath, 'utf8')
  if (source.includes('ANDROID_BOOT_CACHE')) {
    // already patched
  } else {
    const anchor = '/** Concatenate one or more factory registrations and compose their maps as indexed sections. */'
    const head = 'function buildCombo(records, revision) {\n\tlet source = "";'
    const tail = '\tconst sourceMapUrl = comboUrl(entries, rev, true);\n\treturn {\n\t\turl,\n\t\trev,\n\t\tentries,\n\t\tscript: comboScript(source, sourceMapUrl),\n\t\tsourceMap,\n\t\tsourceMapUrl\n\t};\n}'
    if (source.includes(anchor) && source.includes(head) && source.includes(tail)) {
      const cacheHeader = `/**
* Per-record artifacts are pure in \`(entry.id, revision)\`: the same pair always
* rebuilds the same bytes, and \`rebuilt()\` allocates a new revision whenever a
* bundle's content changes. The graph is recomposed once per plugin-registration
* wave at startup, so every wave otherwise re-assembles every individual bundle
* (435 builds; ~10 s on a phone). ANDROID_BOOT_CACHE
*/
const singleComboCache = /* @__PURE__ */ new Map();
const SINGLE_COMBO_CACHE_LIMIT = 256;
`
      const patchedHead = `function buildCombo(records, revision) {
	const comboCacheKey = revision !== void 0 && records.length === 1 ? \`\${records[0].entry.id}@\${revision}\` : void 0;
	if (comboCacheKey !== void 0) {
		const comboCacheHit = singleComboCache.get(comboCacheKey);
		if (comboCacheHit !== void 0) return comboCacheHit;
	}
	let source = "";`
      const patchedTail = `	const sourceMapUrl = comboUrl(entries, rev, true);
	const artifact = {
		url,
		rev,
		entries,
		script: comboScript(source, sourceMapUrl),
		sourceMap,
		sourceMapUrl
	};
	if (comboCacheKey !== void 0) {
		if (singleComboCache.size >= SINGLE_COMBO_CACHE_LIMIT) singleComboCache.delete(singleComboCache.keys().next().value);
		singleComboCache.set(comboCacheKey, artifact);
	}
	return artifact;
}`
      writeFileSync(clientModulesPath, source.replace(anchor, `${cacheHeader}${anchor}`).replace(head, patchedHead).replace(tail, patchedTail))
      console.log('client-modules: per-record combo cache installed (boot ~2.6 s faster)')
    } else {
      console.warn('client-modules: combo cache anchor missing; skipping (boot stays slower)')
    }
  }
} else {
  console.warn(`client-modules: ${clientModulesPath} missing; skipping combo cache`)
}

// 10. Profile resolution mode. 0.1.6-alpha.2 changed the default in
// `profile-boot-<hash>.js` from "link" to "runtime":
//
//   alpha.1  options.resolutionMode ?? "link"
//   alpha.2  options.resolutionMode ?? "runtime"
//
// "runtime" builds a resolution generation and hands it to the PluginPackages
// plugin, whose constructor then reaches `installProfileResolution()` ->
// `internalModules()`, which does an *unguarded*
// `require("node-addon-require-builtin")`. That addon publishes darwin/linux/
// win32 bindings only — there is no android-arm64 build, and npm has never had
// one — so boot dies with
// `host preparation failed: No usable native binding found for
//  node-addon-require-builtin-android-arm64`.
//
// "link" passes no generation, PluginPackages returns early, and the addon is
// never touched. Nothing else in the boot path needs it: the one other consumer
// (cordis-plugin-loader's requireInternal) already prefers --expose-internals
// and wraps both paths in try/catch. So restore the alpha.1 default.
//
// This is the *only* place the default is set, and bin.js never passes
// resolutionMode, so the fallback is always what runs.
const profileBootDir = join(nodeModules, '@deepseek-ai', 'dsh', 'lib')
// Never scan node_modules wholesale; profile-boot is emitted as a hashed chunk
// whose name changes between releases.
const profileBootFiles = existsSync(profileBootDir)
  ? readdirSync(profileBootDir).filter((name) => /^profile-boot-.*\.js$/.test(name))
  : []
const RUNTIME_DEFAULT = 'options.resolutionMode ?? "runtime"'
const LINK_DEFAULT = 'options.resolutionMode ?? "link"'
let resolutionPatched = 0
for (const name of profileBootFiles) {
  const file = join(profileBootDir, name)
  const source = readFileSync(file, 'utf8')
  // The chunk that imports PluginPackages is the one that sets the default.
  if (!source.includes(RUNTIME_DEFAULT)) continue
  writeFileSync(file, source.replaceAll(RUNTIME_DEFAULT, LINK_DEFAULT))
  resolutionPatched += 1
}
if (resolutionPatched > 0) {
  console.log(`profile resolution: default resolutionMode runtime -> link (${resolutionPatched} chunk(s))`)
} else if (profileBootFiles.length === 0) {
  problems.push(`profile resolution: no profile-boot chunk under ${profileBootDir}`)
} else if (profileBootFiles.some((name) => readFileSync(join(profileBootDir, name), 'utf8').includes(LINK_DEFAULT))) {
  // already patched
} else if (profileBootFiles.length > 0) {
  // 0.1.7-alpha.1 deleted resolutionMode outright: profile-boot always builds a
  // runtime generation now, so there is no default left to rewrite. The Android
  // symptom moved to patch 19, which stops the interception that generation
  // would install. Say that instead of claiming the default is already fine.
  console.log('profile resolution: no resolutionMode default in this release (0.1.7+); see patch 19')
}

// 11. HMR service. 0.1.6-alpha.2 hard-codes @deepseek-ai/dsh-hmr into
// dsh-base/cordis.patch.yml, so the older `patchReload: "startup"` trick (see
// patch 4) no longer keeps it out of the tree. The plugin's constructor throws
// `--expose-internals is required for HMR service` when the Cordis loader has no
// `internal` handle — which on Android it cannot get, because that handle comes
// from the same missing addon.
//
// Dropping the patch entry is the smaller change: HMR only reloads profile
// patch files while dsh is running, which matters to developers editing live
// profiles, not to a phone that starts the server once. Boot must not depend on
// a native binding that does not exist for this platform.
const basePatchPath = join(nodeModules, '@deepseek-ai', 'dsh-base', 'cordis.patch.yml')
if (existsSync(basePatchPath)) {
  const source = readFileSync(basePatchPath, 'utf8')
  if (source.includes('ANDROID_PATCH_NO_HMR')) {
    // already patched
  } else {
    const lines = source.split('\n')
    // Upstream quotes the name with single quotes today; accept either style so a
    // cosmetic change upstream cannot silently turn this patch into a no-op.
    const at = lines.findIndex((line) => /['"]@deepseek-ai\/dsh-hmr['"]/.test(line))
    // The entry is a 2-line YAML mapping: `- name: '@deepseek-ai/dsh-hmr'`
    // followed by an indented `config:` block. Drop the whole entry.
    if (at < 0) {
      // Normal on alpha.1, whose dsh-base has no hmr entry at all — nothing to
      // do there. It would only be suspicious if the package itself depended on
      // hmr while shipping no entry for it, which is not a shape we can tell
      // apart from here, so stay quiet rather than block a working install.
      console.log('hmr: no dsh-hmr entry in dsh-base; nothing to remove')
    } else {
      let end = at + 1
      while (end < lines.length && /^\s+\S/.test(lines[end]) && !/^\s*-\s/.test(lines[end])) end += 1
      const start = /^\s*-\s/.test(lines[at]) ? at : at - 1
      lines.splice(start, end - start, `${lines[start].slice(0, lines[start].length - lines[start].trimStart().length)}# ANDROID_PATCH_NO_HMR: dropped '@deepseek-ai/dsh-hmr' (needs the android-less node-addon-require-builtin)`)
      writeFileSync(basePatchPath, lines.join('\n'))
      console.log('hmr: dropped dsh-hmr from dsh-base patch (needs a binding android does not have)')
    }
  }
} else {
  // Pre-alpha.2 releases shipped no such patch file; nothing to remove.
  console.log(`hmr: ${basePatchPath} absent; nothing to patch`)
}

// 12. Sidebar panel toggle. 0.1.6-alpha.2 added the Plugins entry to the sidebar
// rail. Its row calls `selectPanel(id)` unconditionally, so tapping the icon a
// second time re-selects the same panel instead of closing it — and with the
// sidebar already open, the two panes compete for width and the plugin page is
// squeezed into a vertical sliver. Users read that as "the icon does not close".
//
// The host already supports closing: `selectPanel(null)` means "return to the
// Conversation" (layout/lib/client.js:417-422 accepts null, and
// `activePanelId = null` is the documented no-panel state). Nothing upstream
// ever passes it from this row, so the UI simply cannot express "close".
//
// Fix: toggle. Passing null when the row is already active restores the
// conversation; every other panel keeps working unchanged.
//
// Not Android-specific — any platform with the Plugins entry has this — but it
// is the sidebar's own row, so the patch is cheap and self-contained here.
const sidebarClientPath = join(nodeModules, '@deepseek-ai', 'dsh-client-ui-sidebar', 'lib', 'client.js')
if (existsSync(sidebarClientPath)) {
  const source = readFileSync(sidebarClientPath, 'utf8')
  if (source.includes('ANDROID_PATCH_PANEL_TOGGLE')) {
    // already patched
  } else {
    // 0.2.1 wrapped the row body directly in `onClick`; 0.2.2 records the click first
    // with `trackEntryClick` and then selects. Both end on the same statement, so the
    // anchor keeps the surrounding block: a bare `selectPanel(id);` is not unique
    // (`ctx.layout.selectPanel(id)` appears in the props wiring).
    const newAnchor = [
      '\t\t\t\t\tonClick: () => {',
      '\t\t\t\t\t\tconst entry = officialEntry(id);',
      '\t\t\t\t\t\tif (entry !== void 0) trackEntryClick({',
      '\t\t\t\t\t\t\tmenu_name: entry,',
      '\t\t\t\t\t\t\tposition: "sidebar"',
      '\t\t\t\t\t\t});',
      '\t\t\t\t\t\tselectPanel(id);',
      '\t\t\t\t\t},',
    ].join('\n')
    const oldAnchor = '\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\tselectPanel(id);\n\t\t\t\t\t},'
    const marker = '// ANDROID_PATCH_PANEL_TOGGLE: re-tapping the active panel returns to the conversation.'
    if (source.includes(newAnchor)) {
      writeFileSync(sidebarClientPath, source.replace(newAnchor, newAnchor.replace('\t\t\t\t\t\tselectPanel(id);', `\t\t\t\t\t\tselectPanel(active ? null : id); ${marker}`)))
      console.log('sidebar: panel icons toggle (tapping the active one closes it)')
    } else if (source.includes(oldAnchor)) {
      const replacement = [
        '\t\t\t\t\t' + marker,
        '\t\t\t\t\tonClick: () => {',
        '\t\t\t\t\t\tselectPanel(active ? null : id);',
        '\t\t\t\t\t},',
      ].join('\n')
      writeFileSync(sidebarClientPath, source.replace(oldAnchor, replacement))
      console.log('sidebar: panel icons toggle (tapping the active one closes it)')
    } else {
      problems.push(`panel toggle: anchor missing in ${sidebarClientPath} (sidebar row layout changed)`)
    }
  }
} else {
  // Pre-alpha.2 releases have no plugin panel in the rail; nothing to toggle.
  console.log(`sidebar: ${sidebarClientPath} absent; nothing to patch`)
}

// 13. Sidebar icon tooltips never dismiss on a touch screen.
//
// The primitive shows a bubble on focus and hides it on blur, assuming a
// pointer: hover in, hover out. A finger tap fires focus (bubble appears) but
// never mouseleave, and the button then keeps focus, so no blur arrives either.
// The bubble stays until the user taps something unrelated — which is exactly
// what "点击后有个文字在那里" describes.
//
// Fixed here rather than in the primitive, because the primitive cannot be
// patched at all: the client bundle ships a prebuilt copy of
// dsh-client-ui-primitives, so edits to its lib/index.js never reach the
// browser. That was learned the hard way — a fix written there showed 0
// occurrences in the served bundle, while the same kind of edit to this file
// (patch 12) appeared immediately. Patch only what the bundler reads.
//
// Disabling is the honest fix rather than a workaround. A tooltip is a
// hover affordance; there is no hover on a touch screen, so the bubble can only
// ever appear as a side effect of tapping and then linger. Every one of these
// buttons already carries `aria-label`, so screen readers lose nothing, and the
// expanded sidebar shows the same labels as visible text (`disabled: wide`
// already suppressed the bubble in that state anyway).
//
// The rows are distinguished by their indentation: the file has five
// `delayMs: 500,` lines at five distinct tab depths, and each one belongs to a
// sidebar Tooltip. `disabled: wide,` is dropped first so the key is not set
// twice.
const sidebarTooltipPath = join(nodeModules, '@deepseek-ai', 'dsh-client-ui-sidebar', 'lib', 'client.js')
if (existsSync(sidebarTooltipPath)) {
  const source = readFileSync(sidebarTooltipPath, 'utf8')
  if (source.includes('ANDROID_PATCH_NO_TOOLTIP')) {
    // already patched
  } else {
    const withoutWide = source.split('disabled: wide,\n').join('')
    const dropped = source.length - withoutWide.length
    // Insert `disabled: true,` after each delayMs line, keeping its indentation.
    let added = 0
    const patched = withoutWide.replace(/\n(\t+)delayMs: 500,\n/g, (_match, indent) => {
      added += 1
      return `\n${indent}delayMs: 500,\n${indent}// ANDROID_PATCH_NO_TOOLTIP: a tap cannot dismiss a hover bubble; suppress it.\n${indent}disabled: true,\n`
    })
    if (added === 0) {
      problems.push(`sidebar tooltips: no "delayMs: 500," anchors in ${sidebarTooltipPath}`)
    } else {
      writeFileSync(sidebarTooltipPath, patched)
      const note = dropped > 0 ? `, replaced ${dropped / 'disabled: wide,\n'.length} existing gate(s)` : ''
      console.log(`sidebar tooltips: disabled ${added} hover bubble(s)${note}`)
    }
  }
} else {
  problems.push(`sidebar tooltips: ${sidebarTooltipPath} missing`)
}

// 14. Restart button at the bottom of the General settings page.
//
// The app's own restart control lives on the splash screen and is shown only
// when the boot fails, which is exactly when reaching it is hardest. The
// settings page is where people look, so the button belongs there.
//
// The page is web content and cannot stop a Termux process by itself, so the
// native shell exposes `window.dshNative.restartServer()` (MainActivity's
// addJavascriptInterface, wired to the same beginBoot(true) path the splash
// button uses). This patch adds the button that calls it.
//
// Rendered only when that bridge exists, so a desktop browser — where the
// method is absent and a restart has no meaning — sees the page unchanged.
// Confirmation comes first because a restart kills any turn in flight, and the
// button then disables itself so a second tap cannot fire mid-restart.
const generalSettingsPath = join(nodeModules, '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib', 'client.js')
if (existsSync(generalSettingsPath)) {
  const source = readFileSync(generalSettingsPath, 'utf8')
  if (source.includes('ANDROID_PATCH_RESTART_BUTTON')) {
    // already patched
  } else {
    const anchor = [
      '\t\tfunction GeneralSection({ renderSlot }) {',
      '\t\t\treturn (0, react_jsx_runtime.jsx)("div", {',
      '\t\t\t\tclassName: GeneralSection_module_css_default.section,',
      '\t\t\t\tchildren: renderSlot("settings.general.item", {})',
      '\t\t\t});',
      '\t\t}',
    ].join('\n')
    const replacement = [
      '\t\tfunction GeneralSection({ renderSlot }) {',
      '\t\t\t// ANDROID_PATCH_RESTART_BUTTON: the app shell can restart the dsh server;',
      '\t\t\t// expose that here, where users look for settings, instead of only on the',
      '\t\t\t// splash screen that appears when booting already failed.',
      '\t\t\tconst [restarting, setRestarting] = react.useState(false);',
      '\t\t\tconst canRestart = typeof window !== "undefined" && window.dshNative !== void 0;',
      '\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {',
      '\t\t\t\tclassName: GeneralSection_module_css_default.section,',
      '\t\t\t\tchildren: [renderSlot("settings.general.item", {}), canRestart && (0, react_jsx_runtime.jsx)("div", {',
      '\t\t\t\t\tstyle: { padding: "16px 0 8px" },',
      '\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {',
      '\t\t\t\t\t\tvariant: "outline",',
      '\t\t\t\t\t\tsize: "sm",',
      '\t\t\t\t\t\tdisabled: restarting,',
      '\t\t\t\t\t\tonClick: () => {',
      '\t\t\t\t\t\t\tif (!window.confirm("重启 DSH 服务？\\n\\n正在进行的对话会被中断，页面稍后会自动重新连接。")) return;',
      '\t\t\t\t\t\t\tsetRestarting(true);',
      '\t\t\t\t\t\t\ttry {',
      '\t\t\t\t\t\t\t\twindow.dshNative.restartServer();',
      '\t\t\t\t\t\t\t} catch (error) {',
      '\t\t\t\t\t\t\t\tsetRestarting(false);',
      '\t\t\t\t\t\t\t\twindow.alert("重启失败：" + (error && error.message ? error.message : error));',
      '\t\t\t\t\t\t\t}',
      '\t\t\t\t\t\t},',
      '\t\t\t\t\t\tchildren: restarting ? "正在重启…" : "重启 DSH 服务"',
      '\t\t\t\t\t})',
      '\t\t\t\t})]',
      '\t\t\t});',
      '\t\t}',
    ].join('\n')
    if (!source.includes(anchor)) {
      problems.push(`restart button: anchor missing in ${generalSettingsPath} (GeneralSection rewritten)`)
    } else {
      writeFileSync(generalSettingsPath, source.replace(anchor, replacement))
      console.log('settings: restart button added to the General page (visible only in the app)')
    }
  }
} else {
  problems.push(`restart button: ${generalSettingsPath} missing`)
}

// 24. Session initialization: a default prompt and a default agent preset.
//
// Both answer the same question — "how does a new session start" — so they live on
// the General settings page, below the restart button patch 14 put there.
//
// The prompt is `$DSH_HOME/AGENTS.md`, the agent loader's *user-global* instruction
// file: `discoverInstructionFiles()` adds it to every session's system prompt, so
// writing it here is what makes it a default for each new session (and, because the
// loader reconciles instruction files, an edit reaches the current session too).
// Web content cannot write into Termux's home, so MainActivity exposes
// `dshNative.readStartupPrompt() / writeStartupPrompt()`.
//
// The preset is the `agent-preset-registry` settings document's `selectedDefault`,
// read with `settings/describe` and written with `settings/update` (with the fresh
// `expectedRevision`, or the write is refused). That is the same default the
// new-session hero picker starts from.
const startupPromptMarker = 'ANDROID_PATCH_STARTUP_PROMPT'
if (existsSync(generalSettingsPath)) {
  const source = readFileSync(generalSettingsPath, 'utf8')
  // Rewrite the whole section when it is missing *or* carries the first cut of this patch:
  // that cut declared `prompts` while rendering `presets` (which blanked the page) and called
  // native file methods the app cannot use at all — Termux's home belongs to another UID, so
  // writing there answers AccessDeniedException.
  const staleCut = source.includes('const [prompts, setPresets]') || source.includes('readStartupPrompt')
  if (!source.includes(startupPromptMarker) || staleCut) {
    // Matches patch 14's GeneralSection whether it was applied just now or by an
    // earlier launch: any line starting with exactly two tabs and a closing brace ends it.
    const existing = /\t\tfunction GeneralSection\(\{ renderSlot \}\) \{[\s\S]*?\n\t\t\}/.exec(source)
    if (existing === null) {
      problems.push(`startup prompt: GeneralSection not found in ${generalSettingsPath}`)
    } else {
      const generalSection = `\t\tfunction GeneralSection({ renderSlot }) {
\t\t\t// ANDROID_PATCH_RESTART_BUTTON: the app shell can restart the dsh server;
\t\t\t// expose that here, where users look for settings, instead of only on the
\t\t\t// splash screen that appears when booting already failed.
\t\t\t// ${startupPromptMarker}: the same page edits the session initialization prompt
\t\t\t// ($DSH_HOME/AGENTS.md, which the agent loader reads for every session) and the
\t\t\t// default agent preset, because both decide how a new session starts.
\t\t\tconst [restarting, setRestarting] = react.useState(false);
\t\t\tconst [prompt, setPrompt] = react.useState("");
\t\t\tconst [promptPath, setPromptPath] = react.useState("$DSH_HOME/AGENTS.md");
\t\t\tconst [promptStatus, setPromptStatus] = react.useState("");
\t\t\tconst [presets, setPresets] = react.useState([]);
\t\t\tconst [defaultPreset, setDefaultPreset] = react.useState("");
\t\t\tconst bridge = typeof window !== "undefined" ? window.dshNative : void 0;
\t\t\tconst canRestart = bridge !== void 0;
\t\t\tconst rpcId = react.useRef(0);
\t\t\tconst rpc = react.useCallback((method, args) => {
\t\t\t\trpcId.current += 1;
\t\t\t\treturn fetch("/api/" + method, {
\t\t\t\t\tmethod: "POST",
\t\t\t\t\theaders: { "content-type": "application/json" },
\t\t\t\t\tbody: JSON.stringify({
\t\t\t\t\t\ttype: "client-request",
\t\t\t\t\t\trpcId: "android-settings-" + rpcId.current,
\t\t\t\t\t\tmethod: method,
\t\t\t\t\t\tpayload: { args: args }
\t\t\t\t\t})
\t\t\t\t}).then((response) => response.json()).then((body) => (
\t\t\t\t\tbody && body.result && body.result.ok === true ? body.result.value : void 0
\t\t\t\t)).catch(() => void 0);
\t\t\t}, []);
\t\t\tconst presetNamespace = (value) => (
\t\t\t\tvalue && Array.isArray(value.namespaces)
\t\t\t\t\t? value.namespaces.find((entry) => entry.ns === "agent-preset-registry")
\t\t\t\t\t: void 0
\t\t\t);
\t\t\t// The prompt file lives in Termux's home directory, which this app cannot touch: a
\t\t\t// different UID owns /data/data/com.termux (a direct write answers AccessDenied).
\t\t\t// So the edit goes over loopback to the status endpoint Termux already runs, and
\t\t\t// that endpoint does the file work as the Termux user.
\t\t\tconst PROMPT_ENDPOINT = "http://127.0.0.1:3098/prompt";
\t\t\tconst PROMPT_KEY = "_Z2Fve3rcfvvahd4wDmLa0AvbxN061bp";
\t\t\tconst promptRpc = (method, body) => {
\t\t\t\tconst controller = new AbortController();
\t\t\t\tconst timer = setTimeout(() => controller.abort(), 2500);
\t\t\t\tconst headers = { "x-dsh-key": PROMPT_KEY };
\t\t\t\tif (body !== void 0) headers["content-type"] = "application/json";
\t\t\t\treturn fetch(PROMPT_ENDPOINT, {
\t\t\t\t\tmethod: method,
\t\t\t\t\theaders: headers,
\t\t\t\t\tbody: body === void 0 ? void 0 : JSON.stringify(body),
\t\t\t\t\tsignal: controller.signal
\t\t\t\t}).then((response) => response.json()).catch(() => void 0).finally(() => clearTimeout(timer));
\t\t\t};
\t\t\t// The endpoint is not always awake: it exits after a while with no requests. Nudge it
\t\t\t// through the app (a Termux RUN_COMMAND) and keep retrying while it comes up.
\t\t\tconst loadPrompt = (attempt) => {
\t\t\t\tpromptRpc("GET").then((value) => {
\t\t\t\t\tif (value && typeof value.text === "string") {
\t\t\t\t\t\tsetPrompt(value.text);
\t\t\t\t\t\tif (value.path) setPromptPath(value.path);
\t\t\t\t\t\tsetPromptStatus("");
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tif (attempt >= 5) {
\t\t\t\t\t\tsetPromptStatus("连不上 Termux 侧的状态服务（3098），稍后重试");
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tsetPromptStatus(attempt === 0 ? "正在启动 Termux 侧的状态服务…" : "仍在等待状态服务…");
\t\t\t\t\tif (attempt === 0 && bridge.ensureStatusDaemon) {
\t\t\t\t\t\ttry {
\t\t\t\t\t\t\tbridge.ensureStatusDaemon();
\t\t\t\t\t\t} catch (error) {
\t\t\t\t\t\t\t/* the retry loop reports the outcome */
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t\tsetTimeout(() => loadPrompt(attempt + 1), 900);
\t\t\t\t});
\t\t\t};
\t\t\treact.useEffect(() => {
\t\t\t\tif (bridge === void 0) return;
\t\t\t\tloadPrompt(0);
\t\t\t\trpc("agentPresets/list", {}).then((value) => {
\t\t\t\t\tif (value && Array.isArray(value.presets)) setPresets(value.presets);
\t\t\t\t});
\t\t\t\trpc("settings/describe", {}).then((value) => {
\t\t\t\t\tconst ns = presetNamespace(value);
\t\t\t\t\tif (ns && ns.value) setDefaultPreset(String(ns.value.selectedDefault || ""));
\t\t\t\t});
\t\t\t}, [bridge, rpc]);
\t\t\tconst savePrompt = () => {
\t\t\t\tsetPromptStatus("正在保存…");
\t\t\t\tpromptRpc("POST", { text: prompt }).then((value) => {
\t\t\t\t\tif (value && typeof value.text === "string") {
\t\t\t\t\t\tsetPromptStatus(value.text.trim() === ""
\t\t\t\t\t\t\t? "已清空 · 新会话不再附带初始化提示词"
\t\t\t\t\t\t\t: "已保存 · 新会话的系统提示词会带上它");
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tif (bridge.ensureStatusDaemon) {
\t\t\t\t\t\ttry {
\t\t\t\t\t\t\tbridge.ensureStatusDaemon();
\t\t\t\t\t\t} catch (error) {
\t\t\t\t\t\t\t/* retried below */
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t\tsetTimeout(() => {
\t\t\t\t\t\tpromptRpc("POST", { text: prompt }).then((retry) => {
\t\t\t\t\t\t\tsetPromptStatus(retry && typeof retry.text === "string"
\t\t\t\t\t\t\t\t? "已保存 · 新会话的系统提示词会带上它"
\t\t\t\t\t\t\t\t: "保存失败：Termux 侧的状态服务没起来");
\t\t\t\t\t\t});
\t\t\t\t\t}, 1200);
\t\t\t\t});
\t\t\t};
\t\t\tconst choosePreset = (id) => {
\t\t\t\trpc("settings/describe", {}).then((value) => {
\t\t\t\t\tconst ns = presetNamespace(value);
\t\t\t\t\tif (ns === void 0) {
\t\t\t\t\t\tsetPromptStatus("读不到预设设置，稍后再试");
\t\t\t\t\t\treturn void 0;
\t\t\t\t\t}
\t\t\t\t\treturn rpc("settings/update", {
\t\t\t\t\t\tns: "agent-preset-registry",
\t\t\t\t\t\tpatch: { selectedDefault: id },
\t\t\t\t\t\texpectedRevision: ns.revision
\t\t\t\t\t}).then((updated) => {
\t\t\t\t\t\tif (updated === void 0) {
\t\t\t\t\t\t\tsetPromptStatus("切换失败，稍后再试");
\t\t\t\t\t\t\treturn;
\t\t\t\t\t\t}
\t\t\t\t\t\tsetDefaultPreset(id);
\t\t\t\t\t\tsetPromptStatus("新会话默认预设已切换为 " + id);
\t\t\t\t\t});
\t\t\t\t});
\t\t\t};
\t\t\tconst rowStyle = { display: "flex", flexWrap: "wrap", gap: "8px", padding: "8px 0" };
\t\t\tconst noteStyle = { opacity: 0.7, fontSize: "0.85em", paddingBottom: "8px", lineHeight: 1.5 };
\t\t\tconst areaStyle = {
\t\t\t\twidth: "100%", minHeight: "120px", boxSizing: "border-box", font: "inherit",
\t\t\t\tpadding: "8px", borderRadius: "8px", background: "transparent", color: "inherit",
\t\t\t\tborder: "1px solid rgba(127,127,127,0.35)", resize: "vertical"
\t\t\t};
\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tclassName: GeneralSection_module_css_default.section,
\t\t\t\tchildren: [renderSlot("settings.general.item", {}), bridge !== void 0 && (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\tstyle: { padding: "16px 0 8px", borderTop: "1px solid rgba(127,127,127,0.2)" },
\t\t\t\t\tchildren: [
\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", { style: { fontWeight: 600 }, children: "新会话初始化提示词" }),
\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\tstyle: noteStyle,
\t\t\t\t\t\t\tchildren: "写入 " + promptPath
\t\t\t\t\t\t\t\t+ "，每个新会话的系统提示词都会带上它；清空后保存即删除。"
\t\t\t\t\t\t}),
\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("textarea", {
\t\t\t\t\t\t\tvalue: prompt,
\t\t\t\t\t\t\tonChange: (event) => setPrompt(event.target.value),
\t\t\t\t\t\t\tstyle: areaStyle,
\t\t\t\t\t\t\tplaceholder: "例如：始终用中文回答；改动前先跑一遍测试；不要动 handpan-app/ 目录。"
\t\t\t\t\t\t}),
\t\t\t\t\t\t(0, react_jsx_runtime.jsxs)("div", { style: rowStyle, children: [
\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
\t\t\t\t\t\t\t\tvariant: "outline", size: "sm", onClick: savePrompt, children: "保存提示词"
\t\t\t\t\t\t\t}),
\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
\t\t\t\t\t\t\t\tvariant: "outline",
\t\t\t\t\t\t\t\tsize: "sm",
\t\t\t\t\t\t\t\tonClick: () => { setPrompt(""); setPromptStatus(""); },
\t\t\t\t\t\t\t\tchildren: "清空编辑框"
\t\t\t\t\t\t\t})
\t\t\t\t\t\t] }),
\t\t\t\t\t\tpresets.length > 0 && (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\t\t\tstyle: { paddingTop: "8px" },
\t\t\t\t\t\t\tchildren: [
\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", { style: { fontWeight: 600 }, children: "新会话默认预设" }),
\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\t\t\tstyle: noteStyle,
\t\t\t\t\t\t\t\t\tchildren: "新建会话时的默认模式；会话里仍可用顶部的预设选择器临时切换。"
\t\t\t\t\t\t\t\t}),
\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", { style: rowStyle, children: presets.map((preset) => (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
\t\t\t\t\t\t\t\t\tvariant: "outline",
\t\t\t\t\t\t\t\t\tsize: "sm",
\t\t\t\t\t\t\t\t\tonClick: () => choosePreset(preset.id),
\t\t\t\t\t\t\t\t\tchildren: (preset.name || preset.id) + (preset.id === defaultPreset ? " ✓" : "")
\t\t\t\t\t\t\t\t}, preset.id)) })
\t\t\t\t\t\t\t]
\t\t\t\t\t\t}),
\t\t\t\t\t\tpromptStatus !== "" && (0, react_jsx_runtime.jsx)("div", { style: noteStyle, children: promptStatus }),
\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("div", {
\t\t\t\t\t\t\tstyle: { paddingTop: "12px" },
\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
\t\t\t\t\t\t\t\tvariant: "outline",
\t\t\t\t\t\t\t\tsize: "sm",
\t\t\t\t\t\t\t\tdisabled: restarting,
\t\t\t\t\t\t\t\tonClick: () => {
\t\t\t\t\t\t\t\t\tif (!window.confirm("重启 DSH 服务？\\n\\n正在进行的对话会被中断，页面稍后会自动重新连接。")) return;
\t\t\t\t\t\t\t\t\tsetRestarting(true);
\t\t\t\t\t\t\t\t\ttry {
\t\t\t\t\t\t\t\t\t\twindow.dshNative.restartServer();
\t\t\t\t\t\t\t\t\t} catch (error) {
\t\t\t\t\t\t\t\t\t\tsetRestarting(false);
\t\t\t\t\t\t\t\t\t\twindow.alert("重启失败：" + (error && error.message ? error.message : error));
\t\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t},
\t\t\t\t\t\t\t\tchildren: restarting ? "正在重启…" : "重启 DSH 服务"
\t\t\t\t\t\t\t})
\t\t\t\t\t\t})
\t\t\t\t\t]
\t\t\t\t})]
\t\t\t});
\t\t}`
      writeFileSync(generalSettingsPath, source.replace(existing[0], generalSection))
      console.log('settings: session initialization prompt + default preset added to the General page')
    }
  }
} else {
  problems.push(`startup prompt: ${generalSettingsPath} missing`)
}

// 15. Link profile-installed plugins into the install directory.
//
// Patches 1-14 aside, this exists because of patch 10. Restoring the alpha.1
// default `resolutionMode: "link"` stops alpha.2 from requiring an addon that
// has no Android build — but that mode also means PluginPackages gets an empty
// config and returns before installProfileResolution() runs, so the profile
// node_modules resolution route is never registered. A plugin installed into
// ~/.dsh/profiles/<name>/node_modules is then invisible to the loader, which
// resolves from the install directory and walks upward from there:
//
//   Cannot find package 'dshmarket' → plugin tree fails → nothing boots.
//
// Linking each plugin into <install>/node_modules makes it resolvable again.
// Only the plugin itself is linked, never its dependencies: Node resolves those
// from the symlink's real path, which lands on the profile's own node_modules
// where the versions the plugin actually asked for already live. Linking those
// too would shadow them with whatever the install tree happens to carry (dsh
// ships undici 8.x; dshmarket wants 7.x).
//
// Scoped and quiet on purpose: a profile with no node_modules, or a plugin name
// already taken in the install tree, is skipped rather than fought over.
//
// Honour $DSH_HOME like the rest of this file does. Hard-coding ~/.dsh here made
// the script unsafe to rehearse against a second install: it would reach across
// and rewrite the real profile's plugin bundles. That is exactly what happened on
// 2026-09-22 — a rehearsal in ~/dsh-isolation rewrote the live profile's sidebar
// bundles to 0.1.7 icon names while 0.1.6 was still running.
const profilesRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles')

// Sweep first for links of ours that no longer resolve. The loop below walks the
// profile's node_modules, so it can only ever repair a plugin the profile still
// lists — remove or rename the package and the dangling link is invisible to it,
// and a dangling link still satisfies a plain exists() check on the loader's
// side of the walk. Only entries that are symlinks into a profile are touched;
// dsh's own packages are real directories and are left alone.
let unlinked = 0
if (existsSync(profilesRoot)) {
  const profileNames = readdirSync(profilesRoot).filter((name) => !name.startsWith('.'))
  const roots = [nodeModules]
  for (const name of readdirSync(nodeModules)) {
    if (name.startsWith('@')) roots.push(join(nodeModules, name))
  }
  for (const root of roots) {
    let entries
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const name of entries) {
      const target = join(root, name)
      let stat
      try {
        stat = lstatSync(target)
      } catch {
        continue
      }
      if (!stat.isSymbolicLink() || existsSync(target)) continue
      // Dangling. Remove it only when it points into a profile we own, so an
      // unrelated broken link elsewhere in the tree is not ours to delete.
      let pointsIntoProfile = false
      try {
        const real = readlinkSync(target)
        pointsIntoProfile = profileNames.some((p) => real.startsWith(join(profilesRoot, p) + '/'))
      } catch {
        continue
      }
      if (!pointsIntoProfile) continue
      try {
        rmSync(target)
        unlinked += 1
        console.log(`profile plugin: removed dangling link for ${name}`)
      } catch (error) {
        console.warn(`profile plugin: could not remove dangling ${name}: ${error.message}`)
      }
    }
  }
}

if (existsSync(profilesRoot)) {
  let linked = 0
  for (const entry of readdirSync(profilesRoot)) {
    // Skip the workspace's own shared node_modules and anything hidden.
    if (entry.startsWith('.')) continue
    const profileDir = join(profilesRoot, entry)
    // Only real profiles (they carry a manifest), never loose directories.
    if (!existsSync(join(profileDir, 'package.json'))) continue
    const profileModules = join(profileDir, 'node_modules')
    if (!existsSync(profileModules)) continue
    for (const name of readdirSync(profileModules)) {
      if (name.startsWith('.')) continue
      // Scoped packages (@scope/name) need the scope directory handled too.
      const names = name.startsWith('@')
        ? readdirSync(join(profileModules, name)).map((sub) => `${name}/${sub}`)
        : [name]
      for (const pkgName of names) {
        const source = join(profileModules, pkgName)
        const target = join(nodeModules, pkgName)
        // lstat, not exists: a symlink of ours must be recognised even when its
        // target just vanished. Reinstalling or updating a plugin can replace the
        // profile directory, which leaves our link pointing at nothing — lstat
        // still succeeds there, so an exists-only check would call it "present",
        // skip it, and boot into the very failure this patch prevents.
        let kind = 'absent'
        try {
          const stat = lstatSync(target)
          kind = stat.isSymbolicLink() ? 'link' : 'entry'
        } catch {
          kind = 'absent'
        }
        if (kind === 'entry') continue // dsh's own package: never touch
        if (kind === 'link') {
          // Keep a healthy link (idempotence); rebuild a dangling one.
          if (existsSync(target)) continue
          try {
            rmSync(target)
          } catch (error) {
            console.warn(`profile plugin: could not replace dangling link ${pkgName}: ${error.message}`)
            continue
          }
        }
        try {
          mkdirSync(dirname(target), { recursive: true })
          symlinkSync(source, target, 'dir')
          linked += 1
          console.log(`profile plugin: linked ${pkgName} from profile ${entry}`)
        } catch (error) {
          // A race with a concurrent install, or a path we cannot write: warn,
          // never fail the launch over it.
          console.warn(`profile plugin: could not link ${pkgName}: ${error.message}`)
        }
      }
    }
  }
  if (linked === 0) {
    // Nothing to do is the normal case once everything is linked.
    console.log('profile plugins: all resolvable')
  }
}

// 16. Repair the global node-gyp so plugin installs can compile native deps.
//
// Some plugins pull in a native module that has no prebuilt for Android and
// compiles on the device instead (node-pty is the common one). That compile
// runs `node-gyp`, and on Termux the global one is broken in two ways at once.
//
// - Its shebang is `#!/usr/bin/env node`, and Termux has no /usr/bin/env, so
//    every invocation dies with a bare
//    `bad interpreter: No such file or directory` — surfaced to pnpm as exit
//    status 127. npm and npx avoid this only because their shebangs carry the
//    absolute Termux path.
// - npm left `$PREFIX/bin/node-gyp` as a *copy* of
//    `$PREFIX/lib/node_modules/node-gyp/bin/node-gyp.js` rather than the usual
//    symlink. The script does `require('../')`, which resolves relative to the
//    copy's own directory, so it looks for env-paths under $PREFIX instead of
//    inside the package and dies with `Cannot find module 'env-paths'`.
//
// Both are outside this install tree, which is why they are repaired here
// rather than in a profile: pnpm spawns `node-gyp` from PATH, so the PATH entry
// itself has to work. Idempotent, and silent when node-gyp is absent — it is
// only needed for plugins that build native code.
const prefixBin = dirname(process.execPath)
const gypEntry = join(prefixBin, '..', 'lib', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
const gypShim = join(prefixBin, 'node-gyp')
if (existsSync(gypEntry)) {
  // - shebang
  const termuxEnv = join(prefixBin, 'env')
  if (existsSync(termuxEnv)) {
    const source = readFileSync(gypEntry, 'utf8')
    const firstLine = source.slice(0, source.indexOf('\n'))
    if (firstLine === '#!/usr/bin/env node') {
      writeFileSync(gypEntry, `#!${termuxEnv} node${source.slice(firstLine.length)}`)
      console.log('node-gyp: shebang rewritten to the Termux env (there is no /usr/bin/env)')
    }
  }
  // - shim must be a symlink so `require('../')` lands inside the package
  let shimKind = 'absent'
  try {
    shimKind = lstatSync(gypShim).isSymbolicLink() ? 'link' : 'file'
  } catch {
    shimKind = 'absent'
  }
  if (shimKind === 'file') {
    let isOurCopy = false
    try {
      isOurCopy = readFileSync(gypShim, 'utf8').includes("process.title = 'node-gyp'")
    } catch {
      isOurCopy = false
    }
    if (isOurCopy) {
      try {
        rmSync(gypShim)
        symlinkSync(gypEntry, gypShim)
        console.log('node-gyp: PATH entry relinked to the package (was a copy that could not resolve its own deps)')
      } catch (error) {
        console.warn(`node-gyp: could not relink ${gypShim}: ${error.message}`)
      }
    }
  } else if (shimKind === 'link' && !existsSync(gypShim)) {
    // Dangling after a reinstall: rebuild it.
    try {
      rmSync(gypShim)
      symlinkSync(gypEntry, gypShim)
      console.log('node-gyp: rebuilt a dangling PATH entry')
    } catch (error) {
      console.warn(`node-gyp: could not rebuild ${gypShim}: ${error.message}`)
    }
  }
}

// 17. Repair plugin client bundles that call a primitives icon this dsh no
// longer exports.
//
// dsh reshapes its icon set between releases, and a plugin built against an
// older set keeps referring to the old name. 0.1.6-alpha.2 ships
// IconSendOutline14 but has no IconSendOutline16, while dsh-better-sidebar
// release 0.19.1 renders the latter in its side-chat composer. The property read
// yields undefined, and React throws #130 ("element type is invalid ... but got:
// undefined") the moment that view opens. Nothing warns beforehand: the
// plugin's peer range (^0.1.5-rc.1) still satisfies 0.1.6-alpha.2, so pnpm
// installs it happily.
//
// The scan resolves the alias each bundle uses for the primitives module and
// checks every `alias.Member` reference against the real export list. A missing
// icon that is only a size variant of one that exists is rewritten to that
// variant with the original size carried across, which renders the same glyph
// at the same size. Anything else is only reported: inventing a replacement for
// a component we cannot identify would be worse than saying so.
//
// Best effort on purpose — an unrepaired plugin must never stop the launcher,
// so nothing here is pushed to `problems`.
//
// Layout matters more than it looks. This scan first only looked at `client*.js`
// in the plugin root and in `lib/`, which silently skipped dshmarket: it ships
// its browser bundle as `client/client.js`. 0.1.7 renamed the whole icon set
// (IconX16 -> IconXMedium), so after that upgrade every icon the market read was
// undefined again and the market page died with React #130 while the log stayed
// quiet. Every directory a plugin is known to bundle into is scanned now, and
// the only filter left is file size.
const primitivesEntry = join(nodeModules, '@deepseek-ai', 'dsh-client-ui-primitives', 'lib', 'index.js')
if (existsSync(primitivesEntry)) {
  const primitivesSource = readFileSync(primitivesEntry, 'utf8')
  const exportMatch = /export \{([^}]*)\}/.exec(primitivesSource)
  const shipped = new Set(
    exportMatch ? exportMatch[1].split(',').map((name) => name.trim()).filter((name) => name !== '') : []
  )
  if (shipped.size > 0 && existsSync(profilesRoot)) {
    const profileModules = readdirSync(profilesRoot)
      .filter((name) => !name.startsWith('.'))
      .filter((name) => existsSync(join(profilesRoot, name, 'package.json')))
      .map((name) => join(profilesRoot, name, 'node_modules'))
      .filter((dir) => existsSync(dir))
    let repairedFiles = 0
    let repairedRefs = 0
    for (const modulesDir of profileModules) {
      const plugins = []
      for (const name of readdirSync(modulesDir)) {
        if (name.startsWith('.')) continue
        if (name.startsWith('@')) {
          const scopeDir = join(modulesDir, name)
          for (const sub of readdirSync(scopeDir)) plugins.push({ dir: join(scopeDir, sub), label: `${name}/${sub}` })
        } else {
          plugins.push({ dir: join(modulesDir, name), label: name })
        }
      }
      for (const plugin of plugins) {
        // Every directory a plugin is known to bundle into: the root, `lib/`,
        // `client/` (dshmarket), plus `dist/`, `assets/` and `src/` as cheap
        // insurance against the next layout.
        const bundleDirs = ['', 'lib', 'client', 'dist', 'assets', 'src', 'src/client'].map((sub) =>
          sub === '' ? plugin.dir : join(plugin.dir, sub),
        )
        const bundles = []
        for (const dir of bundleDirs) {
          if (!existsSync(dir)) continue
          for (const name of readdirSync(dir)) {
            if (!name.endsWith('.js')) continue
            const full = join(dir, name)
            let size
            try {
              size = statSync(full).size
            } catch {
              continue
            }
            // A minified bundle can be a megabyte; a generated asset should not be
            // read into memory just to be skipped.
            if (size > 8 * 1024 * 1024) continue
            bundles.push(full)
          }
        }
        for (const file of bundles) {
          const source = readFileSync(file, 'utf8')
          // How this bundle names the primitives module.
          const aliases = new Set()
          for (const match of source.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?require\("(?:@deepseek-ai\/)?dsh-client-ui-primitives"\)/g)) {
            aliases.add(match[1])
          }
          if (aliases.size === 0) continue
          let patched = source
          for (const alias of aliases) {
            const refs = new Set()
            for (const match of source.matchAll(new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)`, 'g'))) refs.add(match[1])
            for (const member of refs) {
              if (shipped.has(member)) continue
              // Same stem, different size suffix: the same glyph, rescaled.
              let replacement = null
              const sized = /^(Icon[A-Za-z0-9_]*?)(\d+)$/.exec(member)
              if (sized !== null) {
                const stem = sized[1]
                const want = Number(sized[2])
                const variants = []
                for (const name of shipped) {
                  const each = /^([A-Za-z0-9_]*?)(\d+)$/.exec(name)
                  if (each !== null && each[1] === stem) variants.push({ name, size: Number(each[2]) })
                }
                if (variants.length > 0) {
                  variants.sort((a, b) => Math.abs(a.size - want) - Math.abs(b.size - want) || a.size - b.size)
                  replacement = { name: variants[0].name, size: want }
                } else if (shipped.has(`${stem}Medium`)) {
                  // 0.1.7 moved the size out of the name and into a stroke-weight
                  // suffix pair: IconSendOutline16 -> IconSendOutlineMedium (or
                  // ...Regular). Same glyph, and the size still travels in props.
                  replacement = { name: `${stem}Medium`, size: want }
                } else if (shipped.has(`${stem}Regular`)) {
                  replacement = { name: `${stem}Regular`, size: want }
                }
              }
              if (replacement === null) {
                console.warn(`plugin icons: ${plugin.label} references ${member}, which this dsh does not export and cannot be substituted`)
                continue
              }
              const empty = `${alias}.${member}, {}`
              if (patched.includes(empty)) {
                patched = patched.split(empty).join(`${alias}.${replacement.name}, { size: ${replacement.size} }`)
              } else {
                patched = patched.split(`${alias}.${member}`).join(`${alias}.${replacement.name}`)
                console.warn(`plugin icons: ${plugin.label} uses ${member} with props; rewrote to ${replacement.name} without forcing size ${replacement.size}`)
              }
              repairedRefs += 1
            }
          }
          if (patched !== source) {
            writeFileSync(file, patched)
            repairedFiles += 1
          }
        }
      }
    }
    if (repairedRefs > 0) {
      console.log(`plugin icons: repaired ${repairedRefs} stale reference(s) in ${repairedFiles} bundle(s)`)
    }
  }
}

// 18. Rebuild the profile-level module farm, and flatten what npm nested.
//
// A plugin installed under $DSH_HOME/profiles/<name>/node_modules lists the
// harness packages it extends (@deepseek-ai/dsh-settings, @deepseek-ai/dsh-agent,
// ...) as peers. Node resolves those by walking up from the plugin's real path:
// profiles/<name>/node_modules, profiles/node_modules, $DSH_HOME/node_modules, ...
// — and the install tree is not on that walk, so the import dies with
// ERR_MODULE_NOT_FOUND and the loader only reports "failed to import".
//
// 0.1.6 filled that gap itself: `link` resolution mode healed a flat symlink farm
// at $DSH_HOME/profiles/node_modules pointing back into <install>/node_modules.
// 0.1.7 dropped that mode for runtime interception, which needs the addon Android
// has no build of (patch 19 skips it), so the farm has to be maintained here.
// The loader resolves bundle names from the install tree rather than from a
// profile, so a package npm left nested also has to be exposed there.
//
// Only packages, never plugin directories: a plugin is reached through its own
// profile (plus the install-tree link patch 15 creates), and mirroring plugins
// into the shared farm would expose one profile's plugins to every other profile.
// Existing entries are left alone unless they dangle, so a hand-made link or a
// real directory is never fought over.
const farmDir = join(profilesRoot, 'node_modules')
if (existsSync(profilesRoot)) {
  mkdirSync(farmDir, { recursive: true })
  const installNames = new Set()
  const farmedNames = new Set()
  let farmLinked = 0
  let farmPruned = 0
  /** Every package directly under one node_modules directory, scopes expanded. */
  const packageEntries = (dir) => {
    const out = []
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return out
    }
    for (const name of names) {
      if (name === '.bin' || name.startsWith('.')) continue
      if (name.startsWith('@')) {
        let subs
        try {
          subs = readdirSync(join(dir, name))
        } catch {
          continue
        }
        for (const sub of subs) out.push({ scope: name, name: sub, dir: join(dir, name, sub) })
      } else {
        out.push({ scope: '', name, dir: join(dir, name) })
      }
    }
    return out
  }
  const farmOne = (scope, name, target) => {
    const relative = scope === '' ? name : join(scope, name)
    installNames.add(relative)
    const link = join(farmDir, relative)
    let stat = null
    try {
      stat = lstatSync(link)
    } catch {
      stat = null
    }
    if (stat !== null) {
      if (!stat.isSymbolicLink()) return
      if (existsSync(link)) return
      try {
        rmSync(link)
        farmPruned += 1
      } catch {
        return
      }
    }
    if (scope !== '') mkdirSync(join(farmDir, scope), { recursive: true })
    try {
      symlinkSync(target, link)
      farmLinked += 1
    } catch (error) {
      problems.push(`profile farm: could not link ${relative}: ${error.message}`)
    }
  }
  for (const scope of readdirSync(farmDir)) {
    if (scope === '.bin' || scope.startsWith('.')) continue
    if (scope.startsWith('@')) {
      let subs
      try {
        subs = readdirSync(join(farmDir, scope))
      } catch {
        continue
      }
      for (const sub of subs) farmedNames.add(join(scope, sub))
    } else {
      farmedNames.add(scope)
    }
  }
  // Top level first: where npm hoisted a package, that copy wins.
  for (const entry of packageEntries(nodeModules)) farmOne(entry.scope, entry.name, entry.dir)
  // Then flatten what npm left nested inside an install-tree package (a
  // dependency of one package rather than a hoisted entry): a profile cannot
  // reach those either. The agent-team client UI package is the one that bites —
  // it lives under @deepseek-ai/dsh-experimental-agent-team-profile/node_modules.
  const frontier = [nodeModules]
  const nestedDirs = []
  for (let depth = 0; depth < 4 && frontier.length > 0; depth += 1) {
    const next = []
    for (const dir of frontier) {
      for (const entry of packageEntries(dir)) {
        const inner = join(entry.dir, 'node_modules')
        if (existsSync(inner)) {
          next.push(inner)
          nestedDirs.push(inner)
        }
      }
    }
    for (const dir of next) {
      for (const entry of packageEntries(dir)) {
        const relative = entry.scope === '' ? entry.name : join(entry.scope, entry.name)
        if (installNames.has(relative)) continue
        farmOne(entry.scope, entry.name, entry.dir)
      }
    }
    frontier.length = 0
    frontier.push(...next)
  }
  // The loader imports bundle names from the install tree, so a nested package has
  // to be reachable there too — the farm only serves importers inside a profile.
  // Same rule as patch 15: a name the install tree already owns is left alone.
  let flattened = 0
  const installTop = new Set(
    packageEntries(nodeModules).map((entry) => (entry.scope === '' ? entry.name : join(entry.scope, entry.name)))
  )
  for (const dir of nestedDirs) {
    for (const entry of packageEntries(dir)) {
      const relative = entry.scope === '' ? entry.name : join(entry.scope, entry.name)
      if (installTop.has(relative)) continue
      const link = join(nodeModules, relative)
      let stat = null
      try {
        stat = lstatSync(link)
      } catch {
        stat = null
      }
      if (stat !== null) {
        if (!stat.isSymbolicLink() || existsSync(link)) {
          installTop.add(relative)
          continue
        }
        try {
          rmSync(link)
        } catch {
          continue
        }
      }
      try {
        if (entry.scope !== '') mkdirSync(join(nodeModules, entry.scope), { recursive: true })
        symlinkSync(entry.dir, link)
        installTop.add(relative)
        flattened += 1
      } catch (error) {
        problems.push(`install flatten: could not link ${relative}: ${error.message}`)
      }
    }
  }
  // A farm link has exactly two legitimate sources: this install tree, and a
  // profile directory under $DSH_HOME. A rehearsal in a separate DSH_HOME once
  // ran this script with a hard-coded profilesRoot and wrote that tree's paths
  // into this farm. Every one of those links still resolved, so the linking loop
  // above left them alone and the old prune never saw them: it only visits names
  // this release still installs, and these links were not dangling. Production
  // then depends on a directory that exists only to be deleted. Re-point them at
  // the install tree, and drop the links left dangling by packages this release
  // removed.
  //
  // The test is the link's own target string, not where it resolves to: an
  // install-tree entry may itself be a link into a profile (patches 15/18 create
  // those), and following the chain would re-point those links on every run.
  let farmRepointed = 0
  const farmRoots = [nodeModules, profilesRoot].map((dir) => resolve(dir))
  const sweepFarm = (dir) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name === '.bin') continue
      const link = join(dir, name)
      let stat
      try {
        stat = lstatSync(link)
      } catch {
        continue
      }
      if (!stat.isSymbolicLink()) {
        // `@scope` directories hold the other half of the farm.
        if (stat.isDirectory() && name.startsWith('@')) sweepFarm(link)
        continue
      }
      let target = null
      try {
        target = readlinkSync(link)
      } catch {
        continue
      }
      const absolute = resolve(dir, target)
      const rel = relative(farmDir, link)
      // A link that no longer resolves is dead wherever it points: an upgrade
      // removes and replaces packages, so a farm link into the install tree then
      // dangles while its target string still reads as "inside the tree". Prune
      // it before the roots test, or nothing ever collects it — the linking loop
      // only visits names this release still installs.
      if (!existsSync(link)) {
        try {
          rmSync(link)
          farmPruned += 1
        } catch {
          // Leave it for the next run rather than aborting the launcher.
        }
        continue
      }
      if (farmRoots.some((root) => absolute === root || absolute.startsWith(root + sep))) continue
      const installCopy = join(nodeModules, rel)
      if (existsSync(installCopy)) {
        try {
          rmSync(link)
          symlinkSync(installCopy, link)
          farmRepointed += 1
        } catch (error) {
          problems.push(`profile farm: could not re-point ${rel}: ${error.message}`)
        }
        continue
      }
      console.warn(`profile farm: ${rel} points outside $DSH_HOME (${target}); left alone`)
    }
  }
  sweepFarm(farmDir)
  if (farmLinked > 0 || farmPruned > 0 || farmRepointed > 0) {
    console.log(
      `profile farm: linked ${farmLinked}, pruned ${farmPruned} stale link(s), re-pointed ${farmRepointed} link(s) into the install tree under ${farmDir}`,
    )
  }
  if (flattened > 0) console.log(`install flatten: exposed ${flattened} nested package(s) at the install root`)
}

// 19. Skip the runtime resolution interception on Android.
//
// 0.1.7-alpha.1 made profile resolution runtime-only and now installs an
// interception on Node's ESM and CJS resolvers from PluginPackages' constructor.
// Installing it calls internalModules(), which does an *unguarded*
// `require("node-addon-require-builtin")` — darwin/linux/win32 bindings only, and
// no android-arm64 build has ever been published — so boot dies with
// `host preparation failed: No usable native binding found for
//  node-addon-require-builtin-android-arm64`.
//
// PluginPackages tolerates a missing interception: packageOf() falls back to
// packageDirFromParent()'s native lookup when it is undefined. Skipping the
// interception therefore restores 0.1.6's "link" semantics, and patches 15/18
// keep plugins and their peers reachable without it. The other caller
// (collectConfigSchemas, reached only by --dump-config) needs the Node module
// loader anyway, so it is left alone.
const ANDROID_RUNTIME_GUARD =
  '\t\tif (process.platform === "android") return; // ANDROID_PATCH: no node-addon-require-builtin build for android-arm64'
const appBootEntry = join(nodeModules, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
if (existsSync(appBootEntry)) {
  const source = readFileSync(appBootEntry, 'utf8')
  const anchor = '\t\tconst interception = installRuntimeInterception(config.resolution);'
  if (source.includes(ANDROID_RUNTIME_GUARD)) {
    // already patched
  } else if (source.includes(anchor)) {
    writeFileSync(appBootEntry, source.replace(anchor, `${ANDROID_RUNTIME_GUARD}\n${anchor}`))
    console.log('runtime resolution: interception skipped on android (no require-builtin binding)')
  } else {
    console.log('runtime resolution: no PluginPackages interception in this release; nothing to skip')
  }
} else {
  problems.push(`runtime resolution: ${appBootEntry} missing`)
}

// 20. Plugin metadata without the internal module loader.
//
// Patch 19 leaves the runtime interception uninstalled, which is what boot needs,
// but PluginPackages.readPluginMeta() resolves each plugin's locale files and
// package.json through ModuleLoader.fromInternal() — the same internal loader —
// to read titles, descriptions and icons *without evaluating plugin code*. With
// no interception that loader is undefined, so every package plugin in the list,
// official built-ins included, reports
//
//   Plugin metadata for <name>: Error: Plugin metadata requires the Node module
//   resolver
//
// instead of its display text. The metadata path only needs "resolve this
// specifier from this parent URL", which import-meta-resolve performs with the
// same algorithm and conditions. Its lower-level `moduleResolve` is used, not the
// public `resolve`: for a package with no `exports` field, `resolve` substitutes
// the subpath without checking that the file exists, so a plugin that ships no
// locale directory (dsh-whale-widget) reached readdirSync and failed with ENOENT
// instead of the "no locale file" that the caller handles. `moduleResolve` agrees
// with the internal resolver on all 882 checked resolutions (every profile plugin
// and every built-in @deepseek-ai package, × package.json and locale/en.json),
// error codes included, and the caller matches on those codes to treat a missing
// locale file as optional. The package is already in the tree and Node 22+ can
// require it from ESM, so the fallback stays synchronous as the caller requires.
// If it is ever absent, fall back to the CommonJS resolver: the subpaths at issue
// (./package.json, ./locale/*.json) carry no import-only conditions.
const ANDROID_META_RESOLVER_GUARD = 'ANDROID_PATCH_META_RESOLVER'
const metaResolverAnchor = `function resolvePluginResource(specifier, parentURL) {
\tconst loader = ModuleLoader.fromInternal();
\tif (loader === void 0) throw new Error("Plugin metadata requires the Node module resolver");`
if (existsSync(appBootEntry)) {
  const source = readFileSync(appBootEntry, 'utf8')
  if (source.includes(ANDROID_META_RESOLVER_GUARD)) {
    // already patched
  } else if (source.includes(metaResolverAnchor)) {
    const replacement = `function androidPluginResourcePath(specifier, parentURL) { // ${ANDROID_META_RESOLVER_GUARD}
\tlet moduleResolve;
\ttry {
\t\tmoduleResolve = createRequire(import.meta.url)("import-meta-resolve").moduleResolve;
\t} catch {
\t\treturn createRequire(parentURL).resolve(specifier);
\t}
\tconst resolved = moduleResolve(specifier, parentURL);
\treturn fileURLToPath(typeof resolved === "string" ? resolved : resolved.href);
}
function resolvePluginResource(specifier, parentURL) {
\tconst loader = ModuleLoader.fromInternal();
\tif (loader === void 0) return androidPluginResourcePath(specifier, parentURL);`
    writeFileSync(appBootEntry, source.replace(metaResolverAnchor, replacement))
    console.log('plugin metadata: resolving resources without the internal loader (android)')
  } else {
    console.log('plugin metadata: resolver anchor missing in this release; nothing to patch')
  }
}

// 21. Recover writer locks orphaned by a killed process.
//
// @deepseek-ai/dsh-atomic-write serializes every writer of a file behind a
// sibling `<file>.lock` holding the writer's pid, and its own documentation is
// explicit that a contender never removes an existing lock ("file age cannot
// prove that its owner stopped; orphan recovery is an operator action"). That is
// the right rule for a desktop, and the wrong one for a phone that restarts the
// server by SIGTERM: the market cancels a plugin install, or the launcher kills
// a boot, and `$DSH_HOME/profiles/web/package.json.lock` survives its owner.
//
// Every later plugin install then blocks on it and gives up — the market spins
// "installing" until the user cancels, and `dsh plugin add` dies with
// `atomic-write: timed out waiting for the writer lock`. Nothing else clears it,
// so plugin management stays dead until someone deletes a 6-byte file by hand.
// This ran at every launch, which is exactly when no install can be in flight:
// the launcher has already killed the previous server and has not started the
// next one.
//
// Only a lock whose contents are a single pid is touched, and only when that pid
// is provably gone — a live process keeps its lock, and so does a file whose
// format this patch does not recognise.
const recoverLocks = (dir) => {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.lock')) continue
    const lockPath = join(dir, name)
    let raw
    try {
      raw = readFileSync(lockPath, 'utf8').trim()
    } catch {
      continue
    }
    if (!/^[1-9][0-9]*$/.test(raw)) continue
    const pid = Number(raw)
    let orphaned = false
    try {
      const started = statSync(`/proc/${pid}`).mtimeMs
      // The holder writes the lock during its own life, so a process that began
      // after the lock was written cannot be the one that took it: the pid was
      // recycled.
      orphaned = started > statSync(lockPath).mtimeMs + 5000
    } catch (error) {
      // No such process at all — the common case (killed boot or cancelled
      // install). EACCES instead means the pid exists but is not ours, so the
      // holder is alive and the lock stays.
      orphaned = error?.code === 'ENOENT'
    }
    if (!orphaned) continue
    try {
      rmSync(lockPath)
      console.log(`writer locks: recovered ${lockPath} (holder pid ${pid} is gone)`)
    } catch (error) {
      console.warn(`writer locks: could not remove ${lockPath}: ${error.message}`)
    }
  }
}
for (const profile of (() => {
  const out = []
  try {
    for (const name of readdirSync(profilesRoot)) {
      if (!name.startsWith('.')) out.push(join(profilesRoot, name))
    }
  } catch {
    // No profiles yet on a fresh install; nothing to recover.
  }
  return out
})()) {
  recoverLocks(profile)
}

// 22. Teach the plugin market's own validator the list-valued patch declaration.
//
// dsh 0.1.7 ships `@deepseek-ai/dsh-web-app` with
// `dsh.bundle.patch: ["./cordis.patch.yml", "./presets/standard.patch.yml", ...]`
// — five patch files: the app plus the four shipped presets. The boot accepts
// both shapes (`bundlePatchFiles()`: "must be a file path or a list of file
// paths"), but dshmarket's `buildBundleLayers()` still reads the field as a
// string only and reports
//
//   bundle declares no dsh.bundle.patch — the profile will fail to boot
//
// for the official web-app layer. Its trial validation treats that as fatal, so
// on 0.1.7 the market rolls back EVERY install and update it attempts — and the
// rollback rewrites the market's own bundle from npm, which is also what wipes
// patch 17's icon repair and brings React #130 straight back.
//
// This is not fixed by updating the market: 1.55.0 carries the same string-only
// check. So the validator is taught the shape the boot already accepts. Both
// sites are patched — the layer build, and the composed-row list that re-parses
// the layer's patch — because parsing only the first of five files would make
// the trial replay a different composition than the boot.
//
// Anchored and guarded: a market that grows list support itself no longer
// matches, and the patch then says so instead of corrupting it.
const marketPatchListGuard = 'ANDROID_PATCH_MARKET_PATCH_LIST'
const marketDeclaredAnchor = [
  '        const declared = bundleManifest.dsh?.bundle?.patch;',
  "        if (typeof declared !== 'string') {",
  "            layer.error = 'bundle declares no dsh.bundle.patch — the profile will fail to boot';",
  '            return layer;',
  '        }',
  '        const patchPath = join(directory, declared);',
  '        if (!existsSync(patchPath)) {',
  '            layer.error = `declared patch ${declared} is missing — the profile will fail to boot`;',
  '            return layer;',
  '        }',
  '        layer.patchPath = patchPath;',
  '        const patches = parsePatchFile(patchPath);',
  '        if (patches === null) {',
  "            layer.parseError = 'patch file is not a valid entry list';",
  '            return layer;',
  '        }',
].join('\n')
const marketDeclaredReplacement = [
  `        // ${marketPatchListGuard}: mirror the boot's own bundlePatchFiles(), which`,
  '        // accepts a path or a list of paths. dsh-web-app declares five patch files.',
  '        const declaredField = bundleManifest.dsh?.bundle?.patch;',
  '        const declaredList = typeof declaredField === \'string\'',
  '            ? [declaredField]',
  '            : Array.isArray(declaredField)',
  '                ? declaredField.filter((entry) => typeof entry === \'string\')',
  '                : [];',
  '        if (declaredList.length === 0) {',
  "            layer.error = 'bundle declares no dsh.bundle.patch — the profile will fail to boot';",
  '            return layer;',
  '        }',
  '        const missing = declaredList.find((entry) => !existsSync(join(directory, entry)));',
  '        if (missing !== undefined) {',
  "            layer.error = 'declared patch ' + missing + ' is missing — the profile will fail to boot';",
  '            return layer;',
  '        }',
  '        const patchPaths = declaredList.map((entry) => join(directory, entry));',
  '        layer.patchPath = patchPaths[0];',
  '        layer.patchPaths = patchPaths;',
  '        const patches = [];',
  '        for (const patchPath of patchPaths) {',
  '            const parsed = parsePatchFile(patchPath);',
  '            if (parsed === null) {',
  "                layer.parseError = 'patch file is not a valid entry list';",
  '                return layer;',
  '            }',
  '            patches.push(...parsed);',
  '        }',
].join('\n')
const marketLayersAnchor =
  '        patches: bundle.patchPath !== null && bundle.parseError === null ? parsePatchFile(bundle.patchPath) ?? [] : [],'
const marketLayersReplacement =
  '        patches: bundle.parseError === null && bundle.patchPaths !== undefined ? bundle.patchPaths.flatMap((patchPath) => parsePatchFile(patchPath) ?? []) : [],'
for (const profile of (() => {
  const out = []
  try {
    for (const name of readdirSync(profilesRoot)) {
      if (!name.startsWith('.')) out.push(join(profilesRoot, name))
    }
  } catch {
    // No profiles yet on a fresh install; nothing to patch.
  }
  return out
})()) {
  const marketCheck = join(profile, 'node_modules', 'dshmarket', 'lib', 'check.js')
  if (!existsSync(marketCheck)) continue
  const source = readFileSync(marketCheck, 'utf8')
  if (source.includes(marketPatchListGuard)) continue
  if (!source.includes(marketDeclaredAnchor) || !source.includes(marketLayersAnchor)) {
    console.log(`market check: ${marketCheck} does not match this patch's anchors; left alone`)
    continue
  }
  writeFileSync(
    marketCheck,
    source.replace(marketDeclaredAnchor, marketDeclaredReplacement).replace(marketLayersAnchor, marketLayersReplacement),
  )
  console.log('market check: accepting a list-valued dsh.bundle.patch (matches the boot)')
}

// 23. Terminal inspection. The right-sidebar terminal asks subprocess-local for a
// platform process inspector *before* it allocates its pty, and that factory knows
// linux/darwin/win32 only — Node reports "android" on Termux, so the feature dies
// with `subprocess-local: terminal inspection is unsupported on platform android`
// and no terminal ever opens. Android is Linux for everything the inspector
// touches: /proc keeps the standard layout and is readable for our own children
// (`stat`, `fd/0`, `task/<tid>/syscall` all verified on device), bionic uses the
// same arm64 syscall numbers the inspector already carries, and node-pty spawns a
// working pty here. Process *containment* deliberately stays on the fallback path:
// the linux-scope probe needs user systemd or a private bootstrap, neither exists
// under Termux, and that path only warns.
const terminalInspectorMarker = 'ANDROID_PATCH: android is linux'
const subprocessLocal = join(nodeModules, '@deepseek-ai', 'dsh-subprocess-local', 'lib')
if (existsSync(subprocessLocal)) {
  // The runtime bundle carries a content hash, so find it by shape rather than name.
  for (const entry of readdirSync(subprocessLocal)) {
    if (!entry.startsWith('runner-launch-') || !entry.endsWith('.js')) continue
    const file = join(subprocessLocal, entry)
    const source = readFileSync(file, 'utf8')
    if (source.includes(terminalInspectorMarker)) continue
    const anchor = 'if (platform === "linux") return new LinuxProcessInspector(arch, internals);'
    if (!source.includes(anchor)) {
      problems.push(`terminal inspector: anchor missing in ${file}`)
      continue
    }
    writeFileSync(
      file,
      source.replace(
        anchor,
        `if (platform === "linux" || platform === "android") return new LinuxProcessInspector(arch, internals); // ${terminalInspectorMarker}: bionic + /proc`,
      ),
    )
    console.log('terminal inspector: android now resolves to the Linux process inspector')
  }

  const runtime = join(subprocessLocal, 'index.js')
  if (existsSync(runtime)) {
    const source = readFileSync(runtime, 'utf8')
    if (!source.includes(terminalInspectorMarker)) {
      // Same reason: an exited shell is classified through the Linux process table.
      const anchor = 'this.platform === "linux" && observed.complete === true'
      if (source.includes(anchor)) {
        writeFileSync(
          runtime,
          source.replace(
            anchor,
            `(this.platform === "linux" || this.platform === "android") /* ${terminalInspectorMarker} */ && observed.complete === true`,
          ),
        )
        console.log('terminal activity: android classifies an exited shell through the Linux process table')
      } else {
        problems.push(`terminal activity: anchor missing in ${runtime}`)
      }
    }
  }
} else {
  problems.push(`terminal inspector: ${subprocessLocal} missing`)
}

// 25. A file path in the preview header can never be read in full on a touch screen.
//
// The header uses the primitives `PathLabel`, a one-line label that clips the path from
// the left and fades the clipped part out; the complete path exists only in the `title`
// attribute, which a touch screen has no way to reveal. A long absolute path therefore
// only ever shows its tail ("...eepseek-har"), and there is no gesture for the rest.
//
// The label is rendered by the prebuilt client shell, so patching the primitives source
// would not reach the browser. This plugin's own bundle is served from disk, so the two
// call sites in the header get a local label that keeps the same DOM and props but
// expands in place when tapped: the path wraps onto as many lines as it needs and the
// header grows with it. Tapping again collapses it to the single line.
const documentPreviewClientPath = join(nodeModules, '@deepseek-ai', 'dsh-client-ui-sidebar-documentpreview', 'lib', 'client.js')
const fullPathMarker = 'ANDROID_PATCH_FULL_PATH'
if (existsSync(documentPreviewClientPath)) {
  const source = readFileSync(documentPreviewClientPath, 'utf8')
  if (source.includes(fullPathMarker)) {
    // already patched
  } else {
    const cssAnchor = '\t\t\t"wrap": "dhJKeW_wrap"\n\t\t};'
    const component = [
      cssAnchor,
      `\t\t// ${fullPathMarker}: a local path label that reveals the whole path on tap.`,
      '\t\t// The header has a fixed height, so it is allowed to grow only while expanded.',
      '\t\tfunction AndroidFullPathLabel({ path: displayPath, className, ...attributes }) {',
      '\t\t\tconst [expanded, setExpanded] = (0, react.useState)(false);',
      '\t\t\tconst { directory, name } = pathPartsOf(displayPath);',
      '\t\t\t(0, react.useEffect)(() => {',
      '\t\t\t\tsetExpanded(false);',
      '\t\t\t}, [displayPath]);',
      '\t\t\t(0, react.useEffect)(() => {',
      '\t\t\t\tif (typeof document === "undefined") return;',
      '\t\t\t\tif (document.querySelector(\'style[data-android-patch="full-path"]\') !== null) return;',
      '\t\t\t\tconst tag = document.createElement("style");',
      '\t\t\t\ttag.dataset.androidPatch = "full-path";',
      '\t\t\t\ttag.textContent = `.${TextPreview_module_css_default.header}:has([data-android-full-path][data-full-path-expanded]){height:auto!important;min-height:38px;align-items:flex-start!important;padding-top:6px!important;padding-bottom:6px!important}`;',
      '\t\t\t\tdocument.head.appendChild(tag);',
      '\t\t\t}, []);',
      '\t\t\tconst collapsedStyle = {',
      '\t\t\t\tflex: "1 1 auto",',
      '\t\t\t\tminWidth: 0,',
      '\t\t\t\toverflow: "hidden",',
      '\t\t\t\twhiteSpace: "nowrap",',
      '\t\t\t\ttextOverflow: "ellipsis",',
      '\t\t\t\tfontSize: 12,',
      '\t\t\t\tcursor: "pointer"',
      '\t\t\t};',
      '\t\t\tconst expandedStyle = {',
      '\t\t\t\tflex: "1 1 auto",',
      '\t\t\t\tminWidth: 0,',
      '\t\t\t\toverflow: "visible",',
      '\t\t\t\twhiteSpace: "normal",',
      '\t\t\t\toverflowWrap: "anywhere",',
      '\t\t\t\tfontSize: 12,',
      '\t\t\t\tcursor: "pointer",',
      '\t\t\t\ttextAlign: "left"',
      '\t\t\t};',
      '\t\t\treturn (0, react_jsx_runtime.jsx)("span", {',
      '\t\t\t\t...attributes,',
      '\t\t\t\tclassName,',
      '\t\t\t\ttitle: displayPath,',
      '\t\t\t\t"data-path-label": true,',
      '\t\t\t\t"data-android-full-path": true,',
      '\t\t\t\t"data-full-path-expanded": expanded ? "" : void 0,',
      '\t\t\t\tstyle: expanded ? expandedStyle : collapsedStyle,',
      '\t\t\t\tonClick: () => setExpanded((value) => !value),',
      '\t\t\t\tchildren: (0, react_jsx_runtime.jsxs)("span", {',
      '\t\t\t\t\tchildren: [directory !== "" && (0, react_jsx_runtime.jsx)("span", {',
      '\t\t\t\t\t\tstyle: {',
      '\t\t\t\t\t\t\tcolor: "var(--dsw-alias-label-tertiary)"',
      '\t\t\t\t\t\t},',
      '\t\t\t\t\t\tchildren: directory',
      '\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {',
      '\t\t\t\t\t\tchildren: name',
      '\t\t\t\t\t})]',
      '\t\t\t\t})',
      '\t\t\t});',
      '\t\t}',
    ].join('\n')

    const callSite = '(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.PathLabel, {'
    const callCount = source.split(callSite).length - 1
    if (!source.includes(cssAnchor) || callCount < 2) {
      problems.push(`full path: anchors missing in ${documentPreviewClientPath} (call sites: ${callCount})`)
    } else {
      const patched = source
        .replace(cssAnchor, component)
        .replaceAll(callSite, '(0, react_jsx_runtime.jsx)(AndroidFullPathLabel, {')
      writeFileSync(documentPreviewClientPath, patched)
      console.log(`file preview: tapping the path reveals the full path (${callCount} call sites)`)
    }
  }
} else {
  problems.push(`full path: ${documentPreviewClientPath} missing`)
}

// 26. "Show file location" cannot work on Android, and fails as a dead button.
//
// The control appears whenever no application is registered for the file type, which is
// always the case here: `nativeFileManager()` knows finder/explorer/directory and answers
// null for android, so the Host refuses the reveal, the page reports "无法显示文件位置，
// 请重试" and the user is left with a button that can only fail.
//
// Android has no OS file manager to reveal a path in — but the phone the WebView runs on
// can hold the path, and "copy the absolute path" is the gesture a phone user wants from
// that button anyway ("where is this file? give me the path"). So on Android the same
// control copies the full path through the primitives clipboard helper and confirms with
// a toast; the label and icon change to say what it does. The menu entry that opens the
// file in a native application is untouched.
const openInAppClientPath = join(nodeModules, '@deepseek-ai', 'dsh-client-ui-open-in-app', 'lib', 'client.js')
const revealCopyMarker = 'ANDROID_PATCH_REVEAL_COPY'
if (existsSync(openInAppClientPath)) {
  const source = readFileSync(openInAppClientPath, 'utf8')
  if (source.includes(revealCopyMarker)) {
    // already patched
  } else {
    // 0.2.2 replaced the `null | "revealError"` return of `openPath` with an outcome
    // object, and moved the success toast out of the button into the shared `report`
    // seat. Both shapes are handled so the patch also keeps applying to 0.2.1 trees.
    const outcomeObjects = source.includes('if (ok) return { kind: action === "reveal" ? "revealed" : "opened" };')
    const toastEdit = outcomeObjects
      ? [
          '\t\t\t\ttext: t(toast.kind === "opened" ? "path.opened" : "path.revealed"),',
          [
            `\t\t\t\t// ${revealCopyMarker}: the copied path is the confirmation.`,
            '\t\t\t\ttext: t(toast.kind === "opened" ? "path.opened" : ANDROID_REVEAL_COPY ? "path.copied" : "path.revealed"),',
          ].join('\n'),
        ]
      : [
          '\t\t\t\t\texecute(operation).then((failure) => {\n\t\t\t\t\t\tif (failure !== null) show(t(`path.${failure}`));\n\t\t\t\t\t}).finally(() => {',
          [
            '\t\t\t\t\texecute(operation).then((failure) => {',
            '\t\t\t\t\t\tif (failure !== null) show(t(`path.${failure}`));',
            `\t\t\t\t\t\t// ${revealCopyMarker}: a copy that worked deserves the same feedback as a failure.`,
            '\t\t\t\t\t\telse if (ANDROID_REVEAL_COPY && operation.kind === "reveal") show(t("path.copied"));',
            '\t\t\t\t\t}).finally(() => {',
          ].join('\n'),
        ]
    const edits = [
      [
        '\t\tlet _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");',
        [
          '\t\tlet _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");',
          `\t\t// ${revealCopyMarker}: Android has no file-manager reveal, so the same gesture copies`,
          '\t\t// the absolute path, which the WebView can do itself. The label and icon follow.',
          '\t\tconst ANDROID_REVEAL_COPY = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);',
        ].join('\n'),
      ],
      [
        '\t\t\tasync openPath(path, action, application) {\n\t\t\t\tconst request = action === "reveal" ? {',
        [
          '\t\t\tasync openPath(path, action, application) {',
          `\t\t\t\t// ${revealCopyMarker}: no Host round trip when there is nothing to reveal.`,
          '\t\t\t\tif (ANDROID_REVEAL_COPY && action === "reveal") {',
          '\t\t\t\t\tconst copied = await _deepseek_ai_dsh_client_ui_primitives.writeClipboard(path);',
          outcomeObjects
            ? '\t\t\t\t\treturn copied ? { kind: "revealed" } : { kind: "failed", failure: "revealError" };'
            : '\t\t\t\t\treturn copied ? null : "revealError";',
          '\t\t\t\t}',
          '\t\t\t\tconst request = action === "reveal" ? {',
        ].join('\n'),
      ],
      toastEdit,
      [
        '\t\t\t"path.reveal": "显示文件位置",',
        [
          `\t\t\t"path.reveal": ANDROID_REVEAL_COPY ? "复制完整路径" : "显示文件位置", // ${revealCopyMarker}`,
          '\t\t\t"path.copied": "已复制完整路径",',
        ].join('\n'),
      ],
      [
        '\t\t\t"path.reveal": "Show file location",',
        [
          `\t\t\t"path.reveal": ANDROID_REVEAL_COPY ? "Copy full path" : "Show file location", // ${revealCopyMarker}`,
          '\t\t\t"path.copied": "Full path copied",',
        ].join('\n'),
      ],
      [
        '\t\t\t}) : revealDefault ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenOutlineRegular, { size: props.prominent ? 18 : 13 }) : (0, react_jsx_runtime.jsx)(ApplicationIcon, {',
        '\t\t\t}) : revealDefault ? (0, react_jsx_runtime.jsx)(ANDROID_REVEAL_COPY ? _deepseek_ai_dsh_client_ui_primitives.IconCopyOutlineRegular : _deepseek_ai_dsh_client_ui_primitives.IconFolderOpenOutlineRegular, { size: props.prominent ? 18 : 13 }) : (0, react_jsx_runtime.jsx)(ApplicationIcon, {',
      ],
      [
        '\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenOutlineRegular, {}),',
        '\t\t\t\t\ticon: (0, react_jsx_runtime.jsx)(ANDROID_REVEAL_COPY ? _deepseek_ai_dsh_client_ui_primitives.IconCopyOutlineRegular : _deepseek_ai_dsh_client_ui_primitives.IconFolderOpenOutlineRegular, {}),',
      ],
    ]
    const missing = edits.filter(([anchor]) => !source.includes(anchor))
    if (missing.length > 0) {
      problems.push(`reveal copy: ${missing.length} anchor(s) missing in ${openInAppClientPath}`)
    } else {
      let patched = source
      for (const [anchor, replacement] of edits) patched = patched.replace(anchor, replacement)
      writeFileSync(openInAppClientPath, patched)
      console.log('open in app: Android copies the full path instead of a reveal that cannot work')
    }
  }
} else {
  problems.push(`reveal copy: ${openInAppClientPath} missing`)
}

// 27. The authenticated file route cannot stream, so a <video> cannot play.
//
// `/api/file` reads a whole file and answers 200 with `Content-Length`; it ignores the
// `Range` header entirely and refuses anything above `maxImageBytes` (20 MB) with 413.
// A media element starts with `Range: bytes=0-` and expects 206 + `Content-Range`, so
// previewing an mp4 in the sidebar is impossible however the client is written — and a
// phone recording is almost always over the limit.
//
// Give the route one bounded byte window per ranged GET (8 MB, so seeking issues a new
// request instead of allocating the file), report `Accept-Ranges`, answer 416 when the
// range cannot be satisfied, and stop applying the whole-file cap to HEAD (a media
// element probes size through it). The plain non-ranged GET keeps its 20 MB cap.
//
// 0.2.2 rewrote the handler around a versioned URL: a request without the current `v`
// is answered 302 to `?path=…&v=…`, the file answer carries `VERSIONED` (immutable)
// caching, and the whole-file cap moved to the top of the function. The ranged answer
// keeps the same 206 shape; the cap is skipped for HEAD and for any request that
// carries a Range, which is what lets a large recording stream.
const sessionControllerPath = join(nodeModules, '@deepseek-ai', 'dsh-api-session-controller', 'lib', 'index.js')
const rangeMarker = 'ANDROID_PATCH_RANGE'
if (existsSync(sessionControllerPath)) {
  const source = readFileSync(sessionControllerPath, 'utf8')
  if (source.includes(rangeMarker)) {
    // already patched
  } else {
    const helperAnchor = 'async function serveFile(request, fs, maxBytes) {'
    const helpers = [
      `/** ${rangeMarker}: bounded window per ranged GET, so media streams without loading the file. */`,
      'const RANGE_CHUNK_BYTES = 8 * 1024 * 1024;',
      `/** Parse one \`bytes=\` range; multi-range and malformed headers fall back to a full response. */
function parseByteRange(value) {
	if (typeof value !== "string") return void 0;
	const match = /^bytes=(\\d*)-(\\d*)$/.exec(value.trim());
	if (match === null) return void 0;
	const [, startText, endText] = match;
	if (startText === "" && endText === "") return void 0;
	if (startText === "") return {
		suffix: Number(endText)
	};
	return {
		start: Number(startText),
		end: endText === "" ? void 0 : Number(endText)
	};
}
/** Resolve one parsed range against a known size, capped at one chunk. */
function resolveByteRange(range, size) {
	if (!Number.isSafeInteger(size) || size < 0) return void 0;
	if (range.suffix !== void 0) {
		if (!Number.isSafeInteger(range.suffix) || range.suffix <= 0) return void 0;
		const offset = Math.max(0, size - range.suffix);
		return {
			offset,
			length: Math.min(range.suffix, size)
		};
	}
	const start = range.start;
	if (!Number.isSafeInteger(start) || start < 0 || start >= size) return void 0;
	const end = range.end === void 0 ? size - 1 : Math.min(range.end, size - 1);
	if (!Number.isSafeInteger(end) || end < start) return void 0;
	return {
		offset: start,
		length: Math.min(end - start + 1, RANGE_CHUNK_BYTES)
	};
}
`,
      helperAnchor,
    ].join('')

    // 0.2.2 rewrote this handler: the file answer is now `VERSIONED` and cacheable,
    // a request without the current `v` is redirected to the versioned URL, and the
    // whole-file cap moved to the top of the function. The range support therefore
    // has three shapes to cover, chosen from the source that is actually installed.
    const versionedHeaders = [
      '\t\tconst headers = {',
      '\t\t\t...VERSIONED,',
      '\t\t\t"Content-Type": mime.lookup(target.displayPath) || "application/octet-stream"',
      '\t\t};',
    ].join('\n')
    const legacyHeaders = '\t\tconst headers = {\n\t\t\t...BASE_HEADERS,\n\t\t\t"Content-Type": mediaType\n\t\t};'
    const versionedRoute = source.includes(versionedHeaders)
    const headersAnchor = versionedRoute ? versionedHeaders : legacyHeaders
    const headersReplacement = versionedRoute
      ? [
          '\t\tconst headers = {',
          '\t\t\t...VERSIONED,',
          '\t\t\t"Content-Type": mime.lookup(target.displayPath) || "application/octet-stream",',
          `\t\t\t"Accept-Ranges": "bytes" // ${rangeMarker}`,
          '\t\t};',
        ].join('\n')
      : [
          '\t\tconst headers = {',
          '\t\t\t...BASE_HEADERS,',
          '\t\t\t"Content-Type": mediaType,',
          `\t\t\t"Accept-Ranges": "bytes" // ${rangeMarker}`,
          '\t\t};',
        ].join('\n')

    const earlyCapAnchor = '\t\tif (info.size !== void 0 && info.size > maxBytes) return fail(413, "file exceeds byte limit");'
    const headCapAnchor = '\t\t\tif (info.size !== void 0) {\n\t\t\t\tif (info.size > maxBytes) return fail(413, "file exceeds byte limit");\n\t\t\t\theaders["Content-Length"] = String(info.size);\n\t\t\t}'
    const capAnchor = versionedRoute ? earlyCapAnchor : headCapAnchor
    const capReplacement = versionedRoute
      ? [
          '\t\t// A media element learns the size through HEAD and streams through Range; both',
          '\t\t// are bounded per request below, so the whole-file cap must not answer them 413.',
          '\t\tif (info.size !== void 0 && info.size > maxBytes && request.method !== "HEAD" && request.headers.get("range") === null) return fail(413, "file exceeds byte limit");',
        ].join('\n')
      : [
          '\t\t\t// A media element learns the size through HEAD; the range branch below enforces',
          '\t\t\t// the per-request bound, so the whole-file cap must not hide the size.',
          '\t\t\tif (info.size !== void 0) headers["Content-Length"] = String(info.size);',
        ].join('\n')

    const bodyAnchor = '\t\tconst bytes = await fs.readBytes(target, request.signal, maxBytes);'
    const rangeBranch = [
      `\t\t// ${rangeMarker}: one bounded window, streamed as 206.`,
      '\t\tconst range = parseByteRange(request.headers.get("range"));',
      '\t\tif (range !== void 0) {',
      ...(versionedRoute
        ? []
        : [
            '\t\t\tconst info = await fs.stat(target, request.signal);',
            '\t\t\tif (info === void 0) return fail(404, "not found");',
            '\t\t\tif (info.type !== "file") return fail(403, "not a regular file");',
          ]),
      '\t\t\tconst window = info.size === void 0 ? void 0 : resolveByteRange(range, info.size);',
      '\t\t\tif (window === void 0) return new Response(null, {',
      '\t\t\t\tstatus: 416,',
      '\t\t\t\theaders: {',
      '\t\t\t\t\t...BASE_HEADERS,',
      `\t\t\t\t\t"Content-Range": \`bytes */\${info.size ?? 0}\``,
      '\t\t\t\t}',
      '\t\t\t});',
      '\t\t\tconst bytes = await fs.readByteRange(target, window, request.signal);',
      '\t\t\tconst first = window.offset;',
      '\t\t\tconst last = window.offset + bytes.byteLength - 1;',
      '\t\t\theaders["Content-Range"] = `bytes ${first}-${last}/${info.size}`;',
      '\t\t\theaders["Content-Length"] = String(bytes.byteLength);',
      '\t\t\treturn new Response(bytes.slice(), {',
      '\t\t\t\tstatus: 206,',
      '\t\t\t\theaders',
      '\t\t\t});',
      '\t\t}',
      bodyAnchor,
    ].join('\n')

    const anchors = [helperAnchor, headersAnchor, capAnchor, bodyAnchor]
    const missing = anchors.filter((anchor) => !source.includes(anchor))
    if (missing.length > 0) {
      problems.push(`file route range: ${missing.length} anchor(s) missing in ${sessionControllerPath}`)
    } else {
      writeFileSync(
        sessionControllerPath,
        source
          .replace(helperAnchor, helpers)
          .replace(headersAnchor, headersReplacement)
          .replace(capAnchor, capReplacement)
          .replace(bodyAnchor, rangeBranch),
      )
      console.log('file route: ranged reads stream media instead of failing at the whole-file cap')
    }
  }
} else {
  problems.push(`file route range: ${sessionControllerPath} missing`)
}

if (problems.length > 0) {
  console.error('unresolved:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

