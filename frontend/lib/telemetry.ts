/**
 * 匿名行为事件上报。
 *
 * 只上报白名单维度（step / question_key / tier / 计数 / 状态枚举），绝不含
 * Offer 原文、事实值或凭证——服务端 telemetry_service 同样按白名单校验，
 * 违规 422，双端结构约束一致。
 *
 * 发送策略：队列满 5 条或 3s 定时批量 POST；页面隐藏/关闭时用
 * keepalive fetch 兜底（sendBeacon 无法带 SameSite cookie 凭证语义时的
 * 等价路径）。上报失败静默丢弃，绝不影响主流程。
 */
export type TelemetryPayload = Record<
  string, string | number | boolean | null | string[] | undefined
>;

type QueuedEvent = { event_type: string; payload: TelemetryPayload; client_ts: string };

const FLUSH_SIZE = 5;
const FLUSH_MS = 3000;

let sid: string | null = null;
let queue: QueuedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** 绑定当前会话（sessionId 变化/登出时调用；null 停止上报） */
export function bindTelemetrySession(sessionId: string | null) {
  sid = sessionId;
  if (sessionId === null) {
    queue = [];
    if (timer) clearTimeout(timer);
    timer = null;
  }
}

function scheduleFlush() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_MS);
}

async function flush(useKeepalive = false) {
  if (!sid || queue.length === 0) return;
  const events = queue.splice(0, queue.length);
  try {
    await fetch(`/api/v1/sessions/${sid}/telemetry`, {
      method: "POST",
      credentials: "include",
      keepalive: useKeepalive,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });
  } catch {
    // telemetry 是尽力而为的旁路：失败静默
  }
}

/** 记录一个事件；无会话时静默丢弃。 */
export function track(eventType: string, payload: TelemetryPayload = {}) {
  if (!sid) return;
  queue.push({ event_type: eventType, payload, client_ts: new Date().toISOString() });
  if (queue.length >= FLUSH_SIZE) void flush();
  else scheduleFlush();
}

// 页面隐藏/关闭时尽力发出未落库事件（keepalive 让请求在卸载后继续）
if (typeof window !== "undefined") {
  const flushOnHide = () => { void flush(true); };
  window.addEventListener("pagehide", flushOnHide);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnHide();
  });
}
