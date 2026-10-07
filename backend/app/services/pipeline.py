import hashlib
import json
from datetime import UTC, datetime
from uuid import UUID

from app.domain import DecisionInput, DecisionSnapshot, evaluate
from app.rules_runtime import RuleSet


def compute_snapshot(*, session_id:UUID, trigger_type:str, inp:DecisionInput, rules:RuleSet, computed_at:datetime|None=None)->DecisionSnapshot:
    outputs=evaluate(inp,rules)
    return DecisionSnapshot(session_id=session_id,computed_at=computed_at or datetime.now(UTC),rule_version=rules.version,trigger_type=trigger_type,inputs=inp,outputs=outputs, rules_digest=hashlib.sha256(json.dumps(rules.model_dump(mode="json"), sort_keys=True, ensure_ascii=False).encode()).hexdigest())
