"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, ErrorText, Spinner } from "@/components/ui";
import { SectionHeading } from "@/components/guided-ui";
import type {
  PreferenceAnswer,
  PreferenceQuestion,
  PreferenceQuestionnaireResource,
} from "@/lib/api/types";
import {
  PREFERENCE_DIMENSION_LABELS,
  PREFERENCE_DIMENSION_ORDER,
  clearQuestionnaireDraft,
  normalizeManualWeights,
  rebalanceWeightPercentages,
  preferenceQuestionnaireDraftKey,
  roundWeightsToPercentages,
  scorePreferenceAnswers,
} from "@/lib/preference-questionnaire";

type Weights = Record<string, number>;
type View = "intro" | "questions" | "result";

/** definition 未就绪时的稳定空数组：避免每次渲染新建 [] 使 useMemo 依赖失效。 */
const NO_QUESTIONS: PreferenceQuestion[] = [];

const DIMENSION_COLORS: Record<string, { solid: string; soft: string; text: string }> = {
  economic: { solid: "#b98a3e", soft: "#f8f2e6", text: "#7a5520" },
  growth: { solid: "#5f7ea3", soft: "#edf1f6", text: "#38557a" },
  experience: { solid: "#4f8a77", soft: "#eaf2ee", text: "#2f6552" },
};

const LEGACY_QUESTION_COPY: Record<string, [string, string]> = {
  economic_vs_growth: ["经济回报和职业成长，你更看重哪边？", "钱包更鼓，还是履历更硬？"],
  economic_vs_experience: ["经济回报和工作体验，你更看重哪边？", "多搞点钱，还是少点班味？"],
  growth_vs_experience: ["职业成长和工作体验，你更看重哪边？", "简历开挂，还是下班有命？"],
  buy_house_intent: ["毕业后 3–5 年考虑在工作城市买房吗？", "未来 3–5 年，在工作城市买房这事儿上日程吗？"],
};

const LEGACY_DIMENSION_COPY: Record<string, [string, string]> = {
  economic: ["税后收入与城市购买力", "钱包能鼓多少：税后收入与城市购买力"],
  growth: ["业务与新人承担层级", "履历能有多硬：业务与新人承担层级"],
  experience: ["工时与每周占用", "班味有多浓：工时与每周占用"],
};

function currentCopy(value: string, legacy?: [string, string]): string {
  return legacy && value === legacy[0] ? legacy[1] : value;
}

type Draft = {
  version: string;
  answers: PreferenceAnswer[];
  currentIndex: number;
};

function colorFor(key: string) {
  return DIMENSION_COLORS[key] ?? { solid: "#111827", soft: "#f3f4f6", text: "#374151" };
}

function answerList(
  questions: PreferenceQuestion[],
  answers: Record<string, string>,
): PreferenceAnswer[] {
  return questions
    .map((question) => ({
      question_id: question.question_id,
      choice: answers[question.question_id],
    }))
    .filter((answer): answer is PreferenceAnswer => Boolean(answer.choice));
}

/** pairwise 选项展示文案：由 option.value 与两侧维度名推导（如「明显偏向『钱』」）。
 *  手机端两张选项卡纵向排列，没有左右概念，后端的「偏向左边」不直观；
 *  桌面端直接点名维度也省去对照卡片。value 不符合预期时回退后端 label。 */
function pairwiseOptionText(value: string, label: string, leftLabel: string, rightLabel: string): string {
  const match = /^(left|right)_(strong|slight)$/.exec(value);
  if (!match) return label;
  const degree = match[2] === "strong" ? "明显" : "稍微";
  return `${degree}偏向「${match[1] === "left" ? leftLabel : rightLabel}」`;
}

