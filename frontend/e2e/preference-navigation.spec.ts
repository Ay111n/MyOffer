import { expect, test } from "@playwright/test";

for (const [name, size] of [["桌面", { width: 1440, height: 900 }], ["手机", { width: 390, height: 844 }]] as const) {
test(`${name}端进度导航从报告返回偏好，并可重复定位填写与问卷`, async ({ page }) => {
  await page.setViewportSize(size);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "一次录入，多维对比" })).toBeVisible();
  const sid = await page.evaluate(() => sessionStorage.getItem("myoffer_sid"));
  const answers = ["economic_vs_growth", "economic_vs_experience", "growth_vs_experience"]
    .map((question_id) => ({ question_id, choice: "equal" }));
  answers.push({ question_id: "buy_house_intent", choice: "undecided" });
  const saved = await page.request.put(`/api/v1/sessions/${sid}/preferences`, { data: {
    version: 1, source: "questionnaire", questionnaire_version: "v2", answers,
  } });
  expect(saved.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: "生成对比报告" }).click();
  await expect(page.getByRole("heading", { name: "三维对比报告" })).toBeVisible();

  const steps = page.getByRole("navigation", { name: "比较进度" });
  const questionnaire = page.locator('button[aria-controls="preference-questionnaire"]');
  const preferences = steps.locator('a[href="/#preferences"]');
  const offers = steps.locator('a[href="/#offers"]');
  await preferences.click();
  await expect(page).toHaveURL(/\/#preferences$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await expect(questionnaire).toBeInViewport({ ratio: 1 });

  // 同一锚点再次点击仍须定位，不能只依赖 hashchange。
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await preferences.click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await expect(questionnaire).toBeInViewport({ ratio: 1 });
  await offers.click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole("heading", { name: "一次录入，多维对比" })).toBeInViewport({ ratio: 1 });

  await steps.locator('a[href="/results"]').click();
  await expect(page.getByRole("heading", { name: "三维对比报告" })).toBeVisible();
  await offers.click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  // 冷加载时问卷尚不存在；数据回来后应完成深链接定位。
  await preferences.click();
  await expect(page).toHaveURL(/\/#preferences$/);
  await expect(questionnaire).toBeInViewport({ ratio: 1 });
  await page.route(/\/api\/v1\/sessions\/[^/]+\/(offers|questions)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  await expect(questionnaire).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => sessionStorage.getItem("myoffer_sid"))).toBe(sid);
});

test(`${name}端问卷可收起、按进度跳题且四题完成后才能提交`, async ({ page }) => {
  await page.setViewportSize(size);
  await page.goto("/");
  const toggle = page.locator('button[aria-controls="preference-questionnaire"]');
  await expect(toggle).toContainText("点击测试我更在意什么");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: "钱包更鼓，还是履历更硬？" })).toBeVisible();

  const progress = page.getByRole("navigation", { name: "问卷题目进度" });
  await expect(progress.getByRole("button")).toHaveCount(4);
  await progress.getByRole("button", { name: "跳转到第 4 题，未作答" }).click();
  await page.getByRole("button", { name: "还没决定" }).click();
  await expect(page.getByRole("button", { name: "保存偏好并继续" })).toHaveCount(0);
  await page.getByRole("button", { name: "补全未答题" }).click();
  await expect(progress.getByRole("button", { name: "跳转到第 1 题，未作答" })).toHaveAttribute("aria-current", "step");
  await page.getByRole("button", { name: "一样重要" }).click();
  await progress.getByRole("button", { name: "跳转到第 3 题，未作答" }).click();
  await page.getByRole("button", { name: "一样重要" }).click();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(progress).toBeHidden();
  await toggle.click();
  await expect(progress.getByRole("button", { name: "跳转到第 3 题，已作答" })).toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("button", { name: "一样重要" })).toHaveAttribute("aria-pressed", "true");

  await progress.getByRole("button", { name: "跳转到第 2 题，未作答" }).click();
  await page.getByRole("button", { name: "一样重要" }).click();
  await page.getByRole("button", { name: "查看结果" }).click();
  await expect(page.getByRole("button", { name: "保存偏好并继续" })).toBeEnabled();
  await page.getByRole("button", { name: "保存偏好并继续" }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});
}
