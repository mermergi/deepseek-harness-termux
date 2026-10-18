# app-scripts

The scripts the Android shell app drives, plus the guarded upgrade tool. They live on the
device in `~/.dsh-app/`; this directory is the tracked copy.

| file | device path | role |
| --- | --- | --- |
| `bridge.sh` | `~/.dsh-app/bridge.sh` | entry point the app invokes through Termux's `RUN_COMMAND`. Starts the server, then publishes its token URL on a short-lived loopback endpoint. |
| `ensure-server.mjs` | `~/.dsh-app/ensure-server.mjs` | makes sure `dsh web` is running and prints its token URL. Also owns the two anti-breakage guards: install-generation check and boot-failure auto-rollback. |
| `upgrade.mjs` | `~/.dsh-app/upgrade.mjs` | guarded upgrade: stage → patch → rehearsal boot → stop → atomic swap → patch → start → health check, with rollback. |

Sync after editing here:

```bash
cp app-scripts/bridge.sh app-scripts/ensure-server.mjs app-scripts/upgrade.mjs ~/.dsh-app/
chmod +x ~/.dsh-app/bridge.sh
```

## Why the guards exist

The server keeps its code in memory but serves the client shell from disk. Replace the
install tree under a live server and the browser gets a client bundle from one release
talking to the API of another — the WebView shows `web boot: N entries did not activate`
and a plugin-load failure page, with no way back except a restart (or, worse, a manual
rollback). That is not a dsh bug; it is a serving-from-a-changed-tree bug.

Three mechanisms make that state unreachable:

1. **Generation binding** — every tree carries `.tree-id`; servers started by these
   scripts inherit `DSH_TREE_ID`. `ensure-server.mjs` refuses to reuse a server whose
   generation does not match the tree on disk, and stops it instead.
2. **Rehearsal before the live server is touched** — `upgrade.mjs` boots the staged tree
   on a spare port against a throwaway copy of the profile. A broken release exits with
   code 10 and the user's working session is never interrupted.
3. **Auto-rollback** — `upgrade.mjs` rolls back itself if the post-swap health check
   fails; `ensure-server.mjs` restores `<dsh>.prev` on its own after two consecutive boot
   failures, so even an upgrade done by other means (npm, manual swap) cannot brick the app.

## Usage

```bash
# upgrade to the `next` dist-tag
node ~/.dsh-app/upgrade.mjs

# explicit version / plan only
node ~/.dsh-app/upgrade.mjs 0.2.1-rc.2
node ~/.dsh-app/upgrade.mjs --to next --dry-run
```

The script stops the live server itself (it owns stop → swap → start), so the app page
will disconnect for the duration and reconnect once the new server prints its token.
Exit codes: `0` upgraded, `10` rejected before touching the install, `20` rolled back,
`21` rollback failed (manual restore printed), `30` usage/unexpected.

Rollback is also available by hand at any time, because the previous tree is kept patched
at `~/dsh.prev`:

```bash
cd ~ && mv dsh dsh.bad && mv dsh.prev dsh && node dsh/android-fix.mjs
```
