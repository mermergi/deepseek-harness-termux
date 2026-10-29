# app-scripts

The scripts the Android shell app drives, plus the guarded upgrade tool. They live on the
device in `~/.dsh-app/`; this directory is the tracked copy.

| file | device path | role |
| --- | --- | --- |
| `bridge.sh` | `~/.dsh-app/bridge.sh` | entry point the app invokes through Termux's `RUN_COMMAND`. Starts the server, then publishes its token URL on a short-lived loopback endpoint. |
| `ensure-server.mjs` | `~/.dsh-app/ensure-server.mjs` | makes sure `dsh web` is running and prints its token URL. Also owns the two anti-breakage guards: install-generation check and boot-failure auto-rollback. |
| `upgrade.mjs` | `~/.dsh-app/upgrade.mjs` | guarded upgrade: stage → patch → rehearsal boot → stop → atomic swap → patch → start → health check, with rollback. |
| `upgrade-detached.sh` | `~/.dsh-app/upgrade-detached.sh` | runs `upgrade.mjs` in its own `setsid` session, after a short delay, so an upgrade asked for from inside the server survives the server being stopped. |

Sync after editing here:

```bash
cp app-scripts/bridge.sh app-scripts/ensure-server.mjs app-scripts/upgrade.mjs \
   app-scripts/upgrade-detached.sh ~/.dsh-app/
chmod +x ~/.dsh-app/bridge.sh ~/.dsh-app/upgrade-detached.sh
```

## Upgrading from inside the server

`upgrade.mjs` stops the live server before it swaps the tree. When the command that asks
for the upgrade runs *inside* that server — an agent turn, a sidebar terminal — the stop
kills the caller mid-run, which is exactly the "swap under a serving process" state the
guard exists to prevent. Start it detached instead:

```sh
setsid nohup bash ~/.dsh-app/upgrade-detached.sh 0.2.2-alpha.2 >/dev/null 2>&1 &
```

Arguments go straight to `upgrade.mjs`. The app disconnects for the duration of the swap
and comes back when the new tree passes its health check; reopen it afterwards (the bridge
adopts the running server, since its generation matches the tree). Progress and the verdict
land in `~/.dsh-app/upgrade-detached.log`, `upgrade-*.log` beside it, and `~/.dsh-app/server.log`.
`DSH_UPGRADE_DELAY_SECONDS` (default 45) is the pause before the run starts, which is also
the window in which the caller can still deliver a final message.

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
