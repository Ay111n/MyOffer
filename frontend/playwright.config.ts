import { defineConfig, devices } from "@playwright/test";

/**
 * 冒烟 E2E：走通「创建会话 → 信息补全 → 进入偏好」核心路径。
 * 前置：后端使用当前进程内临时存储，无需数据库。
 */

/** venv 里的 uvicorn 不在 PATH 上（裸 uvicorn 在未激活 venv 的机器上会
 *  启动失败、健康检查超时），统一用 venv 的 python -m uvicorn 拉起。 */
const backendUvicorn = process.platform === "win32"
  ? "cd /d ..\\backend && .venv\\Scripts\\python.exe -m uvicorn app.main:app --port 8000"
  : "cd ../backend && .venv/bin/python -m uvicorn app.main:app --port 8000";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3010",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // 生产构建是静态导出（output: 'export'），next start 不可用；
      // dev 模式自带 /api → :8000 的代理，冒烟测试用它即可。
      command: "npx next dev -p 3010",
      url: "http://localhost:3010",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: backendUvicorn,
      url: "http://localhost:8000/healthz",
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
