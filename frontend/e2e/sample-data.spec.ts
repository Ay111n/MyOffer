import { expect, test } from "@playwright/test";

test("三份示例完整且总分接近", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();
  await page.getByRole("button", { name: "添加 Offer" }).click();
  await expect(page.getByRole("button", { name: /Offer C.*0\/7/ })).toBeVisible();
  await page.getByRole("button", { name: "填入示例数据" }).click();
  for (const label of ["A", "B", "C"]) {
    await expect(page.getByRole("button", { name: new RegExp(`Offer ${label}.*7/7`) })).toBeVisible();
  }
  await page.getByRole("button", { name: /Offer C.*7\/7/ }).click();
  await expect(page.getByRole("spinbutton", { name: "税前月薪" })).toHaveValue("17000");

  await page.getByRole("button", { name: /点击测试我更在意什么/ }).click();
  for (let index = 0; index < 3; index++) {
    await page.getByRole("button", { name: "一样重要" }).click();
    await page.getByRole("button", { name: "下一题" }).click();
  }
  await page.getByRole("button", { name: "还没决定" }).click();
  await page.getByRole("button", { name: "查看结果" }).click();
  await page.getByRole("button", { name: "保存偏好并继续" }).click();
  await page.getByRole("button", { name: "生成对比报告" }).click();
  await page.waitForURL(/\/results/);
  await expect(page.getByRole("heading", { name: "三维对比报告" })).toBeVisible();
  const analysis = page.getByRole("region", { name: "三维结果分析" });
  await expect(analysis.getByRole("button", { name: "固定年度税后说明" })).toBeVisible();

  const sid = await page.evaluate(() => sessionStorage.getItem("myoffer_sid"));
  const response = await page.request.get(`/api/v1/sessions/${sid}/result`);
  expect(response.ok()).toBeTruthy();
  const offers = (await response.json()).data.offers as Array<{
    display_order: number; overall_score: number; input_values: Record<string, unknown>;
  }>;
  offers.sort((a, b) => a.display_order - b.display_order);
  expect(offers).toHaveLength(3);
  expect(offers.every((offer) => Object.keys(offer.input_values).length >= 50)).toBeTruthy();
  const comparison = analysis;
  await expect(comparison.getByRole("button", { name: "常规年度税后现金说明" })).toBeVisible();
  await expect(comparison.getByRole("button", { name: "约定年度调薪说明" })).toBeVisible();
  await expect(comparison.getByRole("button", { name: "入职阶段收入合计说明" })).toBeVisible();
  await expect(comparison.getByRole("heading", { name: /技能积累/ })).toBeVisible();
  await expect(comparison.getByRole("heading", { name: /工作边界/ })).toBeVisible();
  await expect(comparison.getByText("三年年均税后现金")).toHaveCount(0);
  await expect(comparison.getByText("有效税后时薪")).toHaveCount(0);
  expect(Math.max(...offers.map((offer) => offer.overall_score)) - Math.min(...offers.map((offer) => offer.overall_score))).toBeLessThan(5);
});

test("两份示例按当前 Offer 数量填充且不覆盖用户修改", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();
  await page.getByRole("button", { name: "填入示例数据" }).click();
  await expect(page.getByRole("button", { name: /Offer A.*7\/7/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Offer B.*7\/7/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Offer C/ })).toHaveCount(0);
  await page.getByRole("spinbutton", { name: "税前月薪" }).fill("31000");
  await page.getByRole("button", { name: "填入示例数据" }).click();
  await expect(page.getByRole("spinbutton", { name: "税前月薪" })).toHaveValue("31000");
  await expect(page.getByRole("button", { name: /Offer C/ })).toHaveCount(0);
});
