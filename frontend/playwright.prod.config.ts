import { defineConfig, devices } from "@playwright/test";

/**
 * 生产形态 E2E：对 `next build` 产出的静态 out/ 跑同一套用例。
 *
 * 与 playwright.config.ts（dev 形态）的差异：静态导出没有 dev 代理，
 * 由 e2e/static-server.mjs 模拟 nginx（静态回退 + /api 反代），因此
 * 路由回退、刷新恢复、API 错误处理都在与生产一致的形态下被验证。
 *
 * 前置：先 `npm run build` 产出 out/（Makefile e2e-prod 目标已包含）。
 */
const STATIC_PORT = 4173;
/** e2e 专用后端端口：与开发用的 8000 错开。reuseExistingServer 会复用端口上
 *  已经在跑的服务——若复用的是手工启动的开发后端，下面注入的限流豁免不会
 *  生效（env 只对 Playwright 自己拉起的进程有效），E2E 就会莫名撞上 429。 */
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? "8010");

/** E2E 限流豁免：后端按 client IP 限制匿名会话创建（默认 30 次/分），而每个
 *  Playwright 用例都是全新 context → 每次首页加载都新建匿名身份，几十个用例
 *  同走 127.0.0.1，一分钟内必然触发 429，页面报「创建会话失败：请求过于频繁」。
 *  只放宽 E2E 自己的后端进程，生产阈值不动。 */
const E2E_BACKEND_ENV = { RATE_LIMIT_SESSIONS_PER_MINUTE: "1000" };

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 2,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${STATIC_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node e2e/static-server.mjs",
      url: `http://127.0.0.1:${STATIC_PORT}`,
      reuseExistingServer: true,
      timeout: 30_000,
      env: { PORT: String(STATIC_PORT), API_ORIGIN: `http://127.0.0.1:${BACKEND_PORT}` },
    },
    {
      // venv 里的 uvicorn 不在 PATH 上，统一用 venv 的 python -m uvicorn
      // （路径按平台区分，与 playwright.config.ts 同一口径）。
      command: process.platform === "win32"
        ? `cd /d ..\\backend && .venv\\Scripts\\python.exe -m uvicorn app.main:app --port ${BACKEND_PORT}`
        : `cd ../backend && .venv/bin/python -m uvicorn app.main:app --port ${BACKEND_PORT}`,
      url: `http://127.0.0.1:${BACKEND_PORT}/healthz`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: E2E_BACKEND_ENV,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
