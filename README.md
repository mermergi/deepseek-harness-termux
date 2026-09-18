# deepseek-harness-termux

English | [中文](README.zh.md)

Compatibility patches plus a one-tap launcher that get [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) running on **Android / Termux**.

dsh officially supports Linux, macOS and Windows. Android (Termux, bionic libc) is missing several prerequisites it assumes, so `npx @deepseek-ai/dsh web` from the official README **will not start** on a phone. This repository collects the **17 patches** that are verified to work on a real device into one idempotent script (`android-fix.mjs`), provides launch steps you can copy directly, and ships a **locally built Android shell app** — it starts the server, and adds a floating status bubble, a notification island, a file picker, and a restart button in the settings page.

Most of the patches are Android platform gaps; patch 9 is a performance tweak; patches 10–15 come from `0.1.6-alpha.2` and its new plugin page; patch 16 repairs the global `node-gyp`, which only matters for plugins that compile native code on the device; patch 17 repairs plugin bundles that reference an icon this dsh no longer ships.

## Table of contents

- [Demo](#demo)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Desktop one-tap launch](#desktop-one-tap-launch)
- [Native Android app](#native-android-app-optional)
- [PhoneUse plugin (optional)](#phoneuse-plugin-optional)
- [Security notice (read this)](#security-notice-read-this)
- [Patch list](#patch-list)
- [Installing plugins](#installing-plugins)
- [Restarting](#restarting)
- [After reinstalling or upgrading](#after-reinstalling-or-upgrading)
- [Verification and notes](#verification-and-notes)

## Demo

![An animated illustration of a hippo riding a bicycle](hippo-bicycle.webp)

Three renderings of the same illustration, left behind by testing how dsh actually runs on this device. They are not screenshots: the PNG is byte-for-byte what this device's `sharp` produces from the SVG, and that is the same WebAssembly `sharp` dsh uses for attachments on Android (patch 4), so the set doubles as evidence that the image path works end to end.

| File | Format | Size | Dimensions | Frames |
|---|---|---|---|---|
| [`hippo-bicycle.svg`](hippo-bicycle.svg) | SVG, SMIL-animated (18 `<animate>` elements) | 13 KB | 800×600 | — |
| [`hippo-bicycle.png`](hippo-bicycle.png) | PNG | 58 KB | 800×600 | 1 |
| [`hippo-bicycle.webp`](hippo-bicycle.webp) | animated WebP | 279 KB | 480×360 | 24 |

The animated WebP is five times the size of the static PNG while covering fewer pixels, because it carries 24 distinct frames. Count them yourself, from the directory dsh was installed into (the one from step 2, where `sharp` lives) and pointing at the file in your clone:

```sh
cd ~/dsh
node -e "require('sharp')(process.argv[1]).metadata().then(m => console.log(m.pages))" \
  ~/deepseek-harness-termux/hippo-bicycle.webp
```

## Requirements

| Item | Requirement |
|---|---|
| OS | Android + Termux (verified on aarch64) |
| Node.js | `^22.19.0 \|\| >=24.0.0` (dsh's `engines` requirement; verified on v26.4.0) |
| Build toolchain | `clang` + `make` + `python` (node-pty ships no Android prebuild, so node-gyp has to compile it on device) |
| Search tool | `ripgrep` (`pkg install ripgrep`): `@vscode/ripgrep` has no Android build, see patch 6; with no `rg` on `PATH` the `glob`/`grep` tools are unavailable |
| Disk | roughly 300 MB (dsh pulls in 515 npm packages) |
| Network | access to the npm registry and to the model API of your choice (DeepSeek official, or a compatible gateway) |

## Quick start

### Option A: one command

```sh
curl -fsSL -o install.sh \
  https://raw.githubusercontent.com/mermergi/deepseek-harness-termux/main/install.sh
bash install.sh --deps
```

`install.sh` works through the following in order: check the Node version and the build toolchain → install dsh into `~/dsh` → add `@img/sharp-wasm32` → apply the compatibility patches → install the silent launcher at `~/.shortcuts/tasks/start_dsh.sh` (plus a visible-terminal copy at `~/dsh/start_dsh-terminal.sh`). **It is safe to re-run**: if it fails, fix the cause and run it again; steps that already succeeded are skipped.

| Flag | Effect |
|---|---|
| `--deps` | also install the Termux dependencies with `pkg install` (nodejs python clang make) |
| `--dir ~/foo` | install somewhere else (the path is written into the launcher's `DSH_DIR`) |
| `--version 0.1.5-rc.1` | pin the dsh version, for reproducibility |

### Option B: manual, step by step

If you would rather not run a script, follow the steps below — they do exactly what option A does, and they make it clear what each step is for.

#### 1. Install the dependencies

```sh
pkg update && pkg install -y nodejs python clang make
node -v   # needs >= 24 (or 22.19+)
```

#### 2. Install dsh into a fixed directory

```sh
mkdir -p ~/dsh && cd ~/dsh
npm install @deepseek-ai/dsh
npm install @img/sharp-wasm32 sharp
```

Two things matter here:

- **Do not use `npx`.** `npx` unpacks the package into a temporary directory, so the patches have no stable place to land. Install into a fixed directory such as `~/dsh`.
- **`@img/sharp-wasm32` is not optional.** `sharp` ships no android-arm64 prebuild, and without it the attachment plugin crashes dsh **during startup**.

> To reproduce the versions verified in this document: `0.1.5-rc.1` (the `latest` at the time of writing) or `0.1.6-alpha.1` (the `alpha` tag, which only installs when the version is pinned explicitly).

#### 3. Apply the patches

```sh
curl -fsSL -o ~/dsh/android-fix.mjs \
  https://raw.githubusercontent.com/mermergi/deepseek-harness-termux/main/android-fix.mjs
node ~/dsh/android-fix.mjs
```

The script is **idempotent**: anything already patched is skipped, and it exits quietly when there is nothing to do. It prints every change it makes.

#### 4. Launch

```sh
node ~/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web
```

It prints a URL carrying a token (by default `http://127.0.0.1:3080`) and opens the browser for you. The first time, enter your DeepSeek API key once under **Settings → Models** — it is written to `~/.dsh/.credentials.yaml` and you will not be asked for it again.

> **Why not `node_modules/.bin/dsh`:** that shim's shebang is `#!/usr/bin/env node`, and Termux has no `/usr/bin/env`. In an interactive shell, `termux-exec`'s `LD_PRELOAD` rewrites the shebang, so executing it directly **does work** — but a fresh session started by Termux:Widget has no such preload and fails outright:
>
> ```
> .../node_modules/.bin/dsh: /usr/bin/env: bad interpreter: No such file or directory
> ```
>
> That is why the scripts always start the JS entry point through `node` explicitly.

## Desktop one-tap launch

Option A already sets this up; for a manual install, add it:

```sh
mkdir -p ~/.shortcuts/tasks
curl -fsSL -o ~/.shortcuts/tasks/start_dsh.sh \
  https://raw.githubusercontent.com/mermergi/deepseek-harness-termux/main/start_dsh.sh
chmod +x ~/.shortcuts/tasks/start_dsh.sh
```

Then add a **Termux:Widget** widget to your home screen and tap `start_dsh`.

**Why `tasks/`**: Termux:Widget opens a new terminal session for scripts at the **top level** of `~/.shortcuts/` (a window pops up on every tap); only scripts under `~/.shortcuts/tasks/` run in the background. A silent entry therefore has to live in `tasks/`.

- Launching is **silent**: a tap only shows a Termux:API toast (`⏳ DSH 启动中` → `✅ DSH 已启动  `) and then the browser opens. For live output, run `~/dsh/start_dsh-terminal.sh` in a terminal.
- The toast needs the Termux:API app; without it nothing breaks, you just lose the feedback.
- The script's file name must be **ASCII**. A Chinese file name fails outright under Termux:Widget: `env: '<path>': No such file or directory`.
- The script re-runs the patches before starting, so one tap keeps working after dsh is upgraded or reinstalled.
- Tapping it again: if the port is already in use it only opens the browser. After the first launch the browser holds a 30-day login cookie, so the token stops mattering; the script never starts a second instance either.
- If your install directory is not `~/dsh`: change `DSH_DIR` at the top of the script, or override it with `DSH_DIR=/your/path`.

## Native Android app (optional)

If you would rather not use a browser, install [`android-app/`](android-app/README.md) — a
self-signed APK built **on the phone itself** with `aapt2` + `javac` + `d8`, no PC and no
Android Studio required:

```sh
bash android-app/install.sh                    # the Termux half (bridge scripts + allow-external-apps)
termux-open android-app/prebuilt/dsh.apk       # install the committed APK; no build toolchain needed
```

The APK is only the client (75 KB) — dsh itself lives in Termux (~271 MB), so a fresh phone sets
up the Termux side first. See [android-app/README.md](android-app/README.md#installing-on-a-fresh-phone).

- **Home-screen icon, full screen, no address bar**: a WebView shell; Back navigates the page
  first and only then leaves the app.
- **One tap starts the server**: it drives `~/.dsh-app/bridge.sh` through Termux's
  `RUN_COMMAND`, which needs `allow-external-apps` in `termux.properties` (`install.sh` does it).
- **No repeated login**: the hand-off hands over a `?token=` URL, which is exchanged for a 30-day
  cookie; later launches take a fast path that never touches Termux.
- **Two small niceties**: pull-to-refresh at the top of the page, and a floating bubble that shows
  `working / idle / server stopped` while you are in another app. The state is not guessed — it reads
  the last `turn/start` / `turn/end` in the session log, so waiting on the model and long silent tool
  calls are both classified correctly. Dragging the bubble to a screen edge snaps it into a slim
  half-ellipse handle whose fill colour carries the state.
- **Shared logs**: everything lives in `~/.dsh-app/`. `start_dsh.sh` no longer logs to `$TMPDIR` —
  Termux wipes `$PREFIX/tmp`, while a running dsh keeps writing to the deleted inode, so the token
  would vanish into thin air. See [android-app/README.md](android-app/README.md) for the full
  write-up.

## PhoneUse plugin (optional)

An agent preset that gives one session eight `phone_*` tools for driving this phone directly: `phone_screenshot` (the screen as an image the model can actually look at), `phone_ui` (the accessibility tree with real device-pixel tap coordinates), `phone_tap` / `phone_swipe` / `phone_key` / `phone_text`, `phone_app`, and `phone_status`. Everything runs through the Termux `adb` client paired to `127.0.0.1`.

```sh
bash phone-use/install.sh
```

It copies the shipped `standard` preset into `~/.dsh/.agent-presets/phone-use/`, adds one row, builds the plugin module and self-checks before finishing. Choose **「标准模式 + PhoneUse」** for a session and the tools are there.

The same preset mirrors run status into a single Android notification — `运行中 · phone_tap` while it works, `已结束 · 等你指令` when a turn ends, plus a button back to this GUI — so the end of a run is visible without watching the browser.

Prerequisites, the rebuild loop and the security caveat: [`phone-use/README.md`](phone-use/README.md).

## Security notice (read this)

`start_dsh.sh` contains this line:

```sh
export DSH_PERMISSION_MODE=danger-full-access
```

It **disables the sandbox and the approval prompts at the same time**. The reason: on Android neither `bwrap` (bubblewrap) nor Landlock exists, and in a restricted mode (`workspace-write`) dsh then refuses to run any command at all:

```
sandbox mode "workspace-write" is requested but no sandbox backend is usable on
this host; refusing to run the command unconfined.
```

In other words, this device has only two states — "no sandbox" and "cannot run commands" — with nothing in between.

**The cost**: commands the agent runs hold Termux's full privileges, and can read and write your home directory, your SSH keys, and the API keys in other apps' configuration files.

**To take it back**: delete that `export` line (or change it to `read-only` / `workspace-write`). The cost is that shell and terminal tools become unavailable again, leaving file read/write, search and web access.

## Patch list

17 in total; the numbers match the comments in `android-fix.mjs`.

**Android platform gaps** (1–8):

| # | Symptom | Fix |
|---|---|---|
| 1 | Sessions cannot be written: `ERR_FLOCK_UNSUPPORTED_PLATFORM` | allow flock on Android (degrading to a single process; dsh does the same for its browser worker) |
| 2 | Creating files / publishing to disk: `EACCES ... link` | hard-link publishing falls back: `rename` when the source can be discarded, a `COPYFILE_EXCL` copy when it has to survive |
| 3 | Startup crash: `Could not load the "sharp" module` | install `@img/sharp-wasm32` |
| 4 | Startup crash: the HMR service fails to load | the profile's `patchReload` moves from `live` to `startup` |
| 5 | Image sends rejected (shell code `session/agent-busy`) | skip the ancestor-directory fsync when it hits `EACCES`/`EPERM` |
| 6 | `glob`/`grep` report `SEARCH_FAILED` (`ripgrep launch failed`) | supply the missing `@vscode/ripgrep-android-arm64` and forward to the system `rg` |
| 7 | The right side of the settings page is squeezed (phone portrait) | inject a small `<720px` CSS block that moves the navigation to the top |
| 8 | "Open config file" does nothing | the android branch uses `termux-open` instead, passing `--content-type` according to the extension |

**Performance** (9):

| # | Symptom | Fix |
|---|---|---|
| 9 | Slow cold start | memoize client bundle composition (~10.6 s → 8 s; best effort, a missing anchor only warns) |

**New in `0.1.6-alpha.2`** (10–11 — skip either and **boot fails outright**):

| # | Symptom | Fix |
|---|---|---|
| 10 | Boot: `host preparation failed: No usable native binding found for node-addon-require-builtin-android-arm64` | restore `resolutionMode`'s default from `runtime` back to `link` in `profile-boot-<hash>.js` |
| 11 | Boot: `--expose-internals is required for HMR service` | drop the hard-coded `dsh-hmr` entry from `dsh-base/cordis.patch.yml` |

**UI, plugins and toolchain** (12–17):

| # | Symptom | Fix |
|---|---|---|
| 12 | Re-tapping a sidebar panel icon does not close it (the page collapses into a sliver) | the panel row toggles: `selectPanel(null)` when already active, returning to the conversation |
| 13 | An icon tooltip never goes away after a tap | disable the sidebar's five tooltips (no hover on a touch screen, so the bubble can only linger) |
| 14 | Restarting means reaching for a terminal | a "Restart DSH service" button at the bottom of the General settings page (native ↔ web bridge, with confirmation) |
| 15 | Boot fails after installing a plugin: `Cannot find package '<plugin>'` | link plugins installed into a profile into the install directory; also sweep dangling links |
| 16 | A plugin will not install: `node-pty install … exited with exit status: 127` | repair the global `node-gyp`: point its shebang at the Termux `env`, and turn the PATH entry from a copy back into a symlink |
| 17 | Opening a side chat crashes: `Minified React error #130` | the plugin calls an icon this dsh no longer exports (`IconSendOutline16`); rewrite it to the same glyph at the shipped size |

The reasoning, the trade-offs and the traps are written up in the comments of `android-fix.mjs`. To check whether the patches are in place: `grep -rl ANDROID_ node_modules`.

**Patches 10 and 11 are worth remembering separately**: they are what `0.1.6-alpha.2` introduced relative to `alpha.1`, and without them nothing boots at all. The root cause of 10 is upstream wiring a **platform-specific native dependency** into the boot path every platform takes, for a package that has never shipped an `android-arm64` build. Patch 15 is patch 10's side effect: `link` mode also turns off the profile-plugin resolution route.

## Installing plugins

Install from the plugin market in the UI, then **restart once** (Settings → General → the button at the bottom). The patch links the plugin into the install directory — without that link the loader cannot find it, the whole plugin tree fails, and nothing boots.

Install **from npm** (`pnpm add dshmarket`), not from the **git URL** the market offers: a git install triggers pnpm's build-script allowlist (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`), and once allowed it needs to run `tsc` on the phone — but git dependencies do not get their `devDependencies`, so you get `tsc: not found`. The npm package is already built and needs no compilation.

**Some plugins carry a native dependency** (`node-pty` is the common one). No Android prebuild exists for it, so it has to be compiled on the phone. Three things have to line up:

1. The build tools: `pkg install python clang make` (usually already present).
2. pnpm permission for that dependency to run its build script — in the profile's `pnpm-workspace.yaml`:
   ```yaml
   allowBuilds:
     node-pty: true
   ```
   Without it you get `ERR_PNPM_IGNORED_BUILDS`.
3. A working `node-gyp` — **patch 16 repairs it automatically**.

With all three, the compile runs on the device (measured here: `node-pty@1.1.0` in about 2.4 s), no prebuilt package needed.

## Restarting

Three ways, pick one:

- Settings → General → "Restart DSH service" at the bottom (**in the app, fastest**)
- The splash screen's "重新登录" button (appears when connecting fails)
- In Termux: `bash ~/.dsh-app/bridge.sh --restart`

Do not use `~/.shortcuts/tasks/start_dsh.sh` to restart — it only opens a browser when port 3080 is already taken, it does not restart the server.

A restart interrupts whatever turn is in flight.

## After reinstalling or upgrading

`npm install` overwrites everything inside `node_modules`, so **the patches are lost**. The fix is to run them again:

```sh
node ~/dsh/android-fix.mjs
```

When you launch through this repository's `start_dsh.sh`, that step happens automatically; the app bridge does it too (it re-runs the script before every server start).

### Which version to install

**`0.1.6-alpha.2` is recommended** (the newest release verified to work here):

```sh
cd ~/dsh
npm install @deepseek-ai/dsh@0.1.6-alpha.2
node ~/dsh/android-fix.mjs     # required: without patches 10 and 11 it will not boot
```

Note that npm's `latest` tag still points at `0.1.5-rc.2`, so name the version explicitly — a bare `npm install @deepseek-ai/dsh` will not get you this release.

`0.1.6-alpha.2` adds two **boot-blocking** problems over `alpha.1` (patches 10 and 11). Both are handled in `android-fix.mjs`; patch it and it runs. Verified on this device.

### On pinning versions

Older `@deepseek-ai/dsh` releases declare their sibling packages as `^0.1.6-alpha.1`, and a plain install resolves those to `alpha.2` entries whose exports the core still imports (`watchUserPatches`), so even a rolled-back install will not start.

If you hit a tree whose versions do not line up, install once with a cutoff from before those siblings were published:

```sh
npm install --before=2026-09-16T23:59:00Z @deepseek-ai/dsh@0.1.6-alpha.1 @img/sharp-wasm32 sharp
node ~/dsh/android-fix.mjs
```

Keep `package-lock.json`: it is what holds that tree together. If it breaks anyway, `npm ci` restores it.

`~/dsh/package.json` currently pins `@deepseek-ai/dsh` to an **exact version** (no caret), so it will not drift upward without you asking.

### Dependency tree layout

A `Cannot find package '@deepseek-ai/dsh-plugin-manager'`-style error after installing usually means the tree got **nested** — typically because `package.json` carries a top-level dependency that conflicts with what `dsh` wants internally.

Check:

```sh
ls ~/dsh/node_modules/@deepseek-ai/dsh/node_modules/   # anything here means nesting
```

The fix is a **clean reinstall** (an incremental `npm install` will not relayout the tree):

```sh
cd ~/dsh
mv node_modules ~/nm-broken        # move it aside first, do not delete
rm -f package-lock.json
npm install
node ~/dsh/android-fix.mjs
```

### Smoke-test before you restart

After an upgrade or a config change, **start an instance on another port** instead of restarting the live one:

```sh
cd ~/dsh
timeout 45 node node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port 3599
```

Seeing `dsh web: http://127.0.0.1:3599/?token=...` means it worked (being killed by the timeout is expected). Fix any error first; do not restart into it.

This has paid off twice: once catching a plugin package that never installed, once catching a nested dependency tree.

dsh is in developer preview and upgrades may bring breaking changes. If the script reports something like `missing ...`, an anchor string in the newer code has changed and the patch needs adjusting against it; required patches do not skip silently — the script names the file that failed to match.

## Verification and notes

**Verified** (Android + Termux, aarch64, Node v26.4.0, 2026-09-15 to 18):

- dsh `0.1.5-rc.1`, `0.1.6-alpha.1` and `0.1.6-alpha.2` all install, patch and run (re-checked item by item after upgrading to alpha.2);
- the Web UI responds and is usable at `127.0.0.1:3080`;
- one real task ran end to end: model call → `write` tool creates a file → `bash` tool runs `cat` → a Chinese report, with the bytes on disk matching expectations;
- plugin install: `dshmarket` installed from npm into the profile, linked into the install tree by the patch, and resolvable by the loader;
- in-app restart button: clicking it made `bridge.log` record the `SIGTERM` to the old pid, the restart and a fresh token, with the new process serving afterwards.

**Notes**:

- To edit configuration, use the settings page in the UI, or `nano ~/.dsh/settings.yaml` in Termux.
- Session data lives in `~/.dsh/sessions/`; note that the conversation content in there is written to disk.
- This repository is released under the [MIT license](LICENSE) (matching dsh upstream).

Upstream documentation: <https://deepseek-harness.github.io/deepseek-harness/> ·
<https://github.com/deepseek-ai/deepseek-harness> (MIT)