function explanationFor(
  definition: PreferenceQuestionnaireResource,
  weights: Weights,
): string {
  const ranked = Object.entries(weights).sort(([, a], [, b]) => b - a);
  if (!ranked.length || Math.abs((ranked[0]?.[1] ?? 0) - (ranked[ranked.length - 1]?.[1] ?? 0)) < 0.0001) {
    return "三个维度比较均衡。";
  }
  const dimensions = definition.dimensions ?? {};
  const top = dimensions[ranked[0][0]]?.label ?? PREFERENCE_DIMENSION_LABELS[ranked[0][0]];
  const second = dimensions[ranked[1]?.[0]]?.label ?? PREFERENCE_DIMENSION_LABELS[ranked[1]?.[0]];
  return `你当前更看重「${top}」，同时也在意「${second}」。`;
}

export function PreferenceQuestionnaire({
  sessionId,
  definition,
  definitionLoading,
  definitionError,
  onRetryDefinition,
  saved,
  saving,
  onSaveQuestionnaire,
  startImmediately,
}: {
  sessionId: string;
  definition: PreferenceQuestionnaireResource | undefined;
  definitionLoading: boolean;
  definitionError: string | null;
  onRetryDefinition: () => void;
  saved: boolean;
  saving: boolean;
  onSaveQuestionnaire: (answers: PreferenceAnswer[], version: string, manualWeights?: Weights) => Promise<boolean>;
  startImmediately?: boolean;
}) {
  const [view, setView] = useState<View>(startImmediately ? "questions" : "intro");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [draftReady, setDraftReady] = useState(false);
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [manualEdited, setManualEdited] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect -- 从 sessionStorage 恢复问卷草稿。 */
  useEffect(() => {
    setView(startImmediately ? "questions" : "intro");
    setAnswers({});
    setCurrentIndex(0);
    setDraftReady(false);
    setManualValues({});
    setManualEdited(false);
    if (!definition || typeof window === "undefined") return;

    try {
      const raw = sessionStorage.getItem(preferenceQuestionnaireDraftKey(sessionId));
      if (raw) {
        const draft = JSON.parse(raw) as Draft;
        const valid = draft.version === definition.version
          && Array.isArray(draft.answers)
          && draft.answers.every((answer) => answer?.question_id && answer?.choice);
        if (valid) {
          setAnswers(Object.fromEntries(draft.answers.map((answer) => [answer.question_id, answer.choice])));
          setCurrentIndex(Math.min(Math.max(Number(draft.currentIndex) || 0, 0), (definition.questions ?? []).length - 1));
        }
      }
    } catch {
      // 损坏的草稿按空草稿处理，不能阻塞主流程。
    }
    setDraftReady(true);
    setView(startImmediately ? "questions" : "intro");
  }, [definition, sessionId, startImmediately]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!definition || !draftReady || typeof window === "undefined") return;
    const key = preferenceQuestionnaireDraftKey(sessionId);
    try {
      if (Object.keys(answers).length === 0) {
        sessionStorage.removeItem(key);
        return;
      }
      const draft: Draft = {
        version: definition.version,
        answers: answerList(definition.questions ?? [], answers),
        currentIndex,
      };
      sessionStorage.setItem(key, JSON.stringify(draft));
    } catch {
      // sessionStorage 不可用（隐私模式/配额满）：问卷照常作答，只是草稿不持久化
    }
  }, [answers, currentIndex, definition, draftReady, sessionId]);

  const questions = definition?.questions ?? NO_QUESTIONS;
  const selectedAnswers = useMemo(() => answerList(questions, answers), [answers, questions]);
  const completed = questions.length === 4 && questions.every((question) =>
    (question.options ?? []).some((option) => option.value === answers[question.question_id]));
  const previewWeights = useMemo(
    () => definition && completed ? scorePreferenceAnswers(definition, selectedAnswers) : null,
    [completed, definition, selectedAnswers],
  );
  const manualWeights = manualEdited ? normalizeManualWeights(manualValues) : null;
  const currentQuestion = questions[currentIndex];
  const currentChoice = currentQuestion ? answers[currentQuestion.question_id] : undefined;

  const clearDraft = () => clearQuestionnaireDraft(sessionId);

  const startQuestionnaire = () => {
    if (!definition) return;
    setView("questions");
    setCurrentIndex((index) => Math.min(index, Math.max((definition.questions ?? []).length - 1, 0)));
  };

  const restartQuestionnaire = () => {
    clearDraft();
    setAnswers({});
    setCurrentIndex(0);
    setManualValues({});
    setManualEdited(false);
    setView("questions");
  };

  const selectChoice = (choice: string) => {
    if (!currentQuestion) return;
    setAnswers((current) => ({ ...current, [currentQuestion.question_id]: choice }));
  };

  const nextQuestion = () => {
    if (!currentChoice) return;
    if (completed) {
      const rounded = roundWeightsToPercentages(previewWeights ?? {}, PREFERENCE_DIMENSION_ORDER);
      setManualValues(Object.fromEntries(PREFERENCE_DIMENSION_ORDER.map((key) => [key, String(rounded[key] ?? 0)])));
      setManualEdited(false);
      setView("result");
      return;
    }
    if (currentIndex >= questions.length - 1) {
      const firstUnanswered = questions.findIndex((q) => !answers[q.question_id]);
      if (firstUnanswered >= 0) setCurrentIndex(firstUnanswered);
      return;
    }
    setCurrentIndex((index) => index + 1);
  };

  const saveQuestionnaire = async () => {
    if (!definition || !previewWeights || !completed || saving || (manualEdited && !manualWeights)) return;
    const ok = await onSaveQuestionnaire(selectedAnswers, definition.version, manualEdited ? manualWeights ?? undefined : undefined);
    if (ok) clearDraft();
  };

  if (startImmediately && (definitionLoading || (definition && !draftReady))) {
    return <Spinner label="加载价值观问卷…" />;
  }

  if (view === "result" && definition && previewWeights) {
    const effectiveWeights = manualWeights ?? previewWeights;
    const rounded = roundWeightsToPercentages(effectiveWeights, PREFERENCE_DIMENSION_ORDER);
    const questionRounded = roundWeightsToPercentages(previewWeights, PREFERENCE_DIMENSION_ORDER);
    return (
      <div className="space-y-5">
        <SectionHeading
          title="你的偏好结果"
          description="先确认这组结果，再保存到当前比较会话。"
        />
        <div className="rounded-xl border border-hairline bg-surface p-5 text-ink sm:p-6">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-slate-500">{manualEdited ? "按你调整的数字计算" : "根据你的问卷回答计算"}</p>
              <p className="mt-1 text-lg font-semibold tracking-[-0.02em]">确认三维权重</p>
            </div>
            <span className="rounded-md bg-slate-100 px-2.5 py-1 text-xs text-slate-600">合计 100%</span>
          </div>
          <div className="mt-6 space-y-4">
            {PREFERENCE_DIMENSION_ORDER.map((key) => {
              const colors = colorFor(key);
              const value = rounded[key] ?? 0;
              const label = (definition.dimensions ?? {})[key]?.label ?? PREFERENCE_DIMENSION_LABELS[key] ?? key;
              return (
                <div key={key}>
                  <div className="mb-1.5 flex items-center justify-between text-sm">
                    <span className="font-medium text-ink">{label}</span>
                    <span className="flex items-center gap-1"><input aria-label={`${label}权重`} type="number" min="5" max="90" step="1" value={manualValues[key] ?? String(questionRounded[key] ?? 0)} onChange={(event) => { const raw = event.target.value; setManualValues((current) => rebalanceWeightPercentages(current, key, raw) ?? { ...current, [key]: raw }); setManualEdited(true); }} className="min-h-11 w-16 rounded-lg border border-slate-300 bg-surface px-2 py-1 text-right font-semibold tabular-nums text-ink outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-100" /><span className="text-slate-600">%</span></span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full rounded-full transition-[width]" style={{ width: `${value}%`, backgroundColor: colors.solid }} />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-5 text-sm leading-6 text-slate-600">{explanationFor(definition, effectiveWeights)} 调整任一数字后，另外两项自动补齐至 100%，每维至少 5%。</p>
          {manualEdited && !manualWeights && <p role="alert" className="mt-2 text-sm text-red-700">请填写三个非负数字，且至少有一个大于 0。</p>}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Button variant="subtle" onClick={restartQuestionnaire}>重新回答</Button>
          <Button onClick={() => void saveQuestionnaire()} disabled={saving || (manualEdited && !manualWeights)} className="sm:px-6">
            {saving ? "保存中…" : "保存偏好并继续"}
          </Button>
        </div>
      </div>
    );
  }

  if (view === "questions" && definition && currentQuestion) {
    const dimensions = definition.dimensions ?? {};
    const left = currentQuestion.left_dimension ? dimensions[currentQuestion.left_dimension] : undefined;
    const right = currentQuestion.right_dimension ? dimensions[currentQuestion.right_dimension] : undefined;
    const last = currentIndex === questions.length - 1;
    return (
      <div className="space-y-5">
        <div className="flex gap-2" role="navigation" aria-label="问卷题目进度">
          {questions.map((question, index) => {
            const answered = Boolean(answers[question.question_id]);
            const active = index === currentIndex;
            return <button key={question.question_id} type="button" aria-label={`跳转到第 ${index + 1} 题，${answered ? "已作答" : "未作答"}`} aria-current={active ? "step" : undefined} onClick={() => setCurrentIndex(index)} className="group min-w-0 flex-1 rounded-lg px-0.5 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2">
              <span className={`block text-[11px] font-semibold tabular-nums ${active ? "text-blue-700" : answered ? "text-slate-600" : "text-slate-400"}`}>{String(index + 1).padStart(2, "0")}</span>
              <span aria-hidden="true" className={`mt-1 block h-1.5 rounded-full transition-colors group-hover:bg-blue-400 ${active ? "bg-blue-600" : answered ? "bg-blue-300" : "bg-slate-200"}`} />
            </button>;
          })}
        </div>
        <div>
                  <h3 className="text-xl font-semibold tracking-[-0.02em] text-ink">{currentCopy(currentQuestion.prompt, LEGACY_QUESTION_COPY[currentQuestion.question_id])}</h3>
                  <p className="mt-1.5 text-sm text-slate-500">
                    {currentQuestion.kind === "pairwise"
                      ? "这道题用来决定综合分里两个维度谁占更大比重。没有标准答案，按你真实的感受选。"
                      : "这道题决定要不要把买房压力算进经济回报。"}
                  </p>
                </div>

        {currentQuestion.kind === "pairwise" && left && right ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { key: currentQuestion.left_dimension!, meta: left, side: "A" },
                { key: currentQuestion.right_dimension!, meta: right, side: "B" },
              ].map(({ key, meta, side }) => {
                const colors = colorFor(key);
                return (
                  <div key={key} className="rounded-xl border p-4" style={{ borderColor: `${colors.solid}55`, backgroundColor: colors.soft }}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold" style={{ color: colors.text }}>{side}</span>
                      <span className="text-base font-semibold" style={{ color: colors.text }}>{meta.label}</span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-neutral-600">{currentCopy(meta.description, LEGACY_DIMENSION_COPY[key])}</p>
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
              {(currentQuestion.options ?? []).map((option) => {
                const selected = option.value === currentChoice;
                const text = pairwiseOptionText(option.value, option.label, left.label, right.label);
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-label={text}
                    aria-pressed={selected}
                    onClick={() => selectChoice(option.value)}
                    className={`flex min-h-12 items-center justify-center gap-3 rounded-xl border px-3 py-3 text-center text-xs font-medium leading-5 transition sm:min-h-20 sm:flex-col sm:gap-1 sm:px-2 ${selected ? "border-blue-700 bg-blue-700 text-white" : "border-slate-300 bg-surface text-slate-700 hover:border-blue-400 hover:bg-blue-50"}`}
                  >
                    <span aria-hidden className="block text-[18px] font-semibold">
                      {/* 手机端卡片纵向排列（A 上 / B 下），箭头随布局改为上下方向 */}
                      <span className="sm:hidden">{option.value === "equal" ? "≈" : option.value.startsWith("left") ? "↑" : "↓"}</span>
                      <span className="hidden sm:inline">{option.value === "equal" ? "≈" : option.value.startsWith("left") ? "←" : "→"}</span>
                    </span>
                    <span className="block">{text}</span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <div className={`grid gap-2 ${((currentQuestion.options ?? []).length ?? 0) <= 3 ? "sm:grid-cols-3" : "sm:grid-cols-5"}`}>
            {(currentQuestion.options ?? []).map((option) => {
              const selected = option.value === currentChoice;
              const colors = colorFor(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-label={option.label}
                  aria-pressed={selected}
                  onClick={() => selectChoice(option.value)}
                  className={`min-h-16 rounded-xl border px-3 py-3 text-sm font-semibold transition-colors ${selected ? "text-white" : "border-slate-300 bg-surface text-slate-800 hover:border-slate-400"}`}
                  style={selected ? { borderColor: colors.solid, backgroundColor: colors.solid } : undefined}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button variant="ghost" onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))} disabled={currentIndex === 0} className="sm:min-w-28">
            上一题
          </Button>
          <Button variant="accent" onClick={nextQuestion} disabled={!currentChoice} className="sm:min-w-32">
            {completed ? "查看结果" : last ? "补全未答题" : "下一题"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="border-l-2 border-blue-700 pl-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">设置偏好</p>
        <h2 className="mt-2 text-xl font-semibold tracking-[-0.02em] text-neutral-950">用价值观问卷找到你的侧重点</h2>
        <p className="mt-1 text-sm leading-6 text-neutral-600">
          {questions.length > 1
            ? `回答 ${questions.length - 1} 道取舍题和 1 道购房意向题，系统会计算三维偏好。`
            : "回答取舍题和购房意向题，系统会计算三维偏好。"}
        </p>
      </div>
      {saved && (
        <p className="rounded-2xl bg-blue-50 px-4 py-3 text-sm text-blue-800">
          已保存偏好。重新回答并确认后，会更新当前报告权重。
        </p>
      )}
      {definitionError && (
        <ErrorText>
          问卷暂时无法加载：{definitionError}
        </ErrorText>
      )}
      <div className="rounded-2xl border border-blue-200 bg-blue-50/45 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="rounded-full bg-blue-600 px-2.5 py-1 text-[14px] font-semibold text-white">价值观问卷</span>
          <span className="text-[14px] font-medium text-blue-700">不需要换算</span>
        </div>
        <p className="mt-4 text-sm leading-6 text-neutral-600">
          {definition?.subtitle ?? "回答取舍题，明确你更看重收入、成长还是工作体验。"}
        </p>
        <div className="mt-4 flex flex-wrap gap-2 text-xs text-neutral-600">
          <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-blue-100">{questions.length} 道题</span>
          <span className="rounded-full bg-white px-2.5 py-1 ring-1 ring-blue-100">约 {definition?.estimated_minutes ?? 2} 分钟</span>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button
            variant="accent"
            onClick={startQuestionnaire}
            disabled={!definition || definitionLoading}
            className="sm:px-6"
          >
            {definitionLoading
              ? "加载中…"
              : Object.keys(answers).length > 0
                ? "继续问卷"
                : saved ? "重新回答" : "开始价值观问卷"}
          </Button>
          {definitionError && (
            <Button variant="subtle" onClick={onRetryDefinition}>重试问卷</Button>
          )}
        </div>
      </div>
    </div>
  );
}
