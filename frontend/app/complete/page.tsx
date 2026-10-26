"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Compass } from "lucide-react";
import { Button, Card, ErrorText, Spinner } from "@/components/ui";
import { ChevronRight } from "@/components/guided-ui";
import { Reveal } from "@/components/motion";
import { OfferTabs, MAX_OFFERS } from "@/components/complete/offer-tabs";
import { OfferPanel, type DisplayArea } from "@/components/complete/offer-panel";
import {
  useCreateOffer,
  useCreateSession,
  useDefaultWeights,
  useDeleteOffer,
  useFieldRules,
  useOffers,
  usePatchOffer,
  usePreferenceQuestionnaire,
  usePreferences,
  usePutPreferences,
  useQuestionsCatalog,
  useResetOffer,
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
import { useComparisonScroll } from "@/lib/use-comparison-scroll";
import { useNavGuard } from "@/lib/use-nav-guard";
import { loadDraftsForSession, saveDraft } from "@/lib/draft-storage";
import { bindTelemetrySession, track } from "@/lib/telemetry";
import { clearDemoFlag, markDemoSession } from "@/lib/demo-flag";
import { useGenerateReport } from "@/lib/use-generate-report";
import { EXAMPLE_DETAILS, EXAMPLE_META, EXAMPLE_OFFERS } from "@/lib/example-offers";
import { PreferenceQuestionnaire } from "@/components/preference-questionnaire";
import { preferenceWeightSummary, clearQuestionnaireDraft, readUnsavedQuestionnaireAnswers } from "@/lib/preference-questionnaire";
import {
  FIELD_DEPENDENCY,
  dependencyTriggered,
  questionStatus,
  serverFieldDraft,
  syncFieldBounds,
  type NodeDraft,
} from "@/components/question-parts";

/** 目录板块（questions 已归一化为数组，见 catalogAreas） */
type NormalizedArea = QuestionArea & { questions: RenderedQuestion[] };

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
  const createOffer = useCreateOffer();
  const patchOffer = usePatchOffer();
  const deleteOfferMutation = useDeleteOffer();
  const resetOfferMutation = useResetOffer();

  // 未提交草稿持久化到 localStorage（只存未提交内容，按会话+题目隔离、
  // 24h 过期；提交成功立即清除）——误关标签页/浏览器后重开可恢复。
  const [drafts, setDrafts] = useState<NodeDraft>(() => loadDraftsForSession(sessionId));
  const [error, setError] = useState<string | null>(null);
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
  /** 示例报告直达：全量示例草稿直接生成（结果页打示例横幅）。 */
  const [demoGenerating, setDemoGenerating] = useState(false);
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

  // 预取结果页路由。跳转走 router.push 程序化导航，不会触发 Link 预取；
  // 提前把 /results 的 RSC payload 放进缓存可缩短点击「生成对比报告」后的等待。
  // 延迟 3 s 再发起：避开与首屏关键资源抢带宽。
  // （不再预取图表库：v5 结果页已不渲染 recharts 图表，预取只会白下载 122 KB
  //  永远用不到的 chunk。）
  useEffect(() => {
    const timer = window.setTimeout(() => {
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

  /** 用示例画像构造整套草稿（blanksOnly=true 只填空白，供「填入示例数据」；
   *  demo 模式全量填入）。offersParam 供 demo 传入补建第三份后的最新列表。
   *  返回的新对象与 setDrafts 写入共享引用，供生成链路按引用一致性清理已提交草稿。 */
  const buildExampleDrafts = (blanksOnly: boolean, offersParam?: OfferResource[]): NodeDraft => {
    const targets = offersParam ?? offerList;
    const next: NodeDraft = { ...drafts };
    for (const offer of targets) {
      const profile = { ...EXAMPLE_OFFERS[offer.display_order - 1], ...EXAMPLE_DETAILS[offer.display_order - 1] };
      for (const question of allQuestions) {
        const row = { ...(next[question.question_key]?.[offer.offer_id] ?? {}) };
        let changed = false;
        for (const field of question.fields ?? []) {
          const key = field.field_key;
          if (!(key in profile)) continue;
          if (blanksOnly && (row[key] || serverFieldDraft(question, offer.offer_id, key))) continue;
          row[key] = { status: "known", value: profile[key] };
          changed = true;
        }
        if (changed) next[question.question_key] = { ...next[question.question_key], [offer.offer_id]: row };
      }
    }
    return next;
  };

  const fillExamples = async () => {
    if (!sessionId || fillingExamples || createOffer.isPending) return;
    setError(null);
    setFillingExamples(true);
    try {
      setDrafts(buildExampleDrafts(true));
    } finally {
      setFillingExamples(false);
    }
  };

  // 草稿变化 → 写 localStorage（空题删除条目；按 sessionId+questionKey 隔离；
  // 24h 过期，误关标签页后重开仍可恢复）
  useEffect(() => {
    if (!sessionId) return;
    for (const [qkey, perOffer] of Object.entries(drafts)) {
      const empty = Object.values(perOffer).every((fields) => Object.keys(fields).length === 0);
      saveDraft(sessionId, qkey, empty ? null : perOffer);
    }
  }, [sessionId, drafts]);

  // 切换会话：清空内存草稿（localStorage 按 sid 隔离，互不影响）
  /* eslint-disable react-hooks/set-state-in-effect -- 从本地存储恢复当前会话草稿。 */
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

  /** 「生成对比报告」链路（载荷组装 + 批量提交 + stop + 跳转）见 lib/use-generate-report。
   *  这里只挂两个回调：成功后按引用一致性清除已提交草稿、失败时展示错误。 */
  const { generateReport, submitBatch, stop } = useGenerateReport({
    sessionId,
    drafts,
    offerList,
    allQuestions,
    mergedDraftOf: mergedDraft,
    onClearSubmitted: (submitted) => {
      setDrafts((prev) => {
        const next = { ...prev };
        for (const { q, oid, snapshot } of submitted) {
          const node = { ...(next[q.question_key] ?? {}) };
          const row = { ...(node[oid] ?? {}) };
          for (const [fk, d] of Object.entries(snapshot)) {
            if (row[fk] === d) delete row[fk];
          }
          if (Object.keys(row).length === 0) delete node[oid];
          else node[oid] = row;
          next[q.question_key] = node;
        }
        return next;
      });
    },
    onError: setError,
  });

  /** 一键看示例报告：三份维度互搏的示例（不足三份先补建），写入虚构公司名，
   *  直接走生成链路落到结果页并打示例标记（结果页横幅提供「开始填写我的
   *  Offer」一键清回空白）。补建/改名失败按非关键路径降级继续。 */
  const viewExampleReport = async () => {
    if (!sessionId || demoGenerating || submitBatch.isPending) return;
    setError(null);
    setDemoGenerating(true);
    let current = offerList;
    try {
      while (current.length < MAX_OFFERS) {
        const res = await createOffer.mutateAsync({ sessionId, body: {} });
        if (!("offer_id" in res.data)) break;
        current = [...current, res.data];
      }
      for (const offer of current) {
        const meta = EXAMPLE_META[offer.display_order - 1];
        if (!meta) continue;
        try {
          await patchOffer.mutateAsync({
            sessionId, oid: offer.offer_id,
            body: { version: offer.version, company: meta.company, position: meta.position },
          });
        } catch { /* 命名失败不阻断演示，保持默认 Offer X 称呼 */ }
      }
      markDemoSession();
      await generateReport(buildExampleDrafts(false, current), current);
    } catch (e) {
      setError("生成示例报告失败：" + readApiError(e));
    } finally {
      setDemoGenerating(false);
    }
  };

  /** 用户自己生成真实报告：清掉可能残留的示例标记。
   *  问卷已答完但未保存时先确认（保存成功会清掉问卷草稿，草稿仍在 =
   *  有完整作答未落库）：确定 → 保存并按它生成；取消 → 按当前已保存/默认
   *  权重生成，回答保留在问卷里。半途问卷不拦——权重本就要求全部作答。 */
  const startGenerate = async () => {
    clearDemoFlag();
    if (sessionId && preferenceQuestionnaire) {
      const unsaved = readUnsavedQuestionnaireAnswers(sessionId, preferenceQuestionnaire);
      if (unsaved && window.confirm(
        "偏好问卷的回答还没保存，直接生成将按当前已保存的权重（未保存过则按默认权重）计算。\n"
        + "要先保存这份回答，再按它生成报告吗？",
      )) {
        const ok = await saveQuestionnairePrefs(unsaved, preferenceQuestionnaire.version);
        if (!ok) return; // 保存失败：错误已在页面展示，停在填写页可直接重试
        clearQuestionnaireDraft(sessionId);
      }
    }
    await generateReport();
  };

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
  /** 示例直达只在完全空白时出现：一旦有任何已填内容就不再打扰真实填写。 */
  const nothingFilled = offerList.every((o) => Object.keys(o.facts ?? {}).length === 0)
    && Object.values(drafts).every((perOffer) =>
      Object.values(perOffer).every((fields) => Object.keys(fields).length === 0));

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
        saveDraft(sessionId, qkey, Object.keys(remaining).length ? remaining : null);
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
          <div className="flex flex-wrap items-center gap-x-4">
            {nothingFilled && (
              <button
                type="button"
                onClick={() => void viewExampleReport()}
                disabled={demoGenerating || submitBatch.isPending || stop.isPending}
                title="三份改编自公开校招信息的对比示例（公司名为虚构），覆盖报告、试算、反解等全部功能，随时可清空重来"
                className="-my-2 inline-flex min-h-11 items-center font-medium text-blue-700 underline-offset-4 hover:underline disabled:opacity-50"
              >
                {demoGenerating ? "正在生成示例…" : "先看一份示例报告"}
              </button>
            )}
            <button type="button" onClick={() => void fillExamples()} disabled={fillingExamples || createOffer.isPending} title="为每份 Offer 只填空白项，不覆盖已填内容" className="-my-2 inline-flex min-h-11 items-center font-medium text-blue-700 underline-offset-4 hover:underline disabled:opacity-50">{fillingExamples ? "填入中…" : "填入示例数据"}</button>
          </div>
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
            onClick={() => void startGenerate()}
            disabled={!enoughOffers || submitBatch.isPending || stop.isPending || Boolean(catalogError)}
          >
            {submitBatch.isPending ? "保存中…" : "生成对比报告"}
            {!submitBatch.isPending && !stop.isPending && <ChevronRight />}
          </Button>
      </div>
    </div>
  );
}
