import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const defaultMaxWorkers = 1;
const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);
const maxWorkers = Math.max(1, Math.min(1, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : defaultMaxWorkers));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@fusion/core": resolve(__dirname, "../core/src/index.ts"),
      "@fusion/engine": resolve(__dirname, "../engine/src/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["app/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    maxWorkers,
    fileParallelism: true,
    isolate: true,
    coverage: {
      enabled: false,
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
      include: ["app/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts", "dist/**"],
    },
  },
});
