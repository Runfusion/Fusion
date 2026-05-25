import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { computeMaxWorkers } from "../../packages/core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

const coreSetup = fileURLToPath(
  new URL("../../packages/core/src/__test-utils__/vitest-setup.ts", import.meta.url),
);
const dashboardSetup = fileURLToPath(
  new URL("./src/dashboard/test-setup.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@fusion/dashboard": fileURLToPath(new URL("../../packages/dashboard/src/index.ts", import.meta.url)),
      "@fusion/plugin-sdk": fileURLToPath(new URL("../../packages/plugin-sdk/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // coreSetup runs for all projects via extends: true inheritance
    setupFiles: [coreSetup],
    globalSetup: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-teardown.ts", import.meta.url))],
    pool: "threads",
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers }, forks: { minForks: 1, maxForks: maxWorkers } },
    projects: [
      {
        extends: true,
        test: {
          name: "reports-dashboard",
          environment: "jsdom",
          include: ["src/dashboard/**/__tests__/**/*.test.{ts,tsx}", "src/dashboard/**/*.test.{ts,tsx}"],
          // coreSetup is inherited from root via extends: true.
          // Only add dashboardSetup which is jsdom-specific.
          setupFiles: [dashboardSetup],
        },
      },
      {
        extends: true,
        test: {
          name: "reports-node",
          environment: "node",
          include: ["src/**/__tests__/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
          exclude: ["src/dashboard/**/__tests__/**/*.test.{ts,tsx}", "src/dashboard/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
