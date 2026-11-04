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

/** 清空本机全部会话的草稿（「清除本机数据」时调用）：
 *  会话失效重建会产生旧 sid 的孤儿键，只按当前 sid 清是清不干净的。 */
export function clearAllDrafts(): void {
  const store = readStore();
  if (!store) return;
  const prefix = `${PREFIX}:`;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // 存储不可用时忽略
  }
}

/** 某会话草稿的最新保存时间（无内容返回 0），供孤儿列表按新旧排序。 */
function latestDraftTimestamp(sessionId: string): number {
  const store = readStore();
  if (!store) return 0;
  const prefix = `${PREFIX}:${sessionId}:`;
  let latest = 0;
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      try {
        const parsed = JSON.parse(store.getItem(key) ?? "") as WrappedDraft;
        if (parsed && typeof parsed.t === "number" && parsed.t > latest) latest = parsed.t;
      } catch {
        // 单条损坏不阻断扫描
      }
    }
  } catch {
    // 存储不可用：按 0 处理
  }
  return latest;
}

/**
 * 列出除 currentSid 外、localStorage 中仍含未提交内容的会话 id（新→旧）。
 * 供「恢复上次填写」横幅使用：会话失效自动重建后，旧 sid 的草稿仍在
 * 本机（24h TTL），在这里被重新发现。读取过程会顺手清掉过期/损坏条目。
 */
export function listOrphanDraftSessions(currentSid: string | null): string[] {
  const store = readStore();
  if (!store) return [];
  const prefix = `${PREFIX}:`;
  const sids = new Set<string>();
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const sep = rest.indexOf(":");
      if (sep <= 0) continue;
      const sid = rest.slice(0, sep);
      if (sid !== currentSid) sids.add(sid);
    }
  } catch {
    return [];
  }
  const orphans: { sid: string; latest: number }[] = [];
  for (const sid of sids) {
    if (!hasUnsubmittedDrafts(loadDraftsForSession<Record<string, unknown>>(sid))) continue;
    orphans.push({ sid, latest: latestDraftTimestamp(sid) });
  }
  return orphans.sort((a, b) => b.latest - a.latest).map((item) => item.sid);
}

/**
 * 把 fromSid 的全部草稿迁移到 toSid：offer id 经 remap 重写后落入新会话
 * 键下并删除旧键；新会话已有的 offer 条目保持不动（不覆盖）。任一条目
 * 写入失败即中止并保留旧键，下次仍可整体重试。
 */
export function migrateDraftsBetweenSessions(
  fromSid: string,
  toSid: string,
  remapOfferId: (oid: string) => string | null,
): void {
  if (!fromSid || !toSid || fromSid === toSid) return;
  const store = readStore();
  if (!store) return;
  const prefix = `${PREFIX}:${fromSid}:`;
  const keys: string[] = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) {
      const qkey = key.slice(prefix.length);
      let wrapped: WrappedDraft | null = null;
      try {
        wrapped = JSON.parse(store.getItem(key) ?? "") as WrappedDraft;
      } catch {
        store.removeItem(key); // 损坏条目直接淘汰
        continue;
      }
      if (!wrapped || typeof wrapped !== "object" || wrapped.v == null || typeof wrapped.v !== "object") {
        store.removeItem(key);
        continue;
      }
      const existing = (readEntry(draftKey(toSid, qkey)) ?? null) as Record<string, unknown> | null;
      const merged: Record<string, unknown> = { ...(existing ?? {}) };
      for (const [oid, fields] of Object.entries(wrapped.v as Record<string, unknown>)) {
        const mapped = remapOfferId(oid);
        if (!mapped || fields == null || typeof fields !== "object" || Object.keys(fields as object).length === 0) continue;
        if (!(mapped in merged)) merged[mapped] = fields;
      }
      if (Object.keys(merged).length === 0) {
        store.removeItem(key);
        continue;
      }
      try {
        store.setItem(draftKey(toSid, qkey), JSON.stringify({ t: Date.now(), v: merged } as WrappedDraft));
        store.removeItem(key);
      } catch {
        return; // 写入失败（配额满等）：保留旧键，迁移中止
      }
    }
  } catch {
    // 存储不可用：无从迁移，保留原样
  }
}
