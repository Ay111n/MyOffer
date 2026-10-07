"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "@/lib/api/client";
import { readApiError } from "@/lib/api/errors";
import type { S } from "@/lib/api/types";

type Job = S["AiJob"];
type Config = S["AiConfig"];
const sections = [
  { key: "overall", label: "总体分析", title: "综合解读" },
  { key: "economic", label: "经济回报分析", title: "本节解读" },
  { key: "growth", label: "职业成长分析", title: "本节解读" },
  { key: "experience", label: "工作体验分析", title: "本节解读" },
] as const;
type Part = typeof sections[number]["key"];
type Jobs = Partial<Record<Part, Job>>;
type JobIds = Partial<Record<Part, string>>;
type Errors = Partial<Record<Part, string>>;
const parts = sections.map((section) => section.key);
const terminal = new Set(["succeeded", "failed", "cancelled"]);
type AnalysisContext = {
  config: Config | null; jobs: Jobs; busyPart: Part | null; errors: Errors;
  complete: boolean; start: (part: Part) => Promise<void>; cancel: (part: Part) => Promise<void>;
};
const Context = createContext<AnalysisContext | null>(null);

function storedIds(key: string): JobIds {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(parts.filter((part) => typeof value[part] === "string")
      .map((part) => [part, value[part]])) as JobIds;
  } catch { return {}; }
}

function rememberJob(key: string, part: Part, id: string) {
  try { sessionStorage.setItem(key, JSON.stringify({ ...storedIds(key), [part]: id })); }
  catch { /* Storage is optional. */ }
}

export function AiReportAnalysisProvider({ sessionId, snapshotSeq, complete, children }: {
  sessionId: string; snapshotSeq: number; complete: boolean; children: ReactNode;
}) {
  const [config, setConfig] = useState<Config | null>(null);
  const [jobs, setJobs] = useState<Jobs>({});
  const [busyPart, setBusyPart] = useState<Part | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const storageKey = `myoffer-ai-report:${sessionId}:${snapshotSeq}`;

  const readJob = useCallback(async (part: Part, id: string) => {
    const result = await api.GET("/api/v1/ai/jobs/{job_id}", { params: { path: { job_id: id } } });
    if (result.error) throw result.error;
    if (!result.data) throw new Error("无法读取解读任务。");
    const item = result.data.data;
    if (item.kind !== "analysis" || item.snapshot_seq !== snapshotSeq || item.stage !== part) {
      throw new Error("这份解读与当前报告不一致，请重新生成。");
    }
    return item;
  }, [snapshotSeq]);

  useEffect(() => {
    let alive = true;
    void api.GET("/api/v1/ai/config", {}).then(async (result) => {
      const apiError = (result as { error?: unknown }).error;
      if (apiError) throw apiError;
      if (!result.data) throw new Error("无法读取模型配置。");
      if (!alive) return;
      setConfig(result.data.data);
      const ids = storedIds(storageKey);
      for (const item of result.data.data.active_jobs) {
        if (item.kind === "analysis" && item.snapshot_seq === snapshotSeq && parts.includes(item.stage as Part)) {
          ids[item.stage as Part] = item.id;
          rememberJob(storageKey, item.stage as Part, item.id);
        }
      }
      const restored: Jobs = {};
      await Promise.all(parts.map(async (part) => {
        const id = ids[part];
        if (!id) return;
        try { restored[part] = await readJob(part, id); }
        catch { /* A restarted model process may no longer have this job. */ }
      }));
      if (alive) setJobs(restored);
    }).catch((cause) => { if (alive) setErrors({ overall: readApiError(cause, "无法读取模型配置。") }); });
    return () => { alive = false; };
  }, [readJob, snapshotSeq, storageKey]);

  useEffect(() => {
    const active = parts.find((part) => jobs[part] && !terminal.has(jobs[part].status));
    if (!active) return;
    const id = jobs[active]!.id;
    const timer = window.setInterval(() => {
      void readJob(active, id).then((item) => setJobs((previous) => ({ ...previous, [active]: item })))
        .catch((cause) => setErrors((previous) => ({ ...previous, [active]: readApiError(cause, "无法获取解读进度。") })));
    }, 1800);
    return () => window.clearInterval(timer);
  }, [jobs, readJob]);

  async function start(part: Part) {
    setBusyPart(part);
    setErrors((previous) => ({ ...previous, [part]: undefined }));
    try {
      const result = await api.POST("/api/v1/sessions/{sid}/report/ai-analysis", {
        params: { path: { sid: sessionId } }, body: { snapshot_seq: snapshotSeq, part },
      });
      if (result.error) throw result.error;
      setJobs((previous) => ({ ...previous, [part]: result.data.data }));
      rememberJob(storageKey, part, result.data.data.id);
    } catch (cause) {
      setErrors((previous) => ({ ...previous, [part]: readApiError(cause) }));
    } finally { setBusyPart(null); }
  }

  async function cancel(part: Part) {
    const job = jobs[part];
    if (!job) return;
    setBusyPart(part);
    setErrors((previous) => ({ ...previous, [part]: undefined }));
    try {
      const result = await api.DELETE("/api/v1/ai/jobs/{job_id}", {
        params: { path: { job_id: job.id } },
      });
      if (result.error) throw result.error;
      setJobs((previous) => ({ ...previous, [part]: result.data.data }));
    } catch (cause) {
      setErrors((previous) => ({ ...previous, [part]: readApiError(cause) }));
    } finally { setBusyPart(null); }
  }

  return <Context.Provider value={{ config, jobs, busyPart, errors, complete, start, cancel }}>{children}</Context.Provider>;
}

