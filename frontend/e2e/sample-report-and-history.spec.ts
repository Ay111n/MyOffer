import { expect, test } from "@playwright/test";

/**
 * 第二轮功能的 E2E 固化：示例报告直达闭环 + 历史版本回看 + 导出导入往返。
 */

test("示例报告直达与一键清回空白", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();

  await page.getByRole("button", { name: "先看一份示例报告" }).click();
  await page.waitForURL(/\/results/);
  await expect(page.getByText("当前报告由示例数据生成")).toBeVisible();

  // demo 自动补齐三份并写入虚构公司名：报告页直接展示（改名贯穿）
  await expect(page.getByText("星澜科技").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("蓉创信息").first()).toBeVisible();
  await expect(page.getByText("浦海数据").first()).toBeVisible();

  // 设计意图锁定：三份分差接近（A 微弱领先），结论敏感性 fragile
  const sid = await page.evaluate(() => sessionStorage.getItem("myoffer_sid"));
  const result = await page.request.get(`/api/v1/sessions/${sid}/result`).then((r) => r.json());
  const scores = result.data.overall_scores as Record<string, number>;
  const values = Object.values(scores);
  expect(values).toHaveLength(3);
  expect(Math.max(...values) - Math.min(...values)).toBeLessThan(4);
  expect(result.data.sensitivity.status).toBe("fragile");

  // 一键清回空白：重置全部 Offer 并回到填写页
  await page.getByRole("button", { name: "开始填写我的 Offer" }).click();
  await page.waitForURL(/\/$|\/complete/);
  await expect(page.getByRole("button", { name: /Offer A.*0\/7/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Offer C.*0\/7/ })).toBeVisible();
});

test("历史版本回看与回到最新", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();
  await page.getByRole("button", { name: "先看一份示例报告" }).click();
  await page.waitForURL(/\/results/);
  await expect(page.getByRole("heading", { name: "三维对比报告" })).toBeVisible();

  // demo 补建第三份会先落一条 offer_created 快照，加上批量提交共两条历史
  await page.getByRole("button", { name: /修改记录/ }).click();
  const demoList = page.locator("#history-list");
  await expect(demoList.getByRole("button")).toHaveCount(2, { timeout: 10_000 });

  const sid = await page.evaluate(() => sessionStorage.getItem("myoffer_sid"));
  await page.evaluate(async (sessionId) => {
    const offers = await (await fetch(`/api/v1/sessions/${sessionId}/offers`, { credentials: "include" })).json();
    await fetch(`/api/v1/sessions/${sessionId}/questions/answers/batch`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ question_key: "q_details", answers: [
        { offer_id: offers.data[0].offer_id, fields: [
          { field_key: "signing_bonus", status: "known", value: 30000 }] },
      ] }] }),
    });
    await fetch(`/api/v1/sessions/${sessionId}/questions/stop`, { method: "POST", credentials: "include" });
  }, sid);

  await page.reload();
  await expect(page.getByRole("heading", { name: "三维对比报告" })).toBeVisible();
  await page.getByRole("button", { name: /修改记录/ }).click();
  const list = page.locator("#history-list");
  await expect(list.getByRole("button")).toHaveCount(3, { timeout: 10_000 });

  // 回看旧版本：历史横幅出现，回到最新后消失
  await list.getByRole("button").filter({ hasText: /^#1/ }).click();
  await expect(page.getByText(/正在查看第 1 次结果/)).toBeVisible();
  await page.getByRole("button", { name: "回到最新" }).click();
  await expect(page.getByText(/正在查看第 1 次结果/)).toHaveCount(0);
});

test("导出导入往返保留身份名", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();
  await page.getByRole("textbox", { name: "Offer A 的公司名称" }).fill("字节跳动");
  await page.getByRole("button", { name: "填入示例数据" }).click();
  await expect(page.getByRole("button", { name: /字节跳动.*7\/7/ })).toBeVisible({ timeout: 10_000 });

  // UI 导出为 JSON 下载
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "导出数据" }).click(),
  ]);
  const archivePath = await download.path();
  expect(archivePath).toBeTruthy();

  // UI 导入同一文件 → 新会话恢复，身份名保持
  await page.getByLabel("选择输入与偏好文件").setInputFiles(archivePath!);
  await page.waitForURL(/\/$|\/complete/);
  await expect(page.getByRole("button", { name: /字节跳动.*7\/7/ })).toBeVisible({ timeout: 10_000 });
});
