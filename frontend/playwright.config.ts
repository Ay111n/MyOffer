import { defineConfig, devices } from "@playwright/test";

/**
 * 冒烟 E2E：走通「创建会话 → 信息补全 → 进入偏好」核心路径。
 * 前置：后端使用当前进程内临时存储，无需数据库。
 */

/** e2e 专用后端端口：与开发用的 8000 错开。reuseExistingServer 会复用端口上
 *  已经在跑的服务——若复用的是手工启动的开发后端，下面注入的限流豁免不会
 *  生效（env 只对 Playwright 自己拉起的进程有效），E2E 就会莫名撞上 429。 */
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? "8010");

/** E2E 限流豁免：后端按 client IP 限制匿名会话创建（默认 30 次/分），而每个
 *  Playwright 用例都是全新 context → 每次首页加载都新建匿名身份，几十个用例
 *  同走 127.0.0.1，一分钟内必然触发 429，页面报「创建会话失败：请求过于频繁」。
 *  只放宽 E2E 自己的后端进程，生产阈值不动。 */
const E2E_BACKEND_ENV = { RATE_LIMIT_SESSIONS_PER_MINUTE: "1000" };

/** venv 里的 uvicorn 不在 PATH 上（裸 uvicorn 在未激活 venv 的机器上会
 *  启动失败、健康检查超时），统一用 venv 的 python -m uvicorn 拉起。 */
const backendUvicorn = process.platform === "win32"
  ? `cd /d ..\\backend && .venv\\Scripts\\python.exe -m uvicorn app.main:app --port ${BACKEND_PORT}`
  : `cd ../backend && .venv/bin/python -m uvicorn app.main:app --port ${BACKEND_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  // next dev 是开发服务器：并发 worker 越多，首次编译与热更新越慢，页面能渲染
  // 但 5s 内没等到断言目标，用例就以超时收场（实测 8 worker 时单条要 1 分钟）。
  // 这里与 prod 配置取同一档并发与断言超时——冒烟要的是稳定通过，不是跑得快。
  workers: 2,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: "http://localhost:3010",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // 生产构建是静态导出（output: 'export'），next start 不可用；
      // dev 模式自带 /api → 后端的代理，冒烟测试用它即可。
      command: "npx next dev -p 3010",
      // 代理目标必须指向本配置拉起的 e2e 后端，而不是开发用的 8000
      // （next.config.ts 读 BACKEND_ORIGIN，缺省是 http://localhost:8000）。
      env: { BACKEND_ORIGIN: `http://127.0.0.1:${BACKEND_PORT}` },
      url: "http://localhost:3010",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: backendUvicorn,
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
