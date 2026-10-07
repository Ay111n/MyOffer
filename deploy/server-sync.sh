#!/usr/bin/env bash
# root 执行：server-sync.sh <已推送的40位提交> <本地静态构建tar.gz>
# 同步受版本控制的内容，保留现有依赖与私密环境；失败自动恢复发布前备份。
set -euo pipefail
umask 077
APP=/srv/myoffer
REVISION="${1:?missing commit}"
STATIC_ARCHIVE="${2:?missing static archive}"
REPOSITORY="${MYOFFER_REPOSITORY:-https://github.com/Ay111n/MyOffer.git}"
[[ "$REVISION" =~ ^[a-f0-9]{40}$ ]] || { echo 'invalid revision' >&2; exit 1; }
[[ -f "$STATIC_ARCHIVE" && -x "$APP/backend/.venv/bin/python" ]] || exit 1
STAMP=$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)
BACKUP="/srv/backups/myoffer/$STAMP"
STAGE=$(mktemp -d /srv/.myoffer-sync.XXXXXX)
mkdir -p "$BACKUP" "$STAGE/out"

cleanup() { rm -rf -- "$STAGE"; }
trap cleanup EXIT
git clone --quiet --branch master "$REPOSITORY" "$STAGE/source"
[[ "$(git -C "$STAGE/source" rev-parse HEAD)" == "$REVISION" ]] || {
  echo 'remote HEAD changed; refusing mismatched release' >&2; exit 1;
}
tar -xzf "$STATIC_ARCHIVE" -C "$STAGE/out"
[[ -f "$STAGE/out/index.html" ]] || exit 1

tar --exclude='./backend/.venv' --exclude='node_modules' --exclude='__pycache__' \
    --exclude='./.git' --exclude='./out.old-*' -czf "$BACKUP/tree.tar.gz" -C "$APP" .
cp /etc/systemd/system/myoffer-backend.service "$BACKUP/backend.service"
cp /etc/nginx/sites-available/myoffer "$BACKUP/nginx.conf"
# 旧部署若已有 Git 元数据，额外保留以便完整回滚。
if [[ -d "$APP/.git" ]]; then cp -a "$APP/.git" "$BACKUP/git"; fi
cp "$APP/.env" "$STAGE/source/.env"
python3 - "$STAGE/source/.env" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
settings = dict(SESSION_TTL_DAYS='2', MAX_SESSIONS='200', MAX_IDENTITIES='200',
                MEMORY_DB_MAX_MB='96', DB_GATE_TIMEOUT_SECONDS='8', LOG_LEVEL='INFO',
                TELEMETRY_ENABLED='false', TELEMETRY_RETENTION_HOURS='24',
                TELEMETRY_MAX_PER_SESSION='200', TELEMETRY_MAX_TOTAL='10000')
lines = [line for line in path.read_text().splitlines()
         if line.split('=', 1)[0].strip() not in settings]
path.write_text('\n'.join(lines + [f'{key}={value}' for key, value in settings.items()]) + '\n')
PY
(cd "$STAGE/source/backend" && "$APP/backend/.venv/bin/python" -c \
 'from app.config import get_settings; from app.main import app; s=get_settings(); assert s.env == "production"; assert s.max_sessions == 200; print("staged backend configuration valid")')
NEED_AI_INSTALL=0
if ! cmp -s "$APP/backend/ai-runtime/package-lock.json" "$STAGE/source/backend/ai-runtime/package-lock.json" \
    || [[ ! -d "$APP/backend/ai-runtime/node_modules/@earendil-works/pi-ai" ]]; then
  NEED_AI_INSTALL=1
  (cd "$STAGE/source/backend/ai-runtime" && npm ci --omit=dev --no-audit --no-fund)
fi

# APP 固定为既有部署目录；排除运行环境、秘密与静态目录，只同步源码树。
SYNC_EXCLUDES=(--exclude='.venv/' --exclude='node_modules/' --exclude='__pycache__/'
  --exclude='*.egg-info/' --exclude='.pytest_cache/' --exclude='.ruff_cache/'
  --exclude='.next/' --exclude='/out/' --exclude='/out.old-*' --exclude='frontend/out/'
  --include='.env.example' --exclude='.env' --exclude='.env.*'
  --exclude='test-results/' --exclude='playwright-report/' --exclude='.tmp-runtime/')
rollback() {
  trap - ERR
  echo "release failed; restoring $BACKUP" >&2
  systemctl stop myoffer-backend || true
  mkdir -p "$STAGE/rollback"
  tar -xzf "$BACKUP/tree.tar.gz" -C "$STAGE/rollback"
  rsync -a --delete "${SYNC_EXCLUDES[@]}" --exclude='.git/' "$STAGE/rollback/" "$APP/"
  cp "$STAGE/rollback/.env" "$APP/.env"
  rsync -a --delete "$STAGE/rollback/out/" "$APP/out/"
  if [[ -d "$BACKUP/git" ]]; then
    rsync -a --delete "$BACKUP/git/" "$APP/.git/"
  else
    rm -rf -- "$APP/.git"
  fi
  install -m 644 "$BACKUP/backend.service" /etc/systemd/system/myoffer-backend.service
  install -m 644 "$BACKUP/nginx.conf" /etc/nginx/sites-available/myoffer
  chown -R myoffer:myoffer "$APP"
  systemctl daemon-reload
  systemctl start myoffer-backend
  nginx -t && systemctl reload nginx
  exit 1
}
trap rollback ERR
systemctl stop myoffer-backend
rsync -a --delete "${SYNC_EXCLUDES[@]}" "$STAGE/source/" "$APP/"
install -m 600 "$STAGE/source/.env" "$APP/.env"
if [[ "$NEED_AI_INSTALL" == 1 ]]; then
  rsync -a --delete "$STAGE/source/backend/ai-runtime/node_modules/" "$APP/backend/ai-runtime/node_modules/"
fi
rsync -a --delete "$STAGE/out/" "$APP/out/"
printf '/out/\n/out.old-*/\n' >> "$APP/.git/info/exclude"
chown -R myoffer:myoffer "$APP"
chmod 755 "$APP" "$APP/out"
chmod 750 "$APP/backend"
find "$APP/out" -type d -exec chmod 755 {} +
find "$APP/out" -type f -exec chmod 644 {} +
install -m 644 "$APP/deploy/myoffer-backend.service" /etc/systemd/system/myoffer-backend.service
install -m 644 "$APP/deploy/nginx-myoffer-static.conf" /etc/nginx/sites-available/myoffer
nginx -t
systemctl daemon-reload
systemctl start myoffer-backend
for attempt in {1..15}; do
  if curl -fsS --max-time 2 http://127.0.0.1:8000/readyz >/dev/null; then break; fi
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:8000/readyz
systemctl reload nginx
curl -fsS --max-time 5 http://127.0.0.1/readyz
[[ "$(git -c safe.directory="$APP" -C "$APP" rev-parse HEAD)" == "$REVISION" ]]
[[ -z "$(git -c safe.directory="$APP" -C "$APP" status --porcelain)" ]]
echo "release=$REVISION backup=$BACKUP"
trap - ERR
