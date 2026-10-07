from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_owned_session
from app.models import DecisionResult
from app.rules_runtime import get_rules
from app.schemas import (
    HistoryResponse,
    ReportArchive,
    ResultResponse,
)
from app.schemas.ai import AiJobResponse, AiReportRequest
from app.services import conclusion as conclusion_service
from app.services.ai_report_service import analysis_payload
from app.services.ai_service import get_bridge
from app.services.rate_limit import enforce_rate_limit

router = APIRouter(prefix="/sessions/{sid}", tags=["results"])

# 结果页只接受 v0.8 报告口径快照；更早口径的快照不投影（结构不同）。
MIN_REPORT_SCHEMA_VERSION = 5


def _load_snapshot(row: DecisionResult):
    if int(row.payload.get("schema_version", 1)) < MIN_REPORT_SCHEMA_VERSION:
        raise HTTPException(
            status_code=409,
            detail={"code": "snapshot_schema_mismatch",
                    "message": "该快照是旧评分口径，返回信息补全页重新生成对比即可查看报告"},
        )
    from app.domain.contracts import DecisionSnapshot
    try:
        return DecisionSnapshot.model_validate(row.payload)
    except ValidationError as exc:
        # schema_version 合标但内容解析失败（历史脏数据/契约漂移）：
        # 返回 4xx 包络而非裸 500，与旧口径快照同等的降级路径
        raise HTTPException(
            status_code=409,
            detail={"code": "snapshot_corrupt",
                    "message": "该快照数据无法按当前报告口径解析，返回信息补全页重新生成对比即可查看报告"},
        ) from exc


def _get_snapshot_row(db: Session, session, seq: int | None = None) -> DecisionResult:
    stmt = select(DecisionResult).where(DecisionResult.session_id == session.id)
    if seq is not None:
        stmt = stmt.where(DecisionResult.seq == seq)
    else:
        stmt = stmt.order_by(DecisionResult.seq.desc()).limit(1)
    row = db.scalars(stmt).first()
    if row is None:
        target = f"seq={seq}" if seq is not None else "no snapshot yet"
        raise HTTPException(status_code=404,
                            detail={"code": "not_found", "message": f"Result not found ({target})"})
    return row


@router.get("/result", response_model=ResultResponse)
def latest_result(session=Depends(require_owned_session), db: Session = Depends(get_db)):
    # 只读最新快照 —— 本路由不调用 evaluate
    row = _get_snapshot_row(db, session)
    snapshot = _load_snapshot(row)
    return ResultResponse(data=conclusion_service.build_result_view(snapshot, get_rules(), row.seq))

@router.get("/results/history", response_model=HistoryResponse)
def result_history(
    limit: int = Query(50, ge=1, le=200),  # ge=1：PG 对负 LIMIT 直接抛错变 500
    session=Depends(require_owned_session),
    db: Session = Depends(get_db),
):
    # SQL 层只取 outputs 头部（ranking / overall_scores），不搬全量快照 payload
    outputs_col = DecisionResult.payload["outputs"].label("outputs")
    rows = db.execute(
        select(
            DecisionResult.seq,
            DecisionResult.created_at,
            DecisionResult.trigger_type,
            outputs_col,
        )
        .where(DecisionResult.session_id == session.id)
        .order_by(DecisionResult.seq.desc())
        .limit(limit)
    ).all()
    return HistoryResponse(data=[
        conclusion_service.build_history_item(r.seq, r.created_at, r.trigger_type, r.outputs)
        for r in rows
    ])


@router.get("/results/{seq}", response_model=ResultResponse)
def result_by_seq(
    seq: int,
    session=Depends(require_owned_session),
    db: Session = Depends(get_db),
):
    # 历史快照 projection：只读取该 seq 的既有数据，不恢复旧状态、不重算
    row = _get_snapshot_row(db, session, seq)
    snapshot = _load_snapshot(row)
    return ResultResponse(data=conclusion_service.build_result_view(snapshot, get_rules(), row.seq))


@router.get("/report/export", response_model=ReportArchive)
def export_report(session=Depends(require_owned_session), db: Session = Depends(get_db)):
    from app.services.recompute import assemble_decision_input
    inp = assemble_decision_input(db, session, get_rules())
    return ReportArchive(inputs={"offers": [{"offer_id": offer.offer_id,
                                              "display_order": offer.display_order,
                                              "facts": offer.facts} for offer in inp.offers],
                                 "preferences": inp.preferences})


@router.post("/report/ai-analysis", response_model=AiJobResponse, status_code=202)
def start_ai_analysis(
    body: AiReportRequest,
    session=Depends(require_owned_session), db: Session = Depends(get_db),
):
    # Only the latest snapshot may start a new analysis. The model never writes
    # scores or facts; it receives a bounded projection of computed outputs.
    from app.api.routes.ai import _ai_limiter

    row = _get_snapshot_row(db, session)
    if row.seq != body.snapshot_seq:
        raise HTTPException(409, detail={"code": "stale_report",
                                         "message": "报告已更新，请刷新后再生成 AI 分析。"})
    snapshot = _load_snapshot(row)
    if len(snapshot.outputs.offers) < 2 or any(
        offer.overall_score is None for offer in snapshot.outputs.offers
    ):
        raise HTTPException(409, detail={"code": "report_incomplete",
                                         "message": "请先补齐各份 Offer 的基本信息并生成完整报告。"})
    enforce_rate_limit(_ai_limiter, str(session.user_id))
    return AiJobResponse(data=get_bridge().call(
        str(session.user_id), "analyze", {"report": analysis_payload(snapshot, row.seq), "part": body.part}
    ))
