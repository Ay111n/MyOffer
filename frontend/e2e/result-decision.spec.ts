import { expect, test, type Page } from "@playwright/test";

async function generateSampleReport(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();
  await page.getByRole("button", { name: "填入示例数据" }).click();
  await expect(page.getByRole("button", { name: /Offer A.*7\/7/ })).toBeVisible();
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
}

test("结果页按「得分 → 结论 → 原因 → 差异 → 稳不稳 → 靠不靠谱 → 下一步」组织", async ({ page }) => {
  await generateSampleReport(page);
  const order = [
    "scores-title", "verdict-section-title", "why-title", "diff-title", "stability-title", "reliability-title", "next-title",
  ];
  for (const id of order) await expect(page.locator(`#${id}`)).toBeVisible();
  const tops = await Promise.all(order.map((id) => page.locator(`#${id}`).evaluate((el) => el.getBoundingClientRect().top + window.scrollY)));
  expect([...tops].sort((a, b) => a - b)).toEqual(tops);

  await expect(page.locator("#verdict-title")).toContainText(/当前更推荐 Offer [AB]|并列领先/);
  // 稳不稳：来自后端 sensitivity，标题必为五档之一
  const stability = page.locator("#stability-title").locator("xpath=..");
  await expect(stability).toContainText(/很稳|比较稳|有一定弹性|不太稳|目前并列/);
  await expect(stability.getByRole("link", { name: /试试不同的权重/ })).toHaveAttribute("href", "/#preferences");
});

test("敏感性：接口返回翻转点，页面与之一致", async ({ page }) => {
  await generateSampleReport(page);
  const sid = await page.evaluate(() => sessionStorage.getItem("myoffer_sid"));
  const body = (await (await page.request.get(`/api/v1/sessions/${sid}/result`)).json()).data;
  expect(["stable", "steady", "moderate", "fragile", "tie"]).toContain(body.sensitivity.status);
  for (const flip of body.sensitivity.flips) {
    expect(flip.flip_weight).toBeGreaterThanOrEqual(0.05 - 1e-9);
    expect(flip.flip_weight).toBeLessThanOrEqual(0.9 + 1e-9);
  }
  // 每个维度都有一条可读的轨道说明
  for (const label of ["经济回报", "职业成长", "工作体验"]) {
    await expect(page.locator("#stability-title").locator("xpath=..").getByRole("img", { name: new RegExp(`^${label}`) })).toBeVisible();
  }
});

for (const [path, heading, tableText] of [
  ["/results/salary", "每月到手工资", "全年"],
  ["/results/insurance", "五险一金明细", "合计"],
] as const) {
  test(`明细页 ${path} 可切换 Offer 且不横向溢出`, async ({ page }) => {
    await generateSampleReport(page);
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    const tabs = page.getByRole("group", { name: "明细 Offer 切换" });
    await expect(tabs.getByRole("button", { name: "Offer A" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(tableText).first()).toBeVisible();
    await tabs.getByRole("button", { name: "Offer B" }).click();
    await expect(tabs.getByRole("button", { name: "Offer B" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: /Offer B/, level: 2 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.getByRole("link", { name: "返回报告" }).click();
    await expect(page).toHaveURL(/\/results$/);
  });
}
