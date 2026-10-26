"use client";

/** 单份 Offer 的填写面板：身份改名行 + 三个维度分区，分区内按输入组聚合渲染题列。 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, PencilLine } from "lucide-react";

import type { FieldDraft, OfferResource, RenderedQuestion } from "@/lib/api/types";
import { usePatchOffer } from "@/lib/api/hooks";
import { useFlowStore } from "@/stores/flow-store";
import { offerColor } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { OfferColumn, questionStatusForOffer, type NodeDraft } from "@/components/question-parts";

export type DisplayArea = { key: string; label: string; questions: RenderedQuestion[] };

const INPUT_GROUPS: Record<string, { label: string; fields: Set<string> }[]> = {
  economic: [
    { label: "常规年度收入", fields: new Set(["city", "monthly_base", "guaranteed_salary_months", "annual_bonus_method", "annual_bonus_value", "annual_bonus_months", "monthly_subsidies", "annual_raise_percent", "overtime_comp_annual"]) },
    { label: "入职阶段收入", fields: new Set(["signing_bonus", "relocation_grant", "government_talent_subsidy"]) },
    { label: "试用期", fields: new Set(["probation_months", "probation_pay_percent"]) },
    { label: "福利与缴纳", fields: new Set(["meal_plan", "housing_support", "supplementary_medical_value", "social_security_type", "social_security_base", "housing_fund_base_type", "housing_fund_employee_rate", "housing_fund_employer_rate", "housing_fund_base", "special_additional_deductions"]) },
  ],
  growth: [
    { label: "业务机会", fields: new Set(["business_level", "user_impact_exposure", "project_stage"]) },
    { label: "承担与自主", fields: new Set(["entry_scope", "autonomy_level"]) },
    { label: "技能积累", fields: new Set(["jd_match_level", "problem_complexity_level", "skill_transferability", "goal_skill_fit"]) },
    { label: "培养支持", fields: new Set(["mentorship", "feedback_cadence", "training_days_year", "training_budget_year"]) },
    { label: "后续选择空间", fields: new Set(["internal_mobility", "portfolio_permission", "ai_tool_access"]) },
  ],
  experience: [
    { label: "时间占用", fields: new Set(["weekly_work_hours", "commute_minutes", "peak_week_hours", "peak_weeks_year", "remote_days_week"]) },
    { label: "休息安排", fields: new Set(["work_days_per_week", "extra_paid_leave"]) },
    { label: "工作边界", fields: new Set(["oncall_cadence", "after_hours_response", "travel_days_per_month", "weekend_overtime_days_month"]) },
    { label: "日常环境", fields: new Set(["flex_schedule", "meeting_load", "manager_support", "team_speakup", "work_meaning", "side_project_policy", "workspace_comfort", "performance_pressure"]) },
  ],
};

/** 身份改名行：公司名（必填，strip 后非空）+ 岗位（选填，可清空）。
 *  失焦或回车保存；改名走 PATCH 只更新身份，不重算评分。 */
function OfferIdentityRow({ offer }: { offer: OfferResource }) {
  const sessionId = useFlowStore((s) => s.sessionId);
  const patch = usePatchOffer();
  const [company, setCompany] = useState(offer.company);
  const [position, setPosition] = useState(offer.position);
  const [saved, setSaved] = useState(false);
  // 服务端值变化（如保存成功后重取）时同步输入框；正在编辑时不打断
  const editingRef = useRef(false);
  useEffect(() => {
    if (!editingRef.current) {
      setCompany(offer.company);
      setPosition(offer.position);
    }
  }, [offer.company, offer.position]);

  const save = (nextCompany: string, nextPosition: string) => {
    editingRef.current = false;
    const trimmedCompany = nextCompany.trim();
    if (!sessionId) return;
    // 公司名空：回退为服务端现值（服务端也会拒绝空名）
    if (!trimmedCompany) {
      setCompany(offer.company);
      setPosition(offer.position);
      return;
    }
    if (trimmedCompany === offer.company && nextPosition === offer.position) return;
    patch.mutate(
      {
        sessionId,
        oid: offer.offer_id,
        body: {
          version: offer.version,
          company: trimmedCompany !== offer.company ? trimmedCompany : undefined,
          position: nextPosition !== offer.position ? nextPosition : undefined,
        },
      },
      {
        onSuccess: () => {
          setSaved(true);
          window.setTimeout(() => setSaved(false), 1600);
        },
        onError: () => {
          // 版本冲突或其他失败：回退为服务端现值，由 invalidate 带回最新 version
          setCompany(offer.company);
          setPosition(offer.position);
        },
      },
    );
  };

  const pending = patch.isPending;
  return (
    <div className="flex flex-col gap-3 border-b border-hairline bg-slate-50/60 px-4 py-4 sm:flex-row sm:items-center sm:gap-4 sm:px-6">
      <span
        aria-hidden="true"
        style={{ backgroundColor: offerColor(offer.display_order) }}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white"
      >
        {String.fromCharCode(64 + offer.display_order)}
      </span>
      <label className="min-w-0 flex-1">
        <span className="mb-1 block text-xs font-medium text-slate-500">公司 / 团队名称</span>
        <input
          type="text"
          value={company}
          disabled={pending}
          maxLength={200}
          placeholder="例如：字节跳动"
          onFocus={() => { editingRef.current = true; }}
          onChange={(e) => setCompany(e.target.value)}
          onBlur={() => save(company, position)}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          aria-label={`${offer.company} 的公司名称`}
          className="min-h-11 w-full rounded-lg border border-hairline bg-white px-3 text-base text-ink outline-none transition focus:border-ink focus:ring-2 focus:ring-ink/10 disabled:opacity-60"
        />
      </label>
      <label className="min-w-0 flex-1">
        <span className="mb-1 block text-xs font-medium text-slate-500">岗位（选填）</span>
        <input
          type="text"
          value={position}
          disabled={pending}
          maxLength={200}
          placeholder="例如：后端开发"
          onFocus={() => { editingRef.current = true; }}
          onChange={(e) => setPosition(e.target.value)}
          onBlur={() => save(company, position)}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          aria-label={`${offer.company} 的岗位`}
          className="min-h-11 w-full rounded-lg border border-hairline bg-white px-3 text-base text-ink outline-none transition focus:border-ink focus:ring-2 focus:ring-ink/10 disabled:opacity-60"
        />
      </label>
      <span aria-live="polite" className="flex min-h-6 shrink-0 items-center text-xs text-slate-500 sm:w-20">
        {pending ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />
            保存中…
          </span>
        ) : saved ? (
          <span className="flex items-center gap-1 text-emerald-600">
            <Check aria-hidden="true" className="h-3.5 w-3.5" />
            已保存
          </span>
        ) : (
          <span className="flex items-center gap-1 text-slate-400">
            <PencilLine aria-hidden="true" className="h-3.5 w-3.5" />
            失焦保存
          </span>
        )}
      </span>
    </div>
  );
}

