import logging
from functools import lru_cache
from pathlib import Path

from app.config import get_settings
from app.rules_runtime.models import RuleSet
from app.rules_runtime.validate import (
    city_data_warnings,
    policy_expiry_warnings,
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
    # 数据新旧度 / 政策时效警告：不阻断启动，提醒复核过期参考数据与时点政策
    city_warnings = city_data_warnings(rules)
    if city_warnings:
        names = [warning.split()[1] for warning in city_warnings]
        logger.warning("city data staleness: %d cities (%s); review tools/city-data/MAINTENANCE.md",
                       len(names), ", ".join(names))
    for warning in policy_expiry_warnings(rules):
        logger.warning("policy expiry: %s", warning)
    return rules
