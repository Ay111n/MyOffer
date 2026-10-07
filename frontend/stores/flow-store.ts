"use client";

import { useEffect } from "react";
import { create } from "zustand";

type FlowState = {
  sessionId: string | null;
  /** 进入一个新会话/切换会话时一并清掉未保存草稿守卫。 */
  enterSession: (id: string | null) => void;
};

const SID_STORAGE_KEY = "myoffer_sid";

function readStoredSid(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(SID_STORAGE_KEY);
  } catch {
    return null; // sessionStorage 不可用（隐私模式等）→ 退回纯内存行为
  }
}

function writeStoredSid(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id === null) window.sessionStorage.removeItem(SID_STORAGE_KEY);
    else window.sessionStorage.setItem(SID_STORAGE_KEY, id);
  } catch {
    // 写入失败不阻断主流程
  }
}

/**
 * 当前页面内的流程状态。
 *
 * 后端仍用 sessionId 作为“本次比较”的临时工作区标识。sessionId 只写入
 * sessionStorage（tab 内存活）：刷新页面后从本 tab 恢复会话视图，不再
 * 退回首页重填；关掉标签页即消失，不跨 tab、不留长期痕迹。恢复的
 * sessionId 若在后端已不存在（服务重启/会话被替换），404 中间件
 * （lib/api/client.ts::discardLocalSession）会清空本地状态并回到首页。
 *
 * 初始值必须是 null（而不是创建时同步读 sessionStorage）：页面为静态导出，
 * 预渲染 HTML 按 null 生成，若客户端首帧就带着恢复的 sid 渲染会话视图，
 * 每次"带活会话刷新"都会 hydration mismatch 整树重渲。恢复统一走
 * useHydrateSession 的 effect（水合完成后进行），各使用方把该 hook 放在
 * 自身首个 effect 之前调用即可保证时序。
 */
export const useFlowStore = create<FlowState>()((set) => ({
  sessionId: null,
  enterSession: (id) => {
    writeStoredSid(id);
    set({ sessionId: id });
  },
}));

let sessionHydrated = false;

/** 水合完成后从 sessionStorage 恢复本 tab 的会话（整个页面生命周期只执行一次；
 *  客户端路由切换不重挂 store，模块级标记足以去重）。 */
export function useHydrateSession(): void {
  const enterSession = useFlowStore((s) => s.enterSession);
  useEffect(() => {
    if (sessionHydrated) return;
    sessionHydrated = true;
    const sid = readStoredSid();
    if (sid && useFlowStore.getState().sessionId !== sid) enterSession(sid);
  }, [enterSession]);
}
