import { describe, expect, it } from "vitest";
import { collectDeterministicSignals } from "../eval/eval-signal-collector.js";
import type { TaskDetail } from "../types.js";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-1",
    description: "desc",
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T01:00:00.000Z",
    prompt: "prompt",
    ...overrides,
  } as TaskDetail;
}

describe("collectDeterministicSignals", () => {
  it("normalizes timing workflow review and commit/log evidence", () => {
    const task = makeTask({
      id: "FN-22",
      status: "in-review",
      executionStartedAt: "2026-05-01T00:00:00.000Z",
      executionCompletedAt: "2026-05-01T00:05:00.000Z",
      timedExecutionMs: 120000,
      branch: "fn/fn-22",
      mergeDetails: { commitSha: "abc1234", mergedAt: "2026-05-01T00:06:00.000Z" },
      workflowStepResults: [
        { workflowStepId: "WS-1", workflowStepName: "lint", status: "passed" },
        { workflowStepId: "WS-2", workflowStepName: "tests", status: "failed" },
      ],
      log: [
        { timestamp: "1", action: "[timing] tests in 450ms" },
        { timestamp: "2", action: "warning: flaky" },
        { timestamp: "3", action: "error: boom" },
      ],
    });

    const signals = collectDeterministicSignals(task, { runId: "ER-1", startedAt: "2026-05-02T00:00:00.000Z" });
    expect(signals.workflowSummary).toEqual({ total: 2, passed: 1, failed: 1, pending: 0 });
    expect(signals.reviewStatus).toBe("in-review");
    expect(signals.commitSummary.commitCount).toBe(1);
    expect(signals.logSummary).toEqual({ errorCount: 1, warningCount: 1, timingEntries: 1 });
    expect(signals.evidence.some((e) => e.kind === "timing")).toBe(true);
  });

  it("handles missing optional metadata without throwing", () => {
    const task = makeTask({ column: "archived", log: [] });
    const signals = collectDeterministicSignals(task, { runId: "ER-2", startedAt: "2026-05-02T00:00:00.000Z" });
    expect(signals.column).toBe("archived");
    expect(signals.workflowSummary).toEqual({ total: 0, passed: 0, failed: 0, pending: 0 });
    expect(signals.commitSummary.commitCount).toBe(0);
    expect(signals.logSummary).toEqual({ errorCount: 0, warningCount: 0, timingEntries: 0 });
  });
});
