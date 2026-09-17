#!/data/data/com.termux/files/usr/bin/bash
# Install the Termux half of the DSH Android app.
#
#   bash install.sh            install bridge files + enable allow-external-apps
#   bash install.sh --no-props skip the termux.properties edit
#
# Idempotent: re-run it any time.
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$HOME/.dsh-app"
java_src="$src/src/com/mermergi/dsh/MainActivity.java"
props="$HOME/.termux/termux.properties"
skip_props=0
[ "${1:-}" = "--no-props" ] && skip_props=1

# Single source of truth for the handoff secret is the Java constant.
key="$(sed -n 's/.*HANDOFF_KEY = "\([^"]*\)".*/\1/p' "$java_src" | head -1)"
[ -n "$key" ] || { echo "在 $java_src 里找不到 HANDOFF_KEY" >&2; exit 1; }

echo "==> 安装 $app_dir"
mkdir -p "$app_dir"
install -m 700 "$src/termux/ensure-server.mjs" "$app_dir/ensure-server.mjs"
install -m 700 "$src/termux/handoff.mjs" "$app_dir/handoff.mjs"
install -m 700 "$src/termux/status.mjs" "$app_dir/status.mjs"
sed "s/__DSH_APP_KEY__/$key/" "$src/termux/bridge.sh" >"$app_dir/bridge.sh"
chmod 700 "$app_dir/bridge.sh"

if [ ! -f "$app_dir/env" ]; then
    cat >"$app_dir/env" <<'ENV'
# 传给 bridge 启动的 dsh 服务。改这里等于改 start_dsh.sh 里的对应设置。
# 安卓上没有可用的沙箱后端，去掉这一行 shell 工具会全部拒绝执行。
export DSH_PERMISSION_MODE=danger-full-access
ENV
    echo "==> 写入 $app_dir/env（默认 danger-full-access，和 start_dsh.sh 一致）"
fi

if [ "$skip_props" = "0" ]; then
    echo "==> 打开 allow-external-apps"
    mkdir -p "$(dirname "$props")"
    [ -f "$props" ] || : >"$props"
    if grep -qE '^[[:space:]]*allow-external-apps[[:space:]]*=[[:space:]]*true[[:space:]]*$' "$props"; then
        echo "    已经是 true，跳过"
    elif grep -qE '^[[:space:]]*#?[[:space:]]*allow-external-apps' "$props"; then
        sed -i -E 's|^[[:space:]]*#?[[:space:]]*allow-external-apps[[:space:]]*=.*$|allow-external-apps = true|' "$props"
        echo "    已把注释行改成 allow-external-apps = true"
    else
        printf '\nallow-external-apps = true\n' >>"$props"
        echo "    已追加 allow-external-apps = true"
    fi
    if command -v termux-reload-settings >/dev/null 2>&1; then
        termux-reload-settings >/dev/null 2>&1 || true
        echo "    已 termux-reload-settings"
    fi
fi

echo
echo "完成。自检："
command -v aapt2 >/dev/null 2>&1 && echo "  aapt2     ok" || echo "  aapt2     缺失（pkg install aapt2）"
command -v d8 >/dev/null 2>&1 && echo "  d8        ok" || echo "  d8        缺失（pkg install d8）"
command -v apksigner >/dev/null 2>&1 && echo "  apksigner ok" || echo "  apksigner 缺失（pkg install apksigner）"
command -v javac >/dev/null 2>&1 && echo "  javac     ok" || echo "  javac     缺失（pkg install openjdk-17）"
echo "  bridge    $app_dir/bridge.sh"
