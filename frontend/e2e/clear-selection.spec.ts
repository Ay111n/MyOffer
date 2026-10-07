import { expect, test } from "@playwright/test";

/** 误触保护：单选 chip 选中后必须能再次点击取消（用户反馈）。
 *  取消 = 进入「待定」（生成时提交为 unknown 撤销服务端旧值）；
 *  待定与「不知道」同属已处理的决策，进度角标计数不变。
 *  「业务范围」在默认折叠的「职业成长」分区里，须先展开。 */
test("单选选项可取消选择并可重选", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "一次录入，多维对比" })).toBeVisible({ timeout: 15_000 });

  const section = page.getByRole("button", { name: "职业成长", exact: true });
  await expect(section).toHaveAttribute("aria-expanded", "false");
  await section.click();
  await expect(section).toHaveAttribute("aria-expanded", "true");

  const group = page.getByRole("group", { name: "业务范围" });
  await group.getByRole("button", { name: "核心业务" }).click();
  const pressed = group.locator('button[aria-pressed="true"]');
  await expect(pressed).toHaveCount(1, { timeout: 15_000 });

  // 再点一次 = 取消选择（误触保护），chip 上有提示
  await expect(pressed).toHaveAttribute("title", "再次点击取消选择");
  await pressed.click();
  await expect(group.locator('button[aria-pressed="true"]')).toHaveCount(0);

  // 可重新选择（含选回原值）
  await group.locator('button[aria-pressed="false"]').first().click();
  await expect(group.locator('button[aria-pressed="true"]')).toHaveCount(1);
});
