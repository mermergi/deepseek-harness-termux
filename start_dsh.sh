#!/data/data/com.termux/files/usr/bin/bash

# 一键启动 DeepSeek Harness（dsh）Web UI 并自动打开浏览器
# 首次启动后浏览器会持有 30 天的登录 cookie，之后重开同一地址无需 token
#
# 安装目录可用环境变量覆盖：DSH_DIR=/path/to/dsh ./start_dsh.sh
DSH_DIR="${DSH_DIR:-$HOME/dsh}"

# 工作目录即 dsh 的默认工作区，放在 $HOME 下方便 agent 访问自己的项目
cd "$HOME" || exit 1

# 启动前重做安卓兼容修补（幂等）：重装 dsh 后会自动修回来
node "$DSH_DIR/android-fix.mjs" || exit 1

# 安卓上没有可用的沙箱后端（bwrap / Landlock 都不存在），
# 只能让命令以非受限模式运行并关闭审批询问，否则 shell 工具会一律拒绝执行
# 注意：这意味着 agent 拥有 Termux 的完整权限，不需要就删掉这行
export DSH_PERMISSION_MODE=danger-full-access

port=3080
url="http://127.0.0.1:$port/"
port_open() { (echo >/dev/tcp/127.0.0.1/$port) 2>/dev/null; }

# 若服务器已经在运行，直接打开浏览器即可
if port_open; then
    termux-open-url "$url"
    exit 0
fi

# 前台运行服务器（保持进程存活，dsh 自己会打开浏览器）
#
# 这里必须显式用 node 启动，不要写成 node_modules/.bin/dsh。
# 那个 shim 是指向 lib/bin.js 的符号链接，shebang 为 #!/usr/bin/env node，
# 而 Termux 上并不存在 /usr/bin/env。交互式 shell 里因为 termux-exec 的
# LD_PRELOAD 会改写 shebang 而侥幸能跑，但 Termux:Widget 拉起的新会话没有它，
# 会直接报 "/usr/bin/env: bad interpreter: No such file or directory"。
exec node "$DSH_DIR/node_modules/@deepseek-ai/dsh/lib/bin.js" web
