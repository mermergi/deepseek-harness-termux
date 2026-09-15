# 假设：装了 curl/wget 就代表"能联网"
# 实验：真的发一次请求（DNS+TCP+TLS 全链路），并检查代理变量
sec "P-net. 出站网络（真实请求，不看有没有 curl）"
have() { command -v "$1" >/dev/null 2>&1; }
r() { printf '  %-16s %s\n' "$1" "$2"; }
r "代理变量" "http_proxy=${http_proxy:-无} https_proxy=${https_proxy:-无} all_proxy=${all_proxy:-无}"
if have curl; then
  code="$(curl -sS -o /dev/null -m 8 -w '%{http_code}' https://example.com 2>"$WORK/curlerr")"
  if [ "$code" = 200 ]; then r "HTTPS 请求" "ok (200), $(curl -sS -o /dev/null -m 8 -w '%{time_total}s' https://example.com 2>/dev/null)"
  else r "HTTPS 请求" "失败 code=${code:-none} $(head -c 60 "$WORK/curlerr" 2>/dev/null)"; fi
  ip="$(curl -sS -o /dev/null -m 6 -w '%{remote_ip}' https://example.com 2>/dev/null)"
  r "DNS 解析" "${ip:-失败}"
else r "curl" "不存在，改用 wget"
  wget -q -T 8 -O /dev/null https://example.com && r "HTTPS 请求" "ok" || r "HTTPS 请求" "失败"
fi
