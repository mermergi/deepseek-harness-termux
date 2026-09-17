#!/data/data/com.termux/files/usr/bin/bash
# DSH app bridge — invoked by the DSH Android app through Termux's RUN_COMMAND service.
#
#   1. make sure `dsh web` is running (detached, so it outlives this session)
#   2. publish its process-token URL on a short-lived loopback endpoint
#
# The app polls that endpoint and loads the authenticated URL, which mints its
# 30-day browser-session cookie. Nothing here is long-lived: the endpoint exits
# as soon as it has handed the URL over, or after 90s.
#
# Usage: bridge.sh [--restart | --status]
#   --restart  restart the server so a fresh token is minted. The app only asks for
#              this when it has no usable cookie and cannot otherwise log in.
#   --status   run the work-status endpoint that feeds the floating bubble, nothing else.

set -u

export HOME="${HOME:-/data/data/com.termux/files/home}"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PREFIX
export PATH="$PREFIX/bin:$PATH"
export TMPDIR="${TMPDIR:-$PREFIX/tmp}"

APP_DIR="$HOME/.dsh-app"
export DSH_APP_DIR="$APP_DIR"
export DSH_DIR="${DSH_DIR:-$HOME/dsh}"
export DSH_PORT="${DSH_PORT:-3080}"
HANDOFF_PORT="${DSH_HANDOFF_PORT:-3099}"
STATUS_PORT="${DSH_STATUS_PORT:-3098}"
BRIDGE_LOG="$APP_DIR/bridge.log"
PID_FILE="$APP_DIR/handoff.pid"
export DSH_HANDOFF_PID_FILE="$PID_FILE"
export DSH_SERVER_LOG="${DSH_SERVER_LOG:-$APP_DIR/server.log}"

# Status mode: run the work-status endpoint for the floating bubble, nothing else.
if [ "${1:-}" = "--status" ]; then
    mkdir -p "$APP_DIR"
    exec >>"$APP_DIR/status.log" 2>&1
    echo "--- $(date '+%F %T') status daemon started (port $STATUS_PORT) ---"
    exec node "$APP_DIR/status.mjs" "$STATUS_PORT" "__DSH_APP_KEY__"
fi

RESTART=""
[ "${1:-}" = "--restart" ] && RESTART="--restart"

# Optional overrides, e.g. a different DSH_PERMISSION_MODE.
[ -f "$APP_DIR/env" ] && . "$APP_DIR/env"

mkdir -p "$APP_DIR"
exec >>"$BRIDGE_LOG" 2>&1
echo "--- $(date '+%F %T') bridge invoked (port $DSH_PORT${RESTART:+ $RESTART}) ---"

# A leftover endpoint from an earlier tap would answer the app with a stale URL.
if [ -f "$PID_FILE" ]; then
    OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        kill "$OLD_PID" 2>/dev/null || true
        sleep 0.3
    fi
    rm -f "$PID_FILE"
fi

# Keep Android's phantom-process killer away from the server we are about to start.
if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock 2>/dev/null && echo "wakelock acquired"
fi

URL="$(node "$APP_DIR/ensure-server.mjs" $RESTART)"
echo "url: ${URL:-<none>}"

exec node "$APP_DIR/handoff.mjs" "$URL" "__DSH_APP_KEY__" "$HANDOFF_PORT"
