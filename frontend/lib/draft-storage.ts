/**
 * 未提交答题草稿的 sessionStorage 暂存。
 *
 * 设计约定（与产品要求一致）：
 * - 只保存「未提交草稿」——提交成功立即删除对应条目，绝不长期复制
 *   已经持久化到后端的数据；
 * - 按 sessionId + questionKey 隔离，切换会话互不影响；
 * - 用 sessionStorage（而非 localStorage）：标签页关闭即消失，
 *   防止过期草稿在数天后被意外恢复。
 */

const PREFIX = "offer-drafts";

export function draftKey(sessionId: string, questionKey: string): string {
  return `${PREFIX}:${sessionId}:${questionKey}`;
}

/** 读取某道题的草稿：Record<offerId, Record<fieldKey, FieldDraft>> */
export function loadDraft<T>(sessionId: string | null, questionKey: string): T | null {
  if (!sessionId || typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(draftKey(sessionId, questionKey));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // sessionStorage 不可用或内容损坏：当作无草稿
  }
}

export function loadDraftsForSession<T extends object>(sessionId: string | null): T {
  const out: Record<string, unknown> = {};
  if (!sessionId || typeof window === "undefined") return out as T;
  const prefix = `${PREFIX}:${sessionId}:`;
  try {
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const qkey = key.slice(prefix.length);
      const raw = sessionStorage.getItem(key);
      if (raw) {
        try {
          out[qkey] = JSON.parse(raw);
        } catch {
          sessionStorage.removeItem(key);
        }
      }
    }
  } catch {
    // sessionStorage 不可用（隐私模式等）：内存草稿仍然工作
  }
  return out as T;
}
