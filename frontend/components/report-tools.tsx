"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { readApiError } from "@/lib/api/errors";
import { useFlowStore } from "@/stores/flow-store";

export function ReportRestore() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const cache = useQueryClient();

  async function restore(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      if (file.size > 2_000_000) throw new Error("文件不能超过 2 MB");
      const body = JSON.parse(await file.text());
      if (body.format !== "myoffer-input-v5" || body.schema_version !== 5 || !body.inputs) {
        throw new Error("旧版导出文件不兼容，请导入新版输入与偏好 JSON");
      }
      const result = await api.POST("/api/v1/sessions/restore", { body });
      if (result.error) throw result.error;
      cache.removeQueries({ queryKey: ["session"] });
      useFlowStore.getState().enterSession(result.data.data.session_id);
      router.push("/complete");
    } catch (e) {
      setError(e instanceof Error ? e.message : readApiError(e, "导入失败"));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return <div className="no-print relative">
    <input ref={input} className="sr-only" type="file" accept=".json,application/json" aria-label="选择输入与偏好文件" onChange={(event) => void restore(event.target.files?.[0])} />
    <button type="button" disabled={busy} onClick={() => input.current?.click()} className="inline-flex min-h-11 items-center whitespace-nowrap text-sm font-medium text-slate-600 hover:text-ink">{busy ? "导入中…" : "导入数据"}</button>
    {error && <p role="alert" className="absolute right-0 top-full z-40 mt-3 w-64 rounded-lg border border-red-100 bg-surface p-3 text-sm text-red-700 shadow-float">{error}</p>}
  </div>;
}

export function ReportExport({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await api.GET("/api/v1/sessions/{sid}/report/export", { params: { path: { sid: sessionId } } });
      if (result.error) throw result.error;
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "MyOffer-输入与偏好.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(readApiError(e));
    } finally {
      setBusy(false);
    }
  }

  return <div className="no-print relative text-sm">
    <button type="button" disabled={busy || !sessionId} className="inline-flex min-h-11 items-center whitespace-nowrap font-medium text-slate-600 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50" onClick={() => void save()}>{busy ? "导出中…" : "导出数据"}</button>
    {error && <span role="alert" className="absolute right-0 top-full z-40 mt-3 w-64 rounded-lg border border-red-100 bg-surface p-3 text-sm text-red-700 shadow-float">{error}</span>}
  </div>;
}

export function ReportPrint() {
  function print() {
    const closed = [...document.querySelectorAll<HTMLDetailsElement>(".report-document details:not([open])")];
    closed.forEach((item) => { item.open = true; });
    window.addEventListener("afterprint", () => closed.forEach((item) => { item.open = false; }), { once: true });
    window.print();
  }

  return <button type="button" className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-slate-700 hover:bg-slate-100" onClick={print}>打印 / 保存 PDF</button>;
}
