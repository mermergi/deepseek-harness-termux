#!/data/data/com.termux/files/usr/bin/bash
# Run the guarded upgrade detached from the server it is about to stop.
#
# Usage (from an agent running inside dsh, or any shell):
#   setsid nohup bash ~/.dsh-app/upgrade-detached.sh 0.2.2-alpha.2 >/dev/null 2>&1 &
#
# Why this exists
# ---------------
# `upgrade.mjs` stops the live server before it swaps the tree — that is the whole point
# of the guard. When the command that asks for the upgrade is itself running inside that
# server (an agent turn, a terminal in the right sidebar), the stop kills the caller
# mid-run: the swap would be orphaned half-way, which is the failure mode the guard exists
# to prevent. So the upgrade has to be started in its own session, `setsid`-detached, and
# allowed to outlive the process that asked for it.
#
# The bridge is told to stay out of the way by `upgrade.pause`, which `upgrade.mjs` writes
# before it stages anything and clears when it finishes; `ensure-server.mjs` ignores a
# pause file older than 30 minutes, so a crashed upgrade cannot wedge the app.
#
# Arguments are passed straight through to `upgrade.mjs`
# (`--stage-from <dir>`, `--dry-run`, an explicit version, …). The delay gives the caller
# time to deliver its last message before the app disconnects.
#
# Exit status is `upgrade.mjs`'s: 0 upgraded, 10 rejected before touching the install,
# 20 rolled back after a failed swap, 21 rollback failed, 30 bad usage.
set -u

H="${HOME:-/data/data/com.termux/files/home}"
export HOME="$H"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PREFIX
export PATH="$PREFIX/bin:$PATH"

export DSH_DIR="${DSH_DIR:-$H/dsh}"
export DSH_HOME="${DSH_HOME:-$H/.dsh}"
export DSH_APP_DIR="${DSH_APP_DIR:-$H/.dsh-app}"
export DSH_PORT="${DSH_PORT:-3080}"
export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"
export DSH_SERVER_LOG="${DSH_SERVER_LOG:-$DSH_APP_DIR/server.log}"

# The server started after the swap inherits this environment, so it carries the same
# DSH_DIR/DSH_PORT/DSH_PERMISSION_MODE the bridge would have given it.
DELAY="${DSH_UPGRADE_DELAY_SECONDS:-45}"
LOG="$DSH_APP_DIR/upgrade-detached.log"
mkdir -p "$DSH_APP_DIR"
exec >>"$LOG" 2>&1

echo "==================== $(date '+%F %T') upgrade invoked detached: $* ===================="
if [ -f "$DSH_APP_DIR/upgrade.pause" ]; then
    echo "-- another upgrade holds $DSH_APP_DIR/upgrade.pause; refusing to start a second one"
    echo "-- (delete the file if that run is known dead)"
    exit 30
fi
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock 2>/dev/null

echo "-- waiting ${DELAY}s so the caller can finish its last turn"
sleep "$DELAY"

node "$DSH_APP_DIR/upgrade.mjs" "$@"
STATUS=$?
echo "-- upgrade.mjs exit $STATUS at $(date '+%F %T')"
if [ "$STATUS" -eq 0 ] && printf '%s\n' "$@" | grep -qx -- '--dry-run'; then
    echo "== plan only (--dry-run): nothing was changed =="
    exit 0
fi
case "$STATUS" in
    0)  echo "== upgraded; previous tree kept at $DSH_DIR.prev ==" ;;
    10) echo "== rejected before touching the live install; nothing changed ==" ;;
    20) echo "== post-swap health check failed and the previous tree is serving again ==" ;;
    21) echo "== ROLLBACK FAILED — follow the manual restore steps above ==" ;;
    *)  echo "== unexpected exit $STATUS; read the upgrade-*.log beside it ==" ;;
esac
exit "$STATUS"
