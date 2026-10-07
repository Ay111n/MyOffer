"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api/client";
import { readApiError } from "@/lib/api/errors";
import type { S } from "@/lib/api/types";

type Config = S["AiConfig"];
type Job = S["AiJob"];
type Provider = S["AiProvider"];

const terminal = new Set(["succeeded", "failed", "cancelled"]);

export default function ModelSettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [replyValue, setReplyValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const provider = useMemo<Provider | undefined>(
    () => config?.providers.find((item) => item.id === providerId), [config, providerId],
  );
  const currentModelId = provider?.models.some((item) => item.id === modelId) ? modelId
    : config?.selected?.provider === providerId && provider?.models.some((item) => item.id === config.selected?.model)
      ? config.selected.model : provider?.models[0]?.id ?? "";

  const refresh = useCallback(async () => {
    const result = await api.GET("/api/v1/ai/config", {});
    const apiError = (result as { error?: unknown }).error;
    if (apiError) throw apiError;
    if (!result.data) throw new Error("无法读取模型配置。");
    setConfig(result.data.data);
    setProviderId((current) => current || result.data.data.selected?.provider || result.data.data.providers[0]?.id || "");
    const active = result.data.data.active_jobs.find((item) => item.kind !== "analysis");
    if (active) setJob(active);
    return result.data.data;
  }, []);

  useEffect(() => {
    let alive = true;
    void api.POST("/api/v1/ai/bootstrap", {}).then((result) => {
      const apiError = (result as { error?: unknown }).error;
      if (apiError) throw apiError;
      if (!result.data) throw new Error("无法加载模型配置。");
      if (!alive) return;
      setConfig(result.data.data);
      setProviderId(result.data.data.selected?.provider || result.data.data.providers[0]?.id || "");
      const active = result.data.data.active_jobs.find((item) => item.kind !== "analysis");
      if (active) setJob(active);
    }).catch((cause) => { if (alive) setError(readApiError(cause, "无法加载模型配置。")); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!job || terminal.has(job.status)) return;
    const id = window.setInterval(() => {
      void api.GET("/api/v1/ai/jobs/{job_id}", { params: { path: { job_id: job.id } } })
        .then((result) => {
          if (result.error) throw result.error;
          setJob(result.data.data);
          if (terminal.has(result.data.data.status)) void refresh().catch((cause) => setError(readApiError(cause)));
        })
        .catch((cause) => setError(readApiError(cause, "无法获取授权或测试进度。")));
    }, 1500);
    return () => window.clearInterval(id);
  }, [job, refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (cause) { setError(readApiError(cause)); }
    finally { setBusy(false); }
  }

  async function connectKey() {
    await run(async () => {
      const result = await api.PUT("/api/v1/ai/providers/{provider}/key", {
        params: { path: { provider: providerId } }, body: { api_key: apiKey },
      });
      if (result.error) throw result.error;
      setApiKey("");
      setConfig(result.data.data);
    });
  }

  async function beginLogin() {
    await run(async () => {
      const result = await api.POST("/api/v1/ai/providers/{provider}/login", {
        params: { path: { provider: providerId } },
      });
      if (result.error) throw result.error;
      setJob(result.data.data);
    });
  }

  async function submitReply() {
    if (!job?.prompt) return;
    await run(async () => {
      const result = await api.POST("/api/v1/ai/jobs/{job_id}/reply", {
        params: { path: { job_id: job.id } },
        body: { prompt_id: job.prompt!.id, value: replyValue },
      });
      if (result.error) throw result.error;
      setReplyValue("");
      setJob(result.data.data);
    });
  }

  async function cancelJob() {
    if (!job) return;
    await run(async () => {
      const result = await api.DELETE("/api/v1/ai/jobs/{job_id}", {
        params: { path: { job_id: job.id } },
      });
      if (result.error) throw result.error;
      setJob(result.data.data);
      await refresh();
    });
  }

  async function selectModel() {
    await run(async () => {
      const result = await api.PUT("/api/v1/ai/selection", {
        body: { provider: providerId, model: currentModelId },
      });
      if (result.error) throw result.error;
      setConfig(result.data.data);
    });
  }

  async function testModel() {
    await run(async () => {
      const result = await api.POST("/api/v1/ai/test", {
        body: { provider: providerId, model: currentModelId },
      });
      if (result.error) throw result.error;
      setJob(result.data.data);
    });
  }

  async function disconnect() {
    await run(async () => {
      const result = await api.DELETE("/api/v1/ai/providers/{provider}", {
        params: { path: { provider: providerId } },
      });
      if (result.error) throw result.error;
      setConfig(result.data.data);
    });
  }

  return <div className="mx-auto max-w-4xl space-y-7 pb-16 text-slate-900">
    <header className="border-b border-slate-200 pb-6">
      <p className="text-xs font-semibold tracking-[0.2em] text-slate-500">MYOFFER / AI</p>
      <h1 className="mt-3 text-3xl font-semibold">模型配置</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">连接自己的模型账号或 API Key，选择默认模型后，可在对比报告的四个部分分别生成解读。</p>
      <p className="mt-2 text-xs leading-5 text-slate-500">凭据只保存在服务端当前进程内；服务重启后需重新连接。连接测试和报告分析会使用模型额度。</p>
    </header>

    {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</p>}
    {!config ? <p role="status" className="text-sm text-slate-500">正在加载服务商…</p> : <>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-7">
        <h2 className="text-lg font-semibold">1. 连接服务商</h2>
        <label htmlFor="ai-provider" className="mt-5 block text-sm font-medium">服务商</label>
        <select id="ai-provider" value={providerId} onChange={(event) => { setProviderId(event.target.value); setJob(null); setError(""); }} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm">
          {config.providers.map((item) => <option key={item.id} value={item.id}>{item.name}{item.auth_type ? " · 已连接" : ""}</option>)}
        </select>
        {provider && <div className="mt-5 space-y-5">
          <p className="text-sm text-slate-600">{provider.auth_type ? `已通过${provider.auth_type === "oauth" ? "账号授权" : "API Key"}连接。` : "尚未连接。"}{provider.subscription ? "支持订阅账号授权。" : ""}</p>
          {provider.api_key && <div>
            <label htmlFor="ai-key" className="block text-sm font-medium">API Key</label>
            <div className="mt-2 flex flex-wrap gap-2"><input id="ai-key" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="输入后仅提交到服务端" className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-2.5 text-sm" />
              <button type="button" disabled={busy || !apiKey.trim()} onClick={() => void connectKey()} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">保存密钥</button></div>
          </div>}
          <div className="flex flex-wrap gap-3">
            {provider.oauth && <button type="button" disabled={busy || !!job && !terminal.has(job.status)} onClick={() => void beginLogin()} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">账号授权</button>}
            {provider.auth_type && <button type="button" disabled={busy} onClick={() => void disconnect()} className="rounded-xl border border-rose-200 px-4 py-2.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50">断开连接</button>}
          </div>
        </div>}
      </section>

      {job && job.kind !== "analysis" && <section aria-live="polite" className="rounded-2xl border border-blue-200 bg-blue-50 p-5 sm:p-7">
        <h2 className="text-lg font-semibold">{job.kind === "login" ? "账号授权" : "连接测试"} · {job.status === "pending" ? "进行中" : job.status === "succeeded" ? "已完成" : job.status === "cancelled" ? "已取消" : "失败"}</h2>
        {job.message && <p className="mt-2 text-sm text-slate-700">{job.message}</p>}
        {job.url && <a href={job.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm font-medium text-blue-700 underline">打开服务商授权页面 ↗</a>}
        {job.user_code && <p className="mt-3 text-sm">设备码：<strong className="select-all font-mono">{job.user_code}</strong></p>}
        {job.prompt && <div className="mt-4 space-y-2">
          <label htmlFor="ai-reply" className="block text-sm">{job.prompt.message}</label>
          {job.prompt.type === "select" ? <select id="ai-reply" value={replyValue} onChange={(event) => setReplyValue(event.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"><option value="">请选择</option>{job.prompt.options?.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
            : <input id="ai-reply" type={job.prompt.type === "secret" ? "password" : "text"} value={replyValue} onChange={(event) => setReplyValue(event.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm" />}
          <button type="button" disabled={busy || !replyValue.trim()} onClick={() => void submitReply()} className="rounded-xl bg-blue-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">提交授权信息</button>
        </div>}
        {job.status === "pending" && <button type="button" disabled={busy} onClick={() => void cancelJob()} className="mt-4 block text-sm text-slate-600 underline">取消任务</button>}
      </section>}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-7">
        <h2 className="text-lg font-semibold">2. 选择并测试模型</h2>
        <label htmlFor="ai-model" className="mt-5 block text-sm font-medium">模型</label>
        <select id="ai-model" value={currentModelId} onChange={(event) => setModelId(event.target.value)} disabled={!provider?.models.length} className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm disabled:opacity-50">
          {provider?.models.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
        </select>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="button" disabled={busy || !provider?.auth_type || !currentModelId} onClick={() => void selectModel()} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">设为默认模型</button>
          <button type="button" disabled={busy || !provider?.auth_type || !currentModelId || !!job && !terminal.has(job.status)} onClick={() => void testModel()} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-medium disabled:opacity-50">测试连接</button>
        </div>
        <p className="mt-4 text-sm text-slate-600">当前默认：{config.selected ? `${config.providers.find((item) => item.id === config.selected?.provider)?.name ?? config.selected.provider} / ${config.selected.model}` : "尚未选择"}</p>
        {provider?.last_check && <p className="mt-1 text-xs text-slate-500">最近测试：{provider.last_check.ok ? "成功" : "失败"} · {provider.last_check.model}</p>}
      </section>
      <p className="text-sm text-slate-600"><Link href="/results" className="font-medium text-blue-700 underline">返回对比报告</Link>，在需要解读的部分点击“生成解读”。</p>
    </>}
  </div>;
}
