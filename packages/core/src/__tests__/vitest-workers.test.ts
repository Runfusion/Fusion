import { afterEach, describe, expect, it } from "vitest";
import { cpus } from "node:os";
import { computeMaxWorkers } from "../__test-utils__/vitest-workers";

const ORIGINAL_ENV = { ...process.env };

describe("computeMaxWorkers", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses explicit VITEST_MAX_WORKERS for package-scoped runs", () => {
    process.env.VITEST_MAX_WORKERS = "4";
    delete process.env.FUSION_TEST_TOTAL_WORKERS;
    delete process.env.FUSION_TEST_CONCURRENCY;

    const workers = computeMaxWorkers({ defaultCap: 2 });
    const cpuCap = Math.max(1, cpus().length - 1);

    expect(workers).toBe(Math.min(4, cpuCap));
    expect(process.env.VITEST_MAX_WORKERS).toBe(String(workers));
  });

  it("clamps explicit VITEST_MAX_WORKERS to workspace per-package budget", () => {
    process.env.VITEST_MAX_WORKERS = "4";
    process.env.FUSION_TEST_TOTAL_WORKERS = "4";
    process.env.FUSION_TEST_CONCURRENCY = "2";

    const workers = computeMaxWorkers({ defaultCap: 2 });

    expect(workers).toBe(2);
    expect(process.env.VITEST_MAX_WORKERS).toBe("2");
  });

  it("still derives workers from workspace budget when explicit override is absent", () => {
    delete process.env.VITEST_MAX_WORKERS;
    process.env.FUSION_TEST_TOTAL_WORKERS = "6";
    process.env.FUSION_TEST_CONCURRENCY = "2";

    const workers = computeMaxWorkers({ defaultCap: 2 });

    expect(workers).toBe(3);
    expect(process.env.VITEST_MAX_WORKERS).toBe("3");
  });

  it("ignores invalid env values and falls back to default cap", () => {
    process.env.VITEST_MAX_WORKERS = "abc";
    process.env.FUSION_TEST_TOTAL_WORKERS = "0";
    process.env.FUSION_TEST_CONCURRENCY = "-1";

    const workers = computeMaxWorkers({ defaultCap: 2 });

    expect(workers).toBe(2);
    expect(process.env.VITEST_MAX_WORKERS).toBe("2");
  });
});
