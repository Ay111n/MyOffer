"""价值观问卷的确定性校验与透明积分计算。

题目定义来自 preferences.yaml，客户端只提交题目答案；服务端重新按规则计算
权重，避免客户端改写题目顺序或直接伪造最终占比。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from app.rules_runtime import RuleSet
from app.schemas import PreferenceAnswer

PAIRWISE_CHOICES = frozenset({"left_strong", "left_slight", "equal", "right_slight", "right_strong"})
CALIBRATION_NO_DIFFERENCE = "no_difference"


class QuestionnaireValidationError(ValueError):
    """问卷答案不符合当前规则版本。"""


@dataclass(frozen=True)
class QuestionnaireScore:
    weights: dict[str, float]
    answers: list[PreferenceAnswer]
    scores: dict[str, int]


def score_questionnaire(
    rules: RuleSet, answers: Sequence[PreferenceAnswer]
) -> QuestionnaireScore:
    """校验完整问卷并按透明积分法生成归一化权重。

    每个两两比较题先给左右各 1 分，再根据五档选择给倾向侧增加 0/1/2 分；
    最后一题对选中的维度额外加 1 分。返回的答案按规则题目顺序规范化，
    这样相同的逻辑答案不会因为客户端提交顺序不同而产生不同的快照。
    kind=single 的情境题（购房意向）只校验选项合法性，不计入权重积分。
    """
    spec = rules.preference_questionnaire()
    dimensions = list((spec.get("dimensions") or {}).keys())
    questions = spec.get("questions") or []
    if not dimensions or not isinstance(questions, list):
        raise QuestionnaireValidationError("当前问卷配置不可用")

    expected_ids = [str(q.get("question_id", "")) for q in questions]
    if not expected_ids or len(set(expected_ids)) != len(expected_ids):
        raise QuestionnaireValidationError("当前问卷题目配置必须包含不重复的题")

    if len(answers) != len(expected_ids):
        raise QuestionnaireValidationError(
            f"问卷必须完成全部 {len(expected_ids)} 道题"
        )

    answer_by_id: dict[str, PreferenceAnswer] = {}
    for answer in answers:
        if answer.question_id in answer_by_id:
            raise QuestionnaireValidationError(f"题目 {answer.question_id} 重复提交")
        if answer.question_id not in expected_ids:
            raise QuestionnaireValidationError(f"未知题目：{answer.question_id}")
        answer_by_id[answer.question_id] = answer

    missing = [question_id for question_id in expected_ids if question_id not in answer_by_id]
    if missing:
        raise QuestionnaireValidationError(f"缺少题目答案：{', '.join(missing)}")

    scores = {dimension: 0 for dimension in dimensions}
    canonical: list[PreferenceAnswer] = []

    for question in questions:
        question_id = str(question.get("question_id", ""))
        answer = answer_by_id[question_id]
        allowed = {str(option.get("value")) for option in question.get("options", [])}
        if answer.choice not in allowed:
            raise QuestionnaireValidationError(
                f"题目 {question_id} 的选项无效：{answer.choice}"
            )

        kind = question.get("kind")
        if kind == "pairwise":
            left = question.get("left_dimension")
            right = question.get("right_dimension")
            if left not in dimensions or right not in dimensions or left == right:
                raise QuestionnaireValidationError(f"题目 {question_id} 的比较维度配置无效")
            if allowed != PAIRWISE_CHOICES:
                raise QuestionnaireValidationError(f"题目 {question_id} 的五档选项配置无效")
            scores[left] += 1
            scores[right] += 1
            if answer.choice == "left_slight":
                scores[left] += 1
            elif answer.choice == "left_strong":
                scores[left] += 2
            elif answer.choice == "right_slight":
                scores[right] += 1
            elif answer.choice == "right_strong":
                scores[right] += 2
        elif kind == "calibration":
            if allowed != set(dimensions) | {CALIBRATION_NO_DIFFERENCE}:
                raise QuestionnaireValidationError(f"题目 {question_id} 的校准选项配置无效")
            if answer.choice != CALIBRATION_NO_DIFFERENCE:
                scores[answer.choice] += 1
        elif kind == "single":
            # 情境题（购房意向）：只校验选项合法性，不计入任何维度的积分
            pass
        else:
            raise QuestionnaireValidationError(f"题目 {question_id} 的类型无效")

        canonical.append(PreferenceAnswer(question_id=question_id, choice=answer.choice))

    total = sum(scores.values())
    if total <= 0:
        raise QuestionnaireValidationError("问卷积分总和必须为正")
    weights = {dimension: scores[dimension] / total for dimension in dimensions}
    return QuestionnaireScore(weights=weights, answers=canonical, scores=scores)
