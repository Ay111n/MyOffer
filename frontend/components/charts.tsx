"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { offerColor, type GradeTone } from "@/lib/constants";
import { OfferBadge } from "@/components/ui";

const TOOLTIP_STYLE = {
  borderRadius: 12,
  border: "1px solid #e5e5e5",
  fontSize: 15,
  boxShadow: "0 12px 32px -20px rgba(0,0,0,0.4)",
} as const;

/** recharts 网格/轴刻度的统一颜色。 */
const RADAR_GRID_STROKE = "#e5e5e5";
const LINE_GRID_STROKE = "#f0f0f0";
const RADAR_AXIS_TICK = { fontSize: 13, fill: "#737373" };
const LINE_AXIS_TICK = { fontSize: 13, fill: "#64748b" };

export type RadarOfferInput = {
  offer_id: string;
  display_order: number;
  axes: Record<string, number>;
};

/** 发展水平八轴雷达：每个 Offer 一条轮廓（轴为 0-100 分）。 */
export function DevelopmentRadarChart({ offers }: { offers: RadarOfferInput[] }) {
  if (offers.length === 0) return null;
  // 轴全集取各 Offer 的并集（按首次出现排序）：后端按 Offer 独立裁轴
  // （未作答/城市缺失的轴整轴缺席），只按 offers[0] 取会让其他 Offer
  // 独有的轴从所有轮廓上消失。缺值的 Offer 渲染为 null（tooltip 显示 —）。
  const axes: string[] = [];
  for (const o of offers) {
    for (const key of Object.keys(o.axes)) {
      if (!axes.includes(key)) axes.push(key);
    }
  }
  const data = axes.map((axis) => {
    const row: Record<string, string | number | null> = { axis };
    for (const o of offers) {
      row[`o${o.display_order}`] = o.axes[axis] ?? null;
    }
    return row;
  });

  return (
    <ResponsiveContainer width="100%" height={280}>
      <RadarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 16 }}>
        <PolarGrid stroke={RADAR_GRID_STROKE} />
        <PolarAngleAxis dataKey="axis" tick={RADAR_AXIS_TICK} />
        <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => (typeof v === "number" ? v.toFixed(0) : "—")} />
        <Legend wrapperStyle={{ fontSize: 15 }} />
        {offers.map((o) => (
          <Radar
            key={o.offer_id}
            name={`Offer ${String.fromCharCode(64 + o.display_order)}`}
            dataKey={`o${o.display_order}`}
            stroke={offerColor(o.display_order)}
            fill={offerColor(o.display_order)}
            fillOpacity={0.1}
            strokeWidth={1.8}
            isAnimationActive={false}
            animationDuration={700}
            animationEasing="ease-out"
          />
        ))}
      </RadarChart>
    </ResponsiveContainer>
  );
}

export type MonthlyLineOffer = {
  offer_id: string;
  display_order: number;
  after_tax_by_month: (number | null | undefined)[];
};

