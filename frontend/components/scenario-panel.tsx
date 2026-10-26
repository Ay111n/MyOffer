"use client";

/**
 * 免写入试算：在最新报告上假设「月薪 / 年终奖倍数 / 每周工时」变化后重打一次分。
 *
 * 面向拿到报告后最自然的追问——「如果谈到 X 会怎样」：
 * - 只调一个 Offer，其他 Offer 保持不变作为对照；
 * - 结果内联对比（排名是否翻转、各 Offer 总分变化），明确标注不改已存数据；
 * - 服务端 scenario 全程不落库、不产生新快照，刷新即回到真实报告。
 */
import { useMemo, useState } from "react";
import { FlaskConical, Target } from "lucide-react";

import { api } from "@/lib/api/client";
import { readApiError } from "@/lib/api/errors";
import type { OfferReportView, ResultView, S } from "@/lib/api/types";
import { offerColor } from "@/lib/constants";
import { cn } from "@/lib/utils";

const DIMENSION_LABELS: Record<string, string> = {
  economic: "经济回报", growth: "职业成长", experience: "工作体验",
};

const money = (value: number) => `¥${Math.round(value).toLocaleString("zh-CN")}`;

/** 谈判建议：按维度加权贡献的差距找出第一名领先最多的维度。
 *  追平线可达时不再说「仅谈月薪效果有限」（与追平结论同屏矛盾），
 *  改为指出可作筹码的其他维度差距。 */
