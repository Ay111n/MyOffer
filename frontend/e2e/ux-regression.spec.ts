import { expect, test } from "@playwright/test";

/**
 * 2026-10 试用反馈修复的回归锚点（docs/issue-triage-2026-10-27.md 批次二～四）：
 * 手风琴多开、必填缺失地图、从上一份带入、年终奖切换与换算、问卷摘要卡
 * 实时权重与买房题说明、导出反馈、报告页目录、月供收入比警示。
 */

const heading = { name: "一次录入，多维对比" };

/** 七项必填的 API 造数（与 report-generation.spec 同口径）。 */
const CORE_FACTS = {
  city: "北京", monthly_base: 20000, guaranteed_salary_months: 12,
  business_level: "core", entry_scope: "small_feature",
  weekly_work_hours: 50, work_days_per_week: 5,
};

/** 用 API 填齐两份 Offer 并保存问卷答案，再从 UI 生成排名报告。 */
async function generateRankedReport(
  page: import("@playwright/test").Page,
  { city = "北京", monthlyBase = 20000, buyChoice = "undecided" } =
    { city: "北京", monthlyBase: 20000, buyChoice: "undecided" },
) {
  await page.goto("/");
  await expect(page.getByRole("heading", heading)).toBeVisible();
  const sid = await page.evaluate(() => sessionStorage.getItem("myoffer_sid"));
  expect(sid).toBeTruthy();
  const offers = (await (await page.request.get(`/api/v1/sessions/${sid}/offers`)).json()).data;
  for (const offer of offers) {
    const patched = await page.request.patch(`/api/v1/sessions/${sid}/offers/${offer.offer_id}`, { data: {
      version: offer.version,
      facts: Object.entries({ ...CORE_FACTS, city, monthly_base: monthlyBase })
        .map(([field_key, value]) => ({ field_key, value })),
    } });
    expect(patched.ok()).toBeTruthy();
  }
  const answers = ["economic_vs_growth", "economic_vs_experience", "growth_vs_experience"]
    .map((question_id) => ({ question_id, choice: "equal" }));
  answers.push({ question_id: "buy_house_intent", choice: buyChoice });
  const pref = await page.request.put(`/api/v1/sessions/${sid}/preferences`, { data: {
    version: 1, source: "questionnaire", questionnaire_version: "v2", answers,
  } });
  expect(pref.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: "生成对比报告" }).click();
  await page.waitForURL(/\/results/);
  await expect(page.getByRole("heading", { name: "三维对比报告" })).toBeVisible();
}

test("表单允许多分区同开，保存语义诚实，分区头按必填口径计数", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", heading)).toBeVisible();
  // 诚实保存文案：身份行标「自动保存」（表单级长说明句已按用户反馈移除）
  await expect(page.getByText("自动保存", { exact: true })).toBeVisible();

  // 手风琴多开：首个分区默认展开，再展开其余分区后先前的不收起（互斥已移除）
  const sectionButton = (name: string) => page.getByRole("button", { name, exact: true });
  await expect(sectionButton("经济回报")).toHaveAttribute("aria-expanded", "true");
  await sectionButton("职业成长").click();
  await sectionButton("工作体验").click();
  for (const section of ["经济回报", "职业成长", "工作体验"]) {
    await expect(sectionButton(section)).toHaveAttribute("aria-expanded", "true");
  }
  // 分区头是必填口径（经济回报 3 项必填），不再把选填计入分母
  await expect(page.getByRole("button", { name: "经济回报", exact: true })).toContainText("必填 0/3");
});

test("必填缺失地图点名缺项，点击定位字段，填齐后消失", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("group", { name: "必填缺失地图" })).toBeVisible();
  // 全新表单：七项全缺
  for (const label of ["工作城市", "税前月薪", "固定薪数", "周工作天数"]) {
    await expect(page.getByRole("group", { name: "必填缺失地图" }).getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  // 点击 chip：展开所在分区并滚动高亮该字段
  await page.getByRole("group", { name: "必填缺失地图" }).getByRole("button", { name: "工作城市", exact: true }).click();
  await expect(page.locator('[data-field-anchor$=":city"]')).toBeInViewport();

  // 七项填齐后地图消失，标签计数 7/7
  const sid = await page.evaluate(() => sessionStorage.getItem("myoffer_sid"));
  expect(sid).toBeTruthy();
  const offers = (await (await page.request.get(`/api/v1/sessions/${sid}/offers`)).json()).data;
  for (const offer of offers) {
    const patched = await page.request.patch(`/api/v1/sessions/${sid}/offers/${offer.offer_id}`, { data: {
      version: offer.version,
      facts: Object.entries(CORE_FACTS).map(([field_key, value]) => ({ field_key, value })),
    } });
    expect(patched.ok()).toBeTruthy();
  }
  await page.reload();
  await expect(page.getByRole("group", { name: "必填缺失地图" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Offer A.*7\/7/ })).toBeVisible();
});

