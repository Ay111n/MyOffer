"""Build a bounded, score-only payload for the four AI report explanations."""
from __future__ import annotations

from app.domain.contracts import DecisionSnapshot


def analysis_payload(snapshot: DecisionSnapshot, seq: int) -> dict:
    outputs = snapshot.outputs
    return {
        "snapshot_seq": seq,
        "rule_version": snapshot.rule_version,
        "city_data_version": outputs.city_data_version,
        "buy_house_intent": snapshot.inputs.preferences.buy_house_intent,
        "weights": outputs.weights,
        "offers": [
            {
                "label": f"Offer {chr(65 + row.display_order - 1)}",
                "city": row.city,
                "city_data_as_of": row.city_data_as_of,
                "rank": row.overall_rank,
                "overall_score": row.overall_score,
                "dimension_scores": row.dimension_scores,
                "score_contributions": row.score_contributions,
                "sub_scores": row.sub_scores,
                "sub_metrics": row.sub_metrics,
                "missing_core": row.missing_core,
                "compliance_alert": row.compliance_alert,
            }
            for row in sorted(outputs.offers, key=lambda item: item.display_order)
        ],
    }