export function OfferPanel({
  offer,
  areas,
  expanded,
  onToggleSection,
  onDraftChange,
  mergedDraftOf,
  drafts,
}: {
  offer: OfferResource;
  areas: DisplayArea[];
  expanded: Record<string, boolean>;
  onToggleSection: (key: string, areaKey: string | null) => void;
  onDraftChange: (qkey: string, oid: string, fk: string, d: FieldDraft | null) => void;
  mergedDraftOf: (q: RenderedQuestion, oid: string) => Record<string, FieldDraft>;
  /** 与 Offer 卡片角标同源：进度只统计用户编辑/服务端已答，不含默认值 */
  drafts: NodeDraft;
}) {
  const oid = offer.offer_id;
  return (
    <div>
      <section
      id="offer-panel"
      aria-label={offer.company + " · 信息填写"}
      className="min-w-0 animate-panel-in overflow-hidden rounded-card border border-hairline bg-surface"
    >
      <div className="divide-y divide-hairline">
        {/* 身份改名：只影响展示（标签/报告名），不参与评分 */}
        <OfferIdentityRow offer={offer} />
        {/* 三个维度 */}
        {areas.map((area, index) => {
          const key = `${oid}:${area.key}`;
          const open = Boolean(expanded[key]);
          const progress = area.questions.reduce((acc, q) => {
            const p = questionStatusForOffer(q, oid, drafts);
            return { answered: acc.answered + p.answered, total: acc.total + p.total };
          }, { answered: 0, total: 0 });
          return (
            <div key={area.key} id={`section-${oid}-${area.key}`}>
              <SectionRow label={area.label} index={index + 1} progress={progress} open={open} onToggle={() => onToggleSection(key, null)} />
              {open && (
                <div className="border-t border-hairline bg-white px-4 py-1 sm:px-6">
                  {INPUT_GROUPS[area.key].map((group) => {
                    const questions = area.questions.map((q) => ({ ...q, fields: (q.fields ?? []).filter((field) => group.fields.has(field.field_key)) })).filter((q) => q.fields.length);
                    if (!questions.length) return null;
                    return <div key={group.label} className="border-b border-slate-100 py-4 last:border-0">
                      <h3 className="mb-2 text-xs font-semibold tracking-[0.12em] text-slate-500">{group.label}</h3>
                      {questions.map((q) => <OfferColumn key={q.question_key} qkey={q.question_key} oid={oid} name="" showHeader={false} fields={q.fields} draft={mergedDraftOf(q, oid)} onDraftChange={onDraftChange} />)}
                    </div>;
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      </section>
    </div>
  );
}

/** 分区标题：蓝色标记 + 名称 + 展开箭头。 */
function SectionRow({ label, index, progress, open, onToggle }: {
  label: string;
  index: number;
  progress: { answered: number; total: number };
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={open}
      onClick={onToggle}
      className={cn("flex min-h-16 w-full items-center gap-3 px-4 py-4 text-left transition-colors sm:px-6", open ? "bg-slate-50" : "hover:bg-slate-50")}
    >
      <span aria-hidden="true" className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold tabular-nums", open ? "bg-ink text-white" : "bg-slate-100 text-slate-500")}>{index}</span>
      <span className="flex-1 text-base font-semibold text-ink">{label}</span>
      <span className="text-xs tabular-nums text-slate-500">{progress.answered}/{progress.total}</span>
      <ChevronRight className={`shrink-0 text-neutral-400 transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
    </button>
  );
}
