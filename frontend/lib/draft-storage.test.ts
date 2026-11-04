import { beforeEach, describe, expect, it } from "vitest";

import {
  clearAllDrafts, clearDraftsForSession, draftKey, hasUnsubmittedDrafts, listOrphanDraftSessions,
  loadDraft, loadDraftsForSession, migrateDraftsBetweenSessions, saveDraft,
} from "./draft-storage";

describe("draft-storage（未提交草稿的 localStorage 持久化 + 24h 过期）", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it("key 按 sessionId/questionKey 隔离", () => {
    const a = draftKey("s1", "q1");
    const b = draftKey("s2", "q1");
    const c = draftKey("s1", "q2");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("save + load 往返；无 sid 时返回 null", () => {
    const sid = "session-a";
    saveDraft(sid, "q1", { o1: { f1: { status: "pending" } } });
    expect(loadDraft(sid, "q1")).toEqual({ o1: { f1: { status: "pending" } } });
    expect(loadDraft(null, "q1")).toBeNull();
    saveDraft(sid, "q1", null);
    expect(loadDraft(sid, "q1")).toBeNull();
  });

  it("loadDraftsForSession 只加载该会话的草稿，坏条目被忽略", () => {
    saveDraft("s1", "q1", { ok: 1 });
    saveDraft("s2", "q1", { other: 1 });
    localStorage.setItem(draftKey("s1", "bad"), "{not-json");
    const drafts = loadDraftsForSession<{ q1?: unknown }>("s1");
    expect(drafts.q1).toEqual({ ok: 1 });
    expect(Object.keys(drafts)).not.toContain("bad");
    expect(JSON.stringify(drafts)).not.toContain("other");
  });

  it("超过 24 小时的草稿过期丢弃，不误恢复", () => {
    const sid = "session-old";
    localStorage.setItem(draftKey(sid, "q1"), JSON.stringify({ t: Date.now() - 25 * 3600_000, v: { a: 1 } }));
    expect(loadDraft(sid, "q1")).toBeNull();
    expect(localStorage.getItem(draftKey(sid, "q1"))).toBeNull();
  });

  it("旧版 sessionStorage 明文草稿一次性迁移后可读取", () => {
    const sid = "session-legacy";
    sessionStorage.setItem(draftKey(sid, "q1"), JSON.stringify({ o1: { f1: { status: "known", value: 1 } } }));
    expect(loadDraft(sid, "q1")).toEqual({ o1: { f1: { status: "known", value: 1 } } });
    // 旧键迁移后删除，新键落入 localStorage（关标签页仍可恢复）
    expect(sessionStorage.getItem(draftKey(sid, "q1"))).toBeNull();
    expect(localStorage.getItem(draftKey(sid, "q1"))).not.toBeNull();
  });

  it("hasUnsubmittedDrafts 只认有字段条目的草稿，空骨架不算", () => {
    expect(hasUnsubmittedDrafts(null)).toBe(false);
    expect(hasUnsubmittedDrafts({})).toBe(false);
    // 空 perOffer / 空字段对象：清空 Offer 后可能的残留骨架，不算未提交内容
    expect(hasUnsubmittedDrafts({ q1: {} })).toBe(false);
    expect(hasUnsubmittedDrafts({ q1: { o1: {} } })).toBe(false);
    expect(hasUnsubmittedDrafts({ q1: { o1: { f1: { status: "pending" } } } })).toBe(true);
    expect(hasUnsubmittedDrafts({ q1: { o1: { f1: { status: "known", value: 1 } } } })).toBe(true);
  });

  it("clearDraftsForSession 只清当前会话的草稿", () => {
    saveDraft("s1", "q1", { a: 1 });
    saveDraft("s1", "q2", { b: 1 });
    saveDraft("s2", "q1", { c: 1 });
    clearDraftsForSession("s1");
    expect(loadDraftsForSession("s1")).toEqual({});
    expect(loadDraft("s2", "q1")).toEqual({ c: 1 });
  });

  it("listOrphanDraftSessions 列出含内容的旧会话，排除当前会话/空骨架/过期草稿", () => {
    saveDraft("old-1", "q1", { o1: { f1: { status: "known", value: 1 } } });
    saveDraft("current", "q1", { o1: { f1: { status: "known", value: 2 } } });
    saveDraft("empty-sid", "q1", { o1: {} }); // 空骨架不算
    localStorage.setItem(
      draftKey("expired", "q1"),
      JSON.stringify({ t: Date.now() - 25 * 3600_000, v: { o1: { f1: { status: "known", value: 1 } } } }),
    );
    expect(listOrphanDraftSessions("current")).toEqual(["old-1"]);
    // 此处核对筛选结果；连续写入可能同毫秒，也可能跨毫秒，排序由下个用例验证。
    expect(new Set(listOrphanDraftSessions(null))).toEqual(new Set(["old-1", "current"]));
  });

  it("listOrphanDraftSessions 按最近保存时间新→旧排序", () => {
    localStorage.setItem(draftKey("older", "q1"), JSON.stringify({ t: Date.now() - 5000, v: { o1: { f1: { status: "known", value: 1 } } } }));
    localStorage.setItem(draftKey("newer", "q1"), JSON.stringify({ t: Date.now(), v: { o1: { f1: { status: "known", value: 1 } } } }));
    expect(listOrphanDraftSessions("current")).toEqual(["newer", "older"]);
  });

  it("migrateDraftsBetweenSessions 按 remap 重写 offer id 并删除旧键", () => {
    saveDraft("from", "q1", { oldA: { f1: { status: "known", value: 1 } }, oldB: { f2: { status: "known", value: 2 } } });
    migrateDraftsBetweenSessions("from", "to", (oid) => ({ oldA: "newA", oldB: "newB" }[oid] ?? null));
    expect(loadDraftsForSession("from")).toEqual({});
    expect(loadDraft("to", "q1")).toEqual({
      newA: { f1: { status: "known", value: 1 } },
      newB: { f2: { status: "known", value: 2 } },
    });
  });

  it("migrateDraftsBetweenSessions 不覆盖新会话已有条目，remap 不到的放弃", () => {
    saveDraft("to", "q1", { newA: { existing: { status: "known", value: 9 } } });
    saveDraft("from", "q1", {
      oldA: { f1: { status: "known", value: 1 } },
      unknown: { f2: { status: "known", value: 2 } },
    });
    migrateDraftsBetweenSessions("from", "to", (oid) => (oid === "oldA" ? "newA" : null));
    expect(loadDraft("to", "q1")).toEqual({ newA: { existing: { status: "known", value: 9 } } });
    expect(loadDraftsForSession("from")).toEqual({});
  });

  it("clearAllDrafts 清掉全部会话的草稿", () => {
    saveDraft("s1", "q1", { a: 1 });
    saveDraft("s2", "q1", { b: 1 });
    clearAllDrafts();
    expect(loadDraftsForSession("s1")).toEqual({});
    expect(loadDraftsForSession("s2")).toEqual({});
  });
});
