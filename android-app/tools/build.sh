#!/data/data/com.termux/files/usr/bin/bash
# Build, sign and (optionally) install the DSH Android shell app — entirely on-device.
#
#   ./build.sh            build ./out/dsh.apk
#   ./build.sh --install  build, then hand the APK to the system package installer
#
# Requires (pkg install): aapt2 apksigner d8 openjdk-17
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
out="$root/out"
gen="$out/gen"
obj="$out/obj"
dex="$out/dex"
android_jar="$here/android.jar"

for tool in aapt2 javac d8 apksigner keytool; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "缺少工具 $tool —— 先跑：pkg install aapt2 apksigner d8 openjdk-17" >&2
        exit 1
    }
done
[ -f "$android_jar" ] || { echo "缺少 $android_jar" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$gen" "$obj" "$dex"

echo "==> aapt2 compile"
aapt2 compile --dir "$root/res" -o "$out/res.zip"

echo "==> aapt2 link"
aapt2 link \
    -o "$out/base.apk" \
    -I "$android_jar" \
    --manifest "$root/AndroidManifest.xml" \
    --java "$gen" \
    --min-sdk-version 26 \
    --target-sdk-version 34 \
    --version-code 1 \
    --version-name 1.0 \
    "$out/res.zip"

echo "==> javac"
# -source/-target 8 keeps the class files inside d8's comfort zone; android.jar stands in
# for the JDK bootclasspath, which is what -bootclasspath is doing here.
mapfile -t sources < <(find "$gen" "$root/src" -name '*.java')
set +e
javac \
    -encoding UTF-8 \
    -source 8 -target 8 \
    -bootclasspath "$android_jar" \
    -classpath "$android_jar" \
    -d "$obj" \
    -nowarn \
    "${sources[@]}" >"$out/javac.log" 2>&1
javac_status=$?
set -e
grep -v '^warning: \[' "$out/javac.log" | grep -v '^Note: ' || true
if [ "$javac_status" -ne 0 ]; then
    echo "javac 失败（完整日志 $out/javac.log）" >&2
    exit 1
fi
[ -f "$obj/com/mermergi/dsh/MainActivity.class" ] || {
    echo "javac 没有产出 MainActivity.class" >&2
    exit 1
}

echo "==> d8"
mapfile -t classes < <(find "$obj" -name '*.class')
d8 --lib "$android_jar" --min-api 26 --output "$dex" "${classes[@]}"

echo "==> package"
cp "$out/base.apk" "$out/dsh-unsigned.apk"
if command -v zip >/dev/null 2>&1; then
    (cd "$dex" && zip -q -X "$out/dsh-unsigned.apk" classes.dex)
else
    python3 - "$out/dsh-unsigned.apk" "$dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
PY
fi

echo "==> sign"
keystore="$root/keystore.jks"
if [ ! -f "$keystore" ]; then
    keytool -genkeypair -v \
        -keystore "$keystore" \
        -alias dsh -keyalg RSA -keysize 2048 -validity 10950 \
        -storepass dshlocal -keypass dshlocal \
        -dname "CN=DSH App, OU=local, O=local, L=local, S=local, C=CN" >/dev/null
fi
apksigner sign \
    --ks "$keystore" --ks-key-alias dsh \
    --ks-pass pass:dshlocal --key-pass pass:dshlocal \
    --v1-signing-enabled true --v2-signing-enabled true \
    --out "$out/dsh.apk" "$out/dsh-unsigned.apk"
apksigner verify --print-certs "$out/dsh.apk" | head -4

# Keep the committed copy in step. It is what lets a fresh phone install without the 237 MB
# build toolchain (aapt2/apksigner/d8/openjdk-17), and having it tracked means `git status`
# shows the moment the two drift apart.
prebuilt_dir="$root/prebuilt"
mkdir -p "$prebuilt_dir"
cp "$out/dsh.apk" "$prebuilt_dir/dsh.apk"
echo "prebuilt -> $prebuilt_dir/dsh.apk ($(wc -c <"$prebuilt_dir/dsh.apk") bytes)"

ls -la "$out/dsh.apk"
echo "OK -> $out/dsh.apk"

if [ "${1:-}" = "--install" ]; then
    termux-open "$out/dsh.apk"
fi
