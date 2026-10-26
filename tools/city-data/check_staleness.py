# -*- coding: utf-8 -*-
"""列出参考数据超过阈值未更新的城市，供数据复核排期（无需启动后端）。

口径与启动警告同源（app.rules_runtime.validate.stale_city_entries）：
逐城取 city_index.yaml 的 as_of，距今超过 CITY_DATA_STALE_MONTHS（14）个月
即入选，按月数降序。复核流程与记录格式见 tools/city-data/MAINTENANCE.md。

用法（仓库根目录）：
    backend/.venv/Scripts/python.exe tools/city-data/check_staleness.py
    backend/.venv/Scripts/python.exe tools/city-data/check_staleness.py --min-months 6
"""
import argparse
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app.rules_runtime.models import RuleSet  # noqa: E402
from app.rules_runtime.validate import CITY_DATA_STALE_MONTHS, stale_city_entries  # noqa: E402

RULES_DIR = REPO_ROOT / "backend" / "app" / "rules"


def main() -> int:
    parser = argparse.ArgumentParser(description="列出 as_of 超过阈值的城市（数据复核排期用）")
    parser.add_argument("--min-months", type=int, default=CITY_DATA_STALE_MONTHS,
                        help=f"阈值月数（默认 {CITY_DATA_STALE_MONTHS}，与启动警告一致）")
    parser.add_argument("--rules-dir", type=Path, default=RULES_DIR,
                        help="规则目录（默认 backend/app/rules）")
    args = parser.parse_args()

    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")

    rules = RuleSet.load(args.rules_dir)
    stale = [(ck, as_of, months) for ck, as_of, months in stale_city_entries(rules)
             if months > args.min_months]

    print(f"规则版本 {rules.version} · 阈值 {args.min_months} 个月 · 截至 {date.today().isoformat()}")
    if not stale:
        print("没有超过阈值的城市。")
        return 0

    width = max(len(ck) for ck, _, _ in stale)
    for ck, as_of, months in stale:
        print(f"  {ck:<{width}}  as_of {as_of}  （{months} 个月前）")
    print(f"\n共 {len(stale)} 个城市超过 {args.min_months} 个月未更新；"
          "复核流程与记录格式见 tools/city-data/MAINTENANCE.md。"
          "税费/公积金/房价须逐项核对官方公告后再改数值。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
