# DSH Android app

Wraps the DeepSeek Harness web GUI into a **real Android app**: home-screen icon, full screen,
no address bar — and it starts the Termux-side server itself.

Everything is compiled **on the phone** with `aapt2` + `javac` + `d8` + `apksigner`. No PC, no
Android Studio, no SDK download.

> The Chinese doc is longer and carries the measured evidence: [README.zh.md](README.zh.md)

---

## What it changes

| | Before | After |
|---|---|---|
| Entry point | Termux:Widget shortcut | **DSH** icon on the home screen |
| Surface | A browser tab | Full-screen WebView |
| Login | A fresh `?token=` URL each time | One exchange, then a 30-day cookie |
| Server | The widget script starts it | The app starts it on demand |
| Back key | Leaves the browser | Navigates back inside the page first |
| Stuck page | Switch tabs / reload | Pull down at the top of the page to reload |
| Switched to another app | No idea if it is still running | A floating bubble shows `working / idle / server stopped`; tap to expand it, double-tap to return |
| Bubble in the way | — | Two shapes, decided only by whether it is docked: a slim 24x56dp hollow arc on the left or right edge (a `(` on the right, `)` on the left), or the pill when it is away from an edge. Colour is the state; "working" also breathes. Drag to dock or undock, tap toggles, double-tap returns |

The bubble is the only part with real difficulty — deciding *whether the agent is working*,
and, for the bubble itself, a snap-to-edge that only ever failed on the right. That asymmetry was
the clue: the left edge is 0 in every coordinate space, so it measures directly, while the right
gap inherits every error in the computed screen width. The edges are now **measured** with
`getLocationOnScreen()` while docked, not assumed. See [README.zh.md](README.zh.md) for the full
write-up, the cost table that drove three rounds of optimisation (94 ms -> 0.81 ms per poll), and
`tools/test-status.mjs`, which replays every session log in growth slices against a full read.

## Build

```sh
cd android-app/tools
bash build.sh              # -> ../out/dsh.apk
bash build.sh --install    # build, then hand the APK to the system installer
```

Needs `pkg install aapt2 apksigner d8 openjdk-17`. `tools/android.jar` (the API 35 platform stub)
and `out/` are gitignored; `tools/make-icon.mjs` regenerates the icon set from an inline SVG.

Signing uses `keystore.jks` (passphrase `dshlocal`, self-signed). It is **not committed** — see
`.gitignore`: anyone holding it could sign an APK that installs as an update over yours. A fresh
clone generates its own key on first build, which then cannot update over an already-installed
copy. **Keep the local one**; a different key means uninstall + reinstall, losing the cookie.

## Install

```sh
bash android-app/install.sh          # the Termux half
bash android-app/tools/build.sh --install
```

`install.sh` is idempotent and does two things: copy the bridge scripts into `~/.dsh-app/`
(syncing the hand-off secret from `MainActivity.java`, the single source of truth), and turn on
`allow-external-apps` in `~/.termux/termux.properties` followed by `termux-reload-settings`.

## Installing on a fresh phone

The APK is only the client (75 KB); dsh itself lives in Termux (~271 MB). A new phone therefore
cannot get by with the APK alone:

```sh
pkg install -y git
git clone https://github.com/mermergi/deepseek-harness-termux
cd deepseek-harness-termux
bash install.sh --deps              # node/python/clang/ripgrep + dsh + the Android patches
bash android-app/install.sh         # bridge scripts + allow-external-apps
termux-open android-app/prebuilt/dsh.apk
```

The last step uses the committed `prebuilt/dsh.apk`, so the 237 MB build toolchain
(openjdk-17/d8/aapt2) is only needed if you intend to rebuild from source. `build.sh` refreshes
that committed copy after every successful build, so seeing it in `git status` means source and
prebuilt have moved apart.

## Xiaomi Super Island (partial)

The device reports `persist.sys.feature.island=1`, `notification_focus_protocol=3` and
`canShowFocus=true`, and HyperOS renders focus notifications from an ordinary notification carrying
a `miui.focus.param` extra — no MiPush, no root. Verified outcome: **the status-bar ticker shows
"DSH 工作中", the island itself stays empty**, even after correcting the payload field-for-field
against the published component model (the missing required `islandPriority`, the non-existent
`TextInfo.frontTitle`/`useHighLight`, and `BaseInfo.type`).

Since an ordinary notification cannot put text in the status bar, the ticker proves the focus
channel is accepted; it is the island *rendering* that is unavailable. That matches Xiaomi's own
FAQ line that the platform configures the permission per app after an application — `canShowFocus`
most likely reflects the user-visible notification toggle, not island capability. Supporting
evidence: every third-party island tool found is an LSPosed module hooking SystemUI rather than
using the API.

The shipped behaviour is therefore the status-bar variant: a focus notification while the agent is
working, withdrawn when it goes idle. Details and the full field reference are in
[README.zh.md](README.zh.md).

## Two traps worth knowing about

**`$TMPDIR` gets wiped while the server is still writing to it.** Termux clears `$PREFIX/tmp`
when the Termux app process restarts, but a running dsh keeps its file descriptor:

```
l-wx------ 1 -> /data/data/com.termux/files/usr/tmp/dsh_web.log (deleted)
```

The process stays up and the token disappears from disk — and that log line is the only external
copy of it. Invisible while the cookie is valid, fatal once the 30-day cookie expires. Logs now
live in `~/.dsh-app/`, which both the widget launcher and the app use.

**`/system/bin/am` is not callable by ordinary apps** on this Android version:

```
java.lang.SecurityException: Permission Denial: package=com.android.shell does not belong to uid=10436
```

That is why the Termux to app hand-off is a loopback HTTP endpoint rather than an intent.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| App stuck on "DSH 没起来" | `tail -30 ~/.dsh-app/bridge.log` |
| Is the server up / what is the token | `tail -20 ~/.dsh-app/server.log` |
| Did the app actually reach Termux | `bridge invoked` in `bridge.log` |
| Server up but no token available | `no usable token in any log` in `bridge.log` |
| Force a fresh token | `bash ~/.dsh-app/bridge.sh --restart` |
