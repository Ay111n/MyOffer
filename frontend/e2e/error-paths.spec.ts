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
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
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
  // 只填了 Offer A：空 Offer 不参与评分的确认弹窗需要接受才能走到提交
  page.on("dialog", (dialog) => void dialog.accept());
  // 批量提交端点为 /questions/answers/batch（旧逐题端点已下线）
  await page.route("**/api/v1/sessions/*/questions/answers/batch", (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "internal_error", message: "服务器内部错误，请稍后重试", details: {} } }),
  }));
  await page.getByRole("button", { name: "生成对比报告" }).click();
  await expect(page.getByText(/服务器内部错误|提交失败/).first()).toBeVisible();
  await expect(page).not.toHaveURL(/\/results/);
  await expect(page.getByRole("button", { name: "生成对比报告" })).toBeEnabled();
});

test("会话失效后本机草稿保留并可通过横幅恢复", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer A.*0\/7/ })).toBeVisible();
  await page.getByRole("spinbutton", { name: "税前月薪" }).fill("20000");
  // 草稿写入 localStorage 后再制造会话失效
  await expect.poll(() =>
    page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("offer-drafts:"))),
  ).toBe(true);
  await page.evaluate(() => sessionStorage.setItem("myoffer_sid", "00000000-0000-0000-0000-00000000dead"));
  await page.reload();
  // 404 → 只解除会话绑定（草稿保留）→ 自动重建 → 恢复横幅出现
  await expect(page.getByText("检测到上次未提交的填写内容")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "恢复到本次比较" }).click();
  await expect(page.getByRole("spinbutton", { name: "税前月薪" })).toHaveValue("20000");
  await expect(page.getByText("检测到上次未提交的填写内容")).toBeHidden();
});

test("放弃恢复会删除旧会话草稿", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer A.*0\/7/ })).toBeVisible();
  await page.getByRole("spinbutton", { name: "税前月薪" }).fill("20000");
  await expect.poll(() =>
    page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("offer-drafts:"))),
  ).toBe(true);
  await page.evaluate(() => sessionStorage.setItem("myoffer_sid", "00000000-0000-0000-0000-00000000dead"));
  await page.reload();
  await expect(page.getByText("检测到上次未提交的填写内容")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "放弃并删除" }).click();
  await expect(page.getByText("检测到上次未提交的填写内容")).toBeHidden();
  await expect.poll(() =>
    page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("offer-drafts:"))),
  ).toBe(false);
  await expect(page.getByRole("spinbutton", { name: "税前月薪" })).toHaveValue("");
});

test("清除本机数据同时清掉旧会话的孤儿草稿与问卷缓存", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", heading)).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem(
      "offer-drafts:00000000-0000-0000-0000-00000000old:economic",
      JSON.stringify({ t: Date.now(), v: { o1: { monthly_base: { status: "known", value: 1 } } } }),
    );
    // 问卷草稿主存储在 localStorage（2026-10-28 起，跨标签存活），
    // 旧版 sessionStorage 键在清除时一并尝试删除
    localStorage.setItem(
      "preference-questionnaire:00000000-0000-0000-0000-00000000old",
      JSON.stringify({ t: Date.now(), v: { version: "v2", answers: [] } }),
    );
    sessionStorage.setItem(
      "preference-questionnaire:00000000-0000-0000-0000-00000000old",
      JSON.stringify({ version: "v2", answers: [] }),
    );
    sessionStorage.setItem(
      "myoffer-ai-report:00000000-0000-0000-0000-00000000old:1",
      JSON.stringify({}),
    );
  });
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "清除本机数据" }).click();
  await expect.poll(() =>
    page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("offer-drafts:"))),
  ).toBe(false);
  await expect.poll(() =>
    page.evaluate(() =>
      Object.keys(localStorage).some((key) => key.startsWith("preference-questionnaire:"))),
  ).toBe(false);
  await expect.poll(() =>
    page.evaluate(() =>
      Object.keys(sessionStorage).some((key) =>
        key.startsWith("preference-questionnaire:") || key.startsWith("myoffer-ai-report:")),
    ),
  ).toBe(false);
});

test("清除本机数据后刷新不复活（2026-10-28 反馈 P0 的回归锁）", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", heading)).toBeVisible();
  // 真实用户路径：填写 → 清除 → 刷新。存储层若未清，刷新后数据会原地复活
  await page.getByRole("spinbutton", { name: "税前月薪" }).fill("18000");
  const readPersistedSid = () => page.evaluate(() => {
    const raw = localStorage.getItem("myoffer_sid_persist");
    if (!raw) return null;
    try {
      return (JSON.parse(raw) as { sid?: string }).sid ?? null;
    } catch {
      return null;
    }
  });
  const sidBefore = await readPersistedSid();
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "清除本机数据" }).click();
  await expect(page.getByRole("button", { name: /Offer A.*0\/7/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /Offer A.*0\/7/ })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "税前月薪" })).toHaveValue("");
  await expect.poll(() =>
    page.evaluate(() => Object.keys(localStorage).filter((key) =>
      key.startsWith("offer-drafts:") || key.startsWith("preference-questionnaire:")).length),
  ).toBe(0);
  // 清除后页面自动新建空白会话：persist 记录的是新 sid，旧会话痕迹不残留
  expect(await readPersistedSid()).toBeTruthy();
  expect(await readPersistedSid()).not.toBe(sidBefore);
});

test("会话失效跳回首页时有 toast 交代（不再静默）", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("myoffer_sid", "00000000-0000-0000-0000-00000000dead"));
  await page.goto("/results");
  // predicate 版 toHaveURL 内部仍等待 load；直接轮询 URL，避开整页跳转的中断。
  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  await expect(page.getByText("会话已失效，本机草稿仍保留")).toBeVisible();
  await expect(page.getByRole("heading", heading)).toBeVisible();
});

test("手机宽度顶栏操作项不竖排（2026-10-28 反馈）", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", heading)).toBeVisible();
  const metrics = await page.evaluate(() => {
    const texts = ["模型配置", "导入数据", "导出数据", "清除本机数据"];
    const spans = texts.map((text) => {
      const el = [...document.querySelectorAll("header a, header button")]
        .find((node) => node.textContent?.trim().includes(text));
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { text, width: rect.width, height: rect.height };
    });
    return {
      spans,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  for (const metric of metrics.spans) {
    expect(metric, "顶栏四个操作项都渲染").toBeTruthy();
    // 逐字竖排的形态是宽 ≪ 高（「模型配置」曾实测 20×92）；正常按钮宽度大于高度
    expect(metric!.width, `${metric!.text} 未被压成逐字竖排`).toBeGreaterThan(metric!.height * 0.8);
  }
  expect(metrics.overflow, "375px 内容无横向溢出").toBe(false);
});
