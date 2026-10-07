import { expect, test } from "@playwright/test";

test("四部分分别生成 AI 解读，刷新后保留各自结果", async ({ page }) => {
  test.setTimeout(120_000);
  const model = "deepseek-chat";
  let snapshotSeq = 0;
  const config = {
    storage: "memory", selected: { provider: "deepseek", model }, active_jobs: [],
    providers: [{ id: "deepseek", name: "DeepSeek", api_key: true, oauth: false,
      subscription: false, auth_type: "api_key", last_check: null,
      models: [{ id: model, name: "DeepSeek Chat", context_window: 64000, reasoning: false, vision: false }] }],
  };
  const jobIds = new Map<string, keyof typeof sections>();
  const requests: (keyof typeof sections)[] = [];
  const sections = {
    overall: "总体分析已生成。\n\n需要留意不同维度的取舍。",
    economic: "经济回报分析已生成。",
    growth: "职业成长分析已生成。",
    experience: "工作体验分析已生成。",
  };
  await page.route("**/api/v1/ai/bootstrap", (route) => route.fulfill({ json: { data: config } }));
  await page.route("**/api/v1/ai/config", (route) => route.fulfill({ json: { data: config } }));
  await page.route("**/api/v1/sessions/*/report/ai-analysis", async (route) => {
    const body = route.request().postDataJSON() as { snapshot_seq: number; part: keyof typeof sections };
    snapshotSeq = body.snapshot_seq;
    requests.push(body.part);
    const jobId = `11111111-1111-4111-8111-${String(requests.length).padStart(12, "0")}`;
    jobIds.set(jobId, body.part);
    await route.fulfill({ status: 202, json: { data: {
      id: jobId, kind: "analysis", provider: "deepseek", model, status: "pending",
      snapshot_seq: snapshotSeq, stage: body.part, sections: {},
      expires_at: "2026-10-07T12:00:00Z",
    } } });
  });
  await page.route("**/api/v1/ai/jobs/*", (route) => {
    const jobId = route.request().url().split("/").pop()!;
    const part = jobIds.get(jobId)!;
    return route.fulfill({ json: { data: {
    id: jobId, kind: "analysis", provider: "deepseek", model, status: "succeeded",
    snapshot_seq: snapshotSeq, stage: part, sections: { [part]: sections[part] },
    expires_at: "2026-10-07T12:00:00Z",
  } } });
  });

  await page.goto("/");
  await expect(page.getByRole("link", { name: "模型配置" }).first()).toBeVisible();
  await page.getByRole("link", { name: "模型配置" }).first().click();
  await expect(page.getByRole("heading", { name: "模型配置" })).toBeVisible();
  await expect(page.getByText("当前默认：DeepSeek / deepseek-chat")).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("button", { name: /Offer B.*0\/7/ })).toBeVisible();
  await page.getByRole("button", { name: "填入示例数据" }).click();
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

  const overall = page.locator('section[aria-label="总体结果分析"]');
  const dimensions = page.getByRole("region", { name: "三维结果分析" });
  await expect(overall.getByRole("button", { name: "生成总体分析" })).toBeVisible();
  for (const [label, analysis] of [["经济回报", "经济回报分析"], ["职业成长", "职业成长分析"], ["工作体验", "工作体验分析"]] as const) {
    const dimension = dimensions.locator(":scope > section").filter({ has: page.getByRole("heading", { name: label, exact: true }) });
    await expect(dimension.locator(`[aria-label="${label}维度总分"] strong`)).toHaveCount(2);
    await expect(dimension.locator(`[aria-label="${analysis}"]`).getByRole("button", { name: `生成${analysis}` })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "AI 分析 · 总体与三维分项" })).toHaveCount(0);
  await overall.getByRole("button", { name: "生成总体分析" }).click();
  await expect(overall.getByRole("heading", { name: "综合解读" })).toBeVisible();
  await expect(overall.locator("p", { hasText: "总体分析已生成。" })).toBeVisible();
  await expect(overall.locator("p", { hasText: "需要留意不同维度的取舍。" })).toBeVisible();
  await expect(overall.locator("p").filter({ hasText: /总体分析已生成|需要留意不同维度/ })).toHaveCount(2);
  expect(requests).toEqual(["overall"]);
  for (const [label, key] of [["经济回报", "economic"], ["职业成长", "growth"], ["工作体验", "experience"]] as const) {
    const dimension = dimensions.locator(":scope > section").filter({ has: page.getByRole("heading", { name: label, exact: true }) });
    await expect(dimension.getByText(sections[key])).toHaveCount(0);
    await dimension.getByRole("button", { name: `生成${label}分析` }).click();
    await expect(dimension.getByRole("heading", { name: "本节解读" })).toBeVisible();
    await expect(dimension.locator(`[aria-label="${label}分析"]`)).toContainText(sections[key]);
  }
  expect(requests).toEqual(["overall", "economic", "growth", "experience"]);
  const economic = dimensions.locator(":scope > section").filter({ has: page.getByRole("heading", { name: "经济回报", exact: true }) });
  await economic.getByRole("button", { name: "重新生成经济回报分析" }).click();
  await expect(economic.getByText(sections.economic)).toBeVisible();
  expect(requests).toEqual(["overall", "economic", "growth", "experience", "economic"]);
  await expect(overall.getByText("总体分析已生成。")).toBeVisible();
  expect(snapshotSeq).toBeGreaterThan(0);
  await page.reload();
  for (const text of ["总体分析已生成。", sections.economic, sections.growth, sections.experience]) {
    await expect(page.getByText(text)).toBeVisible();
  }
});

