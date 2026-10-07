from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_owned_session
from app.rules_runtime import get_rules
from app.schemas import (
    OfferCreateRequest,
    OfferListResponse,
    OfferMutationResponse,
    OfferPatchRequest,
    OfferResetRequest,
)
from app.services import offer_service

router = APIRouter(prefix="/sessions/{sid}/offers", tags=["offers"])


@router.post("", response_model=OfferMutationResponse, status_code=201)
def create_offer(
    body: OfferCreateRequest,
    session=Depends(require_owned_session),
    db: Session = Depends(get_db),
):
    resource, echo = offer_service.create_offer(db, session, body, rules=get_rules())
    return OfferMutationResponse(data=resource, decision=echo)


@router.get("", response_model=OfferListResponse)
def list_offers(session=Depends(require_owned_session), db: Session = Depends(get_db)):
    return OfferListResponse(data=offer_service.list_offers(db, session))


@router.patch("/{oid}", response_model=OfferMutationResponse)
def patch_offer(
    oid: UUID,
    body: OfferPatchRequest,
    session=Depends(require_owned_session),
    db: Session = Depends(get_db),
):
    resource, echo = offer_service.patch_offer(db, session, oid, body, rules=get_rules())
    return OfferMutationResponse(data=resource, decision=echo)


@router.delete("/{oid}", response_model=OfferMutationResponse)
def delete_offer(
    oid: UUID,
    session=Depends(require_owned_session),
    db: Session = Depends(get_db),
):
    resource, echo = offer_service.delete_offer(db, session, oid, rules=get_rules())
    return OfferMutationResponse(data=resource, decision=echo)


@router.post("/{oid}/reset", response_model=OfferMutationResponse)
def reset_offer(
    oid: UUID,
    body: OfferResetRequest,
    session=Depends(require_owned_session),
    db: Session = Depends(get_db),
):
    resource, echo = offer_service.reset_offer(db, session, oid, body, rules=get_rules())
    return OfferMutationResponse(data=resource, decision=echo)
