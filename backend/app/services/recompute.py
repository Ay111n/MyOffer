"""重算管线装配。

职责：进程内状态 → domain 契约（DecisionInput）→ evaluate → 临时快照。
本模块不实现任何决策逻辑；evaluate 是 domain 纯函数。

调用约定：请求必须持有全局 DbGate（StaticPool 单连接），
本模块在既有事务内追加快照并分配 seq。
"""
from __future__ import annotations

from pydantic import ValidationError
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.domain import (
    DecisionInput,
    DecisionSnapshot,
    OfferInput,
    RawFactInput,
    UserPreferenceInput,
)
from app.models import (
    DecisionResult,
    DecisionSession,
    Offer,
    RawFact,
    UserPreference,
)
from app.rules_runtime import RuleSet
from app.schemas import DecisionEcho
from app.services.pipeline import compute_snapshot

# 每个会话保留的快照数：每次写入都追加全量 payload（输入+输出），不设保留
# 窗口的话快照表随操作次数无界增长。历史接口按 seq 倒序读取，窗口够用。
SNAPSHOT_KEEP_PER_SESSION = 10


def reopen_completion(session: DecisionSession) -> None:
    """决策输入发生变化后，把结果阶段的会话退回信息补全。

    ``phase=results`` 表示用户已点击「查看对比结果」。只要用户修改了
    会影响决策的事实或偏好，就必须撤销这个状态；用户再次点击「查看
    对比结果」（POST /questions/stop）时才会回到 results。
    """

    if session.phase == "results":
        session.phase = "completion"


def _default_preferences(rules: RuleSet) -> UserPreferenceInput:
    # 未填写问卷时使用默认权重与默认购房意向。
    return UserPreferenceInput(weights=rules.default_weights(), source="default", buy_house_intent="consider")


def assemble_decision_input(db: Session, session: DecisionSession, rules: RuleSet) -> DecisionInput:
    offers_rows = db.scalars(
        select(Offer).where(Offer.session_id == session.id).order_by(Offer.display_order)
    ).all()
    offer_ids = [o.id for o in offers_rows]

    facts_by_offer: dict = {oid: {} for oid in offer_ids}
    if offer_ids:
        fact_rows = db.scalars(select(RawFact).where(RawFact.offer_id.in_(offer_ids))).all()
        for f in fact_rows:
            facts_by_offer[f.offer_id][f.field_key] = RawFactInput(
                field_key=f.field_key,
                value=f.value,
                status=f.status,
                source=f.source,
                reliability=float(f.reliability) if f.reliability is not None else None,
                version=f.version,
            )

    offer_inputs = [
        OfferInput(
            offer_id=o.id,
            company=o.company,
            position=o.position,
            display_order=o.display_order,
            facts=facts_by_offer[o.id],
        )
        for o in offers_rows
    ]

    pref_row = db.scalar(select(UserPreference).where(UserPreference.session_id == session.id))
    preferences = (
        UserPreferenceInput(
            weights={k: float(v) for k, v in pref_row.weights.items()},
            source=pref_row.source or "questionnaire",
            questionnaire_version=pref_row.questionnaire_version,
            answers=list(pref_row.answers or []),
            # 问卷尾部的购房意向情境题（不计权重）：随答案持久化，在此拆出供引擎消费
            buy_house_intent=next(
                (a.get("choice") for a in (pref_row.answers or [])
                 if isinstance(a, dict) and a.get("question_id") == "buy_house_intent"),
                "consider",
            ),
        )
        if pref_row
        else _default_preferences(rules)
    )

    return DecisionInput(
        offers=offer_inputs,
        preferences=preferences,
    )


def next_seq(db: Session, session_id) -> int:
    current = db.scalar(
        select(func.coalesce(func.max(DecisionResult.seq), 0)).where(
            DecisionResult.session_id == session_id
        )
    )
    return int(current) + 1


def evaluate_and_snapshot(
    db: Session, session: DecisionSession, trigger_type: str, rules: RuleSet
) -> tuple[DecisionSnapshot, int]:
    """在当前事务内 evaluate 并追加临时快照。调用方持有进程锁且负责提交。
    返回 (快照, seq)；快照 payload 与 DecisionSnapshot 契约逐字段一致。"""
    # get_session_factory() 使用 autoflush=False；所有写服务都会先在同一
    # 事务里修改/新增事实或偏好，再从进程内状态装配 DecisionInput。
    # 若不在这里统一 flush，快照会漏掉本次写入，导致结果页显示上一版决策。
    db.flush()
    inp = assemble_decision_input(db, session, rules)
    snapshot = compute_snapshot(
        session_id=session.id, trigger_type=trigger_type, inp=inp, rules=rules
    )
    seq = next_seq(db, session.id)
    db.add(
        DecisionResult(
            session_id=session.id,
            seq=seq,
            rule_version=snapshot.rule_version,
            snapshot_schema_version=snapshot.schema_version,
            trigger_type=trigger_type,
            payload=snapshot.model_dump(mode="json"),
        )
    )
    # 保留窗口外的历史快照随本次写入一并清理（同事务，原子生效）
    db.execute(
        delete(DecisionResult).where(
            DecisionResult.session_id == session.id,
            DecisionResult.seq <= seq - SNAPSHOT_KEEP_PER_SESSION,
        )
    )
    return snapshot, seq


def report_echo(snapshot: DecisionSnapshot, seq: int) -> DecisionEcho:
    """写入响应的报告摘要：综合评分排序头部 + 各 Offer 综合分。"""
    outputs = snapshot.outputs
    top = outputs.ranking[0] if outputs.ranking else None
    return DecisionEcho(
        snapshot_seq=seq,
        ranking_top_offer_id=top,
        overall_scores={str(oid): score for oid, score in (
            (r.offer_id, r.overall_score) for r in outputs.offers
        ) if score is not None},
        weights=dict(outputs.weights),
    )


def latest_echo(db: Session, session: DecisionSession) -> DecisionEcho:
    """从最新快照重建 echo（no-op mutation 不新增快照时使用）。

    旧口径快照（schema_version < 4）没有报告输出，返回空 echo；
    payload 损坏（历史脏数据）同样降级为空 echo——echo 只用于展示，
    不能把整条 mutation 拖成 500。"""
    row = db.scalars(
        select(DecisionResult)
        .where(DecisionResult.session_id == session.id)
        .order_by(DecisionResult.seq.desc())
        .limit(1)
    ).first()
    if row is None:
        return DecisionEcho(snapshot_seq=0)
    if int(row.payload.get("schema_version", 1)) < 5:
        return DecisionEcho(snapshot_seq=row.seq)
    try:
        snapshot = DecisionSnapshot.model_validate(row.payload)
    except ValidationError:
        return DecisionEcho(snapshot_seq=row.seq)
    return report_echo(snapshot, row.seq)
