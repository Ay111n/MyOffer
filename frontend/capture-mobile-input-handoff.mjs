import { chromium, expect } from "@playwright/test";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const page = await context.newPage();
await page.goto(process.env.BASE_URL || "http://localhost:3000");
await page.getByRole("heading", { name: "一次录入，多维对比" }).waitFor();
await page.getByRole("button", { name: /填入示例数据/ }).click();
await expect(page.getByLabel("工作城市").first()).toContainText(/北京|上海|成都/);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
await page.screenshot({ path: "../design-handoff/2026-10-03-ai-ui-review/03-input-mobile-top.png" });
await browser.close();
