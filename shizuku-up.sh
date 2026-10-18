#!/data/data/com.termux/files/usr/bin/bash
#
# shizuku-up.sh —— 手机重启/断开后，一键找回「adb shell 级」通道
#
# 干什么：
#   1) 扫 127.0.0.1 高段端口，自动发现「无线调试」的随机端口
#   2) adb connect 上去
#   3) 拉起 Shizuku server（这就是 uid=2000 shell 权限的来源）
#   4) 用 rish 验证
#
# 用法：
#   ./shizuku-up.sh                    自动恢复
#   ./shizuku-up.sh pair 123456 41234  从未配对过时，先用配对码配对
#   SCAN_LO=40000 SCAN_HI=45000 ./shizuku-up.sh   缩小扫描区间
#
# 注意：Shizuku 13.x 不注册 ServiceManager 服务，所以 `service list`
#       里永远看不到它 —— 判断存活请用 `rish -c id`，别看 service list。
#
set -u

SCAN_LO="${SCAN_LO:-30000}"
SCAN_HI="${SCAN_HI:-50000}"
SHIZUKU_PKG="moe.shizuku.privileged.api"
SHIZUKU_DIR="/storage/emulated/0/Android/data/${SHIZUKU_PKG}"

export RISH_APPLICATION_ID="${RISH_APPLICATION_ID:-com.termux}"

say() { printf '\033[1;36m[*]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[✓]\033[0m %s\n' "$*"; }
bad() { printf '\033[1;31m[✗]\033[0m %s\n' "$*"; }
die() { bad "$*"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "缺 $1，先 pkg install ${2:-$1}"; }

# ---------------------------------------------------------------- pair 模式
if [ "${1:-}" = "pair" ]; then
  CODE="${2:-}"; PPORT="${3:-}"
  [ -n "$CODE" ] && [ -n "$PPORT" ] || die "用法: $0 pair <配对码> <配对端口>"
  adb start-server >/dev/null 2>&1
  say "向 localhost:${PPORT} 配对…（若提示要密码，就用你屏幕上那 6 位数）"
  printf '%s\n' "$CODE" | adb pair "localhost:${PPORT}"
fi

need adb android-tools
need python3 python

# ---------------------------------------------------------------- 0. 已经通了？
if rish -c id >/dev/null 2>&1; then
  ok "Shizuku 已在运行：$(rish -c id 2>/dev/null | head -1)"
  exit 0
fi

# ---------------------------------------------------------------- 1. adb transport
have_transport() { adb devices 2>/dev/null | grep -q 'device$'; }

if ! have_transport; then
  say "没有可用 transport，扫描 127.0.0.1:${SCAN_LO}-${SCAN_HI} 找无线调试端口…"
  adb start-server >/dev/null 2>&1

  PORTS=$(python3 - "$SCAN_LO" "$SCAN_HI" <<'PY'
import socket, concurrent.futures, sys
lo, hi = int(sys.argv[1]), int(sys.argv[2])

def probe(p):
    s = socket.socket()
    s.settimeout(0.08)
    try:
        return p if s.connect_ex(('127.0.0.1', p)) == 0 else None
    except Exception:
        return None
    finally:
        s.close()

with concurrent.futures.ThreadPoolExecutor(max_workers=512) as ex:
    print(' '.join(str(r) for r in ex.map(probe, range(lo, hi + 1)) if r))
PY
)

  [ -n "$PORTS" ] || die "没扫到任何监听端口 —— 确认「设置→开发者选项→无线调试」是打开的，且连着 WLAN"
  say "候选端口: ${PORTS}"

  for p in $PORTS; do
    adb connect "localhost:${p}" >/dev/null 2>&1
    if have_transport; then
      ok "adb 已连接 localhost:${p}"
      break
    fi
  done

  have_transport || die "候选端口都连不上。若本机从未与此终端配对，先跑: $0 pair <配对码> <配对端口>"
fi

# 只留一条 transport，避免 -s 歧义
adb devices | awk 'NR>1 && $2=="device"{print $1}' | tail -n +2 | while read -r t; do
  [ -n "$t" ] && adb disconnect "$t" >/dev/null 2>&1
done
ok "transport: $(adb devices | awk 'NR>1 && $2=="device"{print $1}' | head -1)"

# ---------------------------------------------------------------- 2. 清掉残骸
adb shell 'pkill -f shizuku_server 2>/dev/null; pkill -f ShizukuService 2>/dev/null' >/dev/null 2>&1
sleep 1

# ---------------------------------------------------------------- 3. 拉 server
[ -f "$SHIZUKU_DIR/start.sh" ] || die "找不到 $SHIZUKU_DIR/start.sh —— Shizuku 版本过旧或未安装"
say "启动 Shizuku server…"
adb shell "sh ${SHIZUKU_DIR}/start.sh" 2>&1 | sed 's/^/    /'

# ---------------------------------------------------------------- 4. 验证
say "等待 binder 推送…"
for _ in $(seq 1 15); do
  sleep 2
  if rish -c id >/dev/null 2>&1; then
    ok "搞定：$(rish -c id 2>/dev/null | head -1)"
    ok "SELinux: $(rish -c getenforce 2>/dev/null)"
    exit 0
  fi
done

bad "server 起了但 rish 仍不通（30s 超时）"
echo "    自查:"
echo "      adb shell 'ps -A | grep shizuku_server'    # server 活着吗"
echo "      adb logcat -d | grep -E 'Service :|BinderSender' | tail"
echo "      cat /data/local/tmp/shizuku/shizuku.json   # 你的终端 app 在授权列表里吗(flags=2)"
exit 1
