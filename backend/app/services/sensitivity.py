"""排名对「偏好权重」的敏感性。

回答两个问题：
1. 单轴：某个维度的权重调到多少，第一名会换人？（给出可操作的翻转点文案）
2. 全向：当前权重离「第一名易主」的边界还有多远？（二维单纯形网格全扫，
   覆盖「经济降一点 + 体验升一点」这类两维同动的翻转，单轴扫描看不见）

做法（纯函数，不读库、不重新评估输入）：
  - 取快照里每份 Offer 已算好的三维分 `dimension_scores`；
  - 单轴：逐维度把权重向两侧扫描（0.5% 一步，范围与偏好界面一致 5%–90%），
    另外两维按「各自超出下限的部分」成比例补齐，与前端手动调权重一致；
  - 全向：在 (economic, growth) 网格上枚举全部可行权重组合（experience 由
    归一约束确定），标记「第一名不再是唯一第一」的网格点，取当前权重到
    这些点的最短总变差距离（TV = 半 L1：把 δ 个百分点从一个维度挪到另一个
    维度，TV 恰为 δ，与单轴翻转点的百分点口径一致）；
  - 综合分沿用排名口径：加权和 + 1e-9 后保留一位小数，展示分相同即并列。

status 分级以「到边界的最短距离」为准（全向优先，单轴兜底）；
阈值集中在常量里，只用于措辞。
"""
from __future__ import annotations

from functools import lru_cache

from app.schemas import SensitivityFlip, SensitivityView

DIMENSIONS = ("economic", "growth", "experience")
WEIGHT_MIN = 0.05
WEIGHT_MAX = 0.90
STEP = 0.005
# 全向网格步长与单轴一致；直线边界下网格精度 ≈ ±0.5 个百分点
GRID_STEP = 0.005
# 到翻转边界的最短距离（总变差，0.1 = 在维度间对调 10 个百分点）
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


@lru_cache(maxsize=512)
def _plane_margin_cached(
    leader_scores: tuple[float, float, float],
    other_scores: tuple[tuple[float, float, float], ...],
    current: tuple[float, float, float],
) -> float | None:
    """当前权重到「第一名易主/并列」网格点的最短总变差距离。

    None = 整个可选权重平面内第一名都保持唯一第一（比单轴扫描更强的 stable 证据）。
    快照不可变、输入纯数值——按值缓存，重复查看同一报告零重算。"""
    le, lg, lx = leader_scores
    ce, cg, cx = current
    steps = int(round((WEIGHT_MAX - WEIGHT_MIN) / GRID_STEP))
    best: float | None = None
    for i in range(steps + 1):
        e = WEIGHT_MIN + i * GRID_STEP
        for j in range(steps + 1):
            g = WEIGHT_MIN + j * GRID_STEP
            x = 1.0 - e - g
            if x < WEIGHT_MIN - 1e-9 or x > WEIGHT_MAX + 1e-9:
                continue
            leader_total = round(le * e + lg * g + lx * x + 1e-9, 1)
            lost = False
            for oe, og, ox in other_scores:
                if round(oe * e + og * g + ox * x + 1e-9, 1) >= leader_total:
                    lost = True
                    break
            if lost:
                tv = 0.5 * (abs(e - ce) + abs(g - cg) + abs(x - cx))
                if best is None or tv < best:
                    best = tv
    return best


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
        return SensitivityView(status="tie", leader_id=None, nearest=None, flips=[], margin=None)
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

    leader_key = tuple(scores[leader][k] for k in DIMENSIONS)
    others_key = tuple(
        tuple(scores[oid][k] for k in DIMENSIONS)
        for oid in scores if oid != leader
    )
    margin = _plane_margin_cached(leader_key, others_key, tuple(current[k] for k in DIMENSIONS))

    axis_distance = (abs(nearest.flip_weight - nearest.current_weight)
                     if nearest is not None else None)
    distances = [d for d in (margin, axis_distance) if d is not None]
    if not distances:
        status = "stable"
    else:
        distance = min(distances)
        status = "fragile" if distance < FRAGILE_BELOW else "moderate" if distance < MODERATE_BELOW else "steady"
    return SensitivityView(status=status, leader_id=leader, nearest=nearest, flips=flips,
                           margin=margin if distances else None)
