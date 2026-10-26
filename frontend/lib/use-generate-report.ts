"use client";

/**
 * 「生成对比报告」的完整链路：草稿 → 批载荷 → 单次批量提交 → stop → 跳结果页。
 *
 * 载荷组装（含依赖联动与派生值）从 complete 页原样迁入；页面只提供
 * 草稿状态与两个回调（清草稿 / 报错）。提交走批量端点：服务端单事务、
 * 只重算一次、只落一条快照；失败时整批回滚，本地草稿保留可重试。
 */
import { useCallback } from "react";
import { useRouter } from "next/navigation";

import type { FieldDraft, OfferResource, RenderedQuestion, S } from "@/lib/api/types";
import { readApiError } from "@/lib/api/errors";
import { useInvalidateSession, useStopQuestions, useSubmitAnswersBatch } from "@/lib/api/hooks";
import { nextPathFromPhase } from "@/lib/flow";
import { track } from "@/lib/telemetry";
import {
  FIELD_DEPENDENCY,
  FIELD_VISIBILITY,
  clampToFieldBounds,
  dependencyTriggered,
  serverFieldDraft,
  type NodeDraft,
} from "@/components/question-parts";

/** 一次成功提交后需要清理的草稿（引用快照 + telemetry 所需上下文）。 */
type PreparedSubmission = {
  q: RenderedQuestion;
  oid: string;
  snapshot: Record<string, FieldDraft>;
  wasAnswered: boolean;
  fieldKeys: string[];
};

