import { expect, test } from "@playwright/test";

test("报告后可继续填写并重新计算", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "一次录入，多维对比" })).toBeVisible();
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
  await page.getByRole("button", { name: "生成对比报告" }).click();
  await page.waitForURL(/\/results/);
  await expect(page.getByRole("heading", { name: "三维对比报告" })).toBeVisible();

  await page.getByRole("link", { name: "继续填写" }).click();
  await page.waitForURL(/\/complete/);
  await page.getByRole("spinbutton", { name: "税前月薪" }).fill("20000");
  await page.getByRole("spinbutton", { name: "固定薪数" }).fill("12");
  await page.getByRole("button", { name: "生成对比报告" }).click();
  await page.waitForURL(/\/results/);
  await expect(page.getByRole("heading", { name: "三维对比报告" })).toBeVisible();
  await expect(page.getByRole("region", { name: "关键指标横向对比" }).getByText("¥20,000 × 12")).toBeVisible();
});
