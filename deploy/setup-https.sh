#!/usr/bin/env bash
# 在 ECS 上为 masion.xyz 配置 Let's Encrypt HTTPS
# 用法：export SSHPASS='密码' && bash deploy/setup-https.sh
#
# 前置：
#   - 域名 A 记录 masion.xyz → 47.112.168.59
#   - 阿里云安全组入方向放行 80、443（443 未放行时外网 HTTPS 会超时）

set -euo pipefail

SERVER_USER="${SERVER_USER:-root}"
SERVER_HOST="${SERVER_HOST:-47.112.168.59}"
SSH_PORT="${SSH_PORT:-22}"
CERT_EMAIL="${CERT_EMAIL:-admin@masion.xyz}"
DOMAINS="${CERT_DOMAINS:-masion.xyz}"
SKIP_RENEW_TEST="${SKIP_RENEW_TEST:-0}"

if [[ -n "${SSHPASS:-}" ]] && command -v sshpass >/dev/null 2>&1; then
  SSH="sshpass -e ssh -p ${SSH_PORT} -o StrictHostKeyChecking=no ${SERVER_USER}@${SERVER_HOST}"
  RSYNC_SSH="sshpass -e ssh -p ${SSH_PORT} -o StrictHostKeyChecking=no"
else
  SSH="ssh -p ${SSH_PORT} ${SERVER_USER}@${SERVER_HOST}"
  RSYNC_SSH="ssh -p ${SSH_PORT}"
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

check_public_https() {
  if curl -sI --connect-timeout 8 "https://masion.xyz/ai/rx/api/health" 2>/dev/null | head -1 | grep -q 200; then
    return 0
  fi
  return 1
}

echo "==> [1/5] 上传 Nginx 站点配置"
rsync -avz -e "${RSYNC_SSH}" \
  "${ROOT_DIR}/deploy/nginx-masion.conf" \
  "${ROOT_DIR}/deploy/nginx-location-rx.conf" \
  "${SERVER_USER}@${SERVER_HOST}:/tmp/luckin-nginx/"

echo "==> [2/5] 安装 Certbot、写入 Nginx、放行本机防火墙"
${SSH} bash -s <<'REMOTE'
set -euo pipefail

if ! command -v certbot >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y certbot python3-certbot-nginx
  elif command -v yum >/dev/null 2>&1; then
    yum install -y certbot python3-certbot-nginx
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y certbot python3-certbot-nginx
  else
    echo "请手动安装 certbot 与 python3-certbot-nginx"
    exit 1
  fi
fi

if systemctl is-active firewalld >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http
  firewall-cmd --permanent --add-service=https
  firewall-cmd --reload
fi

mkdir -p /etc/nginx/snippets
install -m 644 /tmp/luckin-nginx/nginx-location-rx.conf /etc/nginx/snippets/luckin-rx.conf
install -m 644 /tmp/luckin-nginx/nginx-masion.conf /etc/nginx/conf.d/masion.conf

if [[ -f /etc/nginx/conf.d/ai-chat.conf ]]; then
  sed -i '/include \/etc\/nginx\/snippets\/luckin-rx.conf;/d' /etc/nginx/conf.d/ai-chat.conf
fi

nginx -t
systemctl reload nginx
REMOTE

echo "==> [3/5] 申请或续用证书（${DOMAINS}）"
DOMAIN_ARGS=""
for domain in ${DOMAINS}; do
  DOMAIN_ARGS="${DOMAIN_ARGS} -d ${domain}"
done

if ${SSH} "certbot certificates 2>/dev/null" | grep -q "VALID"; then
  echo "已有有效证书，重新部署 SSL 到 Nginx"
  ${SSH} "certbot install --cert-name masion.xyz --nginx --redirect --non-interactive 2>/dev/null || certbot --nginx ${DOMAIN_ARGS} --non-interactive --agree-tos -m '${CERT_EMAIL}' --redirect --reinstall"
else
  ${SSH} "certbot --nginx ${DOMAIN_ARGS} --non-interactive --agree-tos -m '${CERT_EMAIL}' --redirect"
fi

echo "==> [4/5] 服务器本地验证"
${SSH} "curl -sf https://127.0.0.1/ai/rx/api/health -k -H 'Host: masion.xyz'"

if [[ "${SKIP_RENEW_TEST}" != "1" ]]; then
  echo "==> [5/5] 测试证书自动续期（约 1–2 分钟，可 SKIP_RENEW_TEST=1 跳过）"
  ${SSH} "timeout 120 certbot renew --dry-run" || echo "⚠️  续期测试超时，证书已签发，可稍后在服务器执行：certbot renew --dry-run"
else
  echo "==> [5/5] 跳过续期测试"
fi

echo ""
if check_public_https; then
  echo "✅ HTTPS 已生效：https://masion.xyz/ai/rx/"
else
  echo "⚠️  服务器 HTTPS 已配置，但外网 443 暂不可达。"
  echo ""
  echo "请在阿里云控制台放行安全组 443："
  echo "  ECS → 实例 → 安全组 → 配置规则 → 入方向 → 添加"
  echo "  协议 TCP，端口 443，源 0.0.0.0/0"
  echo ""
  echo "放行后访问：https://masion.xyz/ai/rx/"
  echo "（HTTP 会自动 301 跳转到 HTTPS）"
fi
