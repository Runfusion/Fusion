import { describe, expect, it } from "vitest";
import { aggregateReportData } from "../aggregation.js";
import { resolveEnabledCadences } from "../cadence.js";
import { startReportsPipeline } from "../pipeline.js";
import { createInMemoryReportsRunsStore } from "../runs-store.js";

describe("reports scaffold seams", () => {
  it("resolves daily and weekly cadence by default in UTC", () => {
    expect(resolveEnabledCadences({})).toEqual([
      { cadence: "daily", timezone: "UTC" },
      { cadence: "weekly", timezone: "UTC" },
    ]);
  });

  it("resolves weekly-only cadence with configured timezone", () => {
    expect(
      resolveEnabledCadences({ dailyEnabled: false, weeklyEnabled: true, timezone: "America/Los_Angeles" }),
    ).toEqual([{ cadence: "weekly", timezone: "America/Los_Angeles" }]);
  });

  it("returns empty sections from scaffold aggregator", async () => {
    const output = await aggregateReportData({ runId: "run-1", cadence: "daily", settings: {} });
    expect(output.sections).toEqual([]);
  });

  it("runs pipeline to review status on happy path", async () => {
    const runsStore = createInMemoryReportsRunsStore();
    const result = await startReportsPipeline(
      { runId: "run-1", cadence: "daily", settings: {} },
      { runsStore, aggregate: aggregateReportData },
    );

    expect(result.status).toBe("review");
    const stored = await runsStore.get("run-1");
    expect(stored).toEqual(result);
    expect(stored?.cadence).toBe("daily");
  });

  it("marks pipeline run failed when aggregation throws and does not rethrow", async () => {
    const runsStore = createInMemoryReportsRunsStore();
    const result = await startReportsPipeline(
      { runId: "run-2", cadence: "weekly", settings: {} },
      {
        runsStore,
        aggregate: async () => {
          throw new Error("boom");
        },
      },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBe("boom");
    await expect(runsStore.get("run-2")).resolves.toEqual(result);
  });

  it("returns undefined when updating unknown run", async () => {
    const runsStore = createInMemoryReportsRunsStore();
    await expect(runsStore.update("missing", { status: "failed" })).resolves.toBeUndefined();
  });
});
