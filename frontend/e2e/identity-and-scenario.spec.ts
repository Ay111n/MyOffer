import { expect, test } from "@playwright/test";

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
  await page.getByRole("button", { name: "填入示例数据" }).click(); // 点别处触发失焦保存
  await expect(page.getByRole("button", { name: /字节跳动.*7\/7/ })).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "生成对比报告" }).click();
  await page.waitForURL(/\/results/);
  // 报告页透传身份名（记分区与结论区都使用）
  await expect(page.getByText("字节跳动").first()).toBeVisible({ timeout: 10_000 });
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
