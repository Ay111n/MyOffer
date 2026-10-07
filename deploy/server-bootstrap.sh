#!/usr/bin/env bash
# MyOffer 服务器引导（在目标服务器上以 root 执行，幂等可重跑）
#
#   scp -i <key> deploy/server-bootstrap.sh root@<IP>:/tmp/
#   ssh -i <key> root@<IP> 'bash /tmp/server-bootstrap.sh'
#
# 只做「装依赖 + 建目录/用户 + venv + pip」，不碰 nginx/systemd 配置。
set -euo pipefail

APP=/srv/myoffer
APP_USER=myoffer
PYPI_MIRROR="${PYPI_MIRROR:-https://mirrors.aliyun.com/pypi/simple}"

echo "== 1. 用户与目录 =="
id "$APP_USER" >/dev/null 2>&1 || useradd -r -d "$APP" -s /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP"/{backend,out,deploy}
echo "   user=$(id -u "$APP_USER")  app=$APP"

echo "== 2. 运行依赖 =="
for c in nginx python3.12 node npm; do
  if ! command -v "$c" >/dev/null 2>&1; then
    echo "   ❌ 缺少 $c —— 请先配置软件源并安装该运行依赖" >&2
    exit 1
  fi
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19)) { console.error("Node.js 22.19+ is required for pi-ai"); process.exit(1); }'
echo "   python3.12=$(python3.12 --version)  nginx=$(nginx -v 2>&1 | cut -d/ -f2)"

echo "== 3. Python 虚拟环境 =="
if [[ ! -x "$APP/backend/.venv/bin/python" ]]; then
  python3.12 -m venv "$APP/backend/.venv"
  echo "   venv 已创建"
else
  echo "   venv 已存在，复用"
fi
PIP="$APP/backend/.venv/bin/pip"

echo "== 4. 安装 Python 依赖（镜像：$PYPI_MIRROR，版本锁 install）=="
# pip 与运行依赖全部锁版本：曾用 `--upgrade pip` + `>=` 下限——构建不可复现，
# 传递依赖随时间漂移。升级 = 更新 requirements-prod.lock 并显式提交（见文件头）。
"$PIP" install --no-cache-dir "pip==26.2.1" -i "$PYPI_MIRROR" >/dev/null
LOCK="$APP/deploy/requirements-prod.lock"
[[ -f "$LOCK" ]] || { echo "   ❌ 缺少 $LOCK（先同步 deploy/ 目录再重跑）" >&2; exit 1; }
"$PIP" install --no-cache-dir -i "$PYPI_MIRROR" -r "$LOCK" >/dev/null
echo "   已按 deploy/requirements-prod.lock 安装 $(grep -c '==' "$LOCK") 个锁定包"

echo "== 4b. 安装模型接入依赖 =="
AI_RUNTIME="$APP/backend/ai-runtime"
[[ -f "$AI_RUNTIME/package-lock.json" ]] || { echo "   ❌ 缺少 $AI_RUNTIME/package-lock.json（先同步 AI 运行目录）" >&2; exit 1; }
(cd "$AI_RUNTIME" && npm ci --omit=dev --no-audit --no-fund)

echo "== 5. 权限与自检 =="
chown -R "$APP_USER:$APP_USER" "$APP"
chmod 750 "$APP"
"$APP/backend/.venv/bin/python" - <<'PY'
import importlib
for m in ("fastapi", "uvicorn", "pydantic", "pydantic_settings", "sqlalchemy",
          "yaml"):
    importlib.import_module(m)
print("   ✅ 全部依赖可导入")
PY
"$APP/backend/.venv/bin/python" --version
du -sh "$APP/backend/.venv"
echo "== 引导完成 =="
