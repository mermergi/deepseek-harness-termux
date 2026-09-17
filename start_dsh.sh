#!/data/data/com.termux/files/usr/bin/bash

# DeepSeek Harness（dsh）Web UI —— 静默一键启动
#
# 放在 ~/.shortcuts/tasks/ 下，所以不会弹终端窗口，只用提示条告知结果。
# 已在跑 → 直接打开浏览器；没在跑 → 后台拉起服务，就绪后打开浏览器。
#
# 日志：tail -30 "$HOME/.dsh-app/launcher.log"（服务自身输出：$HOME/.dsh-app/server.log）
#
# 日志故意不放 $TMPDIR：Termux 重启 App 进程时会清空 $PREFIX/tmp，而已经跑起来的
# dsh 还持有那个 inode（`... (deleted)`），于是进程活着、日志却从磁盘上消失——
# 而日志里那行带 token 的地址是它唯一的外部副本，cookie 过期后就再也登不进去。
# DSH 安卓 App 拉起服务时用的是同一个路径，两边可以互相复用。

set -u

: "${HOME:=/data/data/com.termux/files/home}"
export HOME

# 背景任务未必走登录 shell：只有在确实找不到工具时才补 PATH
command -v node >/dev/null 2>&1 || export PATH="${PREFIX:-/data/data/com.termux/files/usr}/bin:$PATH"

DSH_DIR="${DSH_DIR:-$HOME/dsh}"
PORT="${DSH_PORT:-3080}"
URL="http://127.0.0.1:$PORT/"
STATE_DIR="${DSH_STATE_DIR:-$HOME/.dsh-app}"
mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/launcher.log"
SERVER_LOG="$STATE_DIR/server.log"

port_open() { (echo >/dev/tcp/127.0.0.1/$PORT) 2>/dev/null; }

# 只有装了 Termux:API 应用才弹得出提示条。
# 先查应用在不在再调用 —— 否则 termux-toast 会一直等到超时，点一下要卡好几秒。
_toast_ok=""
toast() {
    command -v termux-toast >/dev/null 2>&1 || return 0
    if [ -z "$_toast_ok" ]; then
        if command -v pm >/dev/null 2>&1 && pm list packages 2>/dev/null | grep -q 'com.termux.api'; then
            _toast_ok=1
        else
            _toast_ok=0
        fi
    fi
    [ "$_toast_ok" = "1" ] || return 0
    timeout 5 termux-toast -g middle "$1" >/dev/null 2>&1 || true
    return 0
}

# dsh 就绪时会打印一行：dsh web: http://127.0.0.1:3080/?token=...
# 必须用这个带 token 的地址：裸地址会 401。
server_url() {
    # 只认本端口的地址：日志里可能残留别的端口（比如调试实例）的旧行
    sed -n "s|^dsh web: \(http://127.0.0.1:$PORT/[^ ]*\).*|\1|p" "$SERVER_LOG" 2>/dev/null | tail -1
}

open_browser() {
    local url
    url="$(server_url)"
    # 服务不是这个脚本起的（日志里没那行）就退回裸地址：
    # 浏览器里已有 30 天登录 cookie，照样能进。
    [ -n "$url" ] || url="$URL"
    echo "打开浏览器: $url"
    if timeout 15 termux-open-url "$url"; then
        return 0
    fi
    echo "⚠ termux-open-url 失败"
    toast "⚠ 浏览器没打开，再点一次 widget"
    return 1
}

{
    if port_open; then
        echo "=== $(date '+%Y-%m-%d %H:%M:%S') 已在运行 ==="
        open_browser
        toast "DSH 已在运行，打开浏览器…"
        exit 0
    fi

    echo "=== $(date '+%Y-%m-%d %H:%M:%S') 启动 ==="
    # dsh 自己还要好几秒才就绪，先给个回执，免得以为没点着
    toast "⏳ DSH 启动中，稍候…"
    cd "$HOME" || { toast "❌ 进不去 $HOME"; exit 1; }

    # 启动前重做安卓兼容修补（幂等）：重装 dsh 后会自动修回来
    if ! node "$DSH_DIR/android-fix.mjs"; then
        echo "android-fix.mjs 失败"
        toast "❌ DSH 安卓修补失败，看日志"
        exit 1
    fi

    # 安卓上没有可用的沙箱后端（bwrap / Landlock 都不存在），
    # 只能让命令以非受限模式运行并关闭审批询问，否则 shell 工具会一律拒绝执行
    export DSH_PERMISSION_MODE=danger-full-access

    # 防 Android 后台清理（和语音引擎同一套路）
    command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock 2>/dev/null && echo "wakelock 已获取"

    # 必须显式用 node 启动，不要写成 node_modules/.bin/dsh：
    # 那个 shim 的 shebang 是 #!/usr/bin/env node，而 Termux 上没有 /usr/bin/env，
    # widget 背景任务里没有 termux-exec 的 LD_PRELOAD 兜底，会直接报 bad interpreter。
    : > "$SERVER_LOG"
    setsid nohup node "$DSH_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js" web --no-open --port "$PORT" \
        >> "$SERVER_LOG" 2>&1 < /dev/null &
    disown 2>/dev/null || true

    printf '等待就绪'
    ok=0
    for _ in $(seq 1 480); do
        sleep 0.25
        printf '.'
        if [ -n "$(server_url)" ]; then
            ok=1
            break
        fi
    done
    echo

    if [ "$ok" = "1" ]; then
        open_browser
        toast "✅ DSH 已启动，打开浏览器…"
    else
        echo "❌ 启动失败，最后 20 行日志:"
        tail -20 "$SERVER_LOG" 2>/dev/null
        toast "❌ DSH 启动失败，看日志 $SERVER_LOG"
        exit 1
    fi
} >> "$LOG" 2>&1
