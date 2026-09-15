#!/usr/bin/env bash
# env-probe.sh —— 与任务无关的环境基线 + 可插拔的任务探测
#
# 设计原则（重要）：
#   没有一份固定清单能覆盖"没见过的任务"。能通用的只有三样：
#     1) 基线：平台/沙箱/文件系统/资源 —— 与做什么无关
#     2) 方法：先写假设，再配最小反证实验（不是查版本号）
#     3) 对照：证明你的"验证手段"能区分正例/负例，否则它不算验证
#   具体领域的探测放在 probes/*.sh，按需加载，不要往基线里塞。
#
# 用法:
#   bash env-probe.sh                        # 只跑基线
#   bash env-probe.sh --list                 # 列出可用探测
#   bash env-probe.sh --with io,net          # 基线 + 指定探测
#   bash env-probe.sh --with all             # 基线 + 全部探测
#   bash env-probe.sh --install               # 装到 PATH，任意工作区可用
#   ENV_PROBE_NM=/path/to/repo bash env-probe.sh   # 指定含 node_modules 的仓库
#   ENV_PROBE_PROBES=/path/to/probes bash env-probe.sh  # 指定探测目录
#
# 跨工作区：脚本按自身所在目录找 probes/（会解析符号链接）。
#   只拷 .sh 不带 probes/ 会明确报错；用 --install 装一次即可到处跑。
#   注意 --install 是"拷贝"，改了源码要重新装。
#
# 只读为主；写入类探测一律写在 $TMPDIR，用完即删。

SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
HERE="$(cd "$(dirname "$SELF")" && pwd)"
PROBE_DIR_SRC="${ENV_PROBE_PROBES:-$HERE/probes}"
WITH=""; LIST=0; PROJ=""; INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --with) WITH="${2:-}"; shift 2 ;;
    --with=*) WITH="${1#*=}"; shift ;;
    --list) LIST=1; shift ;;
    --install) INSTALL=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) PROJ="$1"; shift ;;
  esac
done
PROJ="${PROJ:-$PWD}"
NM="${NM:-}"
TMPROOT="${TMPDIR:-$PROJ}"
WORK=""; NOTES=""

sec()  { printf '\n=== %s ===\n' "$1"; }
kv()   { printf '  %-14s %s\n' "$1" "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }
note() { printf '  - %s\n' "$1" >> "$NOTES"; }

cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; }
trap cleanup EXIT

if [ "$INSTALL" = 1 ]; then
  DEST="${ENV_PROBE_HOME:-$HOME/.local/share/env-probe}"
  BIN="${PREFIX:-/usr/local}/bin"
  mkdir -p "$DEST/probes" "$BIN" || { echo "安装失败：无法创建 $DEST 或 $BIN"; exit 1; }
  # 关键：把 shebang 改成本机真实 bash 路径。
  # 源码里写 /usr/bin/env 是为了在 Linux/macOS 上可移植，但 Android 没有 /usr/bin/env，
  # 直接执行会 "bad interpreter" —— 所以安装时按本机实际情况写入。
  BASH_BIN="$(command -v bash || echo /bin/bash)"
  sed "1s|^#!.*|#!$BASH_BIN|" "$SELF" > "$DEST/env-probe.sh"
  cp "$PROBE_DIR_SRC"/*.sh "$DEST/probes/" 2>/dev/null
  chmod +x "$DEST/env-probe.sh"
  ln -sf "$DEST/env-probe.sh" "$BIN/env-probe"
  echo "已安装：$BIN/env-probe -> $DEST/env-probe.sh"
  echo "探测目录：$DEST/probes"
  echo "现在任意工作区直接跑：  env-probe --with all"
  echo "（PATH 里有 $BIN 即可；否则用 $BIN/env-probe）"
  exit 0
fi

if [ "$LIST" = 1 ]; then
  [ -d "$PROBE_DIR_SRC" ] || { echo "找不到探测目录：$PROBE_DIR_SRC"; echo "（单独拷贝脚本时请把 probes/ 一起带上，或先 --install）"; exit 1; }
  echo "可用探测（$PROBE_DIR_SRC）："
  for f in "$PROBE_DIR_SRC"/*.sh; do
    [ -e "$f" ] || continue
    printf '  %-14s %s\n' "$(basename "$f" .sh)" "$(sed -n '2s/^# *//p' "$f")"
  done
  echo
  echo "提示：任务不在列表里，就照 probes/ 里任意一个的格式现场写一个——"
  echo "      每个探测 = 一句可证伪的假设 + 一个最小的证伪实验。"
  exit 0
