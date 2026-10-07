"""规则镜像表同步。

fields.yaml / questions.yaml 是唯一事实源；field_defs / question_defs 仅承担
FK 引用完整性。部署或启动时 upsert 同步：新键插入、移除的键软删（active=false），
绝不物理删除（事务表对它们建 FK，RESTRICT）。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import FieldDef, QuestionDef
from app.rules_runtime.models import RuleSet


@dataclass
class SyncReport:
    fields_inserted: int = 0
    fields_updated: int = 0
    fields_deactivated: int = 0
    questions_inserted: int = 0
    questions_updated: int = 0
    questions_deactivated: int = 0


def sync_mirrors(db: Session, rules: RuleSet) -> SyncReport:
    report = SyncReport()
    now = datetime.now(UTC)
    version = rules.version

    # ── field_defs ──────────────────────────────────────────
    registry: dict = {k: v for k, v in rules.fields.items() if k != "meta"}
    existing = {fd.key: fd for fd in db.scalars(select(FieldDef))}
    for key, spec in registry.items():
        row = existing.get(key)
        values = dict(
            value_type=str(spec.get("value_type", "text")),
            unit=spec.get("unit"),
            scope=str(spec.get("scope", "offer")),
            required_level=str(spec.get("required_level", "normal")),
            metrics=list(spec.get("metrics", [])),
            active=True,
            synced_at=now,
            synced_rule_version=version,
        )
        if row is None:
            db.add(FieldDef(key=key, **values))
            report.fields_inserted += 1
        else:
            changed = any(getattr(row, col) != val for col, val in values.items())
            for col, val in values.items():
                setattr(row, col, val)
            if changed:
                report.fields_updated += 1
    for key, row in existing.items():
        if key not in registry and row.active:
            row.active = False
            report.fields_deactivated += 1

    # ── question_defs ───────────────────────────────────────
    catalog: dict = rules.questions.get("questions", {})
    existing_q = {qd.key: qd for qd in db.scalars(select(QuestionDef))}
    for key, spec in catalog.items():
        row = existing_q.get(key)
        values = dict(
            phase="initial",  # v0.6：单一目录，无 initial/dynamic 之分
            comparison_mode=str(spec.get("comparison_mode", "per_offer")),
            answer_type=str(spec.get("answer_type", "enum")),
            priority_class=None,
            answerability=None,
            active=True,
            synced_at=now,
            synced_rule_version=version,
        )
        if row is None:
            db.add(QuestionDef(key=key, **values))
            report.questions_inserted += 1
        else:
            changed = any(getattr(row, col) != val for col, val in values.items())
            for col, val in values.items():
                setattr(row, col, val)
            if changed:
                report.questions_updated += 1
    for key, row in existing_q.items():
        if key not in catalog and row.active:
            row.active = False
            report.questions_deactivated += 1

    return report


def ensure_rule_mirrors(db: Session, rules: RuleSet) -> None:
    """写路径前的惰性兜底（仅异常路径，不是正常初始化）。

    仅当启动同步未成功（runtime_state.rules_synced=False）时才真正执行，
    用独立短事务提交，绝不污染调用方事务。镜像缺失时 raw_facts/question_states
    的 FK 会失败——这里补齐后写入才可用。
    """
    import logging

    from app.services import runtime_state

    if runtime_state.rules_synced:
        return
    logger = logging.getLogger("offer.app")
    try:
        from app.db.session import get_session_factory

        with get_session_factory()() as sdb:
            sync_mirrors(sdb, rules)
            sdb.commit()
        runtime_state.rules_synced = True
        logger.info("rule mirrors lazily synced before first write")
    except Exception as exc:
        # 继续执行：后续 FK 失败会以统一 500 包络暴露真实问题
        logger.warning("lazy rule mirror sync failed: %s", exc)
