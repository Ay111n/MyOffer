#!/usr/bin/env bash
# MyOffer 服务器配置（在目标服务器上以 root 执行，幂等可重跑）
#
#   ssh -i <key> root@<IP> 'bash /tmp/server-configure.sh'
#   ssh -i <key> root@<IP> 'HARDEN_SSH=1 bash /tmp/server-configure.sh'   # 额外关闭密码登录
#
# 前置：server-bootstrap.sh 已跑完（venv 与依赖就绪）
# 本脚本负责：.env → systemd → nginx → fail2ban 与主机基础加固
set -euo pipefail

APP=/srv/myoffer
APP_USER=myoffer
ENV_FILE=$APP/.env
# 必须显式设置（公网域名或 IP）：曾硬编码默认值为真实服务器 IP，
# 未设环境变量时会为"别人的 IP"生成 CORS 等配置
PUBLIC_HOST="${PUBLIC_HOST:?必须显式设置 PUBLIC_HOST（公网域名或 IP）}"
HARDEN_SSH="${HARDEN_SSH:-0}"
ADMIN_IP="${ADMIN_IP:-}"
PY="$APP/backend/.venv/bin/python"

log() { printf '\n== %s ==\n' "$*"; }

[[ -x "$PY" ]] || { echo "❌ venv 不存在，请先跑 server-bootstrap.sh" >&2; exit 1; }