fi

WORK="$(mktemp -d "$TMPROOT/.envprobe.XXXXXX" 2>/dev/null || mktemp -d)"
NOTES="$WORK/notes.txt"; : > "$NOTES"
export NOTES PROJ NM TMPROOT WORK

# ============ 基线（与任务无关，永远跑） ============
sec "1. 平台身份"
kv "uname"    "$(uname -srm 2>/dev/null)"
IS_ANDROID=no; SDK=0
if have getprop; then
  IS_ANDROID=yes; SDK="$(getprop ro.build.version.sdk 2>/dev/null)"
  kv "Android" "release=$(getprop ro.build.version.release 2>/dev/null) sdk=${SDK:-?} abi=$(getprop ro.product.cpu.abi 2>/dev/null)"
  kv "机型"    "$(getprop ro.product.model 2>/dev/null)"
else
  kv "Android" "no"
fi
kv "PREFIX"   "${PREFIX:-(unset)}"
kv "HOME"     "${HOME:-(unset)}"
kv "TMPDIR"   "${TMPDIR:-(unset)}"
if [ -e /system/lib64/libc.so ] || [ -e /apex/com.android.runtime/lib64/bionic/libc.so ]; then LIBC=bionic
elif ldd --version 2>&1 | grep -qi musl; then LIBC=musl
else LIBC=glibc/其他; fi
kv "libc"     "$LIBC"
have node && kv "node 视角" "$(node -p "process.platform+' / '+process.arch+' / node '+process.version" 2>/dev/null)"

sec "2. 身份与沙箱"
kv "uid"     "$(id -u 2>/dev/null) ($(id -un 2>/dev/null))"
kv "root"    "$( [ "$(id -u 2>/dev/null)" = 0 ] && echo yes || echo no )"
kv "SELinux" "$(tr -d '\0' < /proc/self/attr/current 2>/dev/null || echo '(读不到)')"

sec "2b. 目录能力（实测，不看配置）"
printf '  %-40s %-5s %-5s %s\n' 目录 存在 可写 可执行
for d in "$PROJ" "$TMPROOT" "$HOME" /tmp /data/local/tmp /sdcard; do
  [ -n "$d" ] || continue
  e=no; w=no; x=no
  if [ -d "$d" ]; then
    e=yes; f="$d/.envprobe.$$"
    if ( printf 'exit 0\n' > "$f" ) 2>/dev/null; then
      w=yes; bash "$f" >/dev/null 2>&1 && x=yes; rm -f "$f"
    fi
  fi
  printf '  %-40s %-5s %-5s %s\n' "$d" "$e" "$w" "$x"
done

sec "3. 工具链（存在≠可用，可用性由对应探测负责）"
for c in bash python3 pip3 node npm pnpm git curl wget jq file readelf cc gcc clang make unzip tar sqlite3 ffmpeg; do
  if have "$c"; then
    if [ "$c" = unzip ]; then v="$("$c" -v 2>&1 | head -1)"; else v="$("$c" --version 2>&1 | head -1)"; fi
    printf '  %-10s %s\n' "$c" "$(printf '%s' "$v" | cut -c1-46)"
  else
    printf '  %-10s %s\n' "$c" "—"
  fi
done

sec "4. 资源与显示"
kv "CPU"  "$(nproc 2>/dev/null || echo '?') 核"
kv "内存" "$(awk '/^MemTotal|^MemAvailable/{gsub(":","",$1); printf "%s=%dMB ", $1, $2/1024}' /proc/meminfo 2>/dev/null)"
kv "磁盘" "$(df -h "$PROJ" 2>/dev/null | tail -1 | awk '{print $2" 总, "$4" 可用"}')"
kv "DISPLAY" "${DISPLAY:-(unset)}"

