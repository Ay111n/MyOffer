import logging
from functools import lru_cache
from pathlib import Path

from app.config import get_settings
from app.rules_runtime.models import RuleSet
from app.rules_runtime.validate import (
    CITY_DATA_STALE_MONTHS,
    policy_expiry_warnings,
    stale_city_entries,
    validate_rules,
)

logger = logging.getLogger(__name__)


class RuleValidationError(RuntimeError):
    """规则配置未通过启动不变量校验（fail-fast，拒绝启动）。"""


@lru_cache
def get_rules() -> RuleSet:
    settings = get_settings()
    root = Path(settings.rules_dir)
    if not root.is_absolute():
        # 相对路径默认相对 backend/ 目录（loader.py 位于 app/rules_runtime/ 下两级）
        root = Path(__file__).resolve().parents[2] / root
    rules = RuleSet.load(root)
    violations = validate_rules(rules)
    if violations:
        detail = "; ".join(violations)
        raise RuleValidationError(f"rule config failed startup invariants: {detail}")
    # 数据新旧度 / 政策时效警告：不阻断启动，提醒复核过期参考数据与时点政策。
    # 城市清单可能上百行，日志里只给条数与最旧锚点，完整清单走 make city-staleness。
    stale = stale_city_entries(rules)
    if stale:
        oldest_city, oldest_as_of, oldest_months = stale[0]
        logger.warning(
            "city data staleness: %d cities older than %d months (oldest: %s %s, %d months); "
            "full list: make city-staleness; review tools/city-data/MAINTENANCE.md",
            len(stale), CITY_DATA_STALE_MONTHS, oldest_city, oldest_as_of, oldest_months,
        )
    for warning in policy_expiry_warnings(rules):
        logger.warning("policy expiry: %s", warning)
    return rules
