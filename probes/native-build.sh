# 假设：装了 cc/gcc 就代表"能编译出可运行的原生程序"
# 实验：现场编译一段 C，运行它，检查退出码与输出（bionic 上这是最容易被高估的一环）
sec "P-native. 现场编译并运行（存在≠可用）"
have() { command -v "$1" >/dev/null 2>&1; }
r() { printf '  %-16s %s\n' "$1" "$2"; }
W="$WORK/native"; mkdir -p "$W"
cat > "$W/h.c" <<'EOF'
#include <stdio.h>
#include <stdlib.h>
int main(void){ printf("native-ok\n"); return 0; }
EOF
CC=""; for c in cc gcc clang; do have "$c" && { CC="$c"; break; }; done
if [ -z "$CC" ]; then r "C 编译器" "无（cc/gcc/clang 都没有）"; else
  r "C 编译器" "$CC"
  if "$CC" "$W/h.c" -o "$W/h" 2>"$WORK/ccerr"; then
    out="$("$W/h" 2>&1)"; rc=$?
    if [ "$out" = "native-ok" ] && [ "$rc" = 0 ]; then r "编译+运行" "ok"
    else r "编译+运行" "产物跑不起来 rc=$rc out=$out"; fi
  else r "编译+运行" "编译失败: $(head -c 70 "$WORK/ccerr")"; fi
  printf '#include <stdio.h>\nint main(){puts("cxx-ok");return 0;}\n' > "$W/h.cpp"
  CXX=""; for c in c++ g++ clang++; do have "$c" && { CXX="$c"; break; }; done
  if [ -n "$CXX" ] && "$CXX" "$W/h.cpp" -o "$W/hx" 2>/dev/null && [ "$("$W/hx" 2>&1)" = "cxx-ok" ]; then
    r "C++ 编译+运行" "ok ($CXX)"
  else r "C++ 编译+运行" "no"; fi
fi
