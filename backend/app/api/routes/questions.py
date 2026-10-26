
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_owned_session
from app.models import DecisionResult
from app.rules_runtime import get_rules
from app.schemas import (
    AnswerRequest,
    AnswerResponse,
    BatchAnswerRequest,
    BatchAnswerResponse,
    QuestionsCatalogResponse,
    ResumeResponse,
    StopResponse,
)
from app.services import answer_service, question_service
from app.services.recompute import evaluate_and_snapshot, latest_echo, report_echo

router = APIRouter(prefix="/sessions/{sid}/questions", tags=["questions"])


@router.get("", response_model=QuestionsCatalogResponse)
def questions_catalog(session=Depends(require_owned_session), db: Session = Depends(get_db)):
    """按板块/轮次分组的问题目录（round 1 默认采集，round 2 由结果页引导进入）。"""
    offers_data = question_service.load_offers_data(db, session)
    return QuestionsCatalogResponse(
        data=question_service.questions_catalog_payload(get_rules(), offers_data, phase=session.phase)
    )

@router.post("/answers/batch", response_model=BatchAnswerResponse)
def answers_batch(
    body: BatchAnswerRequest,
    session=Depends(require_owned_session),
    db: Session = Depends(get_db),
):
    """批量提交多题草稿（「生成对比报告」路径）。

    单事务逐题校验+写入、只重算一次、只落一条快照；任一题校验失败
    整批拒绝（零写入），错误 details 附 question_key。单题端点保留，
    供个别编辑继续使用。
    """
    payload = answer_service.submit_answers_batch(db, session, body.items, rules=get_rules())
    return BatchAnswerResponse(**payload)


@router.post("/{question_key}/answers", response_model=AnswerResponse)
def answer_question(
    # max_length：field_key 同款上限。question_key 不在目录内时 404 文案会
    # 回显路径参数原文，入口截断避免超长 URL 被放大进错误响应。
    question_key: Annotated[str, Path(max_length=100)],
    body: AnswerRequest,
    session=Depends(require_owned_session),
    db: Session = Depends(get_db),
):
    payload = answer_service.submit_answers(db, session, question_key, body, rules=get_rules())
    return AnswerResponse(**payload)


@router.post("/resume", response_model=ResumeResponse)
def resume_questions(session=Depends(require_owned_session), db: Session = Depends(get_db)):
    """撤销「查看对比结果」状态，回到信息补全。"""

    if session.phase not in {"results", "completion"}:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "invalid_phase",
                "message": "当前会话还没有进入可恢复的补全阶段",
                "details": {"phase": session.phase},
            },
        )
    if session.phase != "completion":
        session.phase = "completion"
        db.commit()

    return ResumeResponse(
        data={"phase": "completion"},
        decision=latest_echo(db, session),
    )


@router.post("/stop", response_model=StopResponse)
def stop_questions(session=Depends(require_owned_session), db: Session = Depends(get_db)):
    """完成本轮补全，进入结果对比（phase → results）。

    语义：stop 只写 phase 交互状态，绝不修改结论强度——sufficiency
    原样来自最新快照。任何后续写入会把 phase 自动退回 completion。
    例外：创建后未做任何写入的会话没有快照，直接放行会让结果页
    404——这里先评估一份基线快照。
    """
    has_snapshot = db.scalar(
        select(DecisionResult.seq)
        .where(DecisionResult.session_id == session.id)
        .limit(1)
    ) is not None
    if session.phase != "results":
        session.phase = "results"
    if not has_snapshot:
        _snapshot, seq = evaluate_and_snapshot(
            db, session, trigger_type="manual_stop", rules=get_rules()
        )
        echo = report_echo(_snapshot, seq)
    else:
        echo = latest_echo(db, session)
    db.commit()
    return StopResponse(data={"phase": "results"}, decision=echo)
