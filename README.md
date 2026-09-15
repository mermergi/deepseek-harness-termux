# deepseek-harness-termux

English | [中文](README.zh.md)

Compatibility patches plus a one-tap launcher that get [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) running on **Android / Termux**.

dsh officially supports Linux, macOS and Windows. Android (Termux, bionic libc) is missing several prerequisites it assumes, so `npx @deepseek-ai/dsh web` from the official README **will not start** on a phone. This repository collects the eight patches that are verified to work on a real device into one idempotent script, and provides launch steps you can copy directly (patch 7 — the phone-portrait layout for the Web UI — is a different kind of change from the rest).

## Table of contents

- [Demo](#demo)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Desktop one-tap launch](#desktop-one-tap-launch)
- [Security notice (read this)](#security-notice-read-this)
- [Patch list](#patch-list)
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

`install.sh` works through the following in order: check the Node version and the build toolchain → install dsh into `~/dsh` → add `@img/sharp-wasm32` → apply the compatibility patches → install `~/.shortcuts/start_dsh.sh`. **It is safe to re-run**: if it fails, fix the cause and run it again; steps that already succeeded are skipped.

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
mkdir -p ~/.shortcuts
curl -fsSL -o ~/.shortcuts/start_dsh.sh \
  https://raw.githubusercontent.com/mermergi/deepseek-harness-termux/main/start_dsh.sh
chmod +x ~/.shortcuts/start_dsh.sh
```

Then add a **Termux:Widget** widget to your home screen and tap `start_dsh.sh`.

- The script's file name must be **ASCII**. A Chinese file name fails outright under Termux:Widget: `env: '<path>': No such file or directory`.
- The script re-runs the patches before starting, so one tap keeps working after dsh is upgraded or reinstalled.
- Tapping it again: if the port is already in use it only opens the browser. After the first launch the browser holds a 30-day login cookie, so the token stops mattering; the script never starts a second instance either.
- If your install directory is not `~/dsh`: change `DSH_DIR` at the top of the script, or override it with `DSH_DIR=/your/path`.

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

| Symptom | Fix |
|---|---|
| Startup crash: `--expose-internals is required for HMR service` | the profile's `patchReload` moves from `live` to `startup` |
| Sessions cannot be written: `ERR_FLOCK_UNSUPPORTED_PLATFORM` | allow flock on Android (degrading to a single process; dsh does the same for its browser worker) |
| Creating files / publishing to disk: `EACCES ... link` | hard-link publishing falls back: `rename` when the source can be discarded, a `COPYFILE_EXCL` copy when it has to survive |
| Startup crash: `Could not load the "sharp" module` | install `@img/sharp-wasm32` |
| Image sends rejected (shell code `session/agent-busy`) | skip the ancestor-directory fsync when it hits `EACCES`/`EPERM` |
| `glob`/`grep` report `SEARCH_FAILED` (`ripgrep launch failed`) | supply the missing `@vscode/ripgrep-android-arm64` and forward to the system `rg` |
| The right side of the settings page is squeezed (phone portrait) | inject a small `<720px` CSS block that moves the navigation to the top |
| "Open config file" does nothing | the android branch uses `termux-open` instead, passing `--content-type` according to the extension |

The reasoning, the trade-offs and the traps are written up in the comments of `android-fix.mjs`. To check whether the patches are in place: `grep -rl ANDROID_ node_modules`.

## After reinstalling or upgrading

`npm install` overwrites everything inside `node_modules`, so **the patches are lost**. The fix is to run them again:

```sh
node ~/dsh/android-fix.mjs
```

When you launch through this repository's `start_dsh.sh`, that step happens automatically.

dsh is in developer preview and upgrades may bring breaking changes. If the script reports something like `missing ...`, an anchor string in the newer code has changed and the patch needs adjusting against it; the script does not skip silently — it names the file that failed to match.

## Verification and notes

**Verified** (Android + Termux, aarch64, Node v26.4.0, 2026-09-15 to 16):

- dsh `0.1.5-rc.1` and `0.1.6-alpha.1` both install, patch and run (re-checked item by item after upgrading to the latter);
- the Web UI responds and is usable at `127.0.0.1:3080`;
- one real task ran end to end: model call → `write` tool creates a file → `bash` tool runs `cat` → a Chinese report, with the bytes on disk matching expectations.

**Notes**:

- To edit configuration, use the settings page in the UI, or `nano ~/.dsh/settings.yaml` in Termux.
- Session data lives in `~/.dsh/sessions/`; note that the conversation content in there is written to disk.
- This repository is released under the [MIT license](LICENSE) (matching dsh upstream).

Upstream documentation: <https://deepseek-harness.github.io/deepseek-harness/> ·
<https://github.com/deepseek-ai/deepseek-harness> (MIT)