/** 12 个月到手曲线：累计预扣法下税率随累计收入爬档。 */
export function MonthlyAfterTaxChart({ offers }: { offers: MonthlyLineOffer[] }) {
  const data = Array.from({ length: 12 }, (_, i) => {
    const row: Record<string, string | number | null> = { month: `${i + 1}月` };
    for (const o of offers) {
      row[`o${o.display_order}`] = o.after_tax_by_month[i] ?? null;
    }
    return row;
  });

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={LINE_GRID_STROKE} vertical={false} />
        <XAxis dataKey="month" tick={LINE_AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis
          width={44}
          tick={LINE_AXIS_TICK}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v))}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => (typeof v === "number" ? `${Math.round(v).toLocaleString("zh-CN")} 元` : "—")} />
        <Legend wrapperStyle={{ fontSize: 15 }} />
        {offers.map((o) => (
          <Line
            key={o.offer_id}
            type="monotone"
            name={`Offer ${String.fromCharCode(64 + o.display_order)}`}
            dataKey={`o${o.display_order}`}
            stroke={offerColor(o.display_order)}
            strokeWidth={2}
            dot={{ r: 2 }}
            isAnimationActive={false}
            animationDuration={700}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export type OfferBarStat = {
  /** 段名（如五险一金的「个」「单」），可选。 */
  name?: string;
  /** 数值文本（调用方格式化，缺失传「—」）。 */
  value: string;
  /** 单位（独立列对齐，1 字为宜）。 */
  unit?: string;
};

export type OfferBarItem = {
  key: string;
  display_order: number;
  /** 单段条数值（与 segments 二选一）：basis="max" 按组内最大值归一，basis="score" 将 0-100 分直接当百分比。 */
  value?: number | null | undefined;
  /** 堆叠段（如五险一金的个人/单位），按合计占比分宽度；label 用于悬停占比提示。 */
  segments?: { value: number; color: string; label?: string }[];
  /** 数值行（多条纵向堆叠，如五险一金的个/单）。 */
  rightStats?: OfferBarStat[];
  /** 模块内排名文案（如「第 1」，同分并列同名次）。 */
  rank?: string;
  /** 模块等级，渲染成带语义色的胶囊标签。 */
  grade?: string;
  gradeTone?: GradeTone;
};

/** 等级胶囊的四档色（红绿灯梯度，与 constants.GradeTone 对应）。 */
const GRADE_CHIP_TONES: Record<string, string> = {
  excellent: "bg-green-100 text-green-700",
  good: "bg-lime-100 text-lime-700",
  fair: "bg-amber-100 text-amber-700",
  poor: "bg-red-100 text-red-700",
};

/** 八模块统一条形图模板：柱子固定占行宽 58%，右侧统计区占满剩余空间并按
 *  「排名 | 数值 | 等级胶囊」三列均匀分布（列位置跨模块一致）；悬停柱子显示填充占比。 */
export function OfferBars({ items, basis = "score", maxHint }: {
  items: OfferBarItem[];
  basis?: "max" | "score";
  maxHint?: number;
}) {
  const max = maxHint ?? Math.max(...items.map((it) => it.value ?? 0), 1);
  return (
    <div className="space-y-2">
      {items.map((it) => {
        const total = (it.segments ?? []).reduce((sum, seg) => sum + (seg.value || 0), 0);
        // 悬停气泡：显示填充占比（与实际填充宽度同口径），堆叠段逐段标注
        const tooltip = it.segments
          ? (total > 0
            ? it.segments.filter((seg) => seg.value > 0)
                .map((seg) => `${seg.label ?? "段"} ${Math.round((seg.value / total) * 100)}%`)
                .join(" · ")
            : undefined)
          : it.value == null
            ? undefined
            : `${Math.round(Math.max(2, Math.min(100, basis === "max" ? (it.value / max) * 100 : it.value)))}%`;
        return (
          <div key={it.key} className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 py-1 sm:flex">
            <OfferBadge display_order={it.display_order} />
            <div className="group relative min-w-0 flex-1 sm:w-[48%] sm:flex-none">
              <div className="flex h-4 w-full overflow-hidden rounded-full bg-neutral-100">
                {it.segments ? (
                  total > 0 && it.segments.map((seg, i) => (
                    seg.value > 0 ? (
                      <div
                        key={i}
                        className="h-full transition-[width] duration-700"
                        style={{ width: `${(seg.value / total) * 100}%`, backgroundColor: seg.color }}
                      />
                    ) : null
                  ))
                ) : (
                  it.value != null && (
                    <div
                      className="h-full rounded-full transition-[width] duration-700"
                      style={{
                        width: `${Math.max(2, Math.min(100, basis === "max" ? (it.value / max) * 100 : it.value))}%`,
                        backgroundColor: offerColor(it.display_order),
                      }}
                    />
                  )
                )}
              </div>
              {tooltip && (
                <div className="pointer-events-none absolute bottom-full left-0 right-0 z-10 mb-1 hidden justify-center group-hover:flex">
                  <span className="rounded-md bg-neutral-900/90 px-2 py-0.5 text-xs text-white shadow-lg">{tooltip}</span>
                </div>
              )}
            </div>
            {(it.rightStats?.length ?? 0) > 0 && (
              <div className="col-start-2 grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
                <span className="whitespace-nowrap text-xs text-slate-500">{it.rank}</span>
                <div className="flex min-w-0 flex-col justify-center gap-0.5">
                  {it.rightStats!.map((s, i) => (
                    <div key={i} className="flex items-center justify-center gap-1">
                      {s.name && <span className="shrink-0 text-xs text-neutral-500">{s.name}</span>}
                      <span className="flex shrink-0 items-center gap-1">
                        <span className="min-w-12 text-right text-xs font-medium tabular-nums text-neutral-800">{s.value}</span>
                        {s.unit && <span className="text-xs text-slate-500">{s.unit}</span>}
                      </span>
                    </div>
                  ))}
                </div>
                <span className="flex shrink-0 justify-end">
                  {it.grade && (
                    <span
                      className={`inline-flex min-h-7 items-center whitespace-nowrap rounded-lg px-2 text-[13px] font-medium ${
                        it.gradeTone ? GRADE_CHIP_TONES[it.gradeTone] : "bg-neutral-100 text-neutral-600"
                      }`}
                    >
                      {it.grade}
                    </span>
                  )}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
