#!/data/data/com.termux/files/usr/bin/bash
#
# 在 Android/Termux 上安装并修补 DeepSeek Harness（dsh）。
# 可重复运行：已安装的部分会跳过，补丁本身是幂等的。
#
# 用法：
#   bash install.sh                      # 安装到 ~/dsh
#   bash install.sh --deps               # 顺带用 pkg 装 Termux 依赖
#   bash install.sh --dir ~/foo          # 自定义安装目录
#   bash install.sh --version 0.1.5-rc.1 # 固定版本（便于复现）
#
# 仓库：https://github.com/mermergi/deepseek-harness-termux
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/mermergi/deepseek-harness-termux/main"
DIR="$HOME/dsh"
DSH_VERSION=""
INSTALL_DEPS=0

say() { printf '\033[32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[警告]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
    case "$1" in
        --dir)
            [ $# -ge 2 ] || die "--dir 需要一个路径参数"
            DIR="$2"; shift 2 ;;
        --version)
            [ $# -ge 2 ] || die "--version 需要一个版本号"
            DSH_VERSION="$2"; shift 2 ;;
        --deps) INSTALL_DEPS=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "未知参数：$1（用 --help 查看用法）" ;;
    esac
done

# ── 1. 依赖检查 ────────────────────────────────────────────────
if [ "$INSTALL_DEPS" -eq 1 ]; then
    say "用 pkg 安装 Termux 依赖（nodejs python clang make ripgrep）"
    pkg install -y nodejs python clang make ripgrep || warn "pkg install 失败，请先手动执行 pkg update"
fi

command -v node >/dev/null 2>&1 || die "没找到 node。先执行：pkg install nodejs"
command -v npm  >/dev/null 2>&1 || die "没找到 npm。先执行：pkg install nodejs"

# dsh 的 engines 要求 ^22.19.0 || >=24.0.0
node -e 'const [m,n]=process.versions.node.split(".").map(Number);
         process.exit((m===22&&n>=19)||m>=24?0:1)' \
    || die "Node $(node -p 'process.versions.node') 不满足 dsh 的要求（需要 22.19+ 或 24+）。升级：pkg install nodejs"

# node-pty 在安卓上没有预编译，安装时要用 node-gyp 现场编译
MISSING_TOOLS=""
for tool in clang make python3; do
    command -v "$tool" >/dev/null 2>&1 || MISSING_TOOLS="$MISSING_TOOLS $tool"
done
if [ -n "$MISSING_TOOLS" ]; then
    warn "缺少编译工具：$MISSING_TOOLS"
    warn "node-pty 需要它们才能编译出安卓版 pty.node，请执行："
    warn "  pkg install python clang make"
    warn "（或用本脚本的 --deps 参数自动安装）"
fi

say "Node $(node -p 'process.versions.node') / npm $(npm -v)"

# ── 2. 安装 dsh ───────────────────────────────────────────────
say "安装 dsh 到 $DIR（515 个包，约 300MB，首次较慢）"
mkdir -p "$DIR"
cd "$DIR"

if [ -n "$DSH_VERSION" ]; then
    npm install "@deepseek-ai/dsh@$DSH_VERSION"
else
    npm install @deepseek-ai/dsh
fi

# sharp 没有 android-arm64 预编译，缺了它附件插件会让 dsh 在启动阶段就崩
say "安装 sharp 的 WebAssembly 回退版"
npm install @img/sharp-wasm32 sharp

# ── 3. 打补丁 ─────────────────────────────────────────────────
# 优先用与本脚本同目录的文件（已 clone 的场景），否则从仓库下载。
SELF_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "")"
fetch() {
    if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/$1" ]; then
        cp "$SELF_DIR/$1" "$2"
    else
        curl -fsSL "$REPO_RAW/$1" -o "$2" || die "下载 $1 失败（检查网络，或用 git clone 本仓库后重跑）"
    fi
}

fetch android-fix.mjs "$DIR/android-fix.mjs"
say "执行安卓兼容补丁"
node "$DIR/android-fix.mjs" || die "补丁脚本报错，见上方输出"

if [ ! -f "$DIR/node_modules/node-pty/build/Release/pty.node" ] \
   && [ ! -d "$DIR/node_modules/node-pty/prebuilds/android-arm64" ]; then
    warn "没找到安卓版 pty.node：node-pty 没编译成功。"
    warn "shell / 终端类工具会不可用，请补齐编译工具后重跑本脚本："
    warn "  pkg install python clang make && node $DIR/android-fix.mjs"
fi

# ── 4. 安装一键启动脚本 ───────────────────────────────────────
SHORTCUT="$HOME/.shortcuts/start_dsh.sh"
mkdir -p "$HOME/.shortcuts"
if [ -f "$SHORTCUT" ] && ! cmp -s "$SELF_DIR/start_dsh.sh" "$SHORTCUT" 2>/dev/null; then
    cp "$SHORTCUT" "$SHORTCUT.bak"
    warn "已存在 $SHORTCUT，原文件备份为 start_dsh.sh.bak"
fi
fetch start_dsh.sh "$SHORTCUT"
chmod +x "$SHORTCUT"

if [ "$DIR" != "$HOME/dsh" ]; then
    # 启动脚本默认找 ~/dsh，自定义目录要写进去
    sed -i "s|^DSH_DIR=.*|DSH_DIR=\"$DIR\"|" "$SHORTCUT"
    say "已把启动脚本的 DSH_DIR 设为 $DIR"
fi

# ── 5. 完成 ───────────────────────────────────────────────────
say "完成（dsh $(node -p "require('$DIR/node_modules/@deepseek-ai/dsh/package.json').version")）"
cat <<EOF

  启动：bash ~/.shortcuts/start_dsh.sh
       或在桌面添加 Termux:Widget 小组件后点 start_dsh.sh
       （Web UI 默认在 http://127.0.0.1:3080）

  首次使用：进入界面后到 Settings → Models 填一次 DeepSeek API key

  注意：启动脚本导出 DSH_PERMISSION_MODE=danger-full-access，
       即关闭沙箱与审批。原因是安卓上没有任何可用的沙箱后端
       （bwrap 和 Landlock 都不存在），不这样 shell 工具会一律拒绝执行。
       代价是 agent 的命令拥有 Termux 的完整权限，能读写你的所有文件。
       不需要就去掉该行 export。

EOF
