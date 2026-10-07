"""匿名行为事件服务。

当前存储约束：
  - **只收白名单**：事件类型与 payload 键、值类型、长度全部白名单校验，
    超界即 422——用结构性约束保证"不采集 Offer 原文 / 事实值 / API Key"，
    而不是靠前端自觉。
  - 事件为追加型分析数据：session_id 无外键，不随会话级联删除。
  - 可统计指标包括步骤进入和完成、问题回答、事实修改、结果状态以及快照序号。
"""
from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import TelemetryEvent

#: 事件类型 → 允许的 payload 键 → 允许的值类型。
#: str 值统一限长 64（question_key / field_key / 状态枚举足够）；
#: list 仅接受 str 元素（answer_changed.field_keys，限 10 个）。
_EVENT_SCHEMA: dict[str, dict[str, set[type]]] = {
    "step_enter": {"step": {str}},
    "step_complete": {"step": {str}},
    "question_answered": {"question_key": {str}, "field_count": {int}},
    "answer_changed": {"question_key": {str}, "field_keys": {list}},
    "result_reached": {"snapshot_seq": {int}},
    "result_status": {"recommendation_status": {str}, "sufficiency_level": {str},
                      "coverage_tier": {str}, "snapshot_seq": {int},
                      # 前端 results 页实际上报字段（offer_id 的 UUID 排序头与候选数，
                      # 非 Offer 原文；缺省仍允许 None）。曾漏收这两个键导致整批 422。
                      "ranking_top": {str}, "offer_count": {int}},
}

_MAX_STR = 64
_MAX_LIST = 10
_MAX_KEYS = 8
# int 值上限：snapshot_seq / 计数远达不到该量级；拒绝天文数字，
# 防止畸形 int 写入 JSON 数值字段时触发存储层异常。
_MAX_INT = 10**15

# 事件为追加型数据且不随会话删除级联：不设保留窗口会让存储无界增长。
# 超过保留期的事件在批量写入路径按时间窗节流清理（最多每 10 分钟一次）。
_PRUNE_INTERVAL_SECONDS = 600.0
_last_prune_monotonic = 0.0


def _prune_expired(db: Session) -> None:
    global _last_prune_monotonic
    now = time.monotonic()
    if now - _last_prune_monotonic < _PRUNE_INTERVAL_SECONDS:
        return
    _last_prune_monotonic = now
    # created_at 由数据库 CURRENT_TIMESTAMP 生成（naive UTC），cutoff 同口径
    cutoff = datetime.now(UTC).replace(tzinfo=None) - timedelta(
        hours=get_settings().telemetry_retention_hours)
    db.execute(delete(TelemetryEvent).where(TelemetryEvent.created_at < cutoff))


class TelemetryPayloadError(ValueError):
    """payload 不符合白名单——422 拒绝，让前端 bug 直接暴露。"""


def _check_value(key: str, value) -> None:
    if value is None:
        return
    if isinstance(value, bool):
        return
    if isinstance(value, int):
        if abs(value) > _MAX_INT:
            raise TelemetryPayloadError(f"payload.{key}: 数值超限")
        return  # snapshot_seq / 计数本身不敏感
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise TelemetryPayloadError(f"payload.{key}: 非有限数值")
        return
    if isinstance(value, str):
        if len(value) > _MAX_STR:
            raise TelemetryPayloadError(f"payload.{key}: 字符串超 { _MAX_STR} 字符")
        return
    if isinstance(value, list):
        if len(value) > _MAX_LIST:
            raise TelemetryPayloadError(f"payload.{key}: 列表超 {_MAX_LIST} 项")
        for item in value:
            if not isinstance(item, str) or len(item) > _MAX_STR:
                raise TelemetryPayloadError(f"payload.{key}: 列表元素必须为 ≤{_MAX_STR} 字符的字符串")
        return
    raise TelemetryPayloadError(f"payload.{key}: 不允许的类型 {type(value).__name__}")


def validate_event(event_type: str, payload: dict) -> dict:
    """校验并返回净化后的 payload；违规抛 TelemetryPayloadError。"""
    schema = _EVENT_SCHEMA.get(event_type)
    if schema is None:
        raise TelemetryPayloadError(f"未知事件类型: {event_type}")
    if len(payload) > _MAX_KEYS:
        raise TelemetryPayloadError(f"{event_type}: payload 键数超 {_MAX_KEYS}")
    unknown = set(payload) - set(schema)
    if unknown:
        raise TelemetryPayloadError(f"{event_type}: 不允许的 payload 键 {sorted(unknown)}")
    for key, value in payload.items():
        allowed = schema[key]
        if value is None:
            continue
        if isinstance(value, bool) and bool not in allowed:
            raise TelemetryPayloadError(f"{event_type}.{key}: 值类型不允许")
        if not isinstance(value, bool) and type(value) not in allowed:
            raise TelemetryPayloadError(f"{event_type}.{key}: 值类型不允许")
        _check_value(key, value)
    return payload


def store_batch(
    db: Session, session_id: UUID | None, events: list[tuple[str, dict, datetime | None]],
) -> int:
    """批量落库；单个事件校验失败抛 TelemetryPayloadError（整批拒绝，原子性）。"""
    # 先校验后清理：prune 的 DELETE 与写入同事务，放在校验之前会随无效
    # 批次的 422 一起回滚，保留窗口内的清理被无限推迟。
    rows = []
    for event_type, payload, client_ts in events:
        clean = validate_event(event_type, payload)
        rows.append(TelemetryEvent(
            session_id=session_id, event_type=event_type,
            payload=clean, client_ts=client_ts, created_at=datetime.now(UTC).replace(tzinfo=None),
        ))
    _prune_expired(db)
    if not get_settings().telemetry_enabled:
        return 0
    db.add_all(rows)
    db.flush()
    settings = get_settings()
    for condition, limit in (
        (TelemetryEvent.session_id == session_id, settings.telemetry_max_per_session),
        (True, settings.telemetry_max_total),
    ):
        oldest = select(TelemetryEvent.id).where(condition).order_by(
            TelemetryEvent.created_at.desc(), TelemetryEvent.id.desc()).offset(limit)
        db.execute(delete(TelemetryEvent).where(TelemetryEvent.id.in_(oldest)))
    return len(rows)
