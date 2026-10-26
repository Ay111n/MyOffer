import { describe, expect, it } from "vitest";
import type { OfferReportView } from "@/lib/api/types";
import { bestIndexes, buildNotices, buildVerdict, flipAction, infoGaps, reasonRows, reasonSentence, stabilityCopy, strengthOfGap, type Sensitivity } from "./verdict";

function offer(partial: Partial<OfferReportView> & { display_order: number }): OfferReportView {
  return {
    offer_id: `id-${partial.display_order}`,
    company: `Offer ${String.fromCharCode(64 + partial.display_order)}`,
    position: "",
    completeness: 0,
    city_pending: false,
    compliance_alert: false,
    ...partial,
  } as OfferReportView;
}

describe("strengthOfGap", () => {
  it("按分差给出展示分级", () => {
    expect(strengthOfGap(0.4).level).toBe("toss");
    expect(strengthOfGap(2).level).toBe("near");
    expect(strengthOfGap(2.9).level).toBe("near");
    expect(strengthOfGap(3).level).toBe("moderate");
    expect(strengthOfGap(8).level).toBe("clear");
    expect(strengthOfGap(-9).level).toBe("clear");
  });
});

describe("buildVerdict", () => {
  it("有排名时给出领先者、第二名与分差", () => {
    const a = offer({ display_order: 1, overall_rank: 2, overall_score: 65.9 });
    const b = offer({ display_order: 2, overall_rank: 1, overall_score: 67.9 });
    const v = buildVerdict([a, b]);
    expect(v.kind).toBe("ranked");
    if (v.kind !== "ranked") return;
    expect(v.leaders).toEqual([b]);
    expect(v.runnerUp).toEqual(a);
    expect(v.gap).toBe(2);
    expect(v.strength.label).toBe("接近");
    expect(v.tied).toBe(false);
  });

  it("并列第一时标记 tied", () => {
    const a = offer({ display_order: 1, overall_rank: 1, overall_score: 70 });
    const b = offer({ display_order: 2, overall_rank: 1, overall_score: 70 });
    const v = buildVerdict([a, b]);
    expect(v.kind === "ranked" && v.tied).toBe(true);
  });

  it("任一 Offer 无排名时不给结论并列出缺项", () => {
    const a = offer({ display_order: 1, overall_rank: null, missing_core: ["city"] });
    const b = offer({ display_order: 2, overall_rank: null });
    const v = buildVerdict([a, b]);
    expect(v.kind).toBe("unranked");
    if (v.kind !== "unranked") return;
    expect(v.blockers).toHaveLength(1);
    expect(buildNotices([a, b], v)[0].level).toBe("important");
  });
});

describe("reasonRows", () => {
  const leader = offer({
    display_order: 2,
    dimension_scores: { economic: 42.9, growth: 80.5, experience: 80.2 },
    effective_weights: { economic: 0.34, growth: 0.33, experience: 0.33 },
    score_contributions: { economic: 14.6, growth: 26.5, experience: 26.4 },
  });
  const other = offer({
    display_order: 1,
    dimension_scores: { economic: 40.2, growth: 78.3, experience: 79.1 },
    score_contributions: { economic: 13.7, growth: 25.8, experience: 26.1 },
  });

  it("优先使用后端 attribution，并按影响大小排序", () => {
    const rows = reasonRows(leader, other, { economic: 0.9, growth: 0.7, experience: 0.4 });
    expect(rows.map((r) => r.key)).toEqual(["economic", "growth", "experience"]);
    expect(rows[0].contribution).toBe(0.9);
  });

  it("缺少 attribution 时用 score_contributions 相减", () => {
    const rows = reasonRows(leader, other, null);
    const economic = rows.find((r) => r.key === "economic")!;
    expect(economic.contribution).toBeCloseTo(0.9, 5);
  });

  it("生成人话句子，并区分优势与劣势", () => {
    const rows = [
      { key: "economic", label: "经济回报", contribution: 2.4, leaderScore: 1, otherScore: 1, weight: 0.3 },
      { key: "growth", label: "职业成长", contribution: -1.1, leaderScore: 1, otherScore: 1, weight: 0.3 },
      { key: "experience", label: "工作体验", contribution: 0.01, leaderScore: 1, otherScore: 1, weight: 0.3 },
    ];
    const text = reasonSentence(rows, "Offer B", "Offer A");
    expect(text).toContain("Offer B的优势来自经济回报（+2.4）");
    expect(text).toContain("Offer A在职业成长（−1.1）上更好");
    expect(text).not.toContain("工作体验");
  });
});