test("模型配置页可保存密钥、选择默认模型并测试连接", async ({ page }) => {
  const model = "deepseek-chat";
  const config = {
    storage: "memory", selected: null as null | { provider: string; model: string }, active_jobs: [],
    providers: [{ id: "deepseek", name: "DeepSeek", api_key: true, oauth: false,
      subscription: false, auth_type: null as null | "api_key", last_check: null,
      models: [{ id: model, name: "DeepSeek Chat", context_window: 64000, reasoning: false, vision: false }] }],
  };
  const jobId = "22222222-2222-4222-8222-222222222222";
  await page.route("**/api/v1/ai/bootstrap", (route) => route.fulfill({ json: { data: config } }));
  await page.route("**/api/v1/ai/config", (route) => route.fulfill({ json: { data: config } }));
  await page.route("**/api/v1/ai/providers/deepseek/key", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ api_key: "local-test-key" });
    config.providers[0].auth_type = "api_key";
    await route.fulfill({ json: { data: config } });
  });
  await page.route("**/api/v1/ai/selection", async (route) => {
    config.selected = route.request().postDataJSON() as { provider: string; model: string };
    await route.fulfill({ json: { data: config } });
  });
  await page.route("**/api/v1/ai/test", (route) => route.fulfill({ status: 202, json: { data: {
    id: jobId, kind: "test", provider: "deepseek", model, status: "pending",
    expires_at: "2026-10-07T12:00:00Z",
  } } }));
  await page.route("**/api/v1/ai/jobs/*", (route) => route.fulfill({ json: { data: {
    id: jobId, kind: "test", provider: "deepseek", model, status: "succeeded",
    message: "连接成功，模型已返回有效回复。", expires_at: "2026-10-07T12:00:00Z",
  } } }));

  await page.goto("/settings/models");
  await expect(page.getByRole("heading", { name: "模型配置" })).toBeVisible();
  await page.getByRole("textbox", { name: "API Key" }).fill("local-test-key");
  await page.getByRole("button", { name: "保存密钥" }).click();
  await expect(page.getByText("已通过API Key连接。")).toBeVisible();
  await page.getByRole("button", { name: "设为默认模型" }).click();
  await expect(page.getByText("当前默认：DeepSeek / deepseek-chat")).toBeVisible();
  await page.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByText("连接成功，模型已返回有效回复。")).toBeVisible();
});
