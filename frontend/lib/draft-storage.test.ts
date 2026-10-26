import { beforeEach, describe, expect, it } from "vitest";

import {
  clearDraftsForSession, draftKey, hasUnsubmittedDrafts, loadDraft, loadDraftsForSession, saveDraft,
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
});
