#!/usr/bin/env bash
# MyOffer 服务器磁盘卫生（40G 盘 / 可用 20G+ 场景）
#
#   sudo bash deploy/disk-hygiene.sh          # 只清理缓存类，安全
#   sudo bash deploy/disk-hygiene.sh --dry    # 只报告，不动手
#
# 这个脚本只清缓存、孤儿包与过期发布备份，不碰代码、不碰日志正文。
# 建议挂 cron 每月一次；每次执行后看最后的 df 报告。

set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry" ]] && DRY=1

run() {
  if [[ $DRY -eq 1 ]]; then echo "  [dry] $*"; else echo "  [run] $*"; "$@"; fi
}

echo "== 清理前 =="
df -h / | tail -1

echo
echo "== 1. apt 缓存 + 孤儿包（含旧内核，Ubuntu 上最常见的磁盘黑洞）=="
echo "   每个残留旧内核约 300–500 MB"
run apt-get -y autoremove --purge
run apt-get -y clean
if [[ $DRY -eq 0 ]]; then
  apt-get -y autoclean >/dev/null 2>&1 || true
fi

echo
echo "== 2. pip 缓存（若安装时没用 --no-cache-dir，常有 100–300 MB）=="
run rm -rf /root/.cache/pip
run rm -rf /home/myoffer/.cache/pip

echo
echo "== 3. 误留在服务器上的前端构建产物（本方案不需要）=="
for d in /srv/myoffer/frontend/node_modules /srv/myoffer/frontend/.next /srv/myoffer/frontend/out; do
  if [[ -e "$d" ]]; then
    echo "  发现 $d （$(du -sh "$d" 2>/dev/null | cut -f1)）"
    echo "  ⚠️ 不自动删除。确认它不属于当前运行的发布产物后再手工处理。"
  fi
done

echo
echo "== 4. 历史发布备份 out.*（换 out/ 前的原子备份，静态构建可由 git 随时重建）=="
# 只匹配 out.*（out.old-* / out.pre-* / out.ab-* 等）；当前发布 out 不带点，永不匹配。
# 按 mtime 保留最近 OUT_KEEP 份用于回滚，其余删除。
OUT_KEEP="${OUT_KEEP:-2}"
mapfile -t out_backups < <(
  find /srv/myoffer -maxdepth 1 -type d -name 'out.*' -printf '%T@ %p\n' 2>/dev/null |
    sort -rn | cut -d' ' -f2- || true
)
if [[ ${#out_backups[@]} -le $OUT_KEEP ]]; then
  echo "  备份 ${#out_backups[@]} 份 ≤ 保留上限 $OUT_KEEP，无需清理"
else
  for p in "${out_backups[@]:0:$OUT_KEEP}"; do
    echo "  保留 $(basename "$p") （$(du -sh "$p" 2>/dev/null | cut -f1)）"
  done
  for p in "${out_backups[@]:$OUT_KEEP}"; do
    echo "  删除 $(basename "$p") （$(du -sh "$p" 2>/dev/null | cut -f1)）"
    run rm -rf "$p"
  done
fi

echo
echo "== 清理后 =="
df -h / | tail -1

echo
echo "== 阈值判读 =="
USED_PCT=$(df --output=pcent / | tail -1 | tr -d ' %')
echo "  根分区已用 ${USED_PCT}%"
if [[ "$USED_PCT" -ge 85 ]]; then
  echo "  ⚠️ 超过 85%：先清理缓存、旧内核和无用构建产物"
fi
