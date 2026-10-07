from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_owned_session
from app.rules_runtime import get_rules
from app.schemas import PreferenceMutationResponse, PreferencePutRequest, PreferenceResponse
from app.services import preference_service

router = APIRouter(prefix="/sessions/{sid}/preferences", tags=["preferences"])


@router.get("", response_model=PreferenceResponse)
def get_preferences(
    session=Depends(require_owned_session),
    db: Session = Depends(get_db),
):
    resource, echo = preference_service.get_preferences(db, session)
    return PreferenceResponse(data=resource, decision=echo)


@router.put("", response_model=PreferenceMutationResponse)
def put_preferences(
    body: PreferencePutRequest,
    session=Depends(require_owned_session),
    db: Session = Depends(get_db),
):
    resource, echo = preference_service.put_preferences(db, session, body, rules=get_rules())
    return PreferenceMutationResponse(data=resource, decision=echo)
