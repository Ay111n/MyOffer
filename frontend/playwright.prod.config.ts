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
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? "8000");

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
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
