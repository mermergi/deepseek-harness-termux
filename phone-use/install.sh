#!/data/data/com.termux/files/usr/bin/bash
#
# 把 PhoneUse 装成一个可持久化的 agent preset：重启不丢，新建会话时可选。
# 可重复运行：bundle 已装、生成物已存在时会自行收敛，不会重复添加。
#
# 用法：
#   bash phone-use/install.sh                      # 装进 web profile
#   bash phone-use/install.sh --profile tui        # 指定 profile
#   bash phone-use/install.sh --dsh-dir ~/dsh      # 指定 dsh 安装目录
#   bash phone-use/install.sh --check              # 只检查环境，不写任何文件
#
# 为什么不再是「往 ~/.dsh/.agent-presets/<id>/ 写两个文件」：
# 0.1.7 起那个目录**不再被读取**——preset 现在是 bundle 补丁里的一个
# `@deepseek-ai/dsh-agent-preset` 声明。所以本脚本改为：
#   生成 bundle 补丁 → 构建插件模块 → 自检 → 用 `dsh plugin add` 装 bundle。
#
# 仓库：https://github.com/mermergi/deepseek-harness-termux
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
BUNDLE="$REPO/phone-use-preset"
DSH_DIR="${DSH_DIR:-$HOME/dsh}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="web"
CHECK=0

say() { printf '\033[32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[警告]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --dsh-dir)
            [ $# -ge 2 ] || die "--dsh-dir 需要一个路径参数"
            DSH_DIR="$2"; shift 2 ;;
        --profile)
            [ $# -ge 2 ] || die "--profile 需要一个 profile 名"
            PROFILE="$2"; shift 2 ;;
        --check) CHECK=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "未知参数：$1（用 --help 查看用法）" ;;
    esac
done

command -v node >/dev/null 2>&1 || die "找不到 node —— 先 pkg install nodejs"
[ -f "$HERE/host.js" ] || die "找不到 $HERE/host.js —— 请在仓库里运行本脚本"
[ -f "$HERE/build.mjs" ] || die "找不到 $HERE/build.mjs —— 请在仓库里运行本脚本"
[ -f "$BUNDLE/generate.mjs" ] || die "找不到 $BUNDLE/generate.mjs —— 仓库不完整"
command -v adb >/dev/null 2>&1 || warn "找不到 adb —— pkg install android-tools（没有它，工具装上也用不了）"

DSH_BIN="$DSH_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js"
[ -f "$DSH_BIN" ] || die "在 $DSH_DIR 里找不到 dsh 入口；用 --dsh-dir 指定安装目录"
SHIPPED="$DSH_DIR/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml"
[ -f "$SHIPPED" ] || die "找不到 shipped 的 standard preset（$SHIPPED）；这个 dsh 版本可能还没有它"

say "profile：    $PROFILE"
say "bundle：     $BUNDLE"
say "基底组成：   $SHIPPED"

if [ "$CHECK" = "1" ]; then
    say "--check：只检查到这一步，未写任何文件"
    exit 0
fi

# ── 1. 生成 bundle 补丁：以 shipped standard 为基底，补上 PhoneUse 那一行 ──
DSH_DIR="$DSH_DIR" node "$BUNDLE/generate.mjs" --dsh-dir "$DSH_DIR"

# ── 2. 构建插件模块（把探测到的 defineTool 绝对路径烘进生成物） ────────────
DSH_DIR="$DSH_DIR" node "$HERE/build.mjs" --out "$BUNDLE/plugin"

# ── 3. 自检：加载模块、跑 apply、校验它会发出的命令 ────────────────────────
SMOKE_LOG="${TMPDIR:-$HOME}/phoneuse-smoke.$$.log"
if node "$HERE/smoke.mjs" "$BUNDLE/plugin/index.js" > "$SMOKE_LOG" 2>&1; then
    say "自检通过（$(grep -c "ctx.tools.register(defineTool(" "$BUNDLE/plugin/index.js") 个工具已注册）"
    rm -f "$SMOKE_LOG"
else
    printf '\033[31m---- smoke 输出 ----\033[0m\n' >&2
    cat "$SMOKE_LOG" >&2
    rm -f "$SMOKE_LOG"
    die "自检失败 —— 这个组成挂载时也会失败"
fi

# ── 4. 装 bundle：pnpm 链接本地目录，并把它选进 profile 的 bundle 层 ───────
#     与插件市场内部走的是同一条通道；这一步要拿文件写锁，锁被遗留时由
#     android-fix.mjs 在启动时回收。
node "$DSH_BIN" plugin --profile "$PROFILE" add "$BUNDLE"

LEGACY="$DSH_HOME/.agent-presets/phone-use"
if [ -d "$LEGACY" ]; then
    warn "老目录仍在：$LEGACY（0.1.7 起已无人读取，确认新 preset 可用后可删）"
    warn "  rm -rf \"$LEGACY\""
fi

cat <<EOF

完成。下一步：
  1) 重启一次 DSH（设置 → 通用设置 → 底部「重启 DSH 服务」）
  2) 新建会话，preset 选「标准模式 + PhoneUse」
  3) 让 agent 跑一次 phone_status，确认 connected=true
     若为 false：手机的「无线调试」要开着，并重新 adb connect 127.0.0.1:<端口>

重装或升级 dsh 之后，重跑本脚本即可（幂等）。
EOF
