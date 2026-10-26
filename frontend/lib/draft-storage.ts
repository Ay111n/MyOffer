/**
 * 未提交答题草稿的本地暂存（localStorage）。
 *
 * 设计约定（与产品要求一致）：
 * - 只保存「未提交草稿」——提交成功立即删除对应条目，绝不长期复制
 *   已经持久化到后端的数据；
 * - 按 sessionId + questionKey 隔离，切换会话互不影响；
 * - 用 localStorage 而非 sessionStorage：误关标签页/浏览器后仍可恢复，
 *  代价是加 24 小时过期——过期草稿在读取时直接丢弃，不再被意外恢复；
 * - 数据只留在用户本机，不进服务端持久层，与隐私优先的产品哲学一致。
 *
 * 条目格式：{ t: 保存时间戳, v: 草稿内容 }；旧版 sessionStorage 明文条目
 * 在首次读取时一次性迁移（搬运后删除旧键）。
 */

const PREFIX = "offer-drafts";
/** 草稿过期时间：超过后不再恢复（后端会话本身也只有 2 天 TTL）。 */
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export function draftKey(sessionId: string, questionKey: string): string {
  return `${PREFIX}:${sessionId}:${questionKey}`;
}

type WrappedDraft = { t: number; v: unknown };

function readStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null; // localStorage 不可用（隐私模式等）：当作无持久草稿
  }
}

/** 旧版（sessionStorage 明文）一次性迁移：搬入 localStorage 后删除旧键。 */
function migrateLegacyEntry(key: string, raw: string): WrappedDraft | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return { t: Date.now(), v: parsed };
  } catch {
    return null;
  } finally {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // sessionStorage 不可用时无从删除，忽略
    }
  }
}

function readEntry(key: string): unknown | null {
  const store = readStore();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (raw == null) {
    // 新机器没有 localStorage 条目时，尝试承接旧版 sessionStorage 草稿
    try {
      const legacy = sessionStorage.getItem(key);
      if (legacy != null) {
        const wrapped = migrateLegacyEntry(key, legacy);
        if (wrapped) store.setItem(key, JSON.stringify(wrapped));
        return wrapped?.v ?? null;
      }
    } catch {
      // sessionStorage 不可用：无旧草稿可迁
    }
    return null;
  }
  try {
    const wrapped = JSON.parse(raw) as WrappedDraft;
    if (Date.now() - wrapped.t > DRAFT_TTL_MS) {
      store.removeItem(key); // 过期草稿直接丢弃，不再恢复
      return null;
    }
    return wrapped.v;
  } catch {
    store.removeItem(key); // 内容损坏：当作无草稿
    return null;
  }
}

/** 读取某道题的草稿：Record<offerId, Record<fieldKey, FieldDraft>> */
export function loadDraft<T>(sessionId: string | null, questionKey: string): T | null {
  if (!sessionId) return null;
  const value = readEntry(draftKey(sessionId, questionKey));
  return (value ?? null) as T | null;
}

export function loadDraftsForSession<T extends object>(sessionId: string | null): T {
  const out: Record<string, unknown> = {};
  if (!sessionId) return out as T;
  const store = readStore();
  if (!store) return out as T;
  const prefix = `${PREFIX}:${sessionId}:`;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) {
      const qkey = key.slice(prefix.length);
      const value = readEntry(key);
      if (value != null) out[qkey] = value;
    }
  } catch {
    // 遍历中断（隐私模式等）：已读出的部分仍可用
  }
  return out as T;
}

/**
 * 判断 loadDraftsForSession 载入的草稿是否含有实际内容（qkey → oid → 至少
 * 一个字段条目）。空骨架条目（oid 下无字段）不算——报告页据此提示「填写页
 * 有尚未生成进报告的内容」，未提交与已提交的边界由此保持单一事实源。
 */
export function hasUnsubmittedDrafts(drafts: unknown): boolean {
  if (!drafts || typeof drafts !== "object") return false;
  return Object.values(drafts as Record<string, unknown>).some((perOffer) =>
    perOffer != null && typeof perOffer === "object"
    && Object.values(perOffer as Record<string, unknown>).some(
      (fields) => fields != null && typeof fields === "object"
        && Object.keys(fields as object).length > 0,
    ),
  );
}

/** 写入一道题的草稿；perOffer 传 null 表示删除该条目。 */
export function saveDraft(
  sessionId: string | null, questionKey: string,
  perOffer: Record<string, unknown> | null,
): void {
  if (!sessionId) return;
  const store = readStore();
  if (!store) return;
  const key = draftKey(sessionId, questionKey);
  try {
    if (perOffer == null) store.removeItem(key);
    else store.setItem(key, JSON.stringify({ t: Date.now(), v: perOffer } as WrappedDraft));
  } catch {
    // 写入失败（配额满等）：内存草稿仍然工作
  }
}

/** 清空某会话的全部本机草稿（重置/清除本机数据时调用）。 */
export function clearDraftsForSession(sessionId: string | null): void {
  if (!sessionId) return;
  const store = readStore();
  if (!store) return;
  const prefix = `${PREFIX}:${sessionId}:`;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // 存储不可用时无从清除，忽略
  }
}
