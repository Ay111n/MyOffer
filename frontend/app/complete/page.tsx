"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Compass, Plus, RotateCcw, X } from "lucide-react";
import { Button, Card, ErrorText, Spinner } from "@/components/ui";
import { ChevronRight } from "@/components/guided-ui";
import { Reveal } from "@/components/motion";
import { offerColor } from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  useCreateOffer,
  useCreateSession,
  useDeleteOffer,
  useDefaultWeights,
  useFieldRules,
  useInvalidateSession,
  useOffers,
  usePreferenceQuestionnaire,
  usePreferences,
  usePutPreferences,
  useQuestionsCatalog,
  useResetOffer,
  useStopQuestions,
  useSubmitAnswers,
} from "@/lib/api/hooks";
import { useFlowStore, useHydrateSession } from "@/stores/flow-store";
import { readApiError } from "@/lib/api/errors";
import {
  type FieldDraft,
  type OfferResource,
  type PreferenceAnswer,
  type PreferenceResource,
  type QuestionArea,
  type RenderedQuestion,
} from "@/lib/api/types";
import { nextPathFromPhase } from "@/lib/flow";
import { useComparisonScroll } from "@/lib/use-comparison-scroll";
import { useNavGuard } from "@/lib/use-nav-guard";
import { draftKey, loadDraftsForSession } from "@/lib/draft-storage";
import { bindTelemetrySession, track } from "@/lib/telemetry";
import { PreferenceQuestionnaire } from "@/components/preference-questionnaire";
import { preferenceWeightSummary } from "@/lib/preference-questionnaire";
import {
  FIELD_DEPENDENCY,
  FIELD_VISIBILITY,
  REQUIRED_FIELDS,
  OfferColumn,
  clampToFieldBounds,
  dependencyTriggered,
  questionStatus,
  questionStatusForOffer,
  serverFieldDraft,
  syncFieldBounds,
  type NodeDraft,
} from "@/components/question-parts";

/** Offer 头像字母；配色统一由 offerColor 提供，与报告页保持一致。 */
const AVATAR_LETTERS = ["A", "B", "C"];

const EXAMPLE_OFFERS: Record<string, unknown>[] = [
  { city: "北京", monthly_base: 15000, guaranteed_salary_months: 13, business_level: "core", entry_scope: "small_feature", weekly_work_hours: 46, work_days_per_week: 5, annual_bonus_method: "amount", annual_bonus_value: 15000, signing_bonus: 0, monthly_subsidies: 500, meal_plan: "one_meal", housing_support: "none", social_security_type: "salary", housing_fund_base_type: "salary", housing_fund_employee_rate: 8, special_additional_deductions: ["rent"], mentorship: "assigned", feedback_cadence: "informal_often", commute_minutes: 40, travel_days_per_month: 0 },
  { city: "成都", monthly_base: 11000, guaranteed_salary_months: 13, business_level: "important", entry_scope: "small_feature", weekly_work_hours: 46, work_days_per_week: 5, annual_bonus_method: "amount", annual_bonus_value: 6000, signing_bonus: 0, monthly_subsidies: 200, meal_plan: "one_meal", housing_support: "none", social_security_type: "salary", housing_fund_base_type: "salary", housing_fund_employee_rate: 8, special_additional_deductions: ["rent"], mentorship: "formal", feedback_cadence: "formal_regular", commute_minutes: 35, travel_days_per_month: 0 },
  { city: "上海", monthly_base: 17000, guaranteed_salary_months: 12, business_level: "core", entry_scope: "small_feature", weekly_work_hours: 46, work_days_per_week: 5, annual_bonus_method: "amount", annual_bonus_value: 5000, signing_bonus: 0, monthly_subsidies: 200, meal_plan: "one_meal", housing_support: "none", social_security_type: "salary", housing_fund_base_type: "salary", housing_fund_employee_rate: 8, special_additional_deductions: ["rent"], mentorship: "assigned", feedback_cadence: "occasional", commute_minutes: 40, travel_days_per_month: 0 },
];

