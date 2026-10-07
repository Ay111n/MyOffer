import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "happy-dom",
    include: ["lib/**/*.test.ts", "stores/**/*.test.ts", "components/**/*.test.ts"],
  },
});
