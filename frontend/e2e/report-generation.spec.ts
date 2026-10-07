import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const facts = {
  city: "北京", monthly_base: 20000, guaranteed_salary_months: 12,
  business_level: "core", entry_scope: "small_feature",
  weekly_work_hours: 50, work_days_per_week: 5,
};

for (const [name, size] of [["桌面", { width: 1440, height: 900 }], ["手机", { width: 390, height: 844 }]] as const) {
  test(`${name}端生成三维报告并导出`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(size);
    await page.goto("/");
    const banner = page.locator("header").first();
    await expect(banner.getByRole("button", { name: "导入数据" })).toBeVisible();
    await expect(banner.getByRole("button", { name: "导出数据" })).toBeVisible();
    await expect(page.getByText("把选择的依据看清楚")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await expect(page.getByRole("button", { name: /Offer B/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Offer A.*0\/7/ })).toBeVisible();
    const sections = ["经济回报", "职业成长", "工作体验"];
    for (const section of sections) await expect(page.getByRole("button", { name: section, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "七项基本信息" })).toHaveCount(0);
    const sid = await page.evaluate(() => sessionStorage.getItem("myoffer_sid"));
    expect(sid).toBeTruthy();
    const offers = (await (await page.request.get(`/api/v1/sessions/${sid}/offers`)).json()).data;
    for (const [section, field] of [["经济回报", "city"], ["职业成长", "business_level"], ["工作体验", "weekly_work_hours"]]) {
      const heading = page.getByRole("button", { name: section, exact: true });
      if (await heading.getAttribute("aria-expanded") !== "true") await heading.click();
      await expect(page.locator(`[data-field-anchor="${offers[0].offer_id}:${field}"] .form-label`)).toContainText("*");
    }
    await page.getByRole("button", { name: "经济回报", exact: true }).click();
    await expect(page.getByText("政府人才补贴")).toBeVisible();
    for (const offer of offers) {
      const response = await page.request.patch(`/api/v1/sessions/${sid}/offers/${offer.offer_id}`, { data: {
        version: offer.version,
        facts: Object.entries(facts).map(([field_key, value]) => ({ field_key, value })),
      } });
      expect(response.ok()).toBeTruthy();
    }
    await page.reload();
    await expect(page.getByRole("button", { name: /Offer A.*7\/7/ })).toBeVisible();
    await page.getByRole("button", { name: /点击测试我更在意什么/ }).click();
    for (let index = 0; index < 3; index++) {
      await page.getByRole("button", { name: "一样重要" }).click();
      await page.getByRole("button", { name: "下一题" }).click();
    }
    await page.getByRole("button", { name: "还没决定" }).click();
    await page.getByRole("button", { name: "查看结果" }).click();
    await expect(page.getByRole("spinbutton", { name: "经济回报权重" })).toHaveValue("34");
    await page.getByRole("spinbutton", { name: "经济回报权重" }).fill("50");
    await expect(page.getByRole("spinbutton", { name: "职业成长权重" })).toHaveValue("25");
    await expect(page.getByRole("spinbutton", { name: "工作体验权重" })).toHaveValue("25");
    await page.getByRole("button", { name: "保存偏好并继续" }).click();
    await expect(page.getByRole("button", { name: /调整我的偏好.*手动调整/ })).toBeVisible();
    await expect(page.getByText("手动调整三维权重")).toHaveCount(0);
    const preference = await page.request.get(`/api/v1/sessions/${sid}/preferences`);
    expect((await preference.json()).data).toMatchObject({ source: "manual", weights: { economic: 0.5, growth: 0.25, experience: 0.25 } });
    await page.getByRole("button", { name: "生成对比报告" }).click();
    await page.waitForURL(/\/results/);
    await expect(page.getByRole("heading", { name: "三维对比报告" })).toBeVisible();
    const scoreCards = page.getByRole("region", { name: "Offer 对比" });
    const weightNote = page.getByText("综合分采用当前偏好权重：经济回报 50% • 职业成长 25% • 工作体验 25%。");
    await expect(weightNote).toBeVisible();
    await expect(page.getByRole("region", { name: "主要结论" })).toHaveCount(0);
    expect(await scoreCards.evaluate((element) => {
      const weightElement = document.querySelector('[aria-label="偏好权重声明"]');
      return weightElement != null && Boolean(element.compareDocumentPosition(weightElement) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBeTruthy();
    await expect(page.getByRole("button", { name: "导出数据" })).toHaveCount(1);
    await expect(page.getByText("经济回报").first()).toBeVisible();
    await expect(page.getByText("并列第 1 名")).toHaveCount(2);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出数据" }).click();
    const download = await downloadPromise;
    const buffer = await readFile(await download.path());
    const archive = JSON.parse(buffer.toString("utf8"));
    expect(archive.format).toBe("myoffer-input-v5");
    expect(archive.inputs.offers).toHaveLength(2);
    expect(archive).not.toHaveProperty("report");
    const comparison = page.getByRole("region", { name: "三维结果分析" });
    await expect(comparison.getByText("查看计算")).toHaveCount(0);
    await expect(comparison.getByRole("heading", { name: /常规年度收入/ })).toBeVisible();
    const cashInfo = comparison.getByRole("button", { name: "常规年度收入说明" });
    if (name === "桌面") await cashInfo.hover();
    else await cashInfo.click();
    await expect(comparison.getByRole("tooltip").filter({ hasText: "约定调薪只影响这个子分" })).toBeVisible();
    await comparison.getByRole("button", { name: "固定年度税后说明" }).hover();
    await expect(comparison.getByRole("tooltip").filter({ hasText: "税前月薪乘以固定薪数" })).toBeVisible();
    await expect(comparison.getByRole("heading", { name: "入职阶段收入" })).toBeVisible();
    await expect(comparison.getByRole("heading", { name: /业务机会/ })).toBeVisible();
    await expect(comparison.getByRole("heading", { name: /承担与自主/ })).toBeVisible();
    await expect(comparison.getByRole("heading", { name: /时间占用/ })).toBeVisible();
    await expect(comparison.getByRole("heading", { name: /休息安排/ })).toBeVisible();
    await expect(page.getByText("输入值与计算明细")).toHaveCount(0);
    const economic = comparison.locator(":scope > section").first();
    await expect(economic.getByRole("button", { name: /税后与五险一金/ })).toHaveCount(1);
    await economic.getByRole("button", { name: /税后与五险一金/ }).click();
    const dialog = page.getByRole("dialog", { name: "税后与五险一金明细" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Offer B" }).click();
    await expect(dialog.getByRole("button", { name: "Offer B" })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("heading", { name: "月度税后计算" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "五险一金 · 每月缴纳" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    const width = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(width).toBeTruthy();
  });
}
