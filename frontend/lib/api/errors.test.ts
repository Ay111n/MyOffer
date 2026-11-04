import { describe, expect, it } from "vitest";

import { readApiError } from "./errors";

describe("readApiError 会话类英文包络的中文化", () => {
  it("Session not found 映射为中文并告知数据仍在", () => {
    const message = readApiError({ error: { code: "not_found", message: "Session not found" } });
    expect(message).toContain("服务端会话已失效");
    expect(message).toContain("仍保留在本机");
  });

  it("401 凭证过期同样映射为中文", () => {
    const message = readApiError({ error: { code: "unauthenticated", message: "Invalid or expired session token" } });
    expect(message).toContain("本机会话凭证已过期");
    expect(message).not.toMatch(/Invalid or expired/);
  });

  it("其他错误消息保持原样透传", () => {
    expect(readApiError({ error: { code: "version_conflict", message: "Offer version conflict" } }))
      .toBe("Offer version conflict");
  });

  it("结果快照缺失仍走 fallback 文案", () => {
    expect(readApiError({ error: { code: "not_found", message: "result not found" } }))
      .toBe("请求失败，请检查网络后重试。");
  });
});
