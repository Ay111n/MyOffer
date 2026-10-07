from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.services.sensitivity import compute_sensitivity

W = {"economic": 1 / 3, "growth": 1 / 3, "experience": 1 / 3}


def row(econ, growth, exp, overall=1.0):
    return SimpleNamespace(
        offer_id=uuid4(), overall_score=overall,
        dimension_scores={"economic": econ, "growth": growth, "experience": exp},
    )


def test_returns_none_when_not_rankable():
    a, b = row(50, 50, 50), row(60, 60, None)
    assert compute_sensitivity([a, b], W) is None
    c = row(50, 50, 50, overall=None)
    assert compute_sensitivity([c, row(50, 50, 50)], W) is None
    assert compute_sensitivity([row(50, 50, 50)], W) is None


def test_exact_tie_is_reported_as_tie():
    a, b = row(60, 60, 60), row(60, 60, 60)
    view = compute_sensitivity([a, b], W)
    assert view.status == "tie" and view.leader_id is None and not view.flips


def test_dominant_offer_is_stable_for_any_weights():
    a, b = row(90, 90, 90), row(40, 40, 40)
    view = compute_sensitivity([a, b], W)
    assert view.status == "stable"
    assert view.leader_id == a.offer_id
    assert view.nearest is None and view.flips == []


def test_close_trade_off_is_fragile_and_names_decisive_dimension():
    # A 经济强、体验弱；B 反之。当前几乎打平，轻微加重体验就会翻转给 B。
    a, b = row(80, 60, 40), row(40, 60, 79)
    view = compute_sensitivity([a, b], W)
    assert view.leader_id == a.offer_id
    assert view.status == "fragile"
    assert view.nearest is not None
    assert view.nearest.dimension in {"experience", "economic"}
    assert view.nearest.overtaken_by == b.offer_id
    assert abs(view.nearest.flip_weight - view.nearest.current_weight) < 0.10
    # 翻转点必须落在偏好界面允许的范围内
    for flip in view.flips:
        assert 0.05 - 1e-9 <= flip.flip_weight <= 0.90 + 1e-9


def test_large_gap_with_one_trade_off_is_steady_or_moderate():
    a, b = row(95, 60, 55), row(30, 60, 80)
    view = compute_sensitivity([a, b], W)
    assert view.leader_id == a.offer_id
    assert view.status in {"moderate", "steady"}
    by_key = {(f.dimension, f.direction): f for f in view.flips}
    # A 靠经济领先：调低经济或调高体验都会翻转；反方向只会让 A 更领先
    assert by_key[("economic", "down")].flip_weight < by_key[("economic", "down")].current_weight
    assert by_key[("experience", "up")].flip_weight > by_key[("experience", "up")].current_weight
    assert ("economic", "up") not in by_key and ("experience", "down") not in by_key
    # 成长分相同，调整它只是稀释其他维度，不应凭空产生翻转的结论以外的行为
    assert view.nearest is view.flips[0]
    assert all(abs(view.flips[i].flip_weight - view.flips[i].current_weight)
               <= abs(view.flips[i + 1].flip_weight - view.flips[i + 1].current_weight)
               for i in range(len(view.flips) - 1))


@pytest.mark.parametrize("weights", [
    {"economic": 0.7, "growth": 0.2, "experience": 0.1},
    {"economic": 0.05, "growth": 0.05, "experience": 0.9},
])
def test_handles_skewed_current_weights(weights):
    a, b = row(80, 60, 40), row(40, 60, 79)
    view = compute_sensitivity([a, b], weights)
    assert view is not None
    assert view.status in {"stable", "steady", "moderate", "fragile", "tie"}