export function AiReportSection({ part }: { part: Part }) {
  const state = useContext(Context);
  if (!state) throw new Error("AI report section requires its provider");
  const { config, jobs, busyPart, errors, complete, start, cancel } = state;
  const section = sections.find((item) => item.key === part)!;
  const job = jobs[part];
  const content = job?.sections?.[part]?.trim();
  const pending = job?.status === "pending";
  const otherPending = parts.some((item) => item !== part && jobs[item]?.status === "pending");
  const disabled = Boolean(busyPart || !complete || !config?.selected || pending || otherPending);
  const className = part === "overall"
    ? "border-t border-slate-200 py-5 sm:py-6"
    : "border-t border-slate-100 px-5 py-5 sm:px-7 sm:py-6";
  return <div aria-label={section.label} className={`${className}${content ? "" : " print:hidden"}`}>
    <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h3 className="text-base font-semibold tracking-tight text-slate-900">{section.title}</h3>
        {content && <span className="text-xs text-slate-400">AI 生成</span>}
      </div>
      <div className="no-print flex shrink-0 items-center gap-3">
        <button type="button" aria-label={`${content ? "重新生成" : "生成"}${section.label}`} disabled={disabled}
          onClick={() => void start(part)}
          className="min-w-28 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-800 transition-colors hover:border-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
          {busyPart === part ? "启动中…" : content ? "重新生成" : "生成解读"}
        </button>
        {pending && <button type="button" onClick={() => void cancel(part)} disabled={Boolean(busyPart)} className="text-sm text-slate-500 underline underline-offset-4">取消</button>}
      </div>
    </div>
    {part === "overall" && config && !config.selected && <p className="no-print mt-2 text-sm text-slate-500">请先<Link href="/settings/models" className="ml-1 font-medium text-slate-700 underline underline-offset-4">配置模型</Link>。</p>}
    {!complete && part === "overall" && <p className="no-print mt-2 text-sm text-amber-800">补齐各份 Offer 的七项基本信息后即可生成。</p>}
    {pending && <p role="status" className="no-print mt-3 text-sm text-blue-700">正在生成本部分解读…</p>}
    {job?.status === "failed" && <p role="alert" className="no-print mt-3 text-sm text-rose-700">生成中断：{job.message ?? "请重试。"}</p>}
    {job?.status === "cancelled" && <p role="status" className="no-print mt-3 text-sm text-slate-500">已取消，可重新生成。</p>}
    {errors[part] && <p role="alert" className="no-print mt-3 text-sm text-rose-700">{errors[part]}</p>}
    {content && <div className="mt-4 max-w-3xl space-y-3 text-[15px] leading-7 text-slate-700">
      {content.split(/\n+/).map((paragraph, index) => <p key={index}>{paragraph.trim()}</p>)}
    </div>}
  </div>;
}
