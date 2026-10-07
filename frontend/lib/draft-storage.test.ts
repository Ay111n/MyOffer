import { beforeEach, describe, expect, it } from "vitest";

import { draftKey, loadDraft, loadDraftsForSession } from "./draft-storage";

describe("draft-storage（未提交草稿的 sessionStorage 持久化）", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("key 按 sessionId/questionKey 隔离", () => {
    const a = draftKey("s1", "q1");
    const b = draftKey("s2", "q1");
    const c = draftKey("s1", "q2");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("save + load 往返；无 sid 时返回 null", () => {
    const sid = "session-a";
    sessionStorage.setItem(draftKey(sid, "q1"), JSON.stringify({ o1: { f1: { status: "pending" } } }));
    expect(loadDraft(sid, "q1")).toEqual({ o1: { f1: { status: "pending" } } });
    expect(loadDraft(null, "q1")).toBeNull();
  });

  it("loadDraftsForSession 只加载该会话的草稿，坏 JSON 被忽略", () => {
    sessionStorage.setItem(draftKey("s1", "q1"), JSON.stringify({ ok: 1 }));
    sessionStorage.setItem(draftKey("s2", "q1"), JSON.stringify({ other: 1 }));
    sessionStorage.setItem(draftKey("s1", "bad"), "{not-json");
    const drafts = loadDraftsForSession<{ q1?: unknown }>("s1");
    expect(drafts.q1).toEqual({ ok: 1 });
    expect(Object.keys(drafts)).not.toContain("bad");
    expect(JSON.stringify(drafts)).not.toContain("other");
  });
});