function adviceFor(leader: OfferReportView, target: OfferReportView, reachable: boolean): string | null {
  const gaps = Object.keys(DIMENSION_LABELS)
    .map((key) => ({
      key,
      gap: (leader.score_contributions?.[key] ?? 0) - (target.score_contributions?.[key] ?? 0),
    }))
    .filter((item) => item.gap > 0.05)
    .sort((a, b) => b.gap - a.gap);
  const top = gaps[0];
  if (!top) return null;
  const label = DIMENSION_LABELS[top.key];
  if (top.key === "economic") {
    return `差距主要来自${label}（加权 +${top.gap.toFixed(1)} 分）——谈月薪最直接。`;
  }
  if (reachable) {
    return `月薪追平线如上；领先方更大的优势在${label}（加权 +${top.gap.toFixed(1)} 分），可作为签约前再确认或争取其他条件的筹码。`;
  }
  return `差距主要来自${label}（加权 +${top.gap.toFixed(1)} 分）——仅靠涨薪无法补平，先确认这部分信息再决定。`;
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function ScenarioPanel({
  sessionId, snapshotSeq, offers,
}: {
  sessionId: string;
  snapshotSeq: number;
  offers: OfferReportView[];
}) {
  // 默认试算落后的一份：拿到报告后最常见的动作是「给落后的那份谈一谈」
  const defaultTarget = useMemo(() => {
    const scored = offers.filter((o) => o.overall_score != null);
    if (!scored.length) return offers[0]?.offer_id ?? null;
    return scored.reduce((worst, o) =>
      (o.overall_score ?? Infinity) < (worst.overall_score ?? Infinity) ? o : worst).offer_id;
  }, [offers]);
  const [targetId, setTargetId] = useState<string | null>(defaultTarget);
  const [monthly, setMonthly] = useState("");
  const [bonusFactor, setBonusFactor] = useState("1");
  const [hours, setHours] = useState("");
  const [trial, setTrial] = useState<ResultView | null>(null);
  const [solution, setSolution] = useState<S["ParitySolution"] | null>(null);
  const [solving, setSolving] = useState(false);
  const [solveError, setSolveError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = offers.find((o) => o.offer_id === targetId) ?? null;
  const targetMonthly = typeof target?.input_values?.monthly_base === "number"
    ? target.input_values.monthly_base as number : null;
  // 奖金倍数依赖已填的年终奖事实；没填就禁用该杠杆并说明原因
  const bonusKnown = target != null
    && (target.input_values?.annual_bonus_value != null || target.input_values?.annual_bonus_months != null);
  // 反解只对「非第一名」有意义；并列第一也无需追平
  const leaderOf = useMemo(() => offers.find((o) => o.overall_rank === 1) ?? null, [offers]);
  const solveDisabled = target == null || target.overall_rank === 1;

  const run = async () => {
    if (!target || running) return;
    setError(null);
    const body: S["ReportScenarioRequest"] = { snapshot_seq: snapshotSeq, offer_id: target.offer_id, bonus_factor: 1 };
    const monthlyValue = parseOptionalNumber(monthly);
    if (monthlyValue != null && monthlyValue > 0) body.monthly_base = monthlyValue;
    const factor = parseOptionalNumber(bonusFactor);
    if (bonusKnown && factor != null && factor > 0 && factor !== 1) body.bonus_factor = factor;
    const hoursValue = parseOptionalNumber(hours);
    if (hoursValue != null && hoursValue > 0 && hoursValue <= 168) body.weekly_work_hours = hoursValue;
    if (body.monthly_base == null && body.bonus_factor === 1 && body.weekly_work_hours == null) {
      setError("先调整至少一项（月薪、年终奖倍数或每周工时）再试算。");
      return;
    }
    setRunning(true);
    try {
      const { data, error: apiError } = await api.POST(
        "/api/v1/sessions/{sid}/report/scenario",
        { params: { path: { sid: sessionId } }, body },
      );
      if (apiError) throw apiError;
      setTrial(data.data);
    } catch (e) {
      setError(readApiError(e, "试算失败，请稍后重试。"));
    } finally {
      setRunning(false);
    }
  };

  const reset = () => {
    setMonthly(""); setBonusFactor("1"); setHours(""); setTrial(null); setError(null);
    setSolution(null); setSolveError(null);
  };

  /** 反解追平线：目标 Offer 的月薪谈到多少能追平当前第一名。 */
  const solve = async () => {
    if (!target || solving) return;
    setSolveError(null);
    setSolving(true);
    try {
      const { data, error: apiError } = await api.POST(
        "/api/v1/sessions/{sid}/report/scenario/solve",
        { params: { path: { sid: sessionId } },
          body: { snapshot_seq: snapshotSeq, offer_id: target.offer_id } },
      );
      if (apiError) throw apiError;
      setSolution(data.data);
    } catch (e) {
      setSolveError(readApiError(e, "反解失败，请稍后重试。"));
    } finally {
      setSolving(false);
    }
  };

  return (
    <section aria-labelledby="scenario-title" className="no-print border-t border-hairline py-10">
      <p className="eyebrow">免写入试算</p>
      <h2 id="scenario-title" className="section-title mt-2 flex items-center gap-2">
        <FlaskConical aria-hidden="true" className="h-5 w-5 text-blue-700" />
        试算一下：如果……会怎样
      </h2>
      <p className="section-lede mb-6 mt-2">
        假设某一份 Offer 的月薪、年终奖或工时变了，结论会不会翻转。只在页面上对比，不修改你已保存的数据。
      </p>

      <div className="rounded-card border border-hairline bg-surface p-4 sm:p-6">
        {/* 选择试算对象 */}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="选择试算的 Offer">
          <span className="text-sm text-slate-500">调整对象</span>
          {offers.map((offer) => (
            <button
              key={offer.offer_id}
              type="button"
              aria-pressed={offer.offer_id === targetId}
              onClick={() => { setTargetId(offer.offer_id); setTrial(null); }}
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors",
                offer.offer_id === targetId
                  ? "border-ink bg-surface text-ink"
                  : "border-hairline text-slate-600 hover:border-slate-300",
              )}
            >
              <span
                aria-hidden="true"
                style={{ backgroundColor: offerColor(offer.display_order) }}
                className="flex h-5 w-5 items-center justify-center rounded text-[11px] font-bold text-white"
              >
                {String.fromCharCode(64 + offer.display_order)}
              </span>
              {offer.company}
            </button>
          ))}
        </div>

        {/* 三个杠杆 */}
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <label>
            <span className="mb-1 block text-xs font-medium text-slate-500">
              调整后月薪（元）{targetMonthly != null && <span className="font-normal">· 当前 {targetMonthly.toLocaleString("zh-CN")}</span>}
            </span>
            <input
              type="number" inputMode="numeric" min={1} max={1000000} step={500}
              value={monthly} onChange={(e) => setMonthly(e.target.value)}
              placeholder={targetMonthly != null ? targetMonthly.toLocaleString("zh-CN") : "如 16000"}
              disabled={running || !target}
              aria-label="试算月薪"
              className="min-h-11 w-full rounded-lg border border-hairline bg-white px-3 text-base text-ink outline-none transition focus:border-ink focus:ring-2 focus:ring-ink/10 disabled:opacity-60"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium text-slate-500">
              年终奖倍数{bonusKnown ? "" : " · 未填年终奖，不可用"}
            </span>
            <input
              type="number" min={0} max={2} step={0.1}
              value={bonusFactor} onChange={(e) => setBonusFactor(e.target.value)}
              placeholder="1"
              disabled={running || !target || !bonusKnown}
              aria-label="试算年终奖倍数"
              className="min-h-11 w-full rounded-lg border border-hairline bg-white px-3 text-base text-ink outline-none transition focus:border-ink focus:ring-2 focus:ring-ink/10 disabled:opacity-60"
            />
          </label>
          <label>
            <span className="mb-1 block text-xs font-medium text-slate-500">每周工时（小时）</span>
            <input
              type="number" min={1} max={168} step={1}
              value={hours} onChange={(e) => setHours(e.target.value)}
              placeholder="如 40"
              disabled={running || !target}
              aria-label="试算每周工时"
              className="min-h-11 w-full rounded-lg border border-hairline bg-white px-3 text-base text-ink outline-none transition focus:border-ink focus:ring-2 focus:ring-ink/10 disabled:opacity-60"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button" onClick={() => void run()} disabled={running || !target}
            className="inline-flex min-h-11 items-center rounded-lg bg-ink px-5 text-sm font-medium text-white transition hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? "试算中…" : "重新试算"}
          </button>
          {(monthly || bonusFactor !== "1" || hours || trial) && (
            <button type="button" onClick={reset} className="inline-flex min-h-11 items-center text-sm text-slate-500 underline underline-offset-4 hover:text-slate-700">
              清除试算
            </button>
          )}
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        </div>

        {/* 反解追平线：从「如果……会怎样」到「要谈多少才追平」 */}
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline pt-4">
          <Target aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400" />
          <span className="text-sm text-slate-500">
            {target ? `反解：${target.company} 的月薪谈到多少能追平 ${leaderOf?.company ?? "第一名"}？` : "反解追平线"}
          </span>
          <button
            type="button" onClick={() => void solve()}
            disabled={solving || solveDisabled || !target}
            title={solveDisabled ? "该 Offer 已并列第一或领先，无需追平" : "二分求解追平当前第一名所需的最低月薪"}
            className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 transition hover:border-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {solving ? "计算中…" : "算出追平线"}
          </button>
          {solveDisabled && target && (
            <span className="text-xs text-slate-400">{target.company} 已并列第一或领先，无需追平。</span>
          )}
          {solveError && <p role="alert" className="text-sm text-red-600">{solveError}</p>}
        </div>
        {solution && target && (
          <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50/40 p-4" aria-live="polite">
            {solution.required_value != null ? (
              <p className="text-sm leading-6 text-slate-700">
                {target.company} 的月薪谈到 <strong className="text-ink">{money(solution.required_value)}</strong>
                （{solution.delta ? `+${money(solution.delta)}` : "持平"}，现在 {money(solution.current_value)}）
                即可与 {leaderOf?.company ?? "当前第一名"} 以 {solution.leader_score.toFixed(1)} 分并列第一。
              </p>
            ) : (
              <p className="text-sm leading-6 text-slate-700">
                在合理月薪范围内（至多 ¥1,000,000/月）仅靠涨薪无法追平——差距不止在经济回报，建议先补齐其他维度的信息再决定。
              </p>
            )}
            {leaderOf && adviceFor(leaderOf, target, solution.required_value != null) && (
              <p className="mt-1.5 text-sm text-slate-600">{adviceFor(leaderOf, target, solution.required_value != null)}</p>
            )}
            <p className="mt-1.5 text-xs text-slate-400">反解结果仅供谈判参考，同样不修改已保存的数据。</p>
          </div>
        )}

        {/* 试算结果：内联对比，不写回 */}
        {trial && target && (
          <div className="mt-5 rounded-xl border border-blue-100 bg-blue-50/50 p-4" aria-live="polite">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              {offers.map((offer) => {
                const before = offer.overall_score;
                const after = trial.overall_scores?.[offer.offer_id] ?? null;
                const delta = before != null && after != null ? after - before : null;
                const nowFirst = trial.ranking?.[0] === offer.offer_id;
                return (
                  <div key={offer.offer_id} className="min-w-36">
                    <p className="flex items-center gap-1.5 text-xs text-slate-500">
                      <span aria-hidden="true" style={{ backgroundColor: offerColor(offer.display_order) }} className="h-2.5 w-2.5 rounded-full" />
                      {offer.company}
                      {nowFirst && <span className="font-semibold text-blue-700">调整后第一</span>}
                    </p>
                    <p className="metric mt-0.5 text-lg text-ink tabular-nums">
                      {after != null ? after.toFixed(1) : "—"}
                      {delta != null && Math.abs(delta) >= 0.05 && (
                        <span className={cn("ml-1.5 text-xs font-semibold", delta > 0 ? "text-emerald-600" : "text-red-500")}>
                          {delta > 0 ? "+" : ""}{delta.toFixed(1)}
                        </span>
                      )}
                    </p>
                  </div>
                );
              })}
            </div>
            {target.dimension_scores && (
              <p className="mt-3 text-sm leading-6 text-slate-600">
                {target.company} 的维度分变为：
                {Object.entries(DIMENSION_LABELS).map(([key, label]) => {
                  const after = trial.offers?.find((o) => o.offer_id === target.offer_id)?.dimension_scores?.[key];
                  return ` ${label} ${after != null ? after.toFixed(1) : "—"}`;
                })}。
              </p>
            )}
            <p className="mt-1.5 text-xs text-slate-400">以上为试算结果，未修改已保存的数据；刷新或离开本页即恢复真实报告。</p>
          </div>
        )}
      </div>
    </section>
  );
}
