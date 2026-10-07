"""事实取值校验（fields.yaml 注册表为唯一词典）。

只校验"值是否符合字段声明"；unknown/need_confirmation 的状态语义
由问题作答端点管理，不在此处理。
"""
from __future__ import annotations

import math
import re
from typing import Any

from app.rules_runtime.models import RuleSet


class FactValidationError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# text 型事实的长度上限，避免事实字段接收过长输入。
# 校验层在此拦下，避免超大字符串进入临时事实、引擎和快照。
MAX_TEXT_FACT_LEN = 2_000

# 错误信息里的取值回显上限：超大输入不应被原样放大进 422 响应体。
_ECHO_LIMIT = 200


def _echo(value: Any) -> str:
    text = repr(value)
    return text if len(text) <= _ECHO_LIMIT else text[:_ECHO_LIMIT] + "…(truncated)"


def normalize_city_name(raw: Any) -> Any:
    """城市名规范化：去空白、去尾部「市」（与前端 normalizeCity 同口径）。

    前端在提交前已做同样的规范化；这里兜底直接 API 调用等
    未规范化入口，保证持久化值与 supported_cities 精确匹配口径一致。
    """
    if not isinstance(raw, str):
        return raw
    value = re.sub(r"\s+", "", raw.strip())
    while len(value) > 1 and value.endswith("市"):
        value = value[:-1]
    return value


def normalize_fact_value(rules: RuleSet, field_key: str, value: Any) -> Any:
    """按字段声明的 normalize 规则在写入/校验前规范化取值。

    当前仅 city 字段声明 normalize: city_name；未声明规范化规则的字段
    原样返回。返回值应替换原值参与校验与持久化。
    """
    spec = rules.fields.get(field_key) or {}
    if spec.get("normalize") == "city_name":
        return normalize_city_name(value)
    return value


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_finite(v: Any) -> bool:
    # Infinity/NaN 能通过 pydantic float，但会让 JSON 写入失败并污染引擎指标。
    # 超大整数（超出 float 表示范围）float() 抛 OverflowError 而非返回 inf，
    # 若放行会让边界比较处的 float(value) 以 500 漏出——统一按非法数值拒绝。
    if isinstance(v, int):
        try:
            return math.isfinite(float(v))
        except OverflowError:
            return False
    return math.isfinite(v)


def _unhashable(v: Any) -> bool:
    return isinstance(v, (dict, list))


def validate_fact_value(rules: RuleSet, field_key: str, value: Any) -> None:
    spec = rules.fields.get(field_key)
    if spec is None:
        raise FactValidationError("unknown_field", f"field '{field_key}' not in registry")
    vtype = spec.get("value_type", "text")

    if vtype == "enum":
        allowed = {o["value"] for o in spec.get("options", [])}
        try:
            ok = value in allowed
        except TypeError:
            # dict/list 等不可哈希值：JSON 合法但不是合法枚举，按 422 拒绝而非 500
            ok = False
        if not ok:
            raise FactValidationError(
                "invalid_option", f"value {_echo(value)} not allowed for enum field '{field_key}'"
            )
    elif vtype == "multi_enum":
        allowed = {o["value"] for o in spec.get("options", [])}
        if not isinstance(value, list) or any(
            _unhashable(v) or v not in allowed for v in value
        ):
            raise FactValidationError(
                "invalid_option", f"value {_echo(value)} not allowed for multi_enum field '{field_key}'"
            )
        # 重复项会让按出现次数求和的口径（专项附加扣除）双倍计入，直接拒绝
        if len(value) != len(set(value)):
            raise FactValidationError(
                "duplicate_option",
                f"value {_echo(value)} contains duplicate options for multi_enum field '{field_key}'",
            )
    elif vtype in ("money", "number", "percent"):
        if not _is_number(value) or not _is_finite(value):
            raise FactValidationError(
                "invalid_number", f"field '{field_key}' expects a finite number, got {_echo(value)}"
            )
        # 数值型事实在本域内不存在合法负值（工资/时长/比例）；字段可声明 min/max 收紧
        lower = spec.get("min", 0)
        upper = spec.get("max")
        if lower is not None and float(value) < float(lower):
            raise FactValidationError(
                "out_of_range", f"field '{field_key}' expects >= {lower}, got {_echo(value)}"
            )
        if upper is not None and float(value) > float(upper):
            raise FactValidationError(
                "out_of_range", f"field '{field_key}' expects <= {upper}, got {_echo(value)}"
            )
    elif vtype == "boolean":
        if not isinstance(value, bool):
            raise FactValidationError("invalid_boolean", f"field '{field_key}' expects true/false")
    elif vtype == "text":
        if not isinstance(value, str) or not value.strip():
            raise FactValidationError("invalid_text", f"field '{field_key}' expects non-empty text")
        if len(value) > MAX_TEXT_FACT_LEN:
            # 超长输入不回显值本身，避免 422 响应体被同样的超大输入放大
            raise FactValidationError(
                "invalid_text", f"field '{field_key}' text exceeds {MAX_TEXT_FACT_LEN} characters"
            )
        # allowed_from：城市 universe 之类的白名单字段。取值必须来自规则层
        # 定义的支持列表（引用不存在/为空由启动校验拦截，这里不误放行）。
        allowed_ref = spec.get("allowed_from")
        if allowed_ref:
            allowed = rules.reference_values(allowed_ref)
            if allowed and value not in allowed:
                raise FactValidationError(
                    "unsupported_city",
                    f"当前版本暂不支持该城市：{_echo(value)}（当前支持：{'、'.join(allowed)}）",
                )
    else:  # pragma: no cover - 注册表校验器保证 value_type 合法
        raise FactValidationError("invalid_value_type", f"unknown value_type '{vtype}'")
