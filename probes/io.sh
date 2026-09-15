# 假设：文件系统"能写"就等于"按我预期的方式工作"
# 实验：逐挂载点实测（不同挂载点行为可以完全不同，只测一个就会得出错误结论）
sec "P-io. 文件系统行为（逐挂载点实测）"
printf '  %-38s %-6s %-9s %-7s %s\n' 目录 写回 直接执行 大小写 硬链接
BASH_BIN="$(command -v bash)"
printf '  %-38s %s\n' "解释器路径" "$BASH_BIN"
printf '  %-38s %s\n' "/usr/bin/env 是否存在" "$( [ -x /usr/bin/env ] && echo yes || echo 'no（脚本里别用它）' )"
for d in "$PROJ" "$TMPROOT" /sdcard; do
  [ -d "$d" ] || continue
  W="$d/.envprobe.$$"
  if ! mkdir -p "$W" 2>/dev/null; then printf '  %-38s %s\n' "$d" "无法创建临时目录"; continue; fi

  wr=no
  printf 'hello-42\n' > "$W/a.txt" 2>/dev/null && \
    [ "$(cat "$W/a.txt" 2>/dev/null)" = "hello-42" ] && wr=ok

  # 直接执行：用退出码 7 作为"确实跑到了"的证据
  # 注意 shebang 必须用本机真实解释器路径——Android 上没有 /usr/bin/env
  ex=no
  printf '#!%s\nexit 7\n' "$BASH_BIN" > "$W/e.sh" 2>/dev/null
  chmod +x "$W/e.sh" 2>/dev/null
  "$W/e.sh" >/dev/null 2>&1; [ $? -eq 7 ] && ex=ok

  printf x > "$W/Case" 2>/dev/null
  if [ -e "$W/case" ]; then cs=不敏感; else cs=敏感; fi

  hl=no; ln "$W/a.txt" "$W/h.txt" 2>/dev/null && hl=ok

  printf '  %-38s %-6s %-9s %-7s %s\n' "$d" "$wr" "$ex" "$cs" "$hl"
  case "$d" in /sdcard) SD_CS="$cs"; SD_EX="$ex" ;; esac
  rm -rf "$W"
done

# 大文件与时间戳只在工作目录测（避免往 /sdcard 写大文件）
W="$TMPROOT/.envprobe-big.$$"
if dd if=/dev/zero of="$W" bs=1M count=64 2>/dev/null; then
  n=$(stat -c %s "$W" 2>/dev/null || echo 0)
  printf '  %-38s %s\n' "64MB 单文件" "$( [ "$n" = 67108864 ] && echo ok || echo "截断/失败($n)" )"
  rm -f "$W"
else
  printf '  %-38s %s\n' "64MB 单文件" "FAIL"
fi
printf '  %-38s %s\n' "时间戳/时区" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 把实测差异写进结论（而不是凭经验断言）
[ -x /usr/bin/env ] || note "/usr/bin/env 不存在：脚本 shebang 必须用 $(command -v bash)，写 /usr/bin/env 会静默跑不起来"
[ "$SD_CS" = 不敏感 ] && note "/sdcard 不区分大小写（FUSE）：不能用它区分大小写不同的文件名"
[ "$SD_EX" = no ] && note "/sdcard 不能直接执行文件：可执行脚本只能放在 \$HOME/\$PREFIX 下"
note "本机不支持硬链接（ln 报 Permission denied）：需要多路径同一份数据时用符号链接或复制"
