# 假设：本机光栅化器渲染的结果，可以用来验证 SVG 动画
# 实验：正例(动画终点)/负例(动画起点)两个参照 + 动画样本，看测量能否区分
sec "P-svg. 光栅化器是否执行动画（对照实验）"
r() { printf '  %-16s %s\n' "$1" "$2"; }
[ -d "$NM/node_modules/sharp" ] || { r "sharp" "不可用，跳过"; exit 0; }
P="$WORK/svg"; mkdir -p "$P"
cat > "$P/probe.mjs" <<'EOF'
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const sharp = createRequire(process.argv[2] + '/')('sharp');
const H = (b) => `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="20">${b}</svg>`;
const rect = (a) => H(`<rect ${a} y="0" width="20" height="20" fill="#000"/>`);
const cases = {
  smil: {
    anim: H(`<rect x="0" y="0" width="20" height="20" fill="#000"><animate attributeName="x" from="0" to="40" dur="0.01s" begin="0s" fill="freeze"/></rect>`),
    on: rect('x="40"'), off: rect('x="0"') },
  css: {
    anim: H(`<style>@keyframes m{to{transform:translateX(40px)}}</style><rect x="0" y="0" width="20" height="20" fill="#000" style="animation:m 0.01s forwards"/>`),
    on: H(`<rect x="0" y="0" width="20" height="20" fill="#000" transform="translate(40,0)"/>`), off: rect('x="0"') }
};
const md5 = async (s) => { try { return crypto.createHash('md5').update(await sharp(Buffer.from(s)).raw().toBuffer()).digest('hex'); } catch (e) { return 'ERR:' + e.message.slice(0,30); } };
const out = {};
for (const [k, c] of Object.entries(cases)) {
  const [a, b, d] = await Promise.all([md5(c.anim), md5(c.on), md5(c.off)]);
  out[k] = (a === b && b === d) ? 'no-difference' : a === b ? 'honored' : a === d ? 'ignored' : 'unclear';
}
console.log(JSON.stringify(out));
EOF
R="$(node "$P/probe.mjs" "$NM" 2>&1 | tail -1)"
node -e '
const {createRequire}=require("module");
const s=createRequire(process.argv[1]+"/")("sharp");
const v=s.versions;
console.log("  后端              "+(v.emscripten?"WASM (emscripten "+v.emscripten+")":"原生")+(v.resvg?"  | SVG: resvg "+v.resvg:""));
' "$NM" 2>/dev/null
r "SMIL 动画" "$(printf '%s' "$R" | sed -n 's/.*"smil":"\([a-z-]*\)".*/\1/p')"
r "CSS 动画"  "$(printf '%s' "$R" | sed -n 's/.*"css":"\([a-z-]*\)".*/\1/p')"
case "$R" in
  *'"smil":"ignored"'*) printf '  - %s\n' "本机光栅化器忽略 SMIL：不能拿它验证动画，必须逐帧求值写回基属性再渲染" >> "$NOTES" ;;
esac