log "0. 权限模型（nginx 要能读 out/）"
# /srv/myoffer 必须可被「其他用户」穿过（o+x），否则 nginx(www-data) 读不到 out/。
chmod 755 "$APP"
chmod 755 "$APP/out" "$APP/deploy"
find "$APP/out" -type d -exec chmod 755 {} +
find "$APP/out" -type f -exec chmod 644 {} +
chmod 644 "$APP/deploy"/*
chmod 750 "$APP/backend"          # 后端源码不需要对外可见
[[ -f $APP/.env ]] && chmod 600 "$APP/.env"
echo "   $APP=755  out=755/644  backend=750  .env=600"

log "1. 生成 $ENV_FILE"
if [[ -f $ENV_FILE ]]; then
  echo "   已存在，跳过（重建请先 rm $ENV_FILE）"
else
  # umask 077：含 SESSION_SECRET 的文件从创建起即 600，
  # 消除"先 644 写入、后 chmod 600"的窗口期
  (
    umask 077
    cat > "$ENV_FILE" <<EOF
# 由 deploy/server-configure.sh 生成于 $(date -Iseconds)
ENV=production
SESSION_SECRET=$(openssl rand -hex 32)
# ⚠️ 无域名/无证书阶段 Cookie 不受 TLS 保护：必须显式确认（config.py 护栏），
#    补上 HTTPS 后改为 COOKIE_SECURE=true 并删除本行
ALLOW_INSECURE_COOKIE=1
COOKIE_SECURE=false
CORS_ORIGINS=http://$PUBLIC_HOST
BACKEND_ORIGIN=http://127.0.0.1:8000
RATE_LIMIT_SESSIONS_PER_MINUTE=30
RATE_LIMIT_TELEMETRY_PER_MINUTE=30
SESSION_TTL_DAYS=2
MAX_SESSIONS=200
MAX_IDENTITIES=200
MEMORY_DB_MAX_MB=96
DB_GATE_TIMEOUT_SECONDS=8
LOG_LEVEL=INFO
TELEMETRY_ENABLED=false
TELEMETRY_RETENTION_HOURS=24
TELEMETRY_MAX_PER_SESSION=200
TELEMETRY_MAX_TOTAL=10000
EOF
  )
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "   已生成（SESSION_SECRET 为随机值）"
fi

log "2. systemd 服务"
install -m 644 "$APP/deploy/myoffer-backend.service" /etc/systemd/system/myoffer-backend.service
systemctl daemon-reload
systemctl enable myoffer-backend >/dev/null 2>&1 || true
systemctl restart myoffer-backend
sleep 4
echo -n "   myoffer-backend: "; systemctl is-active myoffer-backend
echo -n "   /healthz: "
code=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/healthz || true)
echo "${code:-000}"
if [ "$code" != "200" ]; then
  # 曾把启动失败降级为一行提示后继续打印"引导完成"——必须在此失败
  echo "   ❌ /healthz 未返回 200，后端未就绪；排查：journalctl -u myoffer-backend -n 50" >&2
  exit 1
fi
echo

log "6. nginx（静态前端 + /api 反向代理）"
install -m 644 "$APP/deploy/nginx-myoffer-static.conf" /etc/nginx/sites-available/myoffer
ln -sf /etc/nginx/sites-available/myoffer /etc/nginx/sites-enabled/myoffer
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
echo -n "   首页 HTTP 状态: "
curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 http://127.0.0.1/
echo -n "   API 反代状态: "
curl -s -o /dev/null -w "%{http_code}\n" --max-time 5 http://127.0.0.1/healthz

log "7. fail2ban（sshd 防爆破）"
# bootstrap 只装 nginx/python：fail2ban 缺失时必须就地安装——否则下方 restart
# 非零退出 + set -e 会静默跳过 7b/7c（防火墙）与 SSH 加固（实测踩坑）
if ! command -v fail2ban-client >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban
fi
mkdir -p /etc/fail2ban/jail.d
cat > /etc/fail2ban/jail.d/myoffer.local <<EOF
[DEFAULT]
# 管理入口加入白名单，避免误封自己的运维 IP（换网络后记得更新）
ignoreip = 127.0.0.1/8 ::1 ${ADMIN_IP:-127.0.0.1}

[sshd]
enabled = true
port = 22
maxretry = 4
findtime = 10m
bantime = 1h
EOF
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban || { echo "   ❌ fail2ban 启动失败，请排查 systemctl status fail2ban" >&2; exit 1; }
sleep 3
echo -n "   fail2ban: "; systemctl is-active fail2ban
fail2ban-client status sshd 2>/dev/null | sed -n '1,4p' || true

log "7b. 定时任务（磁盘告警 / 月度系统清理）"
cat > /etc/cron.d/myoffer <<'EOF'
# 磁盘使用率告警（≥85% 写入 syslog）
0 9 * * * root df --output=pcent / | tail -1 | tr -d ' %x' | awk '$1>=85{print "DISK ALERT: "$1"% used"}' | logger -t myoffer-disk
# 每月 1 日 04:15 清理 apt 缓存、旧内核与历史发布备份 out.*（保留最近 2 份）；
# 输出进 syslog（曾重定向到 /dev/null，清理失败无人知晓）
15 4 1 * * root bash /srv/myoffer/deploy/disk-hygiene.sh 2>&1 | logger -t myoffer-hygiene
EOF
chmod 644 /etc/cron.d/myoffer
echo "   已写入 /etc/cron.d/myoffer"

log "7c. 防火墙（ufw）"
ufw allow 22/tcp >/dev/null          # 先放行 SSH，避免自锁
ufw allow 80/tcp >/dev/null          # HTTP
# 只放行 22/80。云镜像常预装 xrdp(3389)，那是高频爆破目标——
# 若确认需要远控桌面，再单独 `ufw allow 3389/tcp` 并把 xrdp 打开。
ufw --force enable >/dev/null
ufw status | head -8

if [[ "$HARDEN_SSH" == "1" ]]; then
  log "8. SSH 加固（关闭密码登录，仅允许密钥）"
  install -d /etc/ssh/sshd_config.d
  # ⚠️ 必须用 00- 前缀：sshd_config 对同一关键字是「首次出现生效」，而 Ubuntu 云镜像
  # 自带 /etc/ssh/sshd_config.d/50-cloud-init.conf（含 PasswordAuthentication yes）。
  # 用 99- 前缀排在它后面 → 形同没写（本机实测踩过）。
  cat > /etc/ssh/sshd_config.d/00-myoffer-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  rm -f /etc/ssh/sshd_config.d/99-myoffer-hardening.conf
  if sshd -t; then
    systemctl reload ssh
    echo "   已关闭密码登录。生效校验："
    sshd -T 2>/dev/null | grep -iE "^(passwordauthentication|permitrootlogin|pubkeyauthentication)"
    echo "   回滚：rm /etc/ssh/sshd_config.d/00-myoffer-hardening.conf && systemctl reload ssh"
  else
    echo "   ❌ sshd 配置校验失败，已回滚该文件" >&2
    rm -f /etc/ssh/sshd_config.d/00-myoffer-hardening.conf
    exit 1
  fi
fi

log "9. swap 与内核参数（OOM 兜底）"
SWAP_SIZE="${SWAP_SIZE:-2G}"
if swapon --show | grep -q swapfile; then
  echo "   swap 已存在，跳过创建"
else
  fallocate -l "$SWAP_SIZE" /swapfile 2>/dev/null \
    || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo "   已创建并启用 $SWAP_SIZE swap"
fi
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

printf 'vm.swappiness=10\nvm.vfs_cache_pressure=50\n' > /etc/sysctl.d/99-myoffer.conf
# ⚠️ Ubuntu 的 `sysctl --system` 顺序是 sysctl.d/* 在前、**/etc/sysctl.conf 最后**，
#    所以写在 sysctl.d 里的 swappiness 会被 /etc/sysctl.conf 覆盖。
#    本机实测踩到：sysctl.d/99-myoffer.conf 写了 10，实际仍是云镜像预设的 0。
#    → 必须同时改 /etc/sysctl.conf。
[[ -f /etc/sysctl.conf ]] && \
  sed -i 's/^vm\.swappiness *= *[0-9]*/vm.swappiness = 10/' /etc/sysctl.conf
sysctl -q -w vm.swappiness=10 2>/dev/null || true
sysctl -q -w vm.vfs_cache_pressure=50 2>/dev/null || true
printf "   swappiness=%s  swap=%s\n" \
  "$(cat /proc/sys/vm/swappiness)" "$(swapon --show=SIZE --noheadings | tr -d ' ')"

log "10. 状态汇总"
df -h / | tail -1
free -m | head -2
echo -n "监听端口: "; ss -tlnp 2>/dev/null | awk '/LISTEN/ {print $4}' | tr '\n' ' '; echo
