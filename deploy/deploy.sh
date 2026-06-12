#!/usr/bin/env bash
# 一键部署瑞幸定时下单 H5 到阿里云 ECS
# 访问地址：http://masion.xyz/ai/rx
#
# 用法：
#   bash deploy/deploy.sh
#
# 可选环境变量：
#   SERVER_USER   默认 root
#   SERVER_HOST   默认 47.112.168.59
#   SSH_PORT      默认 22
#   REMOTE_DIR    默认 /opt/luckin-scheduler-h5
#   LUCKIN_MCP_TOKEN  未设置时读取 ~/.my-coffee/LUCKIN_MCP_TOKEN

set -euo pipefail

SERVER_USER="${SERVER_USER:-root}"
SERVER_HOST="${SERVER_HOST:-47.112.168.59}"
SSH_PORT="${SSH_PORT:-22}"
REMOTE_DIR="${REMOTE_DIR:-/opt/luckin-scheduler-h5}"
if [[ -n "${SSHPASS:-}" ]] && command -v sshpass >/dev/null 2>&1; then
  SSH="sshpass -e ssh -p ${SSH_PORT} -o StrictHostKeyChecking=no ${SERVER_USER}@${SERVER_HOST}"
  RSYNC_SSH="sshpass -e ssh -p ${SSH_PORT} -o StrictHostKeyChecking=no"
else
  SSH="ssh -p ${SSH_PORT} ${SERVER_USER}@${SERVER_HOST}"
  RSYNC_SSH="ssh -p ${SSH_PORT}"
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

TOKEN="${LUCKIN_MCP_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$HOME/.my-coffee/LUCKIN_MCP_TOKEN" ]]; then
  TOKEN="$(tr -d '[:space:]' < "$HOME/.my-coffee/LUCKIN_MCP_TOKEN")"
fi
if [[ -z "$TOKEN" ]]; then
  echo "错误：未找到 LUCKIN_MCP_TOKEN。请设置环境变量或配置 ~/.my-coffee/LUCKIN_MCP_TOKEN"
  exit 1
fi

echo "==> [1/4] 测试 SSH 连接 ${SERVER_USER}@${SERVER_HOST}:${SSH_PORT}"
${SSH} "echo ok && uname -a"

echo "==> [2/4] 同步代码到 ${REMOTE_DIR}"
rsync -avz --delete \
  -e "${RSYNC_SSH}" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.DS_Store' \
  --exclude 'data/' \
  "${ROOT_DIR}/" \
  "${SERVER_USER}@${SERVER_HOST}:${REMOTE_DIR}/"

echo "==> [3/4] 远程安装依赖并启动服务"
${SSH} "REMOTE_DIR='${REMOTE_DIR}' TOKEN='${TOKEN}' bash -s" <<'REMOTE'
set -euo pipefail

install_node() {
  if command -v node >/dev/null 2>&1; then
    return
  fi
  if command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  elif command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    echo "请手动安装 Node.js 18+"
    exit 1
  fi
}

install_node
node -v

mkdir -p "${REMOTE_DIR}/data"
printf 'LUCKIN_MCP_TOKEN=%s\n' "${TOKEN}" > "${REMOTE_DIR}/.env"
chmod 600 "${REMOTE_DIR}/.env"

install -m 644 "${REMOTE_DIR}/deploy/luckin-scheduler.service" /etc/systemd/system/luckin-scheduler.service
systemctl daemon-reload
systemctl enable --now luckin-scheduler
systemctl restart luckin-scheduler

mkdir -p /etc/nginx/snippets
install -m 644 "${REMOTE_DIR}/deploy/nginx-location-rx.conf" /etc/nginx/snippets/luckin-rx.conf

inject_nginx_include() {
  local conf="$1"
  if grep -q 'snippets/luckin-rx.conf' "$conf" 2>/dev/null; then
    return 0
  fi
  if grep -q 'location /ai/rx/' "$conf" 2>/dev/null; then
    return 0
  fi
  awk '
    /^[[:space:]]*server[[:space:]]*\{/ { in_server=1 }
    in_server && /^[[:space:]]*\}/ && !done {
      print "    include /etc/nginx/snippets/luckin-rx.conf;"
      done=1
    }
    { print }
  ' "$conf" > "${conf}.tmp"
  mv "${conf}.tmp" "$conf"
}

NGINX_CONF=""
for candidate in /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/*; do
  [[ -f "$candidate" ]] || continue
  if grep -qE 'masion\.xyz|/var/www/ai-chat|root[[:space:]]+/var/www' "$candidate" 2>/dev/null; then
    NGINX_CONF="$candidate"
    break
  fi
done

if [[ -z "$NGINX_CONF" ]]; then
  for candidate in /etc/nginx/conf.d/*.conf; do
    [[ -f "$candidate" ]] || continue
    if grep -q 'listen[[:space:]]*80' "$candidate" 2>/dev/null; then
      NGINX_CONF="$candidate"
      break
    fi
  done
fi

if [[ -z "$NGINX_CONF" ]]; then
  echo "未找到 nginx 站点配置，请手动在 server {} 内加入："
  echo "    include /etc/nginx/snippets/luckin-rx.conf;"
  exit 1
fi

echo "写入 nginx include -> ${NGINX_CONF}"
inject_nginx_include "$NGINX_CONF"
nginx -t
systemctl reload nginx

sleep 1
curl -sf http://127.0.0.1:4173/api/health >/dev/null
echo "本地 Node 服务健康检查通过"
REMOTE

echo "==> [4/4] 验证公网访问"
HEALTH="$(curl -sf "https://masion.xyz/ai/rx/api/health" || curl -sf "http://masion.xyz/ai/rx/api/health" || true)"
if [[ -n "$HEALTH" ]]; then
  echo "$HEALTH"
  echo "✅ 部署完成：http://masion.xyz/ai/rx/"
else
  echo "⚠️  公网健康检查未通过，请登录服务器排查："
  echo "   systemctl status luckin-scheduler"
  echo "   curl http://127.0.0.1:4173/api/health"
fi
