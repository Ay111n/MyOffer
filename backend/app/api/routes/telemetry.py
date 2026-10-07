"""匿名事件上报。

POST /sessions/{sid}/telemetry：批量写入白名单事件。事件类型与 payload
键/值由 telemetry_service 白名单校验，违规 422；按会话限流。
只挂 require_owned_session——事件只能写入自己的会话，防止跨会话灌数据。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_db, require_owned_session
from app.config import get_settings
from app.schemas import TelemetryBatchRequest, TelemetryBatchResponse
from app.services import telemetry_service
from app.services.rate_limit import SlidingWindowLimiter, enforce_rate_limit

router = APIRouter(prefix="/sessions/{sid}/telemetry", tags=["telemetry"])


def _telemetry_limiter() -> SlidingWindowLimiter:
    return SlidingWindowLimiter(
        max_events=get_settings().rate_limit_telemetry_per_minute, window_seconds=60.0
    )


telemetry_rate_limiter = _telemetry_limiter()


@router.post("", response_model=TelemetryBatchResponse)
def record_events(
    body: TelemetryBatchRequest,
    session=Depends(require_owned_session),
    db: Session = Depends(get_db),
):
    enforce_rate_limit(telemetry_rate_limiter, str(session.id))
    try:
        accepted = telemetry_service.store_batch(
            db, session.id,
            [(e.event_type, e.payload, e.client_ts) for e in body.events],
        )
    except telemetry_service.TelemetryPayloadError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "validation_error", "message": str(exc), "details": {}},
        ) from exc
    db.commit()
    return TelemetryBatchResponse(data={"accepted": accepted})
