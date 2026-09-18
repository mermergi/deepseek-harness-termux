// Android/Termux compatibility fixes for this dsh install.
// Idempotent: safe to run before every launch (the launcher script does).
//
// Three unrelated Android limitations are handled here; each is listed with the
// reason it exists and what it costs. `DSH_PERMISSION_MODE` is not a patch: the
// shipped profile already reads it, and the launcher sets it.
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

if (problems.length > 0) {
  console.error('unresolved:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

