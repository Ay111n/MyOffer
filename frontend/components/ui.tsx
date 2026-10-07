"use client";

import { useId } from "react";
import { Info } from "lucide-react";

import { offerColor } from "@/lib/constants";
import { cn } from "@/lib/utils";

/** Offer 字母徽章：A/B/C 在所有页面保持同一身份色 + 字母，颜色不是唯一线索。 */
export function OfferBadge({ display_order, size = "md", children }: {
  display_order: number; size?: "md" | "lg"; children?: React.ReactNode;
}) {
  const styles = size === "lg" ? "h-8 w-8 rounded-lg text-base" : "h-6 w-6 rounded-md text-xs";
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center font-bold text-white", styles)}
      style={{ backgroundColor: offerColor(display_order) }}
    >
      {children ?? String.fromCharCode(64 + display_order)}
    </span>
  );
}

export function Button({
  children, onClick, disabled, variant = "primary", type = "button", className,
}: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean;
  variant?: "primary" | "ghost" | "danger" | "subtle" | "accent"; type?: "button" | "submit"; className?: string;
}) {
  const styles = {
    primary: "bg-ink text-white hover:bg-slate-700 disabled:bg-slate-300",
    accent: "bg-blue-700 text-white hover:bg-blue-800 disabled:bg-slate-300",
    ghost: "border border-slate-300 bg-surface text-slate-800 hover:border-slate-400 hover:bg-slate-50",
    danger: "border border-red-100 bg-red-50 text-red-700 hover:bg-red-100",
    subtle: "text-slate-600 hover:bg-slate-100 hover:text-ink",
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={cn("group inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60", styles, className)}>
      {children}
    </button>
  );
}

/** 面板：仅用于确实需要“被框起来”的内容（空状态、错误、会话提示）。
 *  常规页面结构请用留白 + 分割线，不要到处套 Card。 */
export function Card({ children, className, interactive, id }: { children: React.ReactNode; className?: string; interactive?: boolean; id?: string }) {
  return (
    <div id={id} className={cn(
      "min-w-0 rounded-card border border-hairline bg-surface p-5 sm:p-6",
      interactive && "transition-colors duration-150 hover:border-slate-300",
      className,
    )}>{children}</div>
  );
}

/** 错误提示：role="alert" 让屏幕阅读器立即播报。带图形前缀，不只靠颜色。 */
export function ErrorText({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p role="alert" className={cn("rounded-lg border-l-2 border-red-600 bg-red-50 px-3 py-2 text-sm text-red-700", className)}>{children}</p>;
}

export function Badge({
  children, tone = "neutral",
}: { children: React.ReactNode; tone?: "neutral" | "green" | "amber" | "red" | "blue" }) {
  const styles = {
    neutral: "bg-slate-100 text-slate-600",
    green: "bg-blue-100 text-blue-800",
    amber: "bg-amber-100 text-amber-800",
    red: "bg-red-100 text-red-700",
    blue: "bg-blue-100 text-blue-800",
  }[tone];
  return <span className={cn("inline-flex items-center rounded-md px-2 py-1 text-xs font-medium leading-none", styles)}>{children}</span>;
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1.5 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs leading-5 text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm text-ink outline-none transition placeholder:text-slate-400 focus:border-blue-600 focus:ring-4 focus:ring-blue-100";

export function Spinner({ label = "加载中…" }: { label?: string }) {
  return <div role="status" className="flex items-center justify-center gap-3 p-12 text-sm text-slate-500"><span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-blue-700" />{label}</div>;
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: "green" | "amber" | "red" | "neutral" | "blue"; text: string }> = {
    recommended: { tone: "green", text: "排名明确" },
    pending_risk: { tone: "red", text: "重大风险待确认" },
    pending_information: { tone: "blue", text: "信息有限" },
    preference_sensitive: { tone: "amber", text: "偏好敏感" },
    no_data: { tone: "neutral", text: "暂无数据" },
    sufficient: { tone: "green", text: "结论较稳健" },
    provisional: { tone: "amber", text: "暂时领先" },
    insufficient: { tone: "neutral", text: "信息不足" },
    formal: { tone: "green", text: "正式排名" },
  };
  const v = map[status] ?? { tone: "neutral" as const, text: status };
  return <Badge tone={v.tone}>{v.text}</Badge>;
}

/** 鼠标悬停显示详细说明的小问号图标。
 *  触发器是 `<button>`（键盘可达），弹层走 CSS hover/focus 显示；
 *  通过 aria-describedby 关联弹层，屏幕阅读器可朗读内容。
 *  text 支持 \n 换行（用 whitespace-pre-line 渲染）。
 *  注意：不要给 button 再加 title 属性，否则会和这个自定义弹层重复提示。 */
export function InfoTip({ text }: { text: string }) {
  const tipId = useId();
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label="查看说明"
        aria-describedby={tipId}
        className="inline-flex h-6 w-6 items-center justify-center text-slate-400 transition hover:text-ink focus:text-ink focus:outline-none">
        <Info aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <span id={tipId} role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 hidden -translate-x-1/2 mb-2 w-72 max-w-[min(18rem,calc(100vw-2rem))] whitespace-pre-line rounded-lg border border-slate-200 bg-surface p-3 text-left text-xs leading-relaxed text-slate-700 shadow-float group-hover:block group-focus-within:block max-sm:left-0 max-sm:translate-x-0">
        {text}
      </span>
    </span>
  );
}
