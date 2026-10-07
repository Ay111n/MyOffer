"""偏好服务：问卷计算权重，或在问卷结果确认时手动调整。"""
from __future__ import annotations

import math

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import DecisionSession, UserPreference
from app.rules_runtime import RuleSet
from app.schemas import PreferenceAnswer, PreferencePutRequest, PreferenceResource
from app.services.preference_questionnaire import (
    QuestionnaireValidationError,
    score_questionnaire,
)
from app.services.recompute import (
    evaluate_and_snapshot,
    latest_echo,
    reopen_completion,
    report_echo,
)


def _dimension_keys(rules: RuleSet) -> set[str]:
    return set(rules.decision_dimensions().keys())


def _key_diff_echo(rules: RuleSet, weights: dict[str, float]) -> str:
    """weights 键名差异摘要（截断回显）：键名与键数无 schema 上限，
    超长/超量输入不应被原样放大进 422 响应体。"""
    diff = sorted(set(weights) ^ _dimension_keys(rules))[:6]
    shown = ", ".join(diff)
    if len(shown) > 200:
        shown = shown[:200] + "…"
    return shown


def normalize_weights(rules: RuleSet, weights: dict[str, float]) -> dict[str, float]:
    if set(weights) != _dimension_keys(rules):
        raise HTTPException(
            status_code=422,
            detail={"code": "validation_error", "message": "weights 必须包含全部三个维度",
                    "details": {"field_errors": [
                        {"path": "weights", "code": "weights_keys",
                         "message": f"missing/extra: {_key_diff_echo(rules, weights)}"}]}},
        )
    values = {k: float(v) for k, v in weights.items()}
    total = sum(values.values())
    # NaN/Infinity 能通过 pydantic float 与「<= 0 / < 0」比较（NaN 比较恒 False），
    # 一旦入库：JSON 序列化 500 掉所有含权重的响应，引擎指标也被污染——
    # 与 fact_validation._is_finite 同一防线，这里必须显式拒绝非有限值。
    if not math.isfinite(total) or total <= 0 or any(v < 0 for v in values.values()):
        raise HTTPException(status_code=422, detail={
            "code": "validation_error", "message": "权重必须为非负有限数值且和为正",
            "details": {"field_errors": [{"path": "weights", "code": "weights_invalid",
                                          "message": "weights must be non-negative finite numbers with positive sum"}]}})
    if any(v / total < 0.05 - 1e-9 for v in values.values()):
        raise _validation_error("每个维度的权重至少为 5%", "weights")
    return {k: v / total for k, v in values.items()}


def _validation_error(message: str, path: str) -> HTTPException:
    return HTTPException(
        status_code=422,
        detail={
            "code": "validation_error",
            "message": message,
            "details": {"field_errors": [{"path": path, "code": "invalid", "message": message}]},
        },
    )


def _preference_input(
    body: PreferencePutRequest, rules: RuleSet
) -> tuple[dict[str, float], str | None, list[PreferenceAnswer]]:
    """校验请求来源并返回归一化权重、来源版本和规范化答案。

    questionnaire：校验问卷版本与全部答案，权重由透明积分法重算；
    manual：使用请求携带的权重；有问卷答案时一并校验并保存。"""
    if body.source == "manual":
        if not body.weights:
            raise _validation_error("手动偏好必须携带 weights", "weights")
        if body.answers:
            if body.questionnaire_version != rules.preference_questionnaire().get("version"):
                raise _validation_error("questionnaire_version 不是当前问卷版本", "questionnaire_version")
            try:
                scored = score_questionnaire(rules, body.answers)
            except QuestionnaireValidationError as exc:
                raise _validation_error(str(exc), "answers") from exc
            return normalize_weights(rules, body.weights), body.questionnaire_version, scored.answers
        return normalize_weights(rules, body.weights), None, []
    if body.source != "questionnaire":
        raise _validation_error("偏好只能通过价值观问卷或手动权重提交", "source")
    if body.questionnaire_version != rules.preference_questionnaire().get("version"):
        raise _validation_error("questionnaire_version 不是当前问卷版本", "questionnaire_version")
    try:
        scored = score_questionnaire(rules, body.answers)
    except QuestionnaireValidationError as exc:
        raise _validation_error(str(exc), "answers") from exc
    return normalize_weights(rules, scored.weights), body.questionnaire_version, scored.answers


def put_preferences(
    db: Session, session: DecisionSession, body: PreferencePutRequest, rules: RuleSet
) -> tuple[PreferenceResource, object]:
    row = db.scalar(select(UserPreference).where(UserPreference.session_id == session.id))

    if row is not None and row.version != body.version:
        raise HTTPException(
            status_code=409,
            detail={"code": "version_conflict", "message": "Preferences were modified by another client",
                    "details": {"current_version": row.version}},
        )

    weights, questionnaire_version, answers = _preference_input(body, rules)
    # manual 来源不携带问卷版本/答案：沿用已存值。清空会让 recompute 从
    # answers 拆出的 buy_house_intent 变回 None——住房模块悄悄回到综合
    # 评分，与用户刚作答的问卷矛盾（首次保存前无旧值，本来就为空）。
    if body.source == "manual" and row is not None and not body.answers:
        answers_payload = list(row.answers or [])
        if questionnaire_version is None:
            questionnaire_version = row.questionnaire_version
    else:
        answers_payload = [answer.model_dump() for answer in answers]

    # ── no-op detection：与当前状态一致 → 不 evaluate、不新增快照 ──
    if row is not None:
        same = (
            {k: round(float(v), 12) for k, v in row.weights.items()} ==
            {k: round(v, 12) for k, v in weights.items()}
            and (row.source or "questionnaire") == body.source
            and row.questionnaire_version == questionnaire_version
            and list(row.answers or []) == answers_payload
        )
        if same:
            db.commit()
            return _resource(row), latest_echo(db, session)

    # ── 写入 + 重算 ────────────────────────────────────────
    if row is None:
        row = UserPreference(session_id=session.id)
        db.add(row)
    row.weights = weights
    row.source = body.source
    row.questionnaire_version = questionnaire_version
    row.answers = answers_payload
    row.version = (row.version or 0) + 1

    # 结果页的手动权重微调是就地「如果……会怎样」分析，事实输入未变，
    # 不回退 results 阶段；问卷重答仍按「决策输入已变」处理。
    if body.source == "questionnaire":
        reopen_completion(session)

    _snapshot, seq = evaluate_and_snapshot(db, session, trigger_type="preferences_updated", rules=rules)
    db.commit()
    db.refresh(row)
    return _resource(row), report_echo(_snapshot, seq)


def get_preferences(db: Session, session: DecisionSession) -> tuple[PreferenceResource | None, object]:
    """读取已保存的偏好；从未设置过时 data 为 None。"""
    row = db.scalar(select(UserPreference).where(UserPreference.session_id == session.id))
    if row is None:
        return None, latest_echo(db, session)
    return _resource(row), latest_echo(db, session)


def _resource(row: UserPreference) -> PreferenceResource:
    return PreferenceResource(
        weights={k: float(v) for k, v in row.weights.items()},
        version=row.version,
        source=row.source or "questionnaire",
        questionnaire_version=row.questionnaire_version,
        answers=[PreferenceAnswer.model_validate(answer) for answer in (row.answers or [])],
    )
