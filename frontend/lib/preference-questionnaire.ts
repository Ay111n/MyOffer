import type { PreferenceAnswer, PreferenceQuestionnaireResource } from "@/lib/api/types";

export const PREFERENCE_DIMENSION_ORDER = [
  "economic",
  "growth",
  "experience",
] as const;

export const PREFERENCE_DIMENSION_LABELS: Record<string, string> = {
  economic: "经济回报",
  growth: "职业成长",
  experience: "工作体验",
};

export const PREFERENCE_DRAFT_PREFIX = "preference-questionnaire:";

export function preferenceQuestionnaireDraftKey(sessionId: string): string {
  return `${PREFERENCE_DRAFT_PREFIX}${sessionId}`;
}

/** 清空当前会话的问卷草稿（保存成功 / 重新回答时调用）。 */
export function clearQuestionnaireDraft(sessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(preferenceQuestionnaireDraftKey(sessionId));
  } catch {
    // 存储不可用时无草稿可清
  }
}

/**
 * 读取「已答完但尚未保存」的问卷作答。
 *
 * 问卷草稿随作答写入 sessionStorage，保存成功即被清除——因此草稿仍在且
 * 四题齐全，就等价于用户表达过完整偏好但还没落库。生成报告会立即消费
 * 权重，静默用默认/旧权重会偏离用户刚表达的偏好；生成入口据此提醒。
 * 版本不匹配（规则更新后的残留草稿）、答不齐或内容损坏一律返回 null。
 */
export function readUnsavedQuestionnaireAnswers(
  sessionId: string,
  definition: PreferenceQuestionnaireResource,
): PreferenceAnswer[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(preferenceQuestionnaireDraftKey(sessionId));
    if (!raw) return null;
    const draft = JSON.parse(raw) as { version?: unknown; answers?: unknown };
    if (draft.version !== definition.version || !Array.isArray(draft.answers)) return null;
    const questions = definition.questions ?? [];
    if (questions.length === 0) return null;
    const byId = new Map(
      draft.answers
        .filter((a): a is PreferenceAnswer => Boolean(a?.question_id && a?.choice))
        .map((a) => [a.question_id as string, a.choice as string]),
    );
    if (!questions.every((question) => byId.has(question.question_id))) return null;
    return questions.map((question) => ({
      question_id: question.question_id,
      choice: byId.get(question.question_id)!,
    }));
  } catch {
    return null;
  }
}

/** 将服务端归一化权重按最大余数法显示为合计 100 的整数百分比。 */
export function roundWeightsToPercentages(
  weights: Record<string, number>,
  order: readonly string[] = PREFERENCE_DIMENSION_ORDER,
): Record<string, number> {
  const raw = order.map((key) => Math.max(0, Number(weights[key] ?? 0)) * 100);
  const floors = raw.map((value) => Math.floor(value));
  let remaining = 100 - floors.reduce((sum, value) => sum + value, 0);
  const indices = raw
    .map((value, index) => ({ index, fraction: value - floors[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
    .map(({ index }) => index);
  let cursor = 0;
  while (remaining > 0 && indices.length > 0) {
    floors[indices[cursor % indices.length]] += 1;
    remaining -= 1;
    cursor += 1;
  }
  return Object.fromEntries(order.map((key, index) => [key, floors[index]]));
}

export function preferenceWeightSummary(weights: Record<string, number> | null | undefined): string {
  const rounded = roundWeightsToPercentages(weights ?? {}, PREFERENCE_DIMENSION_ORDER);
  return PREFERENCE_DIMENSION_ORDER
    .map((key) => `${PREFERENCE_DIMENSION_LABELS[key]} ${rounded[key] ?? 0}%`)
    .join(" • ");
}

export function normalizeManualWeights(values: Record<string, string>): Record<string, number> | null {
  const raw = PREFERENCE_DIMENSION_ORDER.map((key) => Number(values[key]));
  if (raw.some((value) => !Number.isFinite(value) || value < 0) || raw.every((value) => value === 0)) return null;
  const total = raw.reduce((sum, value) => sum + value, 0);
  const shares = raw.map((value) => value / total);
  if (shares.every((value) => value >= 0.05)) {
    return Object.fromEntries(PREFERENCE_DIMENSION_ORDER.map((key, index) => [key, shares[index]]));
  }
  const excess = shares.map((value) => Math.max(0, value - 0.05));
  const excessTotal = excess.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(PREFERENCE_DIMENSION_ORDER.map((key, index) => [key, 0.05 + 0.85 * excess[index] / excessTotal]));
}

export function rebalanceWeightPercentages(
  values: Record<string, string>, changedKey: string, rawValue: string,
): Record<string, string> | null {
  if (rawValue.trim() === "" || !Number.isFinite(Number(rawValue))) return null;
  const target = Math.min(90, Math.max(5, Math.round(Number(rawValue))));
  const others = PREFERENCE_DIMENSION_ORDER.filter((key) => key !== changedKey);
  if (others.length !== 2) return null;
  const excess = others.map((key) => Math.max(0, Number(values[key] ?? 33) - 5));
  const total = excess[0] + excess[1];
  const first = Math.round(5 + (90 - target) * (total > 0 ? excess[0] / total : 0.5));
  return { ...values, [changedKey]: String(target), [others[0]]: String(first), [others[1]]: String(100 - target - first) };
}

/** 与后端透明积分法相同的本地结果预览；最终保存时仍由后端重新计算。 */
export function scorePreferenceAnswers(
  definition: PreferenceQuestionnaireResource,
  answers: PreferenceAnswer[],
): Record<string, number> | null {
  const dimensions = Object.keys(definition.dimensions ?? {});
  const scores = Object.fromEntries(dimensions.map((key) => [key, 0]));
  const answerMap = new Map(answers.map((answer) => [answer.question_id, answer.choice]));

  for (const question of definition.questions ?? []) {
    const choice = answerMap.get(question.question_id);
    if (!choice) return null;
    if (question.kind === "pairwise") {
      const left = question.left_dimension;
      const right = question.right_dimension;
      if (!left || !right || scores[left] === undefined || scores[right] === undefined) return null;
      scores[left] += 1;
      scores[right] += 1;
      if (choice === "left_slight") scores[left] += 1;
      if (choice === "left_strong") scores[left] += 2;
      if (choice === "right_slight") scores[right] += 1;
      if (choice === "right_strong") scores[right] += 2;
    } else if (choice !== "no_difference" && scores[choice] !== undefined) {
      scores[choice] += 1;
    }
  }

  const total = Object.values(scores).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  return Object.fromEntries(dimensions.map((key) => [key, scores[key] / total]));
}
