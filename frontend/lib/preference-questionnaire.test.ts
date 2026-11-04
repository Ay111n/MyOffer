import { beforeEach, describe, expect, it } from "vitest";
import type { PreferenceQuestion, PreferenceQuestionnaireResource } from "@/lib/api/types";
import {
  clearQuestionnaireDraft,
  listOrphanQuestionnaireSids,
  loadQuestionnaireDraft,
  normalizeManualWeights,
  preferenceQuestionnaireDraftKey,
  preferenceWeightSummary,
  readUnsavedQuestionnaireAnswers,
  rebalanceWeightPercentages,
  roundWeightsToPercentages,
  saveQuestionnaireDraft,
  scorePreferenceAnswers,
  weightPercentText,
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

  it("weightPercentText 与声明行同口径（最大余数法），37.5% 类值各处显示一致", () => {
    // 2026-10-27 试用反馈：报告页「你的权重 / 现在占」曾用 Math.round 与
    // 声明行的最大余数法在 37.5 类值上差 1（37 vs 38）。此测试钉住统一口径。
    const weights = { economic: 0.375, growth: 0.25, experience: 0.375 };
    expect(weightPercentText(weights, "economic")).toBe("38%");
    expect(weightPercentText(weights, "growth")).toBe("25%");
    expect(weightPercentText(weights, "experience")).toBe("37%");
    const summary = preferenceWeightSummary(weights);
    expect(summary).toContain("经济回报 38%");
    expect(summary).toContain("职业成长 25%");
    expect(summary).toContain("工作体验 37%");
  });

  it("weightPercentText 空权重回落默认分配（与 preferenceWeightSummary 一致），部分缺失为 0%", () => {
    // roundWeightsToPercentages 的既有语义：全零/空权重把 100 按索引分配，
    // 得到 34/33/33——摘要卡「默认：经济回报 34%…」正来源于此
    expect(weightPercentText(null, "economic")).toBe("34%");
    expect(weightPercentText({}, "growth")).toBe("33%");
    expect(weightPercentText({ growth: 0.5, experience: 0.5 }, "economic")).toBe("0%");
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

describe("问卷草稿本地持久化（localStorage + 24h TTL）", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  const fullDraft = (version: string) => ({
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
    saveQuestionnaireDraft("s1", fullDraft("v2"));
    expect(readUnsavedQuestionnaireAnswers("s1", definition)).toEqual([
      { question_id: "pair-0", choice: "left_strong" },
      { question_id: "pair-1", choice: "equal" },
      { question_id: "pair-2", choice: "right_slight" },
      { question_id: "buy_house_intent", choice: "consider" },
    ]);
    // 主存储是 localStorage：跨标签/重启可恢复（2026-10-28 反馈）
    expect(JSON.parse(localStorage.getItem(preferenceQuestionnaireDraftKey("s1")) ?? "")).toMatchObject({ v: { version: "v2" } });
    expect(loadQuestionnaireDraft("s1")?.currentIndex).toBe(3);
  });

  it("保存成功清掉草稿后返回 null（不重复提醒）", () => {
    saveQuestionnaireDraft("s1", fullDraft("v2"));
    clearQuestionnaireDraft("s1");
    expect(readUnsavedQuestionnaireAnswers("s1", definition)).toBeNull();
    expect(loadQuestionnaireDraft("s1")).toBeNull();
  });

  it("版本不匹配（规则更新残留）、答不齐、坏 JSON、过期一律返回 null", () => {
    saveQuestionnaireDraft("s1", fullDraft("v1"));
    expect(readUnsavedQuestionnaireAnswers("s1", definition)).toBeNull();

    saveQuestionnaireDraft("s1", { version: "v2", answers: [{ question_id: "pair-0", choice: "left_strong" }] });
    expect(readUnsavedQuestionnaireAnswers("s1", definition)).toBeNull();

    localStorage.setItem(preferenceQuestionnaireDraftKey("s1"), "{not-json");
    expect(readUnsavedQuestionnaireAnswers("s1", definition)).toBeNull();
    expect(loadQuestionnaireDraft("s1")).toBeNull();
    expect(readUnsavedQuestionnaireAnswers("missing-session", definition)).toBeNull();

    // 超过 24h 的草稿读取时直接淘汰
    const key = preferenceQuestionnaireDraftKey("s2");
    localStorage.setItem(key, JSON.stringify({
      t: Date.now() - 25 * 60 * 60 * 1000,
      v: fullDraft("v2"),
    }));
    expect(loadQuestionnaireDraft("s2")).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("listOrphanQuestionnaireSids 列出其他会话的未过期草稿（新→旧），跳过当前会话", () => {
    saveQuestionnaireDraft("old-1", fullDraft("v2"));
    const key2 = preferenceQuestionnaireDraftKey("old-2");
    localStorage.setItem(key2, JSON.stringify({ t: Date.now() - 1000, v: fullDraft("v2") }));
    const key3 = preferenceQuestionnaireDraftKey("expired");
    localStorage.setItem(key3, JSON.stringify({ t: Date.now() - 25 * 60 * 60 * 1000, v: fullDraft("v2") }));
    saveQuestionnaireDraft("current", fullDraft("v2"));

    expect(listOrphanQuestionnaireSids("current")).toEqual(["old-1", "old-2"]);
    expect(listOrphanQuestionnaireSids(null)).toContain("current");
  });
});
