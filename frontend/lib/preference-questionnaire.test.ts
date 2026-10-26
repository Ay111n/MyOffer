import { beforeEach, describe, expect, it } from "vitest";
import type { PreferenceQuestion, PreferenceQuestionnaireResource } from "@/lib/api/types";
import {
  clearQuestionnaireDraft,
  normalizeManualWeights,
  preferenceQuestionnaireDraftKey,
  readUnsavedQuestionnaireAnswers,
  rebalanceWeightPercentages,
  roundWeightsToPercentages,
  scorePreferenceAnswers,
} from "@/lib/preference-questionnaire";

const definition: PreferenceQuestionnaireResource = {
  version: "v2",
  title: "问卷",
  subtitle: "说明",
  estimated_minutes: 1,
  dimensions: {
    economic: { label: "经济回报", description: "收益" },
    growth: { label: "职业成长", description: "成长" },
    experience: { label: "工作体验", description: "状态" },
  },
  questions: [
    ...[
      ["economic", "growth"],
      ["economic", "experience"],
      ["growth", "experience"],
    ].map(([left_dimension, right_dimension], index) => ({
      question_id: `pair-${index}`,
      kind: "pairwise" as const,
      prompt: "比较",
      left_dimension,
      right_dimension,
      options: [
        { value: "left_strong", label: "明显偏向左边" },
        { value: "left_slight", label: "稍微偏向左边" },
        { value: "equal", label: "差不多" },
        { value: "right_slight", label: "稍微偏向右边" },
        { value: "right_strong", label: "明显偏向右边" },
      ],
    })),
    {
      question_id: "buy_house_intent",
      kind: "single" as const,
      prompt: "买房意向",
      options: [
        { value: "consider", label: "考虑" },
        { value: "not_consider", label: "不考虑" },
        { value: "undecided", label: "未决定" },
      ],
    },
  ] as PreferenceQuestion[],
};

describe("preference questionnaire scoring", () => {
  it("keeps neutral answers at one third each", () => {
    const answers = (definition.questions ?? []).map((question) => ({
      question_id: question.question_id,
      choice: question.kind === "single" ? "undecided" : "equal",
    }));
    expect(scorePreferenceAnswers(definition, answers)).toEqual({
      economic: 1 / 3,
      growth: 1 / 3,
      experience: 1 / 3,
    });
  });

  it("rounds displayed percentages to exactly 100", () => {
    const rounded = roundWeightsToPercentages({
      economic: 0.333,
      growth: 0.333,
      experience: 0.334,
    });
    expect(Object.values(rounded).reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(rounded).toEqual({ economic: 33, growth: 33, experience: 34 });
  });

  it("keeps entered proportions and applies the five percent floor", () => {
    expect(normalizeManualWeights({ economic: "50", growth: "30", experience: "20" })).toEqual({ economic: 0.5, growth: 0.3, experience: 0.2 });
    const floored = normalizeManualWeights({ economic: "100", growth: "0", experience: "0" });
    expect(floored?.economic).toBeCloseTo(0.9);
    expect(floored?.growth).toBeCloseTo(0.05);
    expect(floored?.experience).toBeCloseTo(0.05);
    expect(normalizeManualWeights({ economic: "", growth: "0", experience: "0" })).toBeNull();
  });

  it("rebalances the other two percentages in the result confirmation", () => {
    expect(rebalanceWeightPercentages({ economic: "34", growth: "33", experience: "33" }, "economic", "50"))
      .toEqual({ economic: "50", growth: "25", experience: "25" });
    expect(rebalanceWeightPercentages({ economic: "50", growth: "25", experience: "25" }, "economic", "100"))
      .toEqual({ economic: "90", growth: "5", experience: "5" });
  });
});

describe("readUnsavedQuestionnaireAnswers（已答完未保存 = 草稿齐全）", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  const fullDraft = (version: string) => JSON.stringify({
    version,
    currentIndex: 3,
    answers: [
      { question_id: "pair-0", choice: "left_strong" },
      { question_id: "pair-1", choice: "equal" },
      { question_id: "pair-2", choice: "right_slight" },
      { question_id: "buy_house_intent", choice: "consider" },
    ],
  });

  it("草稿四题齐全时按题目顺序返回作答（生成入口据此提醒）", () => {
    sessionStorage.setItem(preferenceQuestionnaireDraftKey("s1"), fullDraft("v2"));
    expect(readUnsavedQuestionnaireAnswers("s1", definition)).toEqual([
      { question_id: "pair-0", choice: "left_strong" },
      { question_id: "pair-1", choice: "equal" },
      { question_id: "pair-2", choice: "right_slight" },
      { question_id: "buy_house_intent", choice: "consider" },
    ]);
  });

  it("保存成功清掉草稿后返回 null（不重复提醒）", () => {
    sessionStorage.setItem(preferenceQuestionnaireDraftKey("s1"), fullDraft("v2"));
    clearQuestionnaireDraft("s1");
    expect(readUnsavedQuestionnaireAnswers("s1", definition)).toBeNull();
  });

  it("版本不匹配（规则更新残留）、答不齐、坏 JSON 一律返回 null", () => {
    sessionStorage.setItem(preferenceQuestionnaireDraftKey("s1"), fullDraft("v1"));
    expect(readUnsavedQuestionnaireAnswers("s1", definition)).toBeNull();

    sessionStorage.setItem(preferenceQuestionnaireDraftKey("s1"), JSON.stringify({
      version: "v2",
      answers: [{ question_id: "pair-0", choice: "left_strong" }],
    }));
    expect(readUnsavedQuestionnaireAnswers("s1", definition)).toBeNull();

    sessionStorage.setItem(preferenceQuestionnaireDraftKey("s1"), "{not-json");
    expect(readUnsavedQuestionnaireAnswers("s1", definition)).toBeNull();
    expect(readUnsavedQuestionnaireAnswers("missing-session", definition)).toBeNull();
  });
});