test("从上一份带入只补空白项，不覆盖已填内容", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer A.*0\/7/ })).toBeVisible();

  // Offer A：填月薪 + 城市（城市走自定义下拉）
  await page.getByRole("spinbutton", { name: "税前月薪" }).fill("20000");
  await page.locator("#offer-panel").getByRole("button", { name: "工作城市" }).click();
  await page.getByRole("option", { name: "北京", exact: true }).click();

  // Offer B：先填自己的月薪（带入不得覆盖）
  await page.getByRole("button", { name: /Offer B/ }).click();
  const salary = page.getByRole("spinbutton", { name: "税前月薪" });
  await expect(salary).toHaveValue("");
  await salary.fill("9999");

  await page.getByRole("button", { name: "从上一份带入" }).click();
  await expect(salary).toHaveValue("9999");
  // 空白项被补上：城市从 A 带入
  await expect(page.locator("#offer-panel").getByRole("button", { name: "工作城市" })).toContainText("北京");
});

test("信息类提示走非阻塞 toast 并自动淡出", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();
  // B 无来源内容可带入 → 信息提示（不是需要处理的错误）
  await page.getByRole("button", { name: /Offer B/ }).click();
  await page.getByRole("button", { name: "从上一份带入" }).click();
  const toast = page.getByText("上一份 Offer 还没有可带入的内容。");
  await expect(toast).toBeVisible();
  await expect(toast).toBeHidden({ timeout: 3_500 });
  // 通知不应占用常驻错误位（页面内不出现 role=alert 的 ErrorText；
  // Next 的路由播报器在 main 之外，不在断言范围）
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
});

test("年终奖方式切换作废旧数值，倍数模式实时换算", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("spinbutton", { name: "税前月薪" }).fill("20000");

  // 选「金额」并填写
  await page.getByRole("button", { name: "金额", exact: true }).click();
  await page.getByRole("spinbutton", { name: "年终奖金额" }).fill("20000");

  // 切到「倍数」：同一输入框单位变化，旧金额显式作废（待定 → 空输入）
  await page.getByRole("button", { name: "倍数", exact: true }).click();
  const bonusInput = page.getByRole("spinbutton", { name: "年终奖倍数" });
  await expect(bonusInput).toHaveValue("");

  // 填倍数后立即看到换算，不用等报告
  await bonusInput.fill("3");
  await expect(page.getByText("≈ 月薪 × 3 = ¥60,000/年")).toBeVisible();
});

test("问卷答完未保存时摘要卡显示你的权重；买房题选项带后果说明", async ({ page }) => {
  await page.goto("/");
  const header = page.locator('button[aria-controls="preference-questionnaire"]');
  await expect(header).toContainText("默认：经济回报 34%");
  await header.click();

  // 第 4 题买房：三个选项各带计算后果说明（盲选问题修复）
  await page.getByRole("button", { name: "跳转到第 4 题，未作答" }).click();
  await expect(page.getByText(/把月供压力计入经济回报/)).toBeVisible();
  await expect(page.getByText(/暂不计入买房压力/)).toBeVisible();

  // 答完四题（不点保存），折叠条摘要应即时反映
  await page.getByRole("button", { name: "还没决定" }).click();
  for (let index = 1; index <= 3; index += 1) {
    await page.getByRole("button", { name: `跳转到第 ${index} 题，未作答` }).click();
    await page.getByRole("button", { name: "一样重要" }).click();
  }
  await expect(header).toContainText("你的偏好已算出，尚未保存");
  await expect(header).toContainText("你的权重：经济回报 34%");
  await expect(header).not.toContainText("默认：");
});

test("导出成功给出可见反馈并触发下载", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer A.*0\/7/ })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "导出数据" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("MyOffer-输入与偏好.json");
  await expect(page.getByRole("button", { name: "已导出 ✓" })).toBeVisible();
});

test("报告页显示页内目录，锚点可跳转", async ({ page }) => {
  await generateRankedReport(page);
  const toc = page.getByRole("navigation", { name: "报告页目录" });
  await expect(toc).toBeVisible();
  for (const label of ["得分", "结论", "原因", "差异", "稳不稳", "试算", "靠不靠谱", "下一步", "详细依据", "修改记录"]) {
    await expect(toc.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  await toc.getByRole("link", { name: "修改记录" }).click();
  await expect(page).toHaveURL(/#history$/);
});

test("月供收入比超过 100% 时红色警示并给一句解读", async ({ page }) => {
  // 深圳参考房价 + 5000 月薪 → 月供远超到手收入
  await generateRankedReport(page, { city: "深圳", monthlyBase: 5000, buyChoice: "consider" });
  await expect(page.getByText(/月供收入比/)).toBeVisible();
  await expect(page.getByText(/月供已超过到手收入/)).toBeVisible();
});
