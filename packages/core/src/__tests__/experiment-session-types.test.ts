import { describe, expect, it } from "vitest";
import {
  EXPERIMENT_METRIC_DIRECTIONS,
  EXPERIMENT_RECORD_TYPES,
  EXPERIMENT_RUN_OUTCOMES,
  EXPERIMENT_SESSION_STATUSES,
  isConfigRecord,
  isFinalizeRecord,
  isHookRecord,
  isRunRecord,
  type ExperimentSessionRecord,
} from "../eval/experiment-session-types.js";

describe("experiment-session-types", () => {
  it("defines constants with expected members and order", () => {
    expect(EXPERIMENT_SESSION_STATUSES).toEqual(["active", "finalizing", "finalized", "archived"]);
    expect(EXPERIMENT_METRIC_DIRECTIONS).toEqual(["maximize", "minimize"]);
    expect(EXPERIMENT_RECORD_TYPES).toEqual(["config", "run", "hook", "finalize"]);
    expect(EXPERIMENT_RUN_OUTCOMES).toEqual(["keep", "discard", "checks_failed", "errored", "pending"]);
  });

  it("narrowing helpers identify record payload types", () => {
    const records: ExperimentSessionRecord[] = [
      {
        id: "EXPR-1",
        sessionId: "EXP-1",
        segment: 1,
        seq: 1,
        type: "config",
        payload: { metric: { name: "throughput", direction: "maximize" } },
        createdAt: new Date().toISOString(),
      },
      {
        id: "EXPR-2",
        sessionId: "EXP-1",
        segment: 1,
        seq: 2,
        type: "run",
        payload: { primaryMetric: 123, secondaryMetrics: [], status: "keep" },
        createdAt: new Date().toISOString(),
      },
      {
        id: "EXPR-3",
        sessionId: "EXP-1",
        segment: 1,
        seq: 3,
        type: "hook",
        payload: { hook: "before", exitCode: 0 },
        createdAt: new Date().toISOString(),
      },
      {
        id: "EXPR-4",
        sessionId: "EXP-1",
        segment: 1,
        seq: 4,
        type: "finalize",
        payload: { keptRunIds: ["EXPR-2"], discardedRunIds: [] },
        createdAt: new Date().toISOString(),
      },
    ];

    const [config, run, hook, finalize] = records;
    expect(isConfigRecord(config)).toBe(true);
    expect(isRunRecord(config)).toBe(false);
    expect(isRunRecord(run)).toBe(true);
    expect(run.payload.primaryMetric).toBe(123);
    expect(isHookRecord(hook)).toBe(true);
    expect(hook.payload.hook).toBe("before");
    expect(isFinalizeRecord(finalize)).toBe(true);
    expect(finalize.payload.keptRunIds).toEqual(["EXPR-2"]);
  });
});
