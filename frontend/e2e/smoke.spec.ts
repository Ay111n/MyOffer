import { expect, test } from "@playwright/test";

test("未填齐七项时仍可查看分项与缺口", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "一次录入，多维对比" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Offer A.*0\/7/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();

  await expect(page.getByText("默认：经济回报 34% • 职业成长 33% • 工作体验 33%")).toBeVisible();
  await expect(page.getByText("默认按考虑买房计算")).toBeVisible();
  await expect(page.getByText(/可选|可跳过/)).toHaveCount(0);
  await page.getByRole("button", { name: "生成对比报告" }).click();
  await page.waitForURL(/\/results/);
  await expect(page.getByRole("heading", { name: "三维对比报告" })).toBeVisible();
  await expect(page.getByText(/缺少|待补/).first()).toBeVisible();
  const sid = await page.evaluate(() => sessionStorage.getItem("myoffer_sid"));
  const response = await page.request.get(`/api/v1/sessions/${sid}/result`);
  expect((await response.json()).data.weights).toEqual({ economic: 0.34, growth: 0.33, experience: 0.33 });
});
