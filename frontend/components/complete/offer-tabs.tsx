"use client";

/** Offer 标签行：一行内完成「切换 / 添加 / 删除 / 清空」。
 *  标签数 ≤2 时不渲染删除标识——至少保留两份才有对比意义。
 *  标签宽度超出时整行横向滚动，不会把页面撑高。 */
import { Plus, RotateCcw, X } from "lucide-react";

import type { OfferResource, RenderedQuestion } from "@/lib/api/types";
import { offerColor } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { REQUIRED_FIELDS, serverFieldDraft, type NodeDraft } from "@/components/question-parts";

/** Offer 上限与示例画像均按 3 份设计。 */
export const MAX_OFFERS = 3;
/** 至少保留两份才有对比意义，因此 ≤2 份时不显示删除标识。 */
export const MIN_OFFERS = 2;

/** Offer 头像字母；配色统一由 offerColor 提供，与报告页保持一致。 */
const AVATAR_LETTERS = ["A", "B", "C"];

/** 作答进度三态：标签上的状态点与文案共用同一套判定。 */
type ProgressState = "todo" | "doing" | "done";

const PROGRESS_TEXT: Record<ProgressState, string> = {
  todo: "待填写",
  doing: "填写中",
  done: "已完成",
};

/** 状态点配色：选中标签（蓝底）与浅色底都要能看清，因此各给一档。 */
const PROGRESS_DOT: Record<ProgressState, { onActive: string; onIdle: string }> = {
  todo: { onActive: "bg-white/40", onIdle: "bg-neutral-300" },
  doing: { onActive: "bg-blue-300", onIdle: "bg-blue-500" },
  done: { onActive: "bg-white", onIdle: "bg-emerald-500" },
};

function progressStateOf(p: { answered: number; total: number }): ProgressState {
  if (p.answered === 0) return "todo";
  return p.answered < p.total ? "doing" : "done";
}

/** 单份 Offer 跨全部题板的作答进度（标签状态点与面板共用）。 */
export function offerProgress(
  questions: RenderedQuestion[], oid: string, drafts: NodeDraft,
): { answered: number; total: number } {
  let answered = 0;
  for (const q of questions) {
    for (const field of q.fields ?? []) {
      if (!REQUIRED_FIELDS.has(field.field_key)) continue;
      const value = drafts[q.question_key]?.[oid]?.[field.field_key] ?? serverFieldDraft(q, oid, field.field_key);
      if (value?.status === "known" && value.value !== null && value.value !== "") answered++;
    }
  }
  return { answered, total: REQUIRED_FIELDS.size };
}

export function OfferTabs({
  offers,
  questions,
  drafts,
  activeId,
  deletingId,
  creating,
  resetting,
  onSelect,
  onAdd,
  onReset,
  onDelete,
}: {
  offers: OfferResource[];
  questions: RenderedQuestion[];
  drafts: NodeDraft;
  activeId: string | null;
  deletingId: string | null;
  creating: boolean;
  resetting: boolean;
  onSelect: (oid: string) => void;
  onAdd: () => void;
  onReset: () => void;
  onDelete: (oid: string) => void;
}) {
  const canDelete = offers.length > MIN_OFFERS;
  const full = offers.length >= MAX_OFFERS;
  return (
    <div
      role="group"
      aria-label="Offer 切换"
      className="flex flex-wrap items-stretch gap-3"
    >
      {offers.map((o, i) => {
        const active = o.offer_id === activeId;
        const progress = offerProgress(questions, o.offer_id, drafts);
        const state = progressStateOf(progress);
        const dot = PROGRESS_DOT[state];
        return (
          <div key={o.offer_id} className="relative min-w-0 flex-1 basis-40">
            <button
              type="button"
              aria-current={active ? "true" : undefined}
              aria-controls="offer-panel"
              onClick={() => onSelect(o.offer_id)}
              className={cn(
                "flex min-h-20 w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors duration-150",
                "pr-3",
                active
                  ? "border-ink bg-surface text-ink"
                  : "border-hairline bg-transparent text-slate-600 hover:border-slate-300 hover:bg-surface",
              )}
            >
              <span
                aria-hidden="true"
                style={{ backgroundColor: offerColor(i + 1) }}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white"
              >
                {AVATAR_LETTERS[i % AVATAR_LETTERS.length]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-base font-semibold">{o.company}</span>
                <span className="mt-0.5 block text-xs font-normal tabular-nums text-slate-500">{PROGRESS_TEXT[state]} · {progress.answered}/{progress.total}</span>
              </span>
              <span
                aria-hidden="true"
                className={cn("h-2 w-2 shrink-0 rounded-full", dot.onIdle)}
              />
              <span className="sr-only">
                {PROGRESS_TEXT[state]}，已填 {progress.answered}/{progress.total} 项
              </span>
            </button>
            {canDelete && (
              <button
                type="button"
                aria-label={"删除 " + o.company}
                title="删除该 Offer"
                disabled={deletingId === o.offer_id}
                onClick={() => onDelete(o.offer_id)}
                className="absolute right-0.5 top-0.5 flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={full ? onReset : onAdd}
        disabled={creating || resetting || (full && !activeId)}
        aria-label={full ? "清空当前 Offer 已填内容" : "添加 Offer"}
        title={full ? "清空当前选中的 Offer，恢复初始状态" : "添加一份 Offer"}
        className="flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 px-4 text-sm font-medium text-slate-600 transition hover:border-blue-400 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {creating || resetting ? (
          <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />
        ) : full ? (
          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
        ) : (
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
        )}
        <span className="whitespace-nowrap">
          {resetting ? "清空中…" : creating ? "添加中…" : full ? "清空当前 Offer" : "添加 Offer"}
        </span>
      </button>
    </div>
  );
}
