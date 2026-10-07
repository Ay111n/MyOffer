import { expect, test } from "@playwright/test";

test("清空当前 Offer 只清除它的输入", async ({ page }) => {
  await page.goto("/");
  const tabs = page.getByRole("group", { name: "Offer 切换" });
  await expect(tabs.getByRole("button", { name: /Offer B/ })).toBeVisible();
  await page.getByRole("button", { name: "添加 Offer" }).click();
  await expect(tabs.getByRole("button", { name: /Offer C.*0\/7/ })).toBeVisible();
  await page.getByRole("spinbutton", { name: "税前月薪" }).fill("20000");
  await expect(tabs.getByRole("button", { name: /Offer C.*1\/7/ })).toBeVisible();
  await page.getByRole("button", { name: "清空当前 Offer 已填内容" }).click();
  await expect(tabs.getByRole("button", { name: /Offer C.*0\/7/ })).toBeVisible();
  await expect(tabs.getByRole("button", { name: /Offer A.*0\/7/ })).toBeVisible();
  await expect(tabs.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();
});
