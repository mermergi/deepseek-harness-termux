# video-preview

A profile bundle that gives the sidebar's file preview a **video and audio player**. A
phone recording stays where it is — in Termux's private directory — and plays in place;
nothing is copied out to shared storage and no external app is involved.

## How it works

`@deepseek-ai/dsh-client-ui-sidebar-documentpreview` owns the preview registry and a
keyed slot. This bundle's host half is a no-op row; its browser half (`lib/client.js`)
registers two things through the regular extension points:

- a `documentPreviews` definition for `mp4 m4v webm mov mkv avi flv wmv 3gp ts` and
  `mp3 wav m4a aac flac ogg oga opus wma amr`, marked `binaryExtensions` (so the plain-text
  fallback never tries to show the bytes) and `loading: "renderer"` (the body fetches
  itself instead of pulling the file through the page);
- a body component in the `sidebar.right.tab.document` slot, keyed by that definition id,
  which streams the file from the authenticated `/api/file` route through
  `<video controls playsinline>` (or `<audio controls>` for audio).

The body still offers the two escapes a preview cannot replace: **copy the absolute path**
and **open in an external player** (the same `session.openWorkspacePath` call the "open in
app" control uses, i.e. `termux-open` on this device).

## How a file gets played

The absolute path comes from the document resource metadata
(`useResource(resourceAddress).value.absolutePath`), never from the resource address alone: an
address built by the workspace-path helpers drops the workspace-root prefix, so guessing a
leading `/` requests `/FatFishHome/...` instead of `/data/data/com.termux/files/home/FatFishHome/...`
and the file route answers 404.

The body never hands a URL straight to `<video>`. On every open it first probes the file
with a ranged `fetch` (`Range: bytes=0-1023`, `credentials: same-origin`) — the same
authenticated path the app already uses for RPC — and then:

- **≤ 16 MB**: fetches the whole file and plays a `blob:` URL. The element talks to no
  network at all, so a flaky or frozen server cannot interrupt playback, and seeking is
  local. This is what a phone screen recording (a few MB) hits.
- **> 16 MB**: streams the file by URL, which is where patch 27 below matters.

A probe that fails is retried with backoff (800 ms → 5 s, four tries): Android freezes
Termux in the background, and a request issued during the thaw would otherwise surface as
a bogus "format error". The media element itself also gets one silent retry. Every step
logs a `[video-preview]` line, and the app captures the page console into
`~/.dsh-app/status.log`, so a remaining failure can be told apart from a decoder problem
by reading that log.

## Requirement: android-fix.mjs patch 27

`/api/file` originally reads the whole file, answers `200`, ignores `Range`, and refuses
anything over 20 MB with `413` — a media element cannot stream or seek against that, and
phone recordings are usually over the limit. Patch 27 in
[`../android-fix.mjs`](../android-fix.mjs) gives the route one bounded 8 MB window per
ranged `GET` (`206` + `Content-Range` + `Accept-Ranges`), answers `416` for unsatisfiable
ranges, and stops hiding the size from `HEAD`. The plain non-ranged `GET` keeps its 20 MB
cap.

Without that patch the player still appears, but Chromium gives up on the source.

## Install

```sh
node ~/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web add \
  /data/data/com.termux/files/home/deepseek-harness-termux/video-preview
```

The plugin manager appends `@local/dsh-video-preview` to the profile's
`dsh.profile.bundles` on its own; if you add the dependency by hand, add that entry too.
Then **restart once** (Settings → General → "Restart DSH service"): client bundles are
composed at boot and cached as immutable, so an edit on disk only reaches the page after
the revision is recomputed.

## Test

```sh
node video-preview/smoke.mjs
```

The smoke test runs the browser half with a stub React and a stub client context,
asserts the registration shape (id, 20 suffixes, binary markers, renderer loading), then
renders the body and checks the `<video>`/`<audio>` output, the `/api/file?path=…` source,
and the message for an address it cannot parse.

## What it will not play

The WebView decodes what its Chromium build supports: H.264/VP8/VP9 in mp4/webm mostly,
HEVC and many mkv/avi/flv variants usually not. When decoding fails the panel says so and
offers the path copy and the external-player hand-off — the failure is the browser's
decoder, not the file.
