import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypescript,
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "fe-n*/**",
    "check-home-banner.cjs",
    "next-env.d.ts",
    "lib/api/schema.d.ts",
    "playwright-report/**",
    "test-results/**",
    "postcss.config.mjs",
  ]),
  {
    rules: {
      // 生成契约与本仓代码风格约定：单文件内一行式类型声明是既有风格
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);
