#!/data/data/com.termux/files/usr/bin/bash
#
# 把 PhoneUse 装成一个可持久化的 agent preset：重启不丢，新建会话时可选。
# 可重复运行：组成/元数据已存在就保留，只补缺的部分，然后重建插件并自检。
#
# 用法：
#   bash phone-use/install.sh                    # 装到 ~/.dsh/.agent-presets/phone-use
#   bash phone-use/install.sh --dsh-dir ~/dsh    # 指定 dsh 安装目录
#   bash phone-use/install.sh --id phoneuse      # 指定 preset id
#   bash phone-use/install.sh --check            # 只检查环境，不写任何文件
#
# 仓库：https://github.com/mermergi/deepseek-harness-termux
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DSH_DIR="${DSH_DIR:-$HOME/dsh}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PRESET_ID="phone-use"
CHECK=0

say() { printf '\033[32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[警告]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --dsh-dir)
            [ $# -ge 2 ] || die "--dsh-dir 需要一个路径参数"
            DSH_DIR="$2"; shift 2 ;;
        --id)
            [ $# -ge 2 ] || die "--id 需要一个 preset id"
            PRESET_ID="$2"; shift 2 ;;
        --check) CHECK=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "未知参数：$1（用 --help 查看用法）" ;;
    esac
done

command -v node >/dev/null 2>&1 || die "找不到 node —— 先 pkg install nodejs"
[ -f "$HERE/host.js" ] || die "找不到 $HERE/host.js —— 请在仓库里运行本脚本"
[ -f "$HERE/build.mjs" ] || die "找不到 $HERE/build.mjs —— 请在仓库里运行本脚本"
command -v adb >/dev/null 2>&1 || warn "找不到 adb —— pkg install android-tools（没有它，工具装上也用不了）"

SHIPPED="$DSH_DIR/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard"
[ -f "$SHIPPED/agent.cordis.yml" ] || die "在 $DSH_DIR 里找不到 shipped 的 standard preset；用 --dsh-dir 指定 dsh 安装目录"
PRESET="$DSH_HOME/.agent-presets/$PRESET_ID"

say "preset 目录：$PRESET"
say "基底组成：  $SHIPPED/agent.cordis.yml"

if [ "$CHECK" = "1" ]; then
    say "--check：只检查到这一步，未写任何文件"
    exit 0
fi

# ── 1. 组成：以 shipped standard 为基底，补上 PhoneUse 那一行 ──────────────
mkdir -p "$PRESET"
if [ -f "$PRESET/agent.cordis.yml" ]; then
    say "组成已存在，保留（只补缺的那一行）"
else
    cp "$SHIPPED/agent.cordis.yml" "$PRESET/agent.cordis.yml"
    say "已复制 standard 组成作为基底"
fi

if grep -q '^- id: tool-phone-use' "$PRESET/agent.cordis.yml"; then
    say "组成里已有 tool-phone-use 行，跳过"
else
    cat >> "$PRESET/agent.cordis.yml" <<'ROW'

# ── PhoneUse ────────────────────────────────────────────────────────────────

# Eyes and hands on this Android phone, through the Termux `adb` client already
# paired to 127.0.0.1. Eight model-facing tools: `phone_status` (reachability,
# model, screen, foreground app), `phone_screenshot` (the screen as an image the
# model can actually look at), `phone_ui` (the accessibility tree as numbered
# elements with REAL device-pixel tap coordinates), and the actions
# `phone_tap`, `phone_swipe`, `phone_key`, `phone_text`, `phone_app`.
#
# The row registers into the host `tools` registry and publishes no service, so
# it sits loose here like `tool-bash` rather than inside an isolate realm. It
# CONSUMES the host `shell`, `fs`, and `attachments` services at call time; a
# realm of its own would hide exactly those and its tools would stop reaching
# them.
#
# The plugin module lives inside this preset (`./plugin/index.js`) instead of an
# installed package: a preset-relative row resolves against this preset's own
# directory, so the preset stays self-contained and survives a deployment
# reinstall. That module is GENERATED from a verified source body — rebuild it
# with `node phone-use/build.mjs --out <preset>/plugin` in the workspace that
# owns `phone-use/host.js`, and never hand-edit the generated file.
#
# This preset is a copy of `standard`, not of `cordis`: `tool-cordis` registers
# process-global Host inspect providers, so a second cordis-family preset
# standing in the same process collides with the shipped `cordis` mount. To get
# both the Cordis toolset and PhoneUse, pick one base per process.
#
# Prerequisite: the Termux adb client connected to this device (`adb pair` once,
# then `adb connect 127.0.0.1:<wireless-debugging-port>`). When that link is
# down, `phone_status` reports connected=false and every other tool fails with
# the reconnect recipe instead of guessing.
- id: tool-phone-use
  name: './plugin/index.js'
ROW
    say "已追加 tool-phone-use 行"
fi

# ── 2. 元数据 ──────────────────────────────────────────────────────────────
if [ -f "$PRESET/preset.yml" ]; then
    say "preset.yml 已存在，保留"
else
    cat > "$PRESET/preset.yml" <<'META'
name: 标准模式 + PhoneUse
description: 标准模式的全部能力，外加 PhoneUse：通过已配对的 adb 直接操作这台安卓手机——截屏并以图像交给模型、读取可点击元素的真实像素坐标、点击、滑动、按键、输入文本、启动与停止应用。
META
    say "已写 preset.yml"
fi

# ── 3. 构建插件模块（把探测到的 defineTool 绝对路径烘进生成物） ────────────
DSH_DIR="$DSH_DIR" node "$HERE/build.mjs" --out "$PRESET/plugin"

# ── 4. 自检：加载模块、跑 apply、校验它会发出的命令 ────────────────────────
SMOKE_LOG="${TMPDIR:-$HOME}/phoneuse-smoke.$$.log"
if node "$HERE/smoke.mjs" "$PRESET/plugin/index.js" > "$SMOKE_LOG" 2>&1; then
    say "自检通过（$(grep -c "ctx.tools.register(defineTool(" "$PRESET/plugin/index.js") 个工具已注册）"
    rm -f "$SMOKE_LOG"
else
    printf '\033[31m---- smoke 输出 ----\033[0m\n' >&2
    cat "$SMOKE_LOG" >&2
    rm -f "$SMOKE_LOG"
    die "自检失败 —— 这个组成挂载时也会失败"
fi

cat <<EOF

完成。下一步：
  1) 在 DSH 的 Web 界面新建会话，preset 选「标准模式 + PhoneUse」
  2) 让 agent 跑一次 phone_status，确认 connected=true
     若为 false：手机的「无线调试」要开着，并重新 adb connect 127.0.0.1:<端口>

重装或升级 dsh 之后，重跑本脚本即可（幂等）。
EOF
