#!/usr/bin/env bash
# MyOffer 启用 HTTPS（有域名 + 证书后执行一次）
#
#   DOMAIN=offer.example.com EMAIL=you@example.com bash deploy/enable-https.sh
#
# 前置条件（缺一不可）：
#   1. 有域名，且 A 记录已指向本机公网 IP（DNS 生效，dig 能查到本机 IP）
#   2. 80 端口可从公网访问（当前已满足）
#   3. ⚠️ 服务器在中国大陆：域名对外提供网站服务**需要 ICP 备案**，
#      未备案时多数云厂商会拦截 80/443。若无法备案，请继续用 IP 访问（HTTP）。
#
# 做四件事：签证书 → 换 TLS 版 nginx 站点 → 打开 COOKIE_SECURE → 验证
set -euo pipefail

DOMAIN="${DOMAIN:?必须提供 DOMAIN，例如 DOMAIN=offer.example.com}"
EMAIL="${EMAIL:?必须提供 EMAIL，用于证书到期提醒}"
APP=/srv/myoffer
ENV_FILE=$APP/.env
WEBROOT=/var/www/certbot

log() { printf '\n== %s ==\n' "$*"; }

log "1. DNS 校验"
resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
public_ip="$(curl -s --max-time 8 https://api.ipify.org || echo '')"
echo "   $DOMAIN → ${resolved:-未解析}"
echo "   本机公网 IP → ${public_ip:-获取失败}"
if [[ -z "$resolved" || ( -n "$public_ip" && "$resolved" != "$public_ip" ) ]]; then
  echo "   ❌ DNS 未指向本机，证书签发必然失败。请先修好 A 记录再执行。" >&2
  exit 1
fi

log "2. 安装 certbot 与验证目录"
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq certbot >/dev/null
mkdir -p "$WEBROOT"
chown -R www-data:www-data "$WEBROOT"

log "3. 签发证书（webroot 模式，不改动现有 nginx 配置）"
if [[ -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  echo "   已存在证书，执行续期检查"
  certbot renew --quiet --cert-name "$DOMAIN" || true
else
  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
    --email "$EMAIL" --agree-tos --no-eff-email --non-interactive
fi
ls -l "/etc/letsencrypt/live/$DOMAIN/" | head -6

log "4. 生成 TLS 版 nginx 站点"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
cat > /etc/nginx/sites-available/myoffer-tls <<EOF
# 由 deploy/enable-https.sh 生成（DOMAIN=$DOMAIN）
limit_req_zone \$binary_remote_addr zone=api:10m rate=10r/s;
limit_conn_zone \$binary_remote_addr zone=perip:10m;

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # ACME 续期验证必须留在 80
    location /.well-known/acme-challenge/ { root $WEBROOT; }

    location / { return 301 https://\$host\$request_uri; }
}

server {
    # 注意：用 listen 443 ssl http2 这种写法，而不是 http2 on 指令。
    # 后者需要 nginx 1.25.1+，而 Ubuntu 22.04 自带 1.18（实测）；
    # 前者在 1.18 与 1.25+ 上都能用（新版本只给 deprecated 警告）。
    # ⚠️ 本文件用未加引号的 heredoc 生成配置，注释里禁止出现反引号
    #    （会被 bash 当命令替换执行）。
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    # 1Mbps 链路上省掉重复 TLS 握手的 RTT
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1h;
    ssl_session_tickets off;

    root $APP/out;
    index index.html;
    client_max_body_size 2m;
    client_body_timeout 30s;
    limit_conn perip 16;

    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_vary on;
    gzip_proxied any;
    gzip_types text/plain text/css application/javascript application/json
               application/xml image/svg+xml font/woff2;
    # Brotli 需额外模块（apt install libnginx-mod-http-brotli-filter）；装了就取消注释
    # brotli on; brotli_comp_level 5;

    location /_next/static/ {
        # Cache-Control 已由 add_header 显式声明，再加 expires 会输出两条头
        add_header Cache-Control "public, max-age=31536000, immutable";
        access_log off;
        try_files \$uri =404;
    }
    location /assets/ {
        # Cache-Control 已由 add_header 显式声明，再加 expires 会输出两条头
        add_header Cache-Control "public, max-age=2592000";
        access_log off;
    }
    # add_header 不跨层继承：首页必须重复 server 级安全头（曾只写 Cache-Control）
    location = /index.html {
        add_header Cache-Control "no-cache";
        add_header X-Content-Type-Options nosniff always;
        add_header X-Frame-Options SAMEORIGIN always;
        add_header Referrer-Policy strict-origin-when-cross-origin always;
    }

    location /api/ {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 70s;
        proxy_send_timeout 70s;
    }
    location = /healthz { proxy_pass http://127.0.0.1:8000/healthz; access_log off; }
    location / { try_files \$uri \$uri.html \$uri/index.html /index.html; }

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
}
EOF
ln -sf /etc/nginx/sites-available/myoffer-tls /etc/nginx/sites-enabled/myoffer-tls
rm -f /etc/nginx/sites-enabled/myoffer      # 关掉 HTTP-only 站点
nginx -t && systemctl reload nginx

log "5. 打开 COOKIE_SECURE（HTTPS 之后必须置 true）"
if [[ -f $ENV_FILE ]]; then
  sed -i 's/^COOKIE_SECURE=false/COOKIE_SECURE=true/' "$ENV_FILE"
  grep -E '^(COOKIE_SECURE|CORS_ORIGINS)' "$ENV_FILE" | sed 's/^/   /'
  # CORS 也顺手换成 https
  sed -i "s#^CORS_ORIGINS=http://#CORS_ORIGINS=https://#" "$ENV_FILE"
  systemctl restart myoffer-backend
  sleep 3
  systemctl is-active myoffer-backend
fi

log "6. 验证"
echo -n "  https 首页: "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 "https://$DOMAIN/"
echo -n "  https /healthz: "; curl -s --max-time 10 "https://$DOMAIN/healthz"; echo
echo -n "  http→https 跳转: "; curl -s -o /dev/null -w "%{http_code} → %{redirect_url}\n" --max-time 10 "http://$DOMAIN/"
echo -n "  Cookie 是否带 Secure: "
curl -s -D - -o /dev/null -X POST "https://$DOMAIN/api/v1/sessions" \
  -H 'Content-Type: application/json' -d '{"title":"tls 验证"}' --max-time 10 \
  | grep -i "^set-cookie" | sed 's/^/    /'

log "7. 自动续期"
systemctl list-timers 'certbot*' --no-pager 2>/dev/null | head -3 || \
  echo "  （certbot 的 systemd timer 或 cron 由包自带，可 certbot renew --dry-run 验证）"
echo
echo "回滚到 HTTP：rm /etc/nginx/sites-enabled/myoffer-tls && ln -s /etc/nginx/sites-available/myoffer /etc/nginx/sites-enabled/myoffer && sed -i 's/^COOKIE_SECURE=true/COOKIE_SECURE=false/' $ENV_FILE && systemctl restart myoffer-backend && systemctl reload nginx"