describe("bestIndexes", () => {
  it("返回更优一方；全部相同或数据不足时不标记", () => {
    expect(bestIndexes([100, 200], "higher")).toEqual([1]);
    expect(bestIndexes([50, 40], "lower")).toEqual([1]);
    expect(bestIndexes([5, 5], "higher")).toEqual([]);
    expect(bestIndexes([5, null], "higher")).toEqual([]);
  });

  it("差距小到可以忽略时不标记", () => {
    expect(bestIndexes([52.4, 52.3], "lower")).toEqual([]);
    expect(bestIndexes([52, 46], "lower")).toEqual([1]);
  });
});

describe("stabilityCopy", () => {
  const a = offer({ display_order: 1 });
  const b = offer({ display_order: 2 });
  const flip = { dimension: "experience", current_weight: 0.333, flip_weight: 0.38, direction: "up" as const, overtaken_by: b.offer_id, ties: false };
  const base: Sensitivity = { status: "fragile", leader_id: a.offer_id, nearest: flip, flips: [flip], weight_min: 0.05, weight_max: 0.9 };

  it("把翻转点说成人话", () => {
    expect(flipAction(flip)).toBe("把「工作体验」提高到 38%（现在 33%）");
    const copy = stabilityCopy(base, [a, b]);
    expect(copy.level).toBe("fragile");
    expect(copy.title).toBe("不太稳");
    expect(copy.body).toContain("第一名就会换成 Offer B");
  });

  it("稳定、并列、并列翻转各有表述", () => {
    expect(stabilityCopy({ ...base, status: "stable", nearest: null, flips: [] }, [a, b]).body).toContain("Offer A 都保持第一");
    expect(stabilityCopy({ ...base, status: "stable", nearest: null, flips: [] }, [a, b]).body).toContain("两个维度同时调整");
    expect(stabilityCopy({ ...base, status: "tie", leader_id: null, nearest: null, flips: [] }, [a, b]).level).toBe("tie");
    const tieFlip = { ...flip, ties: true };
    expect(stabilityCopy({ ...base, status: "moderate", nearest: tieFlip }, [a, b]).body).toContain("会和 Offer B 并列");
  });

  it("margin 有值时附上全向最短距离说明", () => {
    const copy = stabilityCopy({ ...base, status: "steady", margin: 0.148 }, [a, b]);
    expect(copy.body).toContain("15 个百分点");
    expect(copy.body).toContain("无论朝哪个方向");
  });
});

describe("infoGaps / notices", () => {
  it("只有部分 Offer 填写的可比项会被列为待补", () => {
    const a = offer({ display_order: 1, input_values: { commute_minutes: 30 } });
    const b = offer({ display_order: 2, input_values: {} });
    const gaps = infoGaps([a, b]);
    expect(gaps).toEqual([{ offer: b, field: "commute_minutes", reason: "partial" }]);
  });

  it("缴费细节缺失时提示估算，缴费告警时提示核实", () => {
    const a = offer({ display_order: 1, overall_rank: 1, overall_score: 60, compliance_alert: true, input_values: {} });
    const b = offer({
      display_order: 2, overall_rank: 2, overall_score: 59,
      input_values: { social_security_type: "salary", housing_fund_base_type: "salary", housing_fund_employee_rate: 8 },
    });
    const notices = buildNotices([a, b], buildVerdict([a, b]));
    expect(notices.some((n) => n.level === "important" && n.title.includes("核实"))).toBe(true);
    expect(notices.some((n) => n.level === "attention" && n.body.includes("Offer A"))).toBe(true);
    expect(notices.some((n) => n.body.includes("Offer B") && n.title.includes("估算"))).toBe(false);
  });
});
