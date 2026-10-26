"use client";

/**
 * 对比报告的「决策层」：得分 → 结论 → 原因 → 差异 → 可靠性 → 下一步。
 * 所有数字来自后端；这里只负责把它们讲清楚（见 lib/verdict.ts）。
 * 排版优先：用留白、分割线和字号建立层级，而不是一堆卡片。
 */
import Link from "next/link";
import { ArrowRight, Check, CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { OfferReportView } from "@/lib/api/types";
import { fieldLabel, offerColor } from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  DIMENSIONS,
  STRENGTH_SCALE,
  stabilityCopy,
  type Sensitivity,
  bestIndexes,
  buildNotices,
  infoGaps,
  letterOf,
  nameOf,
  reasonRows,
  reasonSentence,
  type Notice,
  type Verdict,
} from "@/lib/verdict";

const money = (value: number | null | undefined) => (value == null ? "—" : `¥${Math.round(value).toLocaleString("zh-CN")}`);
const score = (value: number | null | undefined) => (value == null ? "—" : value.toFixed(1));
const pct = (value: number | null | undefined) => (value == null ? "" : `${Math.round(value * 100)}%`);

function Letter({ offer, size = "md" }: { offer: OfferReportView; size?: "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: offerColor(offer.display_order) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-bold text-white",
        size === "lg" ? "h-9 w-9 rounded-lg text-lg" : "h-6 w-6 rounded-md text-xs",
      )}
    >
      {letterOf(offer)}
    </span>
  );
}

function fixHref(offer: OfferReportView, field: string) {
  return `/complete?offer=${offer.offer_id}&field=${encodeURIComponent(field)}`;
}

/** 缺项提示里的字段名与表单口径一致：年终奖方式选「倍数」时，同一字段是「倍数」而非「金额」。 */
function offerFieldLabel(offer: OfferReportView, field: string): string {
  if (field === "annual_bonus_value" && offer.input_values?.annual_bonus_method === "multiple") {
    return "年终奖倍数";
  }
  return fieldLabel(field);
}

/* ───────────────────────── 1 · 结论 ───────────────────────── */

