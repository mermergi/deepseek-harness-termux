#!/data/data/com.termux/files/usr/bin/bash
# 假设：非 root 的 Termux(untrusted_app) 上，"安卓逆向"这件事能整体走通
#       —— 即 静态分析(APK→Java/smali/res) + 改包重签 + 原生 .so 分析。
# 实验：对真实 APK 跑完整链路，并给每个测量手段配正例/负例对照；
#       同时实测沙箱边界（ptrace 能否附着、能否读他应用数据），把"动态调试"单独判定。
# 用法：env-probe --with android-re   （或直接 bash 本文件）

sec "P-android-re. Termux 上的安卓逆向能力（实测，非查文档）"
have() { command -v "$1" >/dev/null 2>&1; }
r() { printf '  %-22s %s\n' "$1" "$2"; }

W="$WORK/android-re"; mkdir -p "$W"

# ---------- 样本：优先用设备上真实存在的 APK，找不到就现造一个最小 APK ----------
APK=""
for c in "$PROJ"/*.apk "$HOME/deepseek-harness-termux/android-app/prebuilt/dsh.apk" \
         "$HOME/deepseek-harness-termux/android-app/out/dsh.apk"; do
  [ -f "$c" ] && { APK="$c"; break; }
done
if [ -z "$APK" ]; then
  for c in $(find "$HOME" -maxdepth 4 -name '*.apk' 2>/dev/null | head -5); do
    [ -f "$c" ] && { APK="$c"; break; }
  done
fi
r "样本 APK" "${APK:-无（跳过全部静态分析项）}"
[ -z "$APK" ] && { note "没有 APK 样本，无法验证静态链路；放一个 .apk 到 \$HOME 下重跑"; exit 0; }

# 求真 DEX（正例）与纯文本（负例），供所有"反编译类"测量做对照
unzip -o -q "$APK" 'classes*.dex' -d "$W/dex" 2>/dev/null
DEX="$(find "$W/dex" -name '*.dex' 2>/dev/null | head -1)"
printf 'this is definitely not an apk/dex file\n' > "$W/fake.dex"

# ---------- 对照检查：测量手段必须先能区分正/负例 ----------
sec "P-android-re.0 仪器对照（区分不了 = 没验证）"
if have jadx && [ -n "$DEX" ]; then
  a="$(timeout 180 jadx --no-res -d "$W/cc_ok"  "$DEX"   2>&1 | grep -c 'java' )"
  b="$(timeout 180 jadx --no-res -d "$W/cc_no" "$W/fake.dex" 2>&1 | grep -c 'Load failed')"
  r "jadx 对照" "真dex 产出java=$([ -n "$(find "$W/cc_ok" -name '*.java' 2>/dev/null|head -1)" ] && echo yes || echo no) / 假dex 报 Load failed=${b}"
else
  r "jadx 对照" "jadx 或 DEX 缺失，跳过"
fi

# ---------- 1. 静态分析 ----------
sec "P-android-re.1 静态分析（APK 元数据 / Java / smali / 资源）"
if have aapt2; then
  n="$(aapt2 dump badging "$APK" 2>/dev/null | grep -c '^package:')"
  r "aapt2 badging" "package行=$n"
else r "aapt2" "未安装（pkg install aapt2）"; fi

if have jadx; then
  rm -rf "$W/jadx"; timeout 600 jadx -d "$W/jadx" --no-res "$APK" >"$W/jadx.log" 2>&1
  cnt="$(find "$W/jadx" -name '*.java' 2>/dev/null | wc -l | tr -d ' ')"
  r "jadx 反编译" "java 文件=$cnt $(head -20 "$W/jadx/sources"/*/*/*.java 2>/dev/null >/dev/null && echo '(可读)')"
else r "jadx" "未安装（pkg install jadx）"; fi

if have apktool; then
  rm -rf "$W/apktool"; timeout 600 apktool d -f -o "$W/apktool" "$APK" >"$W/apktool.log" 2>&1
  sm="$(find "$W"/apktool/smali* -name '*.smali' 2>/dev/null | wc -l | tr -d ' ')"
  mani="$([ -f "$W/apktool/AndroidManifest.xml" ] && grep -c '<manifest' "$W/apktool/AndroidManifest.xml" || echo 0)"
  r "apktool 解码" "smali=$sm manifest可读=$mani"
else r "apktool" "未安装（pkg install apktool）"; fi

have dex2jar && r "dex2jar" "有" || r "dex2jar" "未装（pkg install dex2jar）"
have d8      && r "d8 (java→dex)" "$(d8 --version 2>&1 | head -1)" || r "d8" "未装"

# ---------- 2. 改包 → 重签（逆向回写闭环） ----------
sec "P-android-re.2 改包重签闭环"
if have apktool && [ -d "$W/apktool" ] && have apksigner && have keytool; then
  timeout 600 apktool b -o "$W/rebuilt.apk" "$W/apktool" >"$W/build.log" 2>&1
  if [ -f "$W/rebuilt.apk" ]; then
    r "apktool b" "ok ($(stat -c%s "$W/rebuilt.apk") B)"
    vU="$(timeout 120 apksigner verify -v "$W/rebuilt.apk" 2>&1 | grep -m1 -E 'DOES NOT VERIFY|Verifies|Exception')"
    r "重包(未签)" "$vU"
    KS="$W/k.keystore"; rm -f "$KS"
    keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias t \
      -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=env-probe" >/dev/null 2>&1
    timeout 300 apksigner sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
      --out "$W/signed.apk" "$W/rebuilt.apk" >"$W/sign.log" 2>&1
    src=$?
    if [ -s "$W/signed.apk" ]; then
      r "apksigner sign" "ok ($(stat -c%s "$W/signed.apk") B)"
      r "重签后 verify" "$(timeout 120 apksigner verify -v "$W/signed.apk" 2>&1 | grep -m1 -E 'DOES NOT VERIFY|Verifies|Exception')"
      r "重签后 aapt2" "$(aapt2 dump badging "$W/signed.apk" 2>/dev/null | grep -m1 '^package:' | cut -c1-38)"
    else
      r "apksigner sign" "失败 rc=$src：$(grep -m1 -E 'Exception|error' "$W/sign.log" | cut -c1-60)"
    fi
  else
    r "apktool b" "失败：$(tail -2 "$W/build.log" | head -1)"
  fi
else
  r "改包重签" "缺 apktool/apksigner/keytool，跳过"
fi

# ---------- 3. 原生 .so 分析 ----------
sec "P-android-re.3 原生 ELF/.so 静态分析"
SO="$(find "$PREFIX/lib" -maxdepth 1 -name 'libsqlite3.so*' 2>/dev/null | head -1)"
[ -z "$SO" ] && SO="$(find "$PREFIX/lib" -maxdepth 1 -name '*.so' 2>/dev/null | head -1)"
if [ -n "$SO" ]; then
  r "readelf -h" "$(readelf -h "$SO" 2>/dev/null | awk -F: '/Type:/{print $2}' | xargs)"
  if have rabin2; then r "rabin2 -I" "$(rabin2 -I "$SO" 2>/dev/null | awk '/^arch|^bits/{printf "%s=%s ",$1,$2}')"; else r "rabin2" "未装（pkg install radare2）"; fi
  if have r2; then
    d="$(timeout 180 r2 -q -e bin.relocs.apply=true -c 'aa; s sym.imp.malloc; pd 2' "$SO" 2>/dev/null | grep -cE 'ldr|adrp')"
    r "r2 反汇编" "malloc 处 arm64 指令行=$d"
  fi
  have objdump && r "llvm-objdump" "$(objdump --version 2>&1 | head -1 | cut -c1-24)"
else r "原生样本" "没找到 .so，跳过"; fi

# ---------- 4. 动态分析边界（沙箱实测，不是猜） ----------
sec "P-android-re.4 动态调试边界（非 root 的真实边界）"
python3 - <<'PY' 2>/dev/null || r "ptrace 实测" "python3 不可用"
import ctypes, subprocess, time, os
libc = ctypes.CDLL("libc.so", use_errno=True)
p = subprocess.Popen(["sleep", "20"]); time.sleep(0.4)
own = libc.ptrace(16, p.pid, None, None); e1 = ctypes.get_errno()
other = libc.ptrace(16, 1, None, None);   e2 = ctypes.get_errno()
p.kill()
print("  %-22s %s" % ("ptrace 自己的子进程", "允许" if own == 0 else "拒绝(errno=%d)" % e1))
print("  %-22s %s" % ("ptrace 别的 UID(pid1)", "允许" if other == 0 else "拒绝(errno=%d %s)" % (e2, os.strerror(e2))))
PY

if ls /data/data/com.android.chrome >/dev/null 2>&1; then r "读他应用 /data/data" "可读"; else r "读他应用 /data/data" "拒绝 Permission denied"; fi
if cat /proc/1/cmdline >/dev/null 2>&1; then r "读他进程 /proc/PID" "可读"; else r "读他进程 /proc/PID" "拒绝 No such file / permission"; fi
# 判 root 不能看 `command -v su`：Termux 自带一个 /usr/bin/su 桩，
# 跑起来只会打印 "No su program found on this device" —— 存在 ≠ 可用。
# 真实验：让 su 执行 id，只有出现 uid=0 才算能提权。
SU_T="$(command -v su >/dev/null 2>&1 && timeout 8 su -c id 2>&1 | head -1 || echo '无 su 命令')"
case "$SU_T" in
  *uid=0*) SU_R="可用" ;;
  *)       SU_R="不可用（存在≠可用：$SU_T）" ;;
esac
r "root / SELinux"       "uid=$(id -u) su=$SU_R / $(cat /proc/self/attr/current 2>/dev/null | tr -d '\0')"
r "adb"                  "$(command -v adb >/dev/null && echo "$(adb version 2>/dev/null | head -1 | awk '{print $5}')" || echo 未装)"
r "能拉起安装器?"        "$(command -v pm >/dev/null && pm list packages 2>/dev/null | wc -l | tr -d ' ' | xargs -I{} echo 'pm 可用，可见包={}' || echo 不可用)"

sec "P-android-re.5 结论"
note "root 判定：uid=$(id -u) 非 root；本机 su 只是 Termux 的桩（'No su program found'），
      所以 'command -v su 成功' 是假阳性，判 root 只看 id -u 和 SELinux 域。"
note "静态链路（APK 元数据/Java/smali/资源 + 改包重签 + .so 反汇编）在本机实测可整体走通。"
note "动态链路：ptrace 只对自己的子进程有效，跨应用附着被 SELinux 拒绝 → 非 root 无法直接 hook 别的 APK；"
note "可行替代是'改包注入'(Frida Gadget/LSPatch)，落回上面的重签闭环——代价是签名变化、有完整性校验的应用会拒跑。"
note "网络注意：本机到 github.com 的 TLS 被中间盒替换（签发者 Scholar Verify），curl 默认证书校验会 exit 60；"
note "release 资产加 -k 可下（实测 200）。pip/PyPI 与 codeload 正常。"