const EXAMPLE_DETAILS: Record<string, unknown>[] = [
  { government_talent_subsidy: 0, probation_months: 3, probation_pay_percent: 100, annual_raise_percent: 3, relocation_grant: 0, supplementary_medical_value: 1200, overtime_comp_annual: 0, jd_match_level: "high_match", autonomy_level: "high", problem_complexity_level: "analytical", skill_transferability: "high", training_days_year: 3, training_budget_year: 2000, internal_mobility: "available", portfolio_permission: "anonymized", ai_tool_access: "supported", user_impact_exposure: "indirect", goal_skill_fit: "high", project_stage: "scaling", peak_week_hours: 55, peak_weeks_year: 6, oncall_cadence: "monthly_few", after_hours_response: "occasional", remote_days_week: 1, flex_schedule: "yes", extra_paid_leave: 2, meeting_load: "moderate", manager_support: "high", team_speakup: "open", work_meaning: "high", side_project_policy: "allowed", weekend_overtime_days_month: 1, workspace_comfort: "good", performance_pressure: "low_ratio" },
  { government_talent_subsidy: 0, probation_months: 3, probation_pay_percent: 100, annual_raise_percent: 3, relocation_grant: 0, supplementary_medical_value: 1000, overtime_comp_annual: 0, jd_match_level: "high_match", autonomy_level: "frequent", problem_complexity_level: "complex", skill_transferability: "high", training_days_year: 4, training_budget_year: 2000, internal_mobility: "available", portfolio_permission: "anonymized", ai_tool_access: "supported", user_impact_exposure: "direct", goal_skill_fit: "high", project_stage: "scaling", peak_week_hours: 52, peak_weeks_year: 4, oncall_cadence: "monthly_few", after_hours_response: "occasional", remote_days_week: 0, flex_schedule: "yes", extra_paid_leave: 3, meeting_load: "moderate", manager_support: "high", team_speakup: "open", work_meaning: "high", side_project_policy: "allowed", weekend_overtime_days_month: 0, workspace_comfort: "good", performance_pressure: "low_ratio" },
  { government_talent_subsidy: 0, probation_months: 3, probation_pay_percent: 100, annual_raise_percent: 3, relocation_grant: 0, supplementary_medical_value: 1000, overtime_comp_annual: 0, jd_match_level: "high_match", autonomy_level: "frequent", problem_complexity_level: "analytical", skill_transferability: "high", training_days_year: 3, training_budget_year: 1500, internal_mobility: "available", portfolio_permission: "anonymized", ai_tool_access: "allowed", user_impact_exposure: "indirect", goal_skill_fit: "high", project_stage: "mature", peak_week_hours: 54, peak_weeks_year: 5, oncall_cadence: "monthly_few", after_hours_response: "occasional", remote_days_week: 1, flex_schedule: "yes", extra_paid_leave: 2, meeting_load: "moderate", manager_support: "high", team_speakup: "open", work_meaning: "high", side_project_policy: "allowed", weekend_overtime_days_month: 0, workspace_comfort: "good", performance_pressure: "low_ratio" },
];

/** Offer 上限与示例画像均按 3 份设计。 */
const MAX_OFFERS = 3;
/** 至少保留两份才有对比意义，因此 ≤2 份时不显示删除标识。 */
const MIN_OFFERS = 2;

/** 提交草稿的并发数。实测单次提交往返约 72 ms（公网 RTT 64 ms + 服务端 ~8 ms），
 *  2 份 Offer 要提交 12 次（6 题 × 2 份）。并发数取 4：足以摊平 RTT，
 *  又不会让阻塞在会话锁上的请求占满 uvicorn 的线程池。 */
const SUBMIT_CONCURRENCY = 4;

/** 目录板块（questions 已归一化为数组，见 catalogAreas） */
type NormalizedArea = QuestionArea & { questions: RenderedQuestion[] };
type DisplayArea = { key: string; label: string; questions: RenderedQuestion[] };