export function useGenerateReport({
  sessionId,
  drafts,
  offerList,
  allQuestions,
  mergedDraftOf,
  onClearSubmitted,
  onError,
}: {
  /** 会话可能尚未建立（store 初始为 null）；生成动作内部自行守卫。 */
  sessionId: string | null;
  drafts: NodeDraft;
  offerList: OfferResource[];
  allQuestions: RenderedQuestion[];
  /** 展示用草稿 = 用户编辑覆盖服务端已答状态（complete 页定义）。 */
  mergedDraftOf: (q: RenderedQuestion, oid: string) => Record<string, FieldDraft>;
  /** 批量提交成功后按引用一致性清除已提交草稿（入参为提交时的引用快照）。 */
  onClearSubmitted: (submitted: PreparedSubmission[]) => void;
  onError: (message: string) => void;
}) {
  const router = useRouter();
  const submitBatch = useSubmitAnswersBatch();
  const invalidateSession = useInvalidateSession();
  const stop = useStopQuestions();

  /** 单题单 Offer 的提交载荷：只携带该 Offer 的草稿（含依赖联动标记），
   *  后端按 offer upsert，不影响其他 Offer 的已答内容。
   *  overrideDrafts：示例报告直达等场景传入即时构造的草稿（不经 React 状态）。 */
  const buildPayloadFor = useCallback((q: RenderedQuestion, oid: string, overrideDrafts?: NodeDraft) => {
    const userDrafts = (overrideDrafts ?? drafts)[q.question_key]?.[oid] ?? {};
    // 覆写草稿只含新构造的用户编辑（新会话无服务端已答），直接视作合并视图
    const merged = overrideDrafts ? userDrafts : mergedDraftOf(q, oid);
    // 只提交用户亲自填写/显式操作的字段：曾把全部 default_value 代填提交，
    // 用户未确认的假设（按工资缴社保、朝九晚六、无出差…）静默参与评分
    const fields: Record<string, FieldDraft> = { ...userDrafts };
    // 依赖联动：父字段取触发值时，未显式填写的子字段随作答自动标记「不适用」
    for (const f of q.fields ?? []) {
      const dep = FIELD_DEPENDENCY[f.field_key];
      if (!dep) continue;
      const pd = merged[dep.on];
      if (dependencyTriggered(pd, dep)) {
        fields[f.field_key] = { status: "not_applicable" };
        continue;
      }
      if (fields[f.field_key]) continue;
      const serverStatus = (merged[f.field_key] ?? serverFieldDraft(q, oid, f.field_key))?.status;
      // 父字段离开触发值时清除残留的「不适用」；父字段被清空/不再满足可见
      // 条件时，服务端残留的 known 值已不可见也不可用，一并撤回为待定，
      // 否则引擎会继续消费一个用户已无法在界面上看到或修改的旧值
      const vis = FIELD_VISIBILITY[f.field_key];
      const parentValue = pd?.status === "known" ? pd.value : undefined;
      const hidden = !vis || !vis.oneOf.includes(parentValue);
      if (serverStatus === "not_applicable" || (hidden && serverStatus === "known")) {
        fields[f.field_key] = { status: "pending" };
      }
    }
    const knownValue = (fieldKey: string): unknown => {
      const value = merged[fieldKey];
      return value?.status === "known" ? value.value : undefined;
    };
    const addDerived = (fieldKey: string, value: unknown) => {
      if (value === undefined || value === null) return;
      if (!(q.fields ?? []).some((field) => field.field_key === fieldKey)) return;
      // 派生值按目标字段的声明边界钳制：源字段与派生目标的合法区间可能
      // 不一致（通勤小时 ≤24 ×60 → 分钟 ≤240；年终奖倍数无上限 → 月数 ≤12），
      // 超界值会被后端 422 整单拒绝，而派生字段对用户隐藏、无法定位修复。
      fields[fieldKey] = {
        status: "known",
        value: typeof value === "number" ? clampToFieldBounds(fieldKey, value) : value,
      };
    };
    if (q.question_key === "q_details") {
      const salary = knownValue("monthly_base");
      // guaranteed_salary_months 不再代填 12：13/15 薪会被静默低估——
      // 留空 = 薪资模块待补充（该字段在表单中紧邻月薪，进度可见）
      if (knownValue("annual_bonus_method") === "multiple") {
        const bonus = knownValue("annual_bonus_value");
        if (typeof bonus === "number") addDerived("annual_bonus_months", bonus);
      }
      const fundType = knownValue("housing_fund_base_type");
      const fundRate = knownValue("housing_fund_employee_rate");
      if (fundType === "none") {
        addDerived("housing_fund_employer_rate", 0);
        addDerived("housing_fund_base", 0);
      } else {
        if (typeof fundRate === "number") addDerived("housing_fund_employer_rate", fundRate);
        if (fundType === "salary" && typeof salary === "number") {
          addDerived("housing_fund_base", salary);
        }
      }
    }
    if (q.question_key === "q_essentials") {
      const parseTime = (value: unknown) => {
        if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return undefined;
        const [hours, minutes] = value.split(":").map(Number);
        return hours * 60 + minutes;
      };
      const start = parseTime(knownValue("work_start_time"));
      const end = parseTime(knownValue("work_end_time"));
      const idle = knownValue("daily_idle_hours");
      const days = knownValue("work_days_per_week");
      if (start !== undefined && end !== undefined && typeof idle === "number" && typeof days === "number") {
        // 跨零点班次（如 22:00-06:00）：end < start 时加 24h，曾算出 0 工时
        const spanMinutes = end >= start ? end - start : end - start + 24 * 60;
        const dailyHours = Math.max(0, spanMinutes / 60 - idle);
        addDerived("weekly_work_hours", dailyHours * days);
      }
      const commute = knownValue("commute_hours");
      if (typeof commute === "number") addDerived("commute_minutes", commute * 60);
      const travelDays = knownValue("travel_days_per_month");
      if (typeof travelDays === "number") {
        addDerived("travel_frequency", travelDays === 0 ? "none"
          : travelDays <= 1 ? "monthly_le1"
            : travelDays <= 4 ? "monthly_2_4"
              : travelDays <= 8 ? "monthly_5_8" : "monthly_gt8");
      }
      if (typeof days === "number") {
        addDerived("weekend_pattern", days <= 5 ? "double_off"
          : days <= 5.5 ? "big_small_week"
            : days <= 6 ? "single_off" : "irregular");
      }
    }
    if (q.question_key === "q_business_profile") {
      const businessLevel: Record<string, string> = {
        core: "core_main", innovative: "strategic_invest", normal: "normal", edge: "edge",
      };
      const growth: Record<string, string> = {
        fast_growth: "fast_growth",
        steady_growth: "steady_growth",
        no_growth: "stable",
        declining: "shrinking",
      };
      const level = knownValue("business_level");
      const trend = knownValue("business_growth_expectation");
      if (typeof level === "string" && businessLevel[level]) {
        addDerived("strategic_position", businessLevel[level]);
      }
      if (typeof trend === "string" && growth[trend]) {
        addDerived("business_trend_status", growth[trend]);
      }
    }
    const items = Object.entries(fields)
      .filter(([fk]) => (q.fields ?? []).some((f) => f.field_key === fk))
      // 只有「已填写但为空」的 known 才丢弃；pending / not_applicable 本身就是有效作答
      .filter(([, d]) => d.status !== "known" || (d.value !== undefined && d.value !== ""))
      .map(([fk, d]) => ({
        field_key: fk,
        // UI 上的「待定」统一发为 unknown
        status: (d.status === "pending" ? "unknown" : d.status) as "known" | "unknown" | "not_applicable",
        value: d.status === "pending" ? undefined : d.value,
        // 仅在有内容时携带 note，避免空串占用字段
        note: d.note?.trim() ? d.note.trim() : null,
      }));
    if (items.length === 0) return null;
    return { answers: [{ offer_id: oid, fields: items }] };
  }, [drafts, mergedDraftOf]);

  /** 生成报告：把全部草稿按题聚合成一次批量提交（服务端单事务、只重算一次、
   *  只落一条快照），再 stop 进入结果阶段。提交失败时服务端整批回滚，
   *  本地草稿原样保留，修正后可直接重试。
   *  overrideDrafts/overrideOffers：示例报告直达场景的即时草稿与即时 Offer
   *  列表（含 demo 中途补建/改名后的最新列表），不经 React 状态。 */
  const generateReport = useCallback(async (overrideDrafts?: NodeDraft, overrideOffers?: OfferResource[]) => {
    if (!sessionId) return;
    const source = overrideDrafts ?? drafts;
    const targets = overrideOffers ?? offerList;
    onError("");
    // 本地先校验所有草稿：「已选但空」的数值字段直接提示，不发请求
    for (const q of allQuestions) {
      for (const o of targets) {
        for (const d of Object.values(source[q.question_key]?.[o.offer_id] ?? {})) {
          if (d.status === "known" && (d.value === undefined || d.value === "")) {
            onError("已选择的字段需要填写数值，或改选其他选项。");
            return;
          }
        }
      }
    }
    // 组装批载荷：一题一条 item，answers 内每 Offer 一条。
    // 提交前对草稿条目做引用快照：提交窗口内用户新编辑的字段对象引用已被
    // 替换，清除时按引用一致性区分——已提交的旧编辑清除，窗口内的新编辑保留
    // （曾整行删除，窗口内输入被静默丢弃）。
    const items: S["BatchAnswerRequest"]["items"] = [];
    const submitted: PreparedSubmission[] = [];
    for (const q of allQuestions) {
      const answers: S["AnswerRequest"]["answers"] = [];
      for (const o of targets) {
        const payload = buildPayloadFor(q, o.offer_id, overrideDrafts);
        if (!payload) continue;
        answers.push(payload.answers[0]);
        submitted.push({
          q,
          oid: o.offer_id,
          snapshot: { ...(source[q.question_key]?.[o.offer_id] ?? {}) },
          wasAnswered: (q.fields ?? []).some(
            (f) => serverFieldDraft(q, o.offer_id, f.field_key) !== undefined),
          fieldKeys: Object.keys(source[q.question_key]?.[o.offer_id] ?? {}).slice(0, 10),
        });
      }
      if (answers.length > 0) items.push({ question_key: q.question_key, answers });
    }
    if (items.length > 0) {
      try {
        await submitBatch.mutateAsync({ sessionId, body: { items } });
      } catch (e) {
        // 原子语义：服务端零写入，草稿全在，修正后重试即可
        onError(`保存失败：${readApiError(e)}。草稿都还在，修正后重试即可。`);
        return;
      }
      onClearSubmitted(submitted);
      // 匿名行为事件（与旧逐条提交同口径）：只含 question_key / 字段键名 / 计数，绝不含字段值
      for (const { q, wasAnswered, fieldKeys } of submitted) {
        track("question_answered", {
          question_key: q.question_key,
          field_count: (q.fields ?? []).length,
        });
        if (wasAnswered) {
          track("answer_changed", { question_key: q.question_key, field_keys: fieldKeys });
        }
      }
    }
    // 整批提交完再统一失效一次会话缓存：逐条失效会让 offers/questions/preferences
    // 各重取 N 轮，把一次流程放大到 45 次 API 请求并触发 nginx 503（见 hooks 注释）。
    await invalidateSession();
    // 提交新答案会把后端 phase 恢复为 completion；始终写入 stop 以进入结果阶段
    try {
      await stop.mutateAsync(sessionId);
    } catch (e) {
      onError("进入结果失败：" + readApiError(e) + " 请稍后再试。");
      return;
    }
    router.push(nextPathFromPhase("completion") ?? "/results");
  }, [allQuestions, buildPayloadFor, drafts, invalidateSession, offerList,
      onClearSubmitted, onError, router, sessionId, stop, submitBatch]);

  return { generateReport, submitBatch, stop };
}
