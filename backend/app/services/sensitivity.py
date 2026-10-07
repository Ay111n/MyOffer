"""排名对「偏好权重」的敏感性。

只回答一个问题：如果用户对三个维度的看重程度和现在不同，排名第一会不会换人？

做法（纯函数，不读库、不重新评估输入）：
  - 取快照里每份 Offer 已算好的三维分 `dimension_scores`；
  - 逐个维度，把该维度的权重从当前值向两侧扫描（0.5% 一步，范围与偏好界面一致：
    每维 5%–90%）；另外两维按「各自超出 5% 下限的部分」成比例补齐到 100%，
    与前端手动调权重时的补齐规则相同；
  - 综合分沿用排名口径：加权和 + 1e-9 后保留一位小数，展示分相同即并列；
  - 当前第一名不再是唯一第一名的最近权重，就是该维度在该方向上的「翻转点」（上调/下调各至多一个）。

分级只用于措辞，阈值集中在下面的常量里。
"""
from __future__ import annotations

from app.schemas import SensitivityFlip, SensitivityView

DIMENSIONS = ("economic", "growth", "experience")
WEIGHT_MIN = 0.05
WEIGHT_MAX = 0.90
STEP = 0.005
# 最近翻转点离当前权重的距离（权重的绝对值，0.1 = 10 个百分点）
FRAGILE_BELOW = 0.10
MODERATE_BELOW = 0.20


def _rebalance(weights: dict[str, float], key: str, target: float) -> dict[str, float]:
    others = [k for k in DIMENSIONS if k != key]
    excess = [max(0.0, weights[k] - WEIGHT_MIN) for k in others]
    total = sum(excess)
    remaining = 1.0 - target - WEIGHT_MIN * len(others)
    shares = [e / total if total > 0 else 1 / len(others) for e in excess]
    out = {key: target}
    for k, share in zip(others, shares, strict=True):
        out[k] = WEIGHT_MIN + remaining * share
    return out


def _winners(scores: dict[object, dict[str, float]], weights: dict[str, float]) -> list[object]:
    shown = {oid: round(sum(s[k] * weights[k] for k in DIMENSIONS) + 1e-9, 1) for oid, s in scores.items()}
    best = max(shown.values())
    return [oid for oid, value in shown.items() if value == best]


def compute_sensitivity(offers, weights: dict[str, float]) -> SensitivityView | None:
    """offers: OfferReport 序列；信息不足以排名（任一 Offer 无三维分）时返回 None。"""
    scores: dict[object, dict[str, float]] = {}
    for row in offers:
        dims = row.dimension_scores or {}
        if row.overall_score is None or any(dims.get(k) is None for k in DIMENSIONS):
            return None
        scores[row.offer_id] = {k: float(dims[k]) for k in DIMENSIONS}
    if len(scores) < 2 or any(k not in weights for k in DIMENSIONS):
        return None

    current = {k: float(weights[k]) for k in DIMENSIONS}
    top = _winners(scores, current)
    if len(top) != 1:
        return SensitivityView(status="tie", leader_id=None, nearest=None, flips=[])
    leader = top[0]

    flips: list[SensitivityFlip] = []
    for key in DIMENSIONS:
        for direction, sign in (("up", 1), ("down", -1)):
            step = 1
            while True:
                target = current[key] + sign * step * STEP
                if target < WEIGHT_MIN - 1e-9 or target > WEIGHT_MAX + 1e-9:
                    break
                winners = _winners(scores, _rebalance(current, key, target))
                if winners != [leader]:
                    overtaker = next((w for w in winners if w != leader), None)
                    if overtaker is not None:
                        flips.append(SensitivityFlip(
                            dimension=key, current_weight=round(current[key], 4),
                            flip_weight=round(target, 4), direction=direction,
                            overtaken_by=overtaker, ties=len(winners) > 1,
                        ))
                    break
                step += 1

    flips.sort(key=lambda f: abs(f.flip_weight - f.current_weight))
    nearest = flips[0] if flips else None
    if nearest is None:
        status = "stable"
    else:
        distance = abs(nearest.flip_weight - nearest.current_weight)
        status = "fragile" if distance < FRAGILE_BELOW else "moderate" if distance < MODERATE_BELOW else "steady"
    return SensitivityView(status=status, leader_id=leader, nearest=nearest, flips=flips)
