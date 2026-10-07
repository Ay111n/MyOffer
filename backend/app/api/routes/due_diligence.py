from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_owned_session
from app.rules_runtime import get_rules
from app.schemas import DueDiligencePatchRequest, DueDiligencePatchResponse, DueDiligenceResponse
from app.services import due_diligence_service

router = APIRouter(prefix="/sessions/{sid}/due-diligence", tags=["due-diligence"])


@router.get("", response_model=DueDiligenceResponse)
def list_due(session=Depends(require_owned_session), db: Session = Depends(get_db)):
    return due_diligence_service.list_items(db, session, rules=get_rules())


@router.patch("/{item_id}", response_model=DueDiligencePatchResponse)
def patch_due(
    item_id: UUID,
    body: DueDiligencePatchRequest,
    session=Depends(require_owned_session),
    db: Session = Depends(get_db),
):
    # 仅更新清单状态：不触发 evaluate、不新增快照（不影响决策结果）
    return DueDiligencePatchResponse(
        data=due_diligence_service.update_status(db, session, item_id, body.status, rules=get_rules())
    )
