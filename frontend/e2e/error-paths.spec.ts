import { expect, test } from "@playwright/test";

const heading = { name: "一次录入，多维对比" };

test("Cookie 失效后重建会话", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", heading)).toBeVisible();
  await context.clearCookies();
  await page.reload();
  await expect(page.getByRole("heading", heading)).toBeVisible();
  await expect(page.getByRole("button", { name: /Offer A.*0\/7/ })).toBeVisible();
});

test("失效的结果会话返回首页", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("myoffer_sid", "00000000-0000-0000-0000-00000000dead"));
  await page.goto("/results");
  await page.waitForURL((url) => url.pathname === "/");
  await expect(page.getByRole("heading", heading)).toBeVisible();
});

test("答案提交失败时保留表单并显示错误", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", heading)).toBeVisible();
  const sid = await page.evaluate(() => sessionStorage.getItem("myoffer_sid"));
  expect(sid).toBeTruthy();
  const answers = ["economic_vs_growth", "economic_vs_experience", "growth_vs_experience"]
    .map((question_id) => ({ question_id, choice: "equal" }));
  answers.push({ question_id: "buy_house_intent", choice: "undecided" });
  const pref = await page.request.put(`/api/v1/sessions/${sid}/preferences`, { data: {
    version: 1, source: "questionnaire", questionnaire_version: "v2", answers,
  } });
  expect(pref.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole("spinbutton", { name: "税前月薪" }).fill("20000");
  await page.route("**/api/v1/sessions/*/questions/*/answers", (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "internal_error", message: "服务器内部错误，请稍后重试", details: {} } }),
  }));
  await page.getByRole("button", { name: "生成对比报告" }).click();
  await expect(page.getByText(/服务器内部错误|提交失败/).first()).toBeVisible();
  await expect(page).not.toHaveURL(/\/results/);
  await expect(page.getByRole("button", { name: "生成对比报告" })).toBeEnabled();
});