export function VerdictHero({ verdict }: { verdict: Verdict }) {
  if (verdict.kind === "unranked") {
    const first = verdict.blockers[0];
    return (
      <section aria-labelledby="verdict-section-title" className="border-t border-hairline py-10">
        <h2 id="verdict-section-title" className="section-title">当前结论</h2>
        <h3 id="verdict-title" className="display mt-4">还不能下结论</h3>
        <p className="prose-cn mt-5 text-base text-slate-700">
          每份 Offer 的七项基本信息都填齐后，才会给出综合排名。现在能看的是各维度的分项，先别用它们直接做决定。
        </p>
        {first && (
          <Link
            href={fixHref(first.offer, first.fields[0])}
            className="no-print mt-6 inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-700 px-5 text-sm font-medium text-white hover:bg-blue-800"
          >
            先补充 {nameOf(first.offer)} 的{offerFieldLabel(first.offer, first.fields[0])}
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        )}
      </section>
    );
  }

  const { leaders, runnerUp, gap, strength, tied } = verdict;
  const lead = leaders[0];
  const title = tied ? `${leaders.map(nameOf).join("、")} 并列领先` : `当前更推荐 ${nameOf(lead)}`;
  const scaleIndex = STRENGTH_SCALE.findIndex((item) => item.level === strength.level);

  return (
    <section aria-labelledby="verdict-section-title" className="border-t border-hairline py-10">
      <h2 id="verdict-section-title" className="section-title">当前结论</h2>
      <div className="mt-4 grid gap-10 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] lg:items-end">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            {leaders.map((offer) => <Letter key={offer.offer_id} offer={offer} size="lg" />)}
            <p className="min-w-0 truncate text-lg text-slate-600">
              {leaders.map((offer) => offer.city || "城市待填").join(" / ")}
            </p>
          </div>
          <h3 id="verdict-title" className="display mt-4 break-words">{title}</h3>
          <p className="prose-cn mt-5 text-base text-slate-700">
            {tied
              ? "按你的偏好，它们的综合分一样，分不出先后。下面看看各自赢在哪里，再决定更看重什么。"
              : runnerUp
                ? `综合分 ${score(lead.overall_score)}，比 ${nameOf(runnerUp)} 高 ${gap.toFixed(1)} 分。${strength.meaning}`
                : `综合分 ${score(lead.overall_score)}。`}
          </p>
        </div>

        {!tied && runnerUp && (
          <div className="min-w-0 border-t border-hairline pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
            <p className="text-sm text-slate-500">领先幅度</p>
            <p className="mt-1 flex items-baseline gap-2">
              <span className="metric text-5xl text-ink">+{gap.toFixed(1)}</span>
              <span className="text-base text-slate-600">分 · {strength.label}</span>
            </p>
            <ol aria-label="领先幅度分级（仅用于说明，不影响排名）" className="mt-5 grid grid-cols-4 gap-1.5">
              {STRENGTH_SCALE.map((item, index) => (
                <li key={item.level} aria-current={index === scaleIndex ? "true" : undefined}>
                  <span
                    aria-hidden="true"
                    className={cn("block h-1.5 rounded-full", index <= scaleIndex ? "bg-blue-700" : "bg-slate-200")}
                  />
                  <span className={cn("mt-2 block text-xs leading-4", index === scaleIndex ? "font-semibold text-ink" : "text-slate-500")}>
                    {item.label}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </section>
  );
}

/* ───────────────────────── 2 · 为什么 ───────────────────────── */

export function Reasons({
  verdict, attribution,
}: { verdict: Verdict; attribution?: Record<string, number> | null }) {
  if (verdict.kind !== "ranked" || !verdict.runnerUp) return null;
  const leader = verdict.leaders[0];
  const other = verdict.tied ? verdict.leaders[1] : verdict.runnerUp;
  if (!leader || !other) return null;
  const rows = reasonRows(leader, other, attribution);
  const max = Math.max(1, ...rows.map((row) => Math.abs(row.contribution)));
  const leaderColor = offerColor(leader.display_order);
  const otherColor = offerColor(other.display_order);
  const heading = verdict.tied ? "它们各自赢在哪里" : `为什么是 ${nameOf(leader)}`;

  return (
    <section aria-labelledby="why-title" className="border-t border-hairline py-10">
      <h2 id="why-title" className="section-title">{heading}</h2>
      <p className="section-lede mt-2">{reasonSentence(rows, nameOf(leader), nameOf(other))}</p>

      <div className="mt-8" role="group" aria-label={`${nameOf(leader)} 与 ${nameOf(other)} 的差异来源`}>
        <div className="hidden grid-cols-[10rem_minmax(0,1fr)_9rem] gap-6 pb-3 text-xs text-slate-500 md:grid">
          <span />
          <span className="flex justify-between">
            <span style={{ color: otherColor }} className="font-semibold">← {nameOf(other)} 更好</span>
            <span style={{ color: leaderColor }} className="font-semibold">{nameOf(leader)} 更好 →</span>
          </span>
          <span className="text-right">维度分（{letterOf(leader)} / {letterOf(other)}）</span>
        </div>
        <ul className="divide-y divide-hairline border-y border-hairline">
          {rows.map((row) => {
            const flat = Math.abs(row.contribution) < 0.05;
            const half = Math.min(50, (Math.abs(row.contribution) / max) * 50);
            const positive = row.contribution > 0;
            const verdictText = flat ? "基本持平" : positive ? `${nameOf(leader)} 领先` : `${nameOf(other)} 更好`;
            const signed = `${row.contribution >= 0 ? "+" : "−"}${Math.abs(row.contribution).toFixed(1)}`;
            return (
              <li key={row.key} className="grid gap-x-6 gap-y-2 py-5 md:grid-cols-[10rem_minmax(0,1fr)_9rem] md:items-center">
                <div>
                  <p className="text-base font-semibold text-ink">{row.label}</p>
                  <p className="text-xs text-slate-500">你的权重 {pct(row.weight)}</p>
                </div>
                <div className="min-w-0">
                  <div
                    role="img"
                    aria-label={`${row.label}：${verdictText}，加权后相差 ${signed} 分`}
                    className="relative h-7"
                  >
                    <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px bg-slate-200" />
                    <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-px bg-slate-400" />
                    {!flat && (
                      <span
                        aria-hidden="true"
                        className="absolute top-1.5 h-4 rounded-sm"
                        style={{
                          backgroundColor: positive ? leaderColor : otherColor,
                          width: `${half}%`,
                          ...(positive ? { left: "50%" } : { right: "50%" }),
                        }}
                      />
                    )}
                  </div>
                  <p className="mt-1 text-sm text-slate-600">
                    <span className="metric font-semibold text-ink">{flat ? "±0.0" : signed}</span>
                    <span className="ml-2">{verdictText}</span>
                  </p>
                </div>
                <p className="num text-sm text-slate-600 md:text-right">
                  <span className="sr-only">维度分：</span>
                  {score(row.leaderScore)} <span className="text-slate-400">/</span> {score(row.otherScore)}
                </p>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs leading-5 text-slate-500">
          条形表示该维度按你的权重折算后，拉开了多少综合分。向哪边延伸，就是哪边在这一项上占优。
        </p>
      </div>
    </section>
  );
}

/* ───────────────────────── 3 · 分数总览 ───────────────────────── */

export function Scoreboard({ offers }: { offers: OfferReportView[] }) {
  const dims = [
    { key: "economic", label: "经济回报" },
    { key: "growth", label: "职业成长" },
    { key: "experience", label: "工作体验" },
  ] as const;
  const cols = offers.length === 2 ? "lg:grid-cols-2" : "lg:grid-cols-3";
  return (
    <section aria-label="Offer 对比" className={cn("grid gap-0 border-y border-hairline lg:divide-x lg:divide-hairline", cols)}>
      {offers.map((offer) => {
        const tied = offers.filter((item) => item.overall_rank === offer.overall_rank).length > 1;
        return (
          <article key={offer.offer_id} className="min-w-0 border-b border-hairline py-6 last:border-b-0 lg:border-b-0 lg:px-6 lg:first:pl-0 lg:last:pr-0">
            <div className="flex items-center justify-between gap-3">
              <p className="flex min-w-0 items-center gap-2 text-sm text-slate-600">
                <Letter offer={offer} />
                <span className="truncate">OFFER {letterOf(offer)} · {offer.city || "城市待填"}</span>
              </p>
              {offer.overall_rank != null && (
                <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                  {tied ? "并列第 " : "第 "}{offer.overall_rank} 名
                </span>
              )}
            </div>
            <p className="mt-4 flex items-baseline gap-2">
              <span className="metric text-5xl text-ink">{score(offer.overall_score)}</span>
              <span className="text-sm text-slate-500">/ 100 综合分</span>
            </p>
            <dl className="mt-5 space-y-3">
              {dims.map(({ key, label }) => (
                <div key={key}>
                  <div className="flex items-baseline justify-between text-sm">
                    <dt className="text-slate-600">{label}</dt>
                    <dd className="metric font-semibold text-ink">{score(offer.dimension_scores?.[key])}</dd>
                  </div>
                  <div aria-hidden="true" className="mt-1.5 h-1 rounded-full bg-slate-200">
                    <div className="h-full rounded-full bg-blue-700" style={{ width: `${Math.min(100, offer.dimension_scores?.[key] ?? 0)}%` }} />
                  </div>
                </div>
              ))}
            </dl>
            {(offer.missing_core?.length ?? 0) > 0 && (
              <p className="mt-4 text-xs text-amber-800">待补：{offer.missing_core?.map(fieldLabel).join("、")}</p>
            )}
          </article>
        );
      })}
    </section>
  );
}

/* ───────────────────────── 4 · 差异在哪 ───────────────────────── */

type KeyRow = { label: string; values: string[]; best: number[]; hint?: string };

function keyRows(offers: OfferReportView[]): KeyRow[] {
  const num = (offer: OfferReportView, key: string) => offer.key_numbers?.[key] ?? null;
  const rows: KeyRow[] = [];

  rows.push({
    label: "税前月薪 × 薪数",
    values: offers.map((offer) => {
      const base = Number(offer.input_values?.monthly_base);
      const months = Number(offer.input_values?.guaranteed_salary_months);
      if (!Number.isFinite(base) || offer.input_values?.monthly_base == null) return "—";
      return `${money(base)} × ${Number.isFinite(months) && offer.input_values?.guaranteed_salary_months != null ? months : "—"}`;
    }),
    best: [],
    hint: "名义数字，没扣税",
  });
  const annual = offers.map((offer) => num(offer, "annual_net"));
  rows.push({ label: "每年税后现金", values: annual.map(money), best: bestIndexes(annual, "higher"), hint: "固定薪资，不含年终奖" });
  const power = offers.map((offer) => num(offer, "purchasing_power_monthly"));
  rows.push({ label: "城市调整后月购买力", values: power.map(money), best: bestIndexes(power, "higher"), hint: "到手的钱在当地能买多少" });
  const entry = offers.map((offer) => num(offer, "entry_income_nominal"));
  if (entry.some((value) => (value ?? 0) > 0)) {
    rows.push({ label: "入职一次性收入", values: entry.map(money), best: bestIndexes(entry, "higher"), hint: "签字费、安家费等" });
  }
  const hours = offers.map((offer) => num(offer, "occupied_hours_weekly"));
  rows.push({
    label: "每周占用时间",
    values: hours.map((value) => (value == null ? "—" : `${value.toFixed(1)} 小时`)),
    best: bestIndexes(hours, "lower"),
    hint: "工作加通勤，越少越好",
  });
  return rows;
}

export function KeyNumbers({ offers }: { offers: OfferReportView[] }) {
  // 没有任何真实数字时（例如基本信息还没填）整段不显示，避免一张全是破折号的表。
  const rows = keyRows(offers).filter((row) => row.values.some((value) => value !== "—" && !value.startsWith("—")));
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="diff-title" className="border-t border-hairline py-10">
      <h2 id="diff-title" className="section-title">差异在哪里</h2>
      <p className="section-lede mt-2">分数背后的几个真实数字。较优的一项会标注「较优」。</p>
      <div role="region" aria-label="关键指标横向对比" className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[320px] border-collapse text-left">
          <thead>
            <tr className="border-b border-ink text-xs text-slate-500">
              <th scope="col" className="py-2 pr-3 font-medium"><span className="sr-only">指标</span></th>
              {offers.map((offer) => (
                <th key={offer.offer_id} scope="col" className="px-1.5 py-2 text-right font-semibold text-ink sm:px-2">
                  <span className="inline-flex items-center gap-1.5"><Letter offer={offer} /><span className="max-sm:sr-only">{nameOf(offer)}</span></span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-hairline align-top">
                <th scope="row" className="min-w-[6.5rem] py-4 pr-2 text-sm font-medium leading-5 text-ink sm:pr-3">
                  {row.label}
                  {row.hint && <span className="mt-0.5 block text-xs font-normal text-slate-500 max-sm:hidden">{row.hint}</span>}
                </th>
                {row.values.map((value, index) => {
                  const best = row.best.includes(index);
                  return (
                    <td key={index} className={cn("num whitespace-nowrap px-1.5 py-4 text-right text-sm sm:px-2 sm:text-base", best ? "font-semibold text-blue-800" : "text-slate-700")}>
                      {value.includes(" × ") ? <>{value.split(" × ")[0]}<span className="whitespace-nowrap"> × {value.split(" × ")[1]}</span></> : value}
                      {best && <span className="mt-0.5 block text-xs font-medium text-blue-700">较优</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ───────────────────────── 4b · 这个结论稳不稳（后端 sensitivity） ───────────────────────── */

const STABILITY_TONE: Record<Sensitivity["status"], { tag: string; bar: string }> = {
  stable: { tag: "text-blue-800", bar: "bg-blue-700" },
  steady: { tag: "text-blue-800", bar: "bg-blue-700" },
  moderate: { tag: "text-amber-800", bar: "bg-amber-700" },
  fragile: { tag: "text-red-700", bar: "bg-red-600" },
  tie: { tag: "text-slate-700", bar: "bg-slate-500" },
};

export function Stability({ offers, sensitivity }: { offers: OfferReportView[]; sensitivity?: Sensitivity | null }) {
  if (!sensitivity) return null;
  const copy = stabilityCopy(sensitivity, offers);
  const tone = STABILITY_TONE[sensitivity.status];
  const min = sensitivity.weight_min ?? 0.05;
  const max = sensitivity.weight_max ?? 0.9;
  const pos = (weight: number) => `${Math.max(0, Math.min(100, ((weight - min) / (max - min)) * 100))}%`;
  const leader = offers.find((offer) => offer.offer_id === sensitivity.leader_id);
  const nameById = (id: string) => offers.find((offer) => offer.offer_id === id);
  const showTracks = sensitivity.status !== "tie" && leader;

  return (
    <section aria-labelledby="stability-title" className="border-t border-hairline py-10">
      <h2 id="stability-title" className="section-title">这个结论稳不稳</h2>
      <p className="mt-4 flex items-baseline gap-3">
        <span className={cn("text-2xl font-bold tracking-tight", tone.tag)}>{copy.title}</span>
      </p>
      <p className="prose-cn mt-2 text-base text-slate-700">{copy.body}</p>

      {showTracks && (
        <div className="mt-8">
          <p className="text-sm font-medium text-ink">每一项看得多重，结论才不变？</p>
          <p className="mt-1 text-xs text-slate-500">
            只调整「各维度占多大比重」，不改变你填的任何信息。深色段是 {nameOf(leader)} 保持第一的范围，竖线是你现在的权重。
          </p>
          <ul className="mt-4 divide-y divide-hairline border-y border-hairline">
            {DIMENSIONS.map(({ key, label }) => {
              const flips = (sensitivity.flips ?? []).filter((flip) => flip.dimension === key);
              const down = flips.find((flip) => flip.direction === "down");
              const up = flips.find((flip) => flip.direction === "up");
              const current = (flips[0]?.current_weight ?? leader.effective_weights?.[key] ?? 0);
              const lo = down ? down.flip_weight : min;
              const hi = up ? up.flip_weight : max;
              const summary = !down && !up
                ? `${label}怎么调都不会换人`
                : `${label}在 ${Math.round(lo * 100)}%–${Math.round(hi * 100)}% 之间，${nameOf(leader)} 都是第一`;
              return (
                <li key={key} className="grid gap-x-6 gap-y-2 py-4 md:grid-cols-[10rem_minmax(0,1fr)] md:items-center">
                  <div>
                    <p className="text-base font-semibold text-ink">{label}</p>
                    <p className="text-xs text-slate-500">现在占 {pct(current)}</p>
                  </div>
                  <div className="min-w-0">
                    <div role="img" aria-label={summary} className="relative h-8">
                      <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-slate-200" />
                      <span
                        aria-hidden="true"
                        className={cn("absolute top-1/2 h-2 -translate-y-1/2 rounded-full", tone.bar)}
                        style={{ left: pos(lo), width: `calc(${pos(hi)} - ${pos(lo)})` }}
                      />
                      {[down, up].filter(Boolean).map((flip) => (
                        <span
                          key={flip!.direction}
                          aria-hidden="true"
                          className="absolute top-0 flex h-8 -translate-x-1/2 flex-col items-center"
                          style={{ left: pos(flip!.flip_weight) }}
                        >
                          <span className="h-8 w-px bg-ink" />
                        </span>
                      ))}
                      <span
                        aria-hidden="true"
                        className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink bg-surface"
                        style={{ left: pos(current) }}
                      />
                    </div>
                    <div className="mt-1 flex items-start justify-between gap-3 text-xs text-slate-500">
                      <span className="tabular-nums">{Math.round(min * 100)}%</span>
                      <span className="min-w-0 text-center text-slate-700">
                        {summary}
                        {[down, up].filter(Boolean).map((flip) => {
                          const other = nameById(flip!.overtaken_by);
                          return (
                            <span key={flip!.direction} className="block text-slate-500">
                              {flip!.direction === "up" ? "超过" : "低于"} {Math.round(flip!.flip_weight * 100)}% → {other ? nameOf(other) : "另一份"} {flip!.ties ? "并列" : "反超"}
                            </span>
                          );
                        })}
                      </span>
                      <span className="tabular-nums">{Math.round(max * 100)}%</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <Link href="/#preferences" className="no-print mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-blue-700 hover:text-blue-800">
            到「你的偏好」里试试不同的权重
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </div>
      )}
    </section>
  );
}

/* ───────────────────────── 5 · 这个结论靠不靠谱 ───────────────────────── */

const NOTICE_STYLE: Record<Notice["level"], { label: string; Icon: typeof Info; box: string; tag: string }> = {
  important: { label: "需核实", Icon: TriangleAlert, box: "border-red-600 bg-red-50", tag: "text-red-700" },
  attention: { label: "注意", Icon: CircleAlert, box: "border-amber-700 bg-amber-50", tag: "text-amber-800" },
  note: { label: "说明", Icon: Info, box: "border-slate-300 bg-transparent", tag: "text-slate-600" },
};

export function Reliability({ offers, verdict }: { offers: OfferReportView[]; verdict: Verdict }) {
  const notices = buildNotices(offers, verdict);
  return (
    <section aria-labelledby="reliability-title" className="border-t border-hairline py-10">
      <h2 id="reliability-title" className="section-title">这个结论靠不靠谱</h2>
      <p className="section-lede mt-2">看看有哪些地方是估算、没填或需要向公司核实的。</p>
      {notices.length === 0 ? (
        <p className="mt-6 flex items-start gap-2 text-sm text-slate-700">
          <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-blue-700" />
          目前没有需要特别留意的信息缺口。
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {notices.map((notice) => {
            const style = NOTICE_STYLE[notice.level];
            return (
              <li key={notice.title} className={cn("rounded-lg border-l-2 px-4 py-3", style.box)}>
                <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <style.Icon aria-hidden="true" className={cn("h-4 w-4 shrink-0", style.tag)} />
                  <span className={cn("text-xs", style.tag)}>{style.label}</span>
                  {notice.title}
                </p>
                <p className="mt-1 text-sm leading-6 text-slate-600">{notice.body}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ───────────────────────── 6 · 下一步 ───────────────────────── */

export function NextSteps({ offers }: { offers: OfferReportView[] }) {
  const gaps = infoGaps(offers).slice(0, 3);
  return (
    <section aria-labelledby="next-title" className="no-print border-t border-hairline py-10">
      <h2 id="next-title" className="section-title">接下来可以做什么</h2>
      <p className="section-lede mt-2">补充后回到填写页重新生成报告，结论会自动更新。</p>
      <ul className="mt-6 divide-y divide-hairline border-y border-hairline">
        {gaps.map((gap) => (
          <li key={`${gap.offer.offer_id}-${gap.field}`}>
            <Link href={fixHref(gap.offer, gap.field)} className="group flex min-h-14 items-center justify-between gap-4 py-4">
              <span className="min-w-0">
                <span className="block text-base font-medium text-ink">建议补充：{nameOf(gap.offer)} 的{offerFieldLabel(gap.offer, gap.field)}</span>
                <span className="mt-0.5 block text-sm text-slate-500">
                  {gap.reason === "required" ? "基本信息，不补就没有综合排名" : "其他 Offer 已经填了，补上后才会纳入比较"}
                </span>
              </span>
              <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400 transition-colors group-hover:text-ink" />
            </Link>
          </li>
        ))}
        <li>
          <Link href="/#preferences" className="group flex min-h-14 items-center justify-between gap-4 py-4">
            <span className="min-w-0">
              <span className="block text-base font-medium text-ink">重新想一想你更看重什么</span>
              <span className="mt-0.5 block text-sm text-slate-500">调整三个维度的权重，看排名会不会变</span>
            </span>
            <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400 transition-colors group-hover:text-ink" />
          </Link>
        </li>
      </ul>
    </section>
  );
}