const DIMENSION_GROUPS = [
  { key: "economic", label: "经济回报", fieldKeys: new Set<string>([
    "city", "monthly_base", "guaranteed_salary_months", "annual_bonus_method",
    "annual_bonus_value", "annual_bonus_months", "signing_bonus", "government_talent_subsidy", "monthly_subsidies",
    "meal_plan", "housing_support", "social_security_type", "social_security_base",
    "housing_fund_base_type", "housing_fund_employee_rate", "housing_fund_employer_rate",
    "housing_fund_base", "special_additional_deductions",
    "probation_months", "probation_pay_percent", "annual_raise_percent",
    "relocation_grant", "supplementary_medical_value", "overtime_comp_annual",
  ]) },
  { key: "growth", label: "职业成长", fieldKeys: new Set<string>([
    "business_level", "entry_scope", "mentorship", "feedback_cadence",
    "jd_match_level", "autonomy_level", "problem_complexity_level",
    "skill_transferability", "training_days_year", "training_budget_year",
    "internal_mobility", "portfolio_permission", "ai_tool_access",
    "user_impact_exposure", "goal_skill_fit", "project_stage",
  ]) },
  { key: "experience", label: "工作体验", fieldKeys: new Set<string>([
    "weekly_work_hours", "work_days_per_week", "commute_minutes", "travel_days_per_month",
    "peak_week_hours", "peak_weeks_year", "oncall_cadence",
    "after_hours_response", "remote_days_week", "flex_schedule",
    "extra_paid_leave", "meeting_load", "manager_support",
    "team_speakup", "work_meaning", "side_project_policy",
    "weekend_overtime_days_month", "workspace_comfort", "performance_pressure",
  ]) },
];

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
function offerProgress(
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

export default function CompletePage() {
  return (
    <Suspense fallback={<Spinner label="加载信息补全…" />}>
      <CompletePageInner />
    </Suspense>
  );
}

function CompletePageInner() {
  const router = useRouter();
  const sessionId = useFlowStore((s) => s.sessionId);
  const enterSession = useFlowStore((s) => s.enterSession);

  const createSession = useCreateSession();
  const {
    data: offers,
    isLoading: offersLoading,
    error: offersError,
    refetch: retryOffers,
  } = useOffers(sessionId);
  const { data: catalog, isLoading: catalogLoading, error: catalogError } = useQuestionsCatalog(sessionId);
  const {
    data: preferenceQuestionnaire,
    isLoading: preferenceQuestionnaireLoading,
    error: preferenceQuestionnaireError,
    refetch: retryPreferenceQuestionnaire,
  } = usePreferenceQuestionnaire();
  const { data: prefs, isPending: prefsPending } = usePreferences(sessionId);
  const { data: defaultWeights } = useDefaultWeights();
  // 字段数值边界：fields.yaml 经 /meta 下发（单一大事实源），注入 question-parts
  const { data: fieldRules } = useFieldRules();
  useEffect(() => { syncFieldBounds(fieldRules?.bounds); }, [fieldRules]);
  const putPrefs = usePutPreferences();
  // 批量提交时逐条失效会让 catalog 重取 N 轮（实测一次流程放大到 45 次请求、
  // 撞上 nginx 限流打出 503），因此提交走 silent，由下面整批完成后统一失效一次。
  const submit = useSubmitAnswers({ silent: true });
  const invalidateSession = useInvalidateSession();
  const stop = useStopQuestions();
  const createOffer = useCreateOffer();
  const deleteOfferMutation = useDeleteOffer();
  const resetOfferMutation = useResetOffer();

  // 未提交草稿持久化到 sessionStorage（只存未提交内容，按会话+题目隔离；
  // 提交成功立即清除）——移动端手势/程序化导航不再丢草稿。
  const [drafts, setDrafts] = useState<NodeDraft>(() => loadDraftsForSession(sessionId));
  const [error, setError] = useState<string | null>(null);
  /** 底部「生成对比报告」的串行提交进度（x/y） */
  const [submitProgress, setSubmitProgress] = useState<{ done: number; total: number } | null>(null);
  /** 偏好小节的展开/收起。 */
  const [prefExpanded, setPrefExpanded] = useState(false);
  /** 保存成功后立即用于摘要展示，避免等待偏好查询失效/重取造成入口仍显示“开始问卷”。 */
  const [localPreference, setLocalPreference] = useState<{ sessionId: string; data: PreferenceResource } | null>(null);
  /** 分节折叠状态，键 = `${oid}:${sectionKey}`（basics 或 area key） */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** 缺失必填项定位：切到对应 Offer/板块并滚动高亮该行（见 generateReport） */
  const [missingFocus, setMissingFocus] = useState<{ oid: string; fieldKey: string } | null>(null);
  const [deletingOfferId, setDeletingOfferId] = useState<string | null>(null);
  const [resettingOfferId, setResettingOfferId] = useState<string | null>(null);
  const [fillingExamples, setFillingExamples] = useState(false);
  /** 当前标签选中的 Offer；失效（为空/已删除/换会话）时由 activeOffer 兜底到第一份 */
  const [activeOfferId, setActiveOfferId] = useState<string | null>(null);
  const autoCreateStartedRef = useRef(false);
  const hadSessionRef = useRef(false);

  const createSessionAutomatically = useCallback(() => {
    // sessionId 读 store 实时值而非闭包：useHydrateSession 与本函数同在一次
    // effect 提交里先后执行，恢复出的 sid 已写入 store，此时不该再自动建会话
    // （后端 create_session 会替换同身份旧会话，竞态会静默丢掉恢复的工作区）。
    if (useFlowStore.getState().sessionId || autoCreateStartedRef.current) return;
    autoCreateStartedRef.current = true;
    setError(null);
    void createSession.mutateAsync(null)
      .then((session) => {
        enterSession(session.session_id);
      })
      .catch((e) => {
        // 保持“已尝试”标记，避免 mutation 状态变化触发无休止的自动重试；
        // 用户点击“重试”时会显式清除该标记。
        setError("创建会话失败：" + readApiError(e));
      });
  }, [createSession, enterSession]);

  // 恢复本 tab 的会话：必须先于自动建会话的 effect 执行（同提交内按声明顺序）
  useHydrateSession();

  // 根路径现在就是信息填写页。页面没有当前临时工作区时自动创建一个；
  // 本 tab 刷新时 sessionId 已由 useHydrateSession 恢复，不会重复创建。
  useEffect(() => {
    if (sessionId) {
      hadSessionRef.current = true;
      return;
    }
    // 只有离开当前会话后才允许下一次自动创建；创建中的请求保持加锁，
    // 避免 React 重渲染窗口再次提交 POST /sessions 并替换临时会话。
    if (hadSessionRef.current) {
      hadSessionRef.current = false;
      autoCreateStartedRef.current = false;
    }
    createSessionAutomatically();
  }, [createSessionAutomatically, sessionId]);

  // 预取结果页依赖的图表库。结果页首屏约 308 KB，其中 recharts 单文件就占
  // 约 122 KB gzip；而跳转走的是 router.push 程序式导航，不会触发 Link 预取，
  // 所以这 122 KB 只能在点击「生成对比报告」之后才开始下载（1 Mbps 下约 0.95 s），
  // 且与提交严格串行。用户填问卷通常要几分钟，用这段空闲提前把它放进缓存。
  //
  // 注意：不能只靠 router.prefetch —— 实测在 output:'export' 静态导出下，它只取
  // RSC payload（/results 与 *.txt），**不会下载该路由的 JS chunk**。所以这里再
  // 显式动态导入图表模块，强制把 recharts 所在的 chunk 拉进缓存。
  // 延迟 3 s 再发起：首屏约 1.6 s 下载完，避开与关键资源抢那 1 Mbps 带宽。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void import("@/components/charts");
      router.prefetch("/results");
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [router]);

  // 有未提交草稿时启用顶部导航离开守卫（hook 须在提前 return 之前调用）
  const hasAnyDraft = Object.values(drafts).some((perOffer) =>
    Object.values(perOffer).some((fields) => Object.keys(fields).length > 0));
  useNavGuard(hasAnyDraft ? "有未提交的答案草稿" : null);

  const offerList = useMemo(() => offers ?? [], [offers]);

  // telemetry 会话绑定（登出/切换会话时停止上报）
  useEffect(() => { bindTelemetrySession(sessionId); }, [sessionId]);

  // 归一化目录：questions 在 schema 中可缺省（default_factory），统一补齐为空数组。
  const catalogAreas: NormalizedArea[] = useMemo(
    () => (catalog?.areas ?? []).map((a) => ({ ...a, questions: a.questions ?? [] })),
    [catalog],
  );
  const allQuestions = useMemo(
    () => catalogAreas.flatMap((a) => a.questions),
    [catalogAreas],
  );
  const areas = useMemo<DisplayArea[]>(() => DIMENSION_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    questions: allQuestions.map((question) => ({
      ...question,
      fields: (question.fields ?? []).filter((field) => group.fieldKeys.has(field.field_key)),
    })).filter((question) => question.fields.length > 0),
  })), [allQuestions]);

  // 当前标签对应的 Offer：activeOfferId 为空或已被删除时兜底到第一份，
  // 因此删除/换会话都不需要额外的同步 effect。
  const activeOffer = useMemo(
    () => offerList.find((o) => o.offer_id === activeOfferId) ?? offerList[0],
    [offerList, activeOfferId],
  );
  const activeId = activeOffer?.offer_id ?? null;

  useEffect(() => {
    if (!sessionId || catalogAreas.length === 0 || offerList.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const target = offerList.find((offer) => offer.offer_id === params.get("offer"));
    if (!target) return;
    const fieldKey = params.get("field");
    const group = DIMENSION_GROUPS.find((item) => item.fieldKeys.has(fieldKey ?? ""));
    const timer = window.setTimeout(() => {
      setActiveOfferId(target.offer_id);
      if (group || params.get("details") === "1") {
        const groupKey = group?.key ?? "economic";
        autoExpandedOffersRef.current.add(target.offer_id);
        setExpanded((current) => ({
          ...current,
          ...Object.fromEntries(DIMENSION_GROUPS.map((item) => [`${target.offer_id}:${item.key}`, item.key === groupKey])),
        }));
        if (fieldKey && group) setMissingFocus({ oid: target.offer_id, fieldKey });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sessionId, catalogAreas, offerList]);

  // 每份 Offer 第一次被选中时展开第一个分区，其余分区由用户按需展开。
  // 用 ref 记录「已自动展开过」，避免用户手动全部收起后又被强行打开。
  const autoExpandedOffersRef = useRef<Set<string>>(new Set());
  // 分板块 telemetry（step_enter 在展开板块时打点；step_complete 按全 Offer 完成打点）
  const completedStepsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // 换会话（旧会话 404 自动重建等）时两份「已做过」记录都要清零，
    // 否则新会话里同板块不再打点、也不再自动展开第一个分区。
    autoExpandedOffersRef.current.clear();
    completedStepsRef.current.clear();
  }, [sessionId]);
  useEffect(() => {
    if (!activeId || allQuestions.length === 0) return;
    if (autoExpandedOffersRef.current.has(activeId)) return;
    autoExpandedOffersRef.current.add(activeId);
    const firstKey = `${activeId}:${DIMENSION_GROUPS[0].key}`;
    setExpanded((prev) => (prev[firstKey] ? prev : { ...prev, [firstKey]: true }));
  }, [activeId, allQuestions]);

  useEffect(() => {
    for (const a of catalogAreas) {
      if (completedStepsRef.current.has(a.key)) continue;
      if (a.questions.length > 0 && a.questions.every(
        (q) => questionStatus(q, drafts, offerList).label === "已完成",
      )) {
        completedStepsRef.current.add(a.key);
        track("step_complete", { step: a.key });
      }
    }
  }, [catalogAreas, drafts, offerList]);

  // 缺失必填项定位：等切换 Offer / 展开板块的重渲染完成后，滚动到该字段行并短暂高亮。
  useEffect(() => {
    if (!missingFocus) return;
    const timer = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-field-anchor="${missingFocus.oid}:${missingFocus.fieldKey}"]`,
      );
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("field-flash");
        void el.offsetWidth; // 重启动画：连续两次点击生成时也能再次高亮
        el.classList.add("field-flash");
        window.setTimeout(() => el.classList.remove("field-flash"), 2000);
      }
      setMissingFocus(null);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [missingFocus]);

  const toggleSection = useCallback((key: string, areaKey: string | null) => {
    setExpanded((prev) => {
      const opening = !prev[key];
      const next = { ...prev };
      if (opening) {
        // 同一份 Offer 同时只展开一个板块；切换到另一个板块时先收起旧板块。
        const separator = key.indexOf(":");
        const offerPrefix = separator >= 0 ? key.slice(0, separator + 1) : "";
        for (const expandedKey of Object.keys(next)) {
          if (offerPrefix && expandedKey.startsWith(offerPrefix)) next[expandedKey] = false;
        }
        next[key] = true;
        if (areaKey) track("step_enter", { step: areaKey });
      } else {
        next[key] = false;
      }
      return next;
    });
  }, []);

  const setField = useCallback((qkey: string, oid: string, fk: string, draft: FieldDraft | null) => {
    setDrafts((prev) => {
      const node = { ...(prev[qkey] ?? {}) };
      const row = { ...(node[oid] ?? {}) };
      if (draft === null) delete row[fk];
      else row[fk] = draft;
      node[oid] = row;
      return { ...prev, [qkey]: node };
    });
  }, []);

  const changeDraft = useCallback(
    (qkey: string, oid: string, fk: string, d: FieldDraft | null) =>
      setField(qkey, oid, fk, d),
    [setField],
  );

  const fillExamples = async () => {
    if (!sessionId || fillingExamples || createOffer.isPending) return;
    setError(null);
    setFillingExamples(true);
    try {
      const sampleOffers = offerList;
      setDrafts((current) => {
        const next = { ...current };
        for (const offer of sampleOffers) {
          const profile = { ...EXAMPLE_OFFERS[offer.display_order - 1], ...EXAMPLE_DETAILS[offer.display_order - 1] };
          if (!profile) continue;
          for (const question of allQuestions) {
            const row = { ...(next[question.question_key]?.[offer.offer_id] ?? {}) };
            let changed = false;
            for (const field of question.fields ?? []) {
              const key = field.field_key;
              if (!(key in profile) || row[key] || serverFieldDraft(question, offer.offer_id, key)) continue;
              row[key] = { status: "known", value: profile[key] };
              changed = true;
            }
            if (changed) next[question.question_key] = { ...next[question.question_key], [offer.offer_id]: row };
          }
        }
        return next;
      });
    } catch (e) {
      setError("填入示例数据失败：" + readApiError(e));
    } finally {
      setFillingExamples(false);
    }
  };

  // 草稿变化 → 写 sessionStorage（空题删除条目；按 sessionId+questionKey 隔离）
  useEffect(() => {
    if (!sessionId) return;
    try {
      for (const [qkey, perOffer] of Object.entries(drafts)) {
        const empty = Object.values(perOffer).every((fields) => Object.keys(fields).length === 0);
        if (empty) sessionStorage.removeItem(draftKey(sessionId, qkey));
        else sessionStorage.setItem(draftKey(sessionId, qkey), JSON.stringify(perOffer));
      }
    } catch {
      // sessionStorage 不可用（隐私模式/配额满）：草稿只在内存，不中断填写
    }
  }, [sessionId, drafts]);

  // 切换会话：清空内存草稿（sessionStorage 按 sid 隔离，互不影响）
  /* eslint-disable react-hooks/set-state-in-effect -- 从 sessionStorage 恢复当前会话草稿。 */
  useEffect(() => {
    setDrafts(loadDraftsForSession(sessionId));
  }, [sessionId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // 偏好摘要（折叠态展示；hook 必须在提前 return 之前调用）
  const preference = localPreference?.sessionId === sessionId ? localPreference.data : prefs?.data;
  const weightSummary = useMemo(() => preferenceWeightSummary(preference?.weights ?? defaultWeights ?? { economic: 0.34, growth: 0.33, experience: 0.33 }), [preference, defaultWeights]);
  // 首个 Offer 分区展开后，问卷的纵向位置才稳定。
  const initialOfferId = offerList[0]?.offer_id;
  const initialSectionReady = !initialOfferId || allQuestions.length === 0
    || expanded[`${initialOfferId}:${DIMENSION_GROUPS[0].key}`] !== undefined;
  useComparisonScroll(Boolean(sessionId && !offersLoading && !catalogLoading && !offersError && initialSectionReady));

  if (!sessionId) {
    return (
      <Card>
        {error ? (
          <>
            <ErrorText>{error}</ErrorText>
            <Button
              className="mt-4"
              onClick={() => {
                autoCreateStartedRef.current = false;
                createSessionAutomatically();
              }}
            >
              重试
            </Button>
          </>
        ) : (
          <Spinner label="准备信息填写…" />
        )}
      </Card>
    );
  }
  if (offersLoading || catalogLoading) return <Spinner label="加载信息补全…" />;
  if (offersError) {
    return (
      <Card>
        <p className="text-sm text-red-600">无法加载候选项：{readApiError(offersError)}</p>
        <Button className="mt-4" onClick={() => { void retryOffers(); }}>重试加载</Button>
      </Card>
    );
  }

  const enoughOffers = offerList.length >= 2;

  /** 展示用草稿 = 用户编辑覆盖服务端已答状态；服务端状态始终可见（含 不知道/待确认） */
  const mergedDraft = (q: RenderedQuestion, oid: string): Record<string, FieldDraft> => {
    const user = drafts[q.question_key]?.[oid] ?? {};
    const out: Record<string, FieldDraft> = {};
    for (const f of q.fields ?? []) {
      const ud = user[f.field_key];
      const sd = serverFieldDraft(q, oid, f.field_key);
      const dep = FIELD_DEPENDENCY[f.field_key];
      const parent = dep
        ? user[dep.on] ?? serverFieldDraft(q, oid, dep.on)
        : undefined;
      if (!ud && dep && sd?.status === "not_applicable" && !dependencyTriggered(parent, dep)) {
        continue;
      }
      if (ud || sd) out[f.field_key] = ud ?? sd!;
    }
    // 不再代填默认值（v0.7.2）：展示草稿 = 用户编辑 + 服务端已答；
    // 留空字段以 placeholder 提示参考值，不参与提交与进度统计
    return out;
  };

  /** 单题单 Offer 的提交载荷：只携带该 Offer 的草稿（含依赖联动标记），
   *  后端按 offer upsert，不影响其他 Offer 的已答内容。 */
  const buildPayloadFor = (q: RenderedQuestion, oid: string) => {
    const userDrafts = drafts[q.question_key]?.[oid] ?? {};
    const merged = mergedDraft(q, oid);
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
  };

  const hasDraftForOffer = (q: RenderedQuestion, oid: string) =>
    Object.keys(drafts[q.question_key]?.[oid] ?? {}).length > 0;

  /** 提交单题单 Offer：submitted=已写入，noop=无新修改，error=失败 */
  const submitOne = async (q: RenderedQuestion, oid: string): Promise<{
    outcome: "submitted" | "noop" | "error"; message?: string;
  }> => {
    for (const [, d] of Object.entries(drafts[q.question_key]?.[oid] ?? {})) {
      if (d.status === "known" && (d.value === undefined || d.value === "")) {
        return { outcome: "error", message: "已选择的字段需要填写数值，或改选其他选项。" };
      }
    }
    const payload = buildPayloadFor(q, oid);
    if (!payload) {
      const answered = questionStatusForOffer(q, oid, drafts).answered > 0;
      return { outcome: "noop", message: answered
        ? "本题已保存，没有新的修改。"
        : "请先填写内容，再保存。" };
    }
    // 提交前对草稿条目做引用快照：批量提交约 1s 窗口内用户新编辑的字段
    // 对象引用已被替换，清除时按引用一致性区分——已提交的旧编辑清除，
    // 窗口内的新编辑保留（曾整行删除，窗口内输入被静默丢弃）。
    const draftSnapshot = { ...(drafts[q.question_key]?.[oid] ?? {}) };
    const wasAnswered = (q.fields ?? []).some(
      (f) => serverFieldDraft(q, oid, f.field_key) !== undefined);
    try {
      await submit.mutateAsync({ sessionId, questionKey: q.question_key, body: payload });
      // 只清除该 Offer 已提交的草稿字段（其他 Offer 未保存的草稿保留）
      setDrafts((prev) => {
        const node = { ...(prev[q.question_key] ?? {}) };
        const row = { ...(node[oid] ?? {}) };
        for (const [fk, d] of Object.entries(draftSnapshot)) {
          if (row[fk] === d) delete row[fk];
        }
        if (Object.keys(row).length === 0) delete node[oid];
        else node[oid] = row;
        return { ...prev, [q.question_key]: node };
      });
      // 匿名行为事件：只含 question_key / 字段键名 / 计数，绝不含字段值
      track("question_answered", {
        question_key: q.question_key,
        field_count: (q.fields ?? []).length,
      });
      if (wasAnswered) {
        track("answer_changed", {
          question_key: q.question_key,
          field_keys: Object.keys(drafts[q.question_key]?.[oid] ?? {}).slice(0, 10),
        });
      }
      return { outcome: "submitted" };
    } catch (e) {
      return { outcome: "error", message: readApiError(e) };
    }
  };

  /** 新增一份 Offer 并立刻切到它的标签（用户点「＋」后期望直接开始填新的一份）。 */
  const addOffer = async () => {
    setError("");
    if (offerList.length >= MAX_OFFERS) return;
    try {
      const res = await createOffer.mutateAsync({ sessionId, body: {} });
      if ("offer_id" in res.data) setActiveOfferId(res.data.offer_id);
    } catch (e) {
      setError("添加 Offer 失败：" + readApiError(e));
    }
  };

  /** 删除 Offer；若删的是当前标签，切到相邻的一份（优先后一个）。 */
  const removeOffer = async (oid: string) => {
    setError("");
    setDeletingOfferId(oid);
    const idx = offerList.findIndex((o) => o.offer_id === oid);
    const neighbor = offerList[idx + 1] ?? offerList[idx - 1];
    try {
      await deleteOfferMutation.mutateAsync({ sessionId, oid });
      if (activeId === oid) setActiveOfferId(neighbor?.offer_id ?? null);
    } catch (e) {
      setError("删除 Offer 失败：" + readApiError(e));
    } finally {
      setDeletingOfferId(null);
    }
  };

  const resetActiveOffer = async () => {
    if (!activeOffer || !sessionId) return;
    const oid = activeOffer.offer_id;
    setError(null);
    setResettingOfferId(oid);
    try {
      await resetOfferMutation.mutateAsync({ sessionId, oid, version: activeOffer.version });
      const withoutOffer = (source: NodeDraft): NodeDraft => {
        const next: NodeDraft = {};
        for (const [qkey, perOffer] of Object.entries(source)) {
          const remaining = Object.fromEntries(Object.entries(perOffer).filter(([id]) => id !== oid));
          if (Object.keys(remaining).length) next[qkey] = remaining;
        }
        return next;
      };
      // 用最新内存草稿清除当前 Offer，避免请求期间切换标签时覆盖其他编辑。
      setDrafts((current) => withoutOffer(current));
      // 同步移除持久化草稿；后续状态 effect 仍会写入最新内存值。
      const stored = loadDraftsForSession<NodeDraft>(sessionId);
      for (const [qkey, perOffer] of Object.entries(stored)) {
        const remaining = Object.fromEntries(Object.entries(perOffer).filter(([id]) => id !== oid));
        try {
          if (Object.keys(remaining).length) sessionStorage.setItem(draftKey(sessionId, qkey), JSON.stringify(remaining));
          else sessionStorage.removeItem(draftKey(sessionId, qkey));
        } catch { /* 内存草稿仍会清空 */ }
      }
      setMissingFocus(null);
    } catch (e) {
      setError("清空 Offer 失败：" + readApiError(e));
    } finally {
      setResettingOfferId(null);
    }
  };


  const saveQuestionnairePrefs = async (
    answers: PreferenceAnswer[],
    questionnaireVersion: string,
    manualWeights?: Record<string, number>,
  ): Promise<boolean> => {
    setError(null);
    // 偏好查询未返回时不猜版本：误发 version:1 会与已存在的偏好行冲突（409）
    if (prefsPending) {
      setError("偏好信息加载中，请稍候重试");
      return false;
    }
    try {
      const res = await putPrefs.mutateAsync({
        sessionId,
        body: {
          version: prefs?.data?.version ?? 1,
          source: manualWeights ? "manual" : "questionnaire",
          questionnaire_version: questionnaireVersion,
          answers,
          ...(manualWeights ? { weights: manualWeights } : {}),
        },
      });
      setLocalPreference({ sessionId, data: res.data });
      setPrefExpanded(false);
      return true;
    } catch (e) {
      setError("保存偏好失败：" + readApiError(e));
      return false;
    }
  };

  /** 生成报告：先把所有草稿按 题×Offer 串行提交（顺序写保证后端重算有序），
   *  再 stop 进入结果阶段。缺失必填项时不弹全局提示，直接跳到第一个
   *  未填字段（切标签 + 展开板块 + 滚动高亮）；提交失败时保留已提交内容。 */
  const generateReport = async () => {
    setError(null);
    const pending = allQuestions.flatMap((q) =>
      offerList
        .filter((o) => hasDraftForOffer(q, o.offer_id))
        .map((o) => ({ q, oid: o.offer_id })));
    const total = pending.length;
    let saved = 0;
    // 有限并发提交。原先逐条 await，把 12 个公网 RTT 累加成约 0.86 s；
    // 并发后服务端仍由 advisory_lock 按会话串行处理（顺序与结果不受影响），
    // 客户端只需付约 1 个 RTT。首个失败后不再派发新任务，等在途的收尾再报错。
    const queue = [...pending];
    let firstError: string | null = null;
    const worker = async () => {
      for (;;) {
        if (firstError !== null || queue.length === 0) return;
        const item = queue.shift();
        if (!item) return;
        const r = await submitOne(item.q, item.oid);
        if (r.outcome === "error") {
          firstError = r.message ?? "提交失败，请重试。";
          return;
        }
        if (r.outcome === "submitted") saved += 1;
        setSubmitProgress({ done: saved, total });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SUBMIT_CONCURRENCY, total) }, () => worker()),
    );
    if (firstError !== null) {
      setSubmitProgress(null);
      setError((saved > 0 ? `已保存前 ${saved} 项；` : "") + firstError);
      return;
    }
    // 整批提交完再统一失效一次会话缓存：逐条失效会让 offers/questions/preferences
    // 各重取 N 轮，把一次流程放大到 45 次 API 请求并触发 nginx 503（见 hooks 注释）。
    await invalidateSession();
    setSubmitProgress(null);
    // 提交新答案会把后端 phase 恢复为 completion；始终写入 stop 以进入结果阶段
    try {
      await stop.mutateAsync(sessionId);
    } catch (e) {
      setError("进入结果失败：" + readApiError(e) + " 请稍后再试。");
      return;
    }
    router.push(nextPathFromPhase("completion") ?? "/results");
  };

  return (
    <div id="offers" className="mx-auto w-full max-w-5xl">
      <div className="space-y-7">
        {/* ── 头图 ──────────────────────────────────────────── */}
        <Reveal>
          <header className="grid gap-8 border-b border-hairline pb-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-end">
            <div>
              <p className="eyebrow mb-3">MyOffer · 2–3 份毕业后全职 Offer</p>
              <h1 className="page-heading">
                一次录入，多维对比
              </h1>
              <p className="prose-cn mt-4 text-base text-slate-600">
                把收入、成长与工作体验放在一起，看清哪份 Offer 更适合你，以及这个结论还缺哪些信息。
              </p>
            </div>
            <ol className="grid gap-3 text-sm text-slate-600 sm:grid-cols-3 lg:gap-4" aria-label="使用步骤">
              {[
                ["1", "填七项基本信息", "每份 Offer 只需城市、月薪等七项，其余可稍后补。"],
                ["2", "选出你更在意什么", "三道比较题加一道买房题，约一分钟。"],
                ["3", "看结论与下一步", "谁领先、为什么、还该确认什么。"],
              ].map(([n, title, body]) => (
                <li key={n} className="border-t border-slate-300 pt-3">
                  <p className="text-xs font-semibold tabular-nums text-blue-700">0{n}</p>
                  <p className="mt-1 font-semibold text-ink">{title}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{body}</p>
                </li>
              ))}
            </ol>
          </header>
        </Reveal>

        {error && <ErrorText>{error}</ErrorText>}
        {catalogError && (
          <ErrorText>无法加载问题目录：{readApiError(catalogError)}</ErrorText>
        )}

        {/* ── Offer 标签行：切换 + 添加 + 删除（≤2 份时不显示删除标识）── */}
        <OfferTabs
          offers={offerList}
          questions={allQuestions}
          drafts={drafts}
          activeId={activeId}
          deletingId={deletingOfferId}
          creating={createOffer.isPending}
          resetting={resettingOfferId !== null}
          onSelect={setActiveOfferId}
          onAdd={addOffer}
          onReset={resetActiveOffer}
          onDelete={removeOffer}
        />
        <div className="-mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm text-slate-500">
          <p>带 <span className="text-red-600">*</span> 的七项填齐后才显示综合排名；其他信息可稍后补充。</p>
          <button type="button" onClick={() => void fillExamples()} disabled={fillingExamples || createOffer.isPending} title="仅填当前 Offer 的空白项" className="-my-2 inline-flex min-h-11 items-center font-medium text-blue-700 underline-offset-4 hover:underline disabled:opacity-50">{fillingExamples ? "填入中…" : "填入示例数据"}</button>
        </div>

        {/* ── 选中的 Offer 面板（同一时刻只渲染一份，卡内分节折叠）── */}
        {activeOffer && (
          <OfferPanel
            key={activeOffer.offer_id}
            offer={activeOffer}
            areas={areas}
            expanded={expanded}
            onToggleSection={toggleSection}
            onDraftChange={changeDraft}
            mergedDraftOf={mergedDraft}
            drafts={drafts}
          />
        )}

        {/* ── 偏好设置 ────────────── */}
        <Reveal>
          <Card id="preferences" className="scroll-mt-28 bg-blue-50/40 sm:scroll-mt-32">
            <button type="button" aria-expanded={prefExpanded} aria-controls="preference-questionnaire" className="flex w-full items-center gap-4 text-left" onClick={() => setPrefExpanded((expanded) => !expanded)}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-100"><Compass aria-hidden="true" className="h-5 w-5 text-blue-700" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-base font-semibold text-ink">
                  {preference ? "调整我的偏好" : "点击测试我更在意什么"}
                </span>
                {!preference && <span className="mt-1 block text-xs text-slate-500">默认：{weightSummary}</span>}
                <span className="mt-1 block text-xs leading-relaxed text-neutral-500">
                  {preference
                    ? `${preference.source === "manual" ? "手动调整" : "问卷结果"} · ${weightSummary}`
                    : "默认按考虑买房计算"}
                </span>
              </span>
              <span className={`transition-transform ${prefExpanded ? "rotate-90" : ""}`}><ChevronRight /></span>
            </button>
            <div id="preference-questionnaire" hidden={!prefExpanded} className="mt-5 border-t border-slate-100 pt-5">
              <PreferenceQuestionnaire
                sessionId={sessionId}
                definition={preferenceQuestionnaire}
                definitionLoading={preferenceQuestionnaireLoading}
                definitionError={preferenceQuestionnaireError ? readApiError(preferenceQuestionnaireError) : null}
                onRetryDefinition={() => { void retryPreferenceQuestionnaire(); }}
                saved={Boolean(preference)}
                saving={putPrefs.isPending}
                onSaveQuestionnaire={saveQuestionnairePrefs}
                startImmediately
              />
            </div>
          </Card>
        </Reveal>
      </div>

      {/* 操作区占据真实布局空间，手机键盘和长页滚动时不遮挡输入。 */}
      <div id="generate-report" className="action-panel mt-8">
        <div>
          <p className="text-base font-semibold text-ink">准备好，把选择摆上桌</p>
          <p className="mt-1 text-sm text-slate-500">{offerList.length} 份 Offer · 生成前会保存当前填写内容</p>
        </div>
          <Button
            variant="accent"
            className="min-w-52 shrink-0 py-3 text-sm sm:px-8"
            onClick={generateReport}
            disabled={!enoughOffers || submitProgress !== null || stop.isPending || submit.isPending || Boolean(catalogError)}
          >
            {submitProgress
              ? `保存中 ${submitProgress.done}/${submitProgress.total}…`
              : "生成对比报告"}
            {!submitProgress && !stop.isPending && !submit.isPending && <ChevronRight />}
          </Button>
      </div>
    </div>
  );
}

/** Offer 标签行：一行内完成「切换 / 添加 / 删除」。
 *  标签数 ≤2 时不渲染删除标识——至少保留两份才有对比意义。
 *  标签宽度超出时整行横向滚动，不会把页面撑高。 */
function OfferTabs({
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

/** 单份 Offer 的填写面板。 */
function OfferPanel({
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
