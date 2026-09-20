import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@fusion/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)), "@fusion/plugin-sdk": fileURLToPath(new URL("../../packages/plugin-sdk/src/index.ts", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
