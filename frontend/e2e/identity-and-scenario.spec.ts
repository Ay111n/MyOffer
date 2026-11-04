import { expect, test } from "@playwright/test";

import { fillExampleFactsViaApi } from "./helpers";

test("公司名 Tab 保存只提交一次，岗位可继续保存且刷新保留", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  const statuses: number[] = [];
  page.on("response", (response) => {
    if (response.request().method() === "PATCH" && /\/offers\/[^/]+$/.test(new URL(response.url()).pathname)) {
      statuses.push(response.status());
    }
  });
  await page.route("**/api/v1/sessions/*/offers/*", async (route) => {
    if (route.request().method() === "PATCH") {
      requests++;
      await gate;
    }
    await route.continue();
  });
  const company = page.getByRole("textbox", { name: /的公司名称$/ });
  const position = page.getByRole("textbox", { name: /的岗位$/ });
  await company.fill("Tab 保存验证");
  await company.press("Tab");
  try {
    await expect(company).toBeDisabled();
    await expect(position).toBeDisabled();
    // 再做一次真实焦点切换，让 pending 禁用输入导致的 blur 完整处理。
    await page.getByRole("button", { name: "经济回报", exact: true }).click();
  } finally {
    release();
  }
  await expect(position).toBeEnabled();
  await expect(page.getByRole("button", { name: /^Tab 保存验证/ })).toBeVisible();
  expect(requests).toBe(1);
  expect(statuses).toEqual([200]);
  await expect(page.getByText("保存失败", { exact: true })).toHaveCount(0);
  const positionSaved = page.waitForResponse((response) =>
    response.request().method() === "PATCH"
    && /\/offers\/[^/]+$/.test(new URL(response.url()).pathname)
    && response.request().postDataJSON()?.position === "开发工程师");
  await position.fill("开发工程师");
  await position.press("Tab");
  expect((await positionSaved).status()).toBe(200);
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await expect(position).toBeEnabled();
  expect(statuses).toEqual([200, 200]);
  await page.reload();
  await expect(company).toHaveValue("Tab 保存验证");
  await expect(position).toHaveValue("开发工程师");
});

test("真实保存失败仍提示错误，重试后可恢复", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();
  await page.route("**/api/v1/sessions/*/offers/*", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "server_busy", message: "fixture" } }) });
    } else {
      await route.continue();
    }
  }, { times: 1 });
  const company = page.getByRole("textbox", { name: /的公司名称$/ });
  await company.fill("失败后重试");
  await company.press("Enter");
  await expect(page.getByText("保存失败", { exact: true })).toBeVisible();
  await expect(company).toBeEnabled();
  await company.fill("失败后重试");
  await company.press("Enter");
  await expect(page.getByText("已保存", { exact: true })).toBeVisible();
  await expect(page.getByText("保存失败", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(company).toHaveValue("失败后重试");
});

/**
 * 第二轮功能的 E2E 固化：Offer 命名全链路 + 免写入试算 + 反解追平线。
 * 此前仅做过手工浏览器验证，本文件将其固化为回归锁。
 */

test("改名贯穿填写页与报告页", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();

  // 命名行：公司名 + 岗位，失焦保存后标签即时同步
  await page.getByRole("textbox", { name: "Offer A 的公司名称" }).fill("字节跳动");
  await page.getByRole("textbox", { name: "Offer A 的岗位" }).fill("后端开发");
  await page.getByRole("button", { name: "经济回报", exact: true }).click(); // 点别处触发失焦保存
  // 标签先出现公司名 = 失焦保存的 PATCH 已落库，再走 API 造数 + 重载
  await expect(page.getByRole("button", { name: /字节跳动/ })).toBeVisible({ timeout: 10_000 });
  await fillExampleFactsViaApi(page);
  await expect(page.getByRole("button", { name: /字节跳动.*7\/7/ })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "生成对比报告" }).click();
  await page.waitForURL(/\/results/);
  // 报告页透传身份名（得分区、结论区都使用，不再只显示 OFFER A 代称）
  await expect(page.getByText("字节跳动").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("region", { name: "Offer 对比" }).getByText("字节跳动")).toBeVisible({ timeout: 10_000 });
});

test("试算与反解追平线", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();
  await page.getByRole("button", { name: "先看一份示例报告" }).click();
  await page.waitForURL(/\/results/);
  await expect(page.getByRole("heading", { name: "三维对比报告" })).toBeVisible();

  const panel = page.getByRole("region", { name: "试算一下：如果……会怎样" });
  await panel.waitFor({ state: "visible" });

  // 给落后的一份（默认调整对象）加薪试算 → 出现「调整后第一」标记
  await panel.getByRole("spinbutton", { name: "试算月薪" }).fill("40000");
  await panel.getByRole("button", { name: "重新试算" }).click();
  await expect(panel.getByText("调整后第一")).toBeVisible({ timeout: 10_000 });

  // 反解追平线：报出追平月薪与谈判建议（可达时指出可作筹码的其他维度差距）
  await panel.getByRole("button", { name: "算出追平线" }).click();
  await expect(panel.getByText(/的月薪谈到 ¥[\d,]+/)).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByText(/并列第一/)).toBeVisible();
  await expect(panel.getByText(/差距主要来自|领先方更大的优势/)).toBeVisible();

  // 反解不落库：快照号不因试算/反解变化
  const sid = await page.evaluate(() => sessionStorage.getItem("myoffer_sid"));
  const before = await page.request.get(`/api/v1/sessions/${sid}`).then((r) => r.json());
  await page.reload();
  await page.waitForURL(/\/results/);
  await expect(page.getByRole("heading", { name: "三维对比报告" })).toBeVisible();
  const after = await page.request.get(`/api/v1/sessions/${sid}`).then((r) => r.json());
  expect(after.data.latest_snapshot_seq).toBe(before.data.latest_snapshot_seq);
});