sec "5. 原生 / WASM（bionic 上的关键分野）"
if [ -z "$NM" ]; then
  d="$PROJ"
  while [ "$d" != "/" ] && [ -n "$d" ]; do
    [ -d "$d/node_modules" ] && { NM="$d"; break; }
    d="$(dirname "$d")"
  done
fi
if [ -z "$NM" ] && [ -n "${ENV_PROBE_NM:-}" ] && [ -d "$ENV_PROBE_NM/node_modules" ]; then
  NM="$ENV_PROBE_NM"
fi
export NM
if [ -n "$NM" ] && [ -d "$NM/node_modules" ]; then
  kv "node_modules" "$NM/node_modules"
  kv "原生模块数"   "$(find "$NM/node_modules" -maxdepth 3 -name '*.node' 2>/dev/null | wc -l | tr -d ' ')"
  [ -d "$NM/node_modules/@img" ] && kv "@img/*" "$(ls "$NM/node_modules/@img" 2>/dev/null | tr '\n' ' ')"
else
  kv "node_modules" "未找到（本工作区无 node_modules，依赖它的探测会跳过）"
fi

# ---- 通用工具：对照检查 ----
# 任何"验证手段"上手前，先证明它能区分正例/负例；区分不了就等于没验证。
# 用法: control_check <名称> <测量命令模板(用 $FILE 占位)> <正例文件> <负例文件>
control_check() {
  local name="$1" tmpl="$2" on="$3" off="$4" a b
  a="$(FILE="$on"  eval "$tmpl" 2>/dev/null)"
  b="$(FILE="$off" eval "$tmpl" 2>/dev/null)"
  if [ "$a" = "$b" ]; then
    printf '  %-16s %s\n' "$name" "无法区分正/负例 → 该测量无效，不能拿来验证"
    return 1
  fi
  printf '  %-16s %s\n' "$name" "可区分（正=$a 负=$b）"
  return 0
}
# 供 probes/*.sh 以子进程方式调用（子进程不继承函数，必须显式导出；须在定义之后）
export -f sec kv have note control_check

# ============ 任务探测（按需加载） ============
if [ "$WITH" = all ]; then
  WITH=""
  for f in "$PROBE_DIR_SRC"/*.sh; do [ -e "$f" ] && WITH="$WITH$(basename "$f" .sh),"; done
fi
if [ -n "$WITH" ]; then
  IFS=',' read -ra _list <<< "$WITH"
  for name in "${_list[@]}"; do
    [ -n "$name" ] || continue
    f="$PROBE_DIR_SRC/$name.sh"
    if [ -f "$f" ]; then
      bash "$f" || printf '  !! 探测 %s 异常退出（rc=%s）\n' "$name" "$?"
    else printf '\n=== 探测 %s 不存在（用 --list 看可用项） ===\n' "$name"; fi
  done
fi

# ============ 由事实推导的约束 ============
sec "8. 由以上事实推导出的约束"
[ "$LIBC" = bionic ] && note "bionic libc：预编译 glibc/linux-arm64 原生模块加载不了，优先 wasm/JS 回退或现场编译"
[ ! -w /tmp ] && note "/tmp 不可写：临时文件一律用 \$TMPDIR = ${TMPDIR:-?}"
if [ "$IS_ANDROID" = yes ] && [ "${SDK:-0}" -ge 31 ] 2>/dev/null; then
  note "Android API ${SDK}：phantom process killer 可能杀掉长时后台子进程，长任务要分片或加心跳"
fi
[ "$IS_ANDROID" = yes ] && note "untrusted_app 沙箱：DSH 的文件策略再宽也绕不过 OS 层路径限制"
[ -s "$NOTES" ] && cat "$NOTES" || echo "  （无）"
printf '\n提示：以上只是基线推论。任务特有假设请写成 probes/<名字>.sh 现场验证，\n'
printf '      并先过一遍 control_check —— 证明你的验证手段能区分正例和负例。\n\n'
