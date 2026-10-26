/**
 * 结果页「结论层」的纯函数。
 *
 * 原则：排名、分数、归因全部来自后端；这里只做两件事——
 *   1. 把后端已算好的数字归类成用户能读懂的说法（展示分级，不影响排名）；
 *   2. 把已有字段整理成「为什么 / 哪里不完整 / 下一步」的列表。
 * 绝不在前端重新计算排名或权重。
 */
import type { OfferReportView, ResultView } from "@/lib/api/types";
import { fieldLabel } from "@/lib/constants";

/** 展示分级：仅用于措辞，不参与任何业务判断。 */
export type StrengthLevel = "toss" | "near" | "moderate" | "clear";

export const STRENGTH_SCALE: { level: StrengthLevel; label: string }[] = [
  { level: "toss", label: "几乎打平" },
  { level: "near", label: "接近" },
  { level: "moderate", label: "有一定优势" },
  { level: "clear", label: "明显领先" },
];

/** 综合分差（按展示的一位小数计）→ 展示分级。阈值只影响文案。 */
export function strengthOfGap(gap: number): { level: StrengthLevel; label: string; meaning: string } {
  const g = Math.abs(gap);
  if (g < 1) return { level: "toss", label: "几乎打平", meaning: "分差很小，别只看这一个数字，更要看下面的取舍。" };
  if (g < 3) return { level: "near", label: "接近", meaning: "领先不多。你的偏好稍有变化，排名就可能反过来。" };
  if (g < 8) return { level: "moderate", label: "有一定优势", meaning: "领先是实打实的，但还没拉开到可以忽略其他因素。" };
  return { level: "clear", label: "明显领先", meaning: "差距足够大，按目前的信息和你的偏好，结论比较明确。" };
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export const letterOf = (offer: Pick<OfferReportView, "display_order">) => String.fromCharCode(64 + offer.display_order);

/** 展示名：「Offer B」；占位名之外的公司名保持原样。 */
export const nameOf = (offer: Pick<OfferReportView, "display_order" | "company">) =>
  offer.company || `Offer ${letterOf(offer)}`;

export type Verdict =
  | { kind: "unranked"; offers: OfferReportView[]; blockers: { offer: OfferReportView; fields: string[] }[] }
  | {
    kind: "ranked";
    leaders: OfferReportView[];
    runnerUp: OfferReportView | null;
    gap: number;
    strength: ReturnType<typeof strengthOfGap>;
    tied: boolean;
  };

export function buildVerdict(offers: OfferReportView[]): Verdict {
  const ranked = offers.length > 0 && offers.every((offer) => offer.overall_rank != null && offer.overall_score != null);
  if (!ranked) {
    return {
      kind: "unranked",
      offers,
      blockers: offers
        .filter((offer) => (offer.missing_core?.length ?? 0) > 0)
        .map((offer) => ({ offer, fields: offer.missing_core ?? [] })),
    };
  }
  const leaders = offers.filter((offer) => offer.overall_rank === 1);
  const others = offers
    .filter((offer) => offer.overall_rank !== 1)
    .sort((a, b) => (b.overall_score ?? 0) - (a.overall_score ?? 0));
  const runnerUp = others[0] ?? null;
  const top = round1(leaders[0]?.overall_score ?? 0);
  const gap = runnerUp ? round1(top - round1(runnerUp.overall_score ?? 0)) : 0;
  return { kind: "ranked", leaders, runnerUp, gap, strength: strengthOfGap(gap), tied: leaders.length > 1 };
}

export const DIMENSIONS = [
  { key: "economic", label: "经济回报" },
  { key: "growth", label: "职业成长" },
  { key: "experience", label: "工作体验" },
] as const;

export type ReasonRow = {
  key: string;
  label: string;
  /** 加权后对「领先者 − 第二名」的贡献（分）；正数 = 领先者占优。 */
  contribution: number;
  leaderScore: number | null;
  otherScore: number | null;
  /** 用户在该维度上的权重（0–1）。 */
  weight: number | null;
};

/** 差异归因：优先用后端 attribution；缺失时用后端给出的 score_contributions 相减。 */
export function reasonRows(
  leader: OfferReportView,
  other: OfferReportView,
  attribution?: Record<string, number> | null,
): ReasonRow[] {
  return DIMENSIONS.map(({ key, label }) => {
    const fromBackend = attribution?.[key];
    const fallback = (leader.score_contributions?.[key] ?? 0) - (other.score_contributions?.[key] ?? 0);
    return {
      key,
      label,
      contribution: typeof fromBackend === "number" ? fromBackend : fallback,
      leaderScore: leader.dimension_scores?.[key] ?? null,
      otherScore: other.dimension_scores?.[key] ?? null,
      weight: leader.effective_weights?.[key] ?? null,
    };
  }).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

const EPS = 0.05;

/** 一句人话：谁赢在哪、谁在哪更好。 */
export function reasonSentence(rows: ReasonRow[], leaderName: string, otherName: string): string {
  const wins = rows.filter((row) => row.contribution >= EPS);
  const losses = rows.filter((row) => row.contribution <= -EPS);
  const fmt = (row: ReasonRow) => `${row.label}（${row.contribution > 0 ? "+" : "−"}${Math.abs(row.contribution).toFixed(1)}）`;
  const parts: string[] = [];
  if (wins.length) parts.push(`${leaderName}的优势来自${wins.slice(0, 2).map(fmt).join("和")}`);
  if (losses.length) parts.push(`${otherName}在${losses.slice(0, 2).map(fmt).join("和")}上更好`);
  if (!parts.length) return "三个维度的加权差距都很小，没有哪一项真正拉开差距。";
  return `${parts.join("；")}。括号里是按你的权重折算后的分差。`;
}

/** 某项指标上「更好」的一方。并列、数据不足，或差距小到可以忽略（默认相差不到 3%）时不标记。 */
export function bestIndexes(
  values: (number | null | undefined)[],
  direction: "higher" | "lower",
  minRelativeGap = 0.03,
): number[] {
  const known = values
    .map((value, index) => ({ value, index }))
    .filter((item): item is { value: number; index: number } => typeof item.value === "number");
  if (known.length < 2) return [];
  const nums = known.map((k) => k.value);
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const scale = Math.max(Math.abs(max), Math.abs(min));
  if (scale === 0 || (max - min) / scale < minRelativeGap) return [];
  const target = direction === "higher" ? max : min;
  const winners = known.filter((k) => k.value === target).map((k) => k.index);
  return winners.length === known.length ? [] : winners;
}

export type Sensitivity = NonNullable<ResultView["sensitivity"]>;
export type SensitivityFlip = NonNullable<Sensitivity["nearest"]>;

const pctText = (weight: number) => `${Math.round(weight * 100)}%`;
const dimLabel = (key: string) => DIMENSIONS.find((d) => d.key === key)?.label ?? key;

/** 一次翻转的人话描述：把「经济回报」降低到 24%（现在 33%）。 */
export function flipAction(flip: SensitivityFlip): string {
  return `把「${dimLabel(flip.dimension)}」${flip.direction === "up" ? "提高" : "降低"}到 ${pctText(flip.flip_weight)}（现在 ${pctText(flip.current_weight)}）`;
}

/** 「这个结论稳不稳」的标题与一句话解释。offers 用来把 overtaken_by 翻译成 Offer 名。 */
export function stabilityCopy(
  sensitivity: Sensitivity,
  offers: OfferReportView[],
): { level: Sensitivity["status"]; title: string; body: string } {
  const name = (id?: string | null) => {
    const offer = offers.find((item) => item.offer_id === id);
    return offer ? nameOf(offer) : "另一份 Offer";
  };
  const leader = name(sensitivity.leader_id);
  const min = pctText(sensitivity.weight_min ?? 0.05);
  const max = pctText(sensitivity.weight_max ?? 0.9);
  const near = sensitivity.nearest;

  if (sensitivity.status === "tie") {
    return { level: "tie", title: "目前并列", body: "两份 Offer 按你的偏好综合分一样，谁领先完全取决于你更看重哪一项。" };
  }
  // margin：全向扫描（含两维同动）得到的到翻转边界最短距离
  const plane = sensitivity.margin != null
    ? `在权重平面上无论朝哪个方向调，至少要把约 ${Math.max(1, Math.round(sensitivity.margin * 100))} 个百分点从一个维度挪到另一个维度，第一名才会变。`
    : null;
  if (sensitivity.status === "stable" || !near) {
    return {
      level: "stable",
      title: "很稳",
      body: `无论把权重怎么组合（每个维度 ${min}–${max}，包括两个维度同时调整），${leader} 都保持第一。这个结论跟偏好无关。`,
    };
  }
  const result = near.ties ? `会和 ${name(near.overtaken_by)} 并列` : `第一名就会换成 ${name(near.overtaken_by)}`;
  if (sensitivity.status === "fragile") {
    return { level: "fragile", title: "不太稳", body: `只要${flipAction(near)}，${result}。这个排名跟你怎么权衡强相关，建议认真想想你到底更看重什么。${plane ?? ""}` };
  }
  if (sensitivity.status === "moderate") {
    return { level: "moderate", title: "有一定弹性", body: `如果${flipAction(near)}，${result}。你的偏好需要有明显变化，结论才会反过来。${plane ?? ""}` };
  }
  return { level: "steady", title: "比较稳", body: `要${flipAction(near)}，${result}。这需要你的看法和现在相差很远，结论比较可靠。${plane ?? ""}` };
}

/** 该用户可读的「信息」条目，严重度分三档。 */
export type Notice = { level: "important" | "attention" | "note"; title: string; body: string };

/** 这三项缺失时税后金额按当地参考参数估算（与明细弹窗同口径）。 */
const ESTIMATE_KEYS = ["social_security_type", "housing_fund_base_type", "housing_fund_employee_rate"];

/** 只有部分 Offer 填写时，不会进入排名的可选项（与旧版「建议补充」同一口径）。 */
export const OPTIONAL_COMPARABLE = [
  "commute_minutes", "travel_days_per_month", "peak_week_hours", "peak_weeks_year", "weekend_overtime_days_month",
];

export type Gap = { offer: OfferReportView; field: string; reason: "required" | "partial" };

/** 值得补充的信息，按重要性排序：必填缺失 > 只有一方填写的可比项。 */
export function infoGaps(offers: OfferReportView[]): Gap[] {
  const gaps: Gap[] = [];
  for (const offer of offers) {
    for (const field of offer.missing_core ?? []) gaps.push({ offer, field, reason: "required" });
  }
  for (const field of OPTIONAL_COMPARABLE) {
    const known = offers.filter((offer) => offer.input_values?.[field] != null);
    if (known.length === 0 || known.length === offers.length) continue;
    for (const offer of offers) {
      if (offer.input_values?.[field] == null) gaps.push({ offer, field, reason: "partial" });
    }
  }
  return gaps;
}

export function buildNotices(offers: OfferReportView[], verdict: Verdict): Notice[] {
  const notices: Notice[] = [];

  if (verdict.kind === "unranked") {
    const detail = verdict.blockers
      .map(({ offer, fields }) => `${nameOf(offer)} 还缺${fields.map(fieldLabel).join("、")}`)
      .join("；");
    notices.push({
      level: "important",
      title: "暂时不能给出排名",
      body: detail ? `${detail}。七项基本信息都填齐后才会出综合排名，下面只展示已有的分项。` : "七项基本信息都填齐后才会出综合排名。",
    });
  }

  const flagged = offers.filter((offer) => offer.compliance_alert);
  if (flagged.length) {
    notices.push({
      level: "important",
      title: "有缴费安排需要核实",
      body: `${flagged.map(nameOf).join("、")} 的社保或公积金安排需要向公司确认。现金与购买力评分已排除未缴或按最低基数缴费带来的多拿部分。`,
    });
  }

  const estimated = offers.filter((offer) => ESTIMATE_KEYS.some((key) => offer.input_values?.[key] == null));
  if (estimated.length) {
    notices.push({
      level: "attention",
      title: "税后金额里有估算",
      body: `${estimated.map(nameOf).join("、")} 没填社保或公积金细节，税后金额按当地参考参数估算。向公司要一份缴费明细，数字会更准。`,
    });
  }

  const partial = infoGaps(offers).filter((gap) => gap.reason === "partial");
  const partialFields = [...new Set(partial.map((gap) => gap.field))];
  if (partialFields.length) {
    notices.push({
      level: "note",
      title: "有几项还没纳入比较",
      body: `${partialFields.map(fieldLabel).join("、")}只有部分 Offer 填了，所以暂时不影响排名。每份都补上后才会计入。`,
    });
  }
  return notices;
}
