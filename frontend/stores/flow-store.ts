"use client";

import { useEffect } from "react";
import { create } from "zustand";

import { clearDraftsForSession } from "@/lib/draft-storage";

type FlowState = {
  sessionId: string | null;
  /** 进入一个新会话/切换会话时一并清掉未保存草稿守卫。 */
  enterSession: (id: string | null) => void;
};

const SID_STORAGE_KEY = "myoffer_sid";
/** 跨标签恢复用的本机会话记录（localStorage，带时间戳，24h 内有效）。 */
const SID_PERSIST_KEY = "myoffer_sid_persist";
const SID_PERSIST_TTL_MS = 24 * 60 * 60 * 1000;

function readStoredSid(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(SID_STORAGE_KEY);
  } catch {
    return null; // sessionStorage 不可用（隐私模式等）→ 退回纯内存行为
  }
}

/** 读取可恢复的持久会话：超过 24 小时的记录直接清除，不再恢复。 */
function readPersistedSid(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SID_PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sid?: unknown; t?: unknown };
    if (typeof parsed.sid !== "string" || typeof parsed.t !== "number") {
      window.localStorage.removeItem(SID_PERSIST_KEY);
      return null;
    }
    if (Date.now() - parsed.t > SID_PERSIST_TTL_MS) {
      window.localStorage.removeItem(SID_PERSIST_KEY);
      return null;
    }
    return parsed.sid;
  } catch {
    return null; // localStorage 不可用或内容损坏：当作无可恢复会话
  }
}

function writePersistedSid(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id === null) window.localStorage.removeItem(SID_PERSIST_KEY);
    else window.localStorage.setItem(SID_PERSIST_KEY, JSON.stringify({ sid: id, t: Date.now() }));
  } catch {
    // 写入失败不阻断主流程
  }
}

/** 清空本机保存的会话痕迹与草稿（会话失效回退 / 用户主动清除时调用）。 */
export function clearLocalWorkspace(): void {
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.removeItem(SID_STORAGE_KEY);
    } catch { /* 存储不可用时忽略 */ }
  }
  const persisted = readPersistedSid();
  writePersistedSid(null);
  clearDraftsForSession(persisted);
}

/**
 * 当前页面内的流程状态。
 *
 * 后端仍用 sessionId 作为“本次比较”的临时工作区标识。sessionId 写入
 * sessionStorage（tab 内存活）：刷新页面后从本 tab 恢复会话视图；同时
 * 落一份带时间戳的记录到 localStorage（24 小时内有效）：误关标签页/
 * 浏览器后重开仍能回到同一工作区，草稿同样只存本机。恢复的 sessionId
 * 若在后端已不存在（服务重启/会话被清理/TTL 过期），404 中间件
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
    try {
      if (id === null) sessionStorage.removeItem(SID_STORAGE_KEY);
      else sessionStorage.setItem(SID_STORAGE_KEY, id);
    } catch {
      // 写入失败不阻断主流程
    }
    writePersistedSid(id);
    set({ sessionId: id });
  },
}));

let sessionHydrated = false;

/** 水合完成后恢复会话（整个页面生命周期只执行一次；客户端路由切换不重挂
 *  store，模块级标记足以去重）。优先本 tab 的 sessionStorage；误关标签后
 *  重开时回退 localStorage 的持久记录（24h 内）。 */
export function useHydrateSession(): void {
  const enterSession = useFlowStore((s) => s.enterSession);
  useEffect(() => {
    if (sessionHydrated) return;
    sessionHydrated = true;
    const sid = readStoredSid() ?? readPersistedSid();
    if (sid && useFlowStore.getState().sessionId !== sid) {
      // 回退恢复的会话可能已过期：同步回 sessionStorage 与持久记录，
      // 失效时由 404 中间件统一清理
      try {
        sessionStorage.setItem(SID_STORAGE_KEY, sid);
      } catch { /* 非致命 */ }
      enterSession(sid);
    }
  }, [enterSession]);
}
