// Android/Termux compatibility fixes for this dsh install.
// Idempotent: safe to run before every launch (the launcher script does).
//
// Three unrelated Android limitations are handled here; each is listed with the
// reason it exists and what it costs. `DSH_PERMISSION_MODE` is not a patch: the
// shipped profile already reads it, and the launcher sets it.
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
} else {
  // Pre-alpha.2 releases default to "link" already; nothing to do.
  console.log('profile resolution: default already link; nothing to patch')
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
    // The indent is five tabs and the `onClick` wrapper is what makes this
    // unique: the bare `selectPanel(id);` also appears in the props wiring.
    const anchor = '\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\tselectPanel(id);\n\t\t\t\t\t},'
    const replacement = [
      '\t\t\t\t\t// ANDROID_PATCH_PANEL_TOGGLE: re-tapping the active panel returns to the conversation.',
      '\t\t\t\t\tonClick: () => {',
      '\t\t\t\t\t\tselectPanel(active ? null : id);',
      '\t\t\t\t\t},',
    ].join('\n')
    if (!source.includes(anchor)) {
      problems.push(`panel toggle: anchor missing in ${sidebarClientPath} (sidebar row layout changed)`)
    } else {
      writeFileSync(sidebarClientPath, source.replace(anchor, replacement))
      console.log('sidebar: panel icons toggle (tapping the active one closes it)')
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
const profilesRoot = join(homedir(), '.dsh', 'profiles')

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
        const libDir = join(plugin.dir, 'lib')
        const bundles = [
          ...readdirSync(plugin.dir).filter((f) => /^client.*\.js$/.test(f)).map((f) => join(plugin.dir, f)),
          ...(existsSync(libDir)
            ? readdirSync(libDir).filter((f) => /^client.*\.js$/.test(f)).map((f) => join(libDir, f))
            : []),
        ]
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

if (problems.length > 0) {
  console.error('unresolved:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

