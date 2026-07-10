import { describe, expect, it } from "vitest";
import { formatTaskPlannerChatMetrics } from "../task-planner-chat-metrics.js";
import type { Task } from "@fusion/core";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-METRICS",
    description: "Metrics task",
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

describe("formatTaskPlannerChatMetrics", () => {
  it("derives token totals, merged per-model costs, and task timing from durable fields", () => {
    const result = formatTaskPlannerChatMetrics(makeTask({
      id: "FN-100",
      title: "Costed task",
      column: "done",
      status: "complete",
      tokenUsage: {
        inputTokens: 3000,
        outputTokens: 750,
        cachedTokens: 120,
        cacheWriteTokens: 30,
        totalTokens: 3900,
        firstUsedAt: "2026-07-01T10:00:00.000Z",
        lastUsedAt: "2026-07-01T10:30:00.000Z",
        perModel: [
          {
            modelProvider: "test-provider",
            modelId: "model-a",
            inputTokens: 1000,
            outputTokens: 200,
            cachedTokens: 50,
            cacheWriteTokens: 10,
            totalTokens: 1260,
            firstUsedAt: "2026-07-01T10:00:00.000Z",
            lastUsedAt: "2026-07-01T10:10:00.000Z",
          },
          {
            modelProvider: "test-provider",
            modelId: "model-a",
            inputTokens: 500,
            outputTokens: 100,
            cachedTokens: 20,
            cacheWriteTokens: 5,
            totalTokens: 625,
            firstUsedAt: "2026-07-01T10:05:00.000Z",
            lastUsedAt: "2026-07-01T10:20:00.000Z",
          },
          {
            modelProvider: "test-provider",
            modelId: "model-b",
            inputTokens: 1500,
            outputTokens: 450,
            cachedTokens: 50,
            cacheWriteTokens: 15,
            totalTokens: 2015,
            firstUsedAt: "2026-07-01T10:12:00.000Z",
            lastUsedAt: "2026-07-01T10:30:00.000Z",
          },
        ],
      },
      executionStartedAt: "2026-07-01T10:00:00.000Z",
      executionCompletedAt: "2026-07-01T10:05:00.000Z",
      firstExecutionAt: "2026-07-01T09:50:00.000Z",
      cumulativeActiveMs: 240_000,
      timedExecutionMs: 120_000,
      log: [
        { timestamp: "2026-07-01T10:01:00.000Z", action: "[timing] setup completed in 500ms" },
        { timestamp: "2026-07-01T10:02:00.000Z", action: "non timing event" },
        { timestamp: "2026-07-01T10:03:00.000Z", action: "tool call", outcome: "[timing] verify completed after 1500ms" },
      ],
      workflowStepResults: [
        {
          workflowStepId: "plan-review",
          workflowStepName: "Plan Review",
          status: "passed",
          startedAt: "2026-07-01T10:03:00.000Z",
          completedAt: "2026-07-01T10:04:10.000Z",
        },
        {
          workflowStepId: "code-review",
          workflowStepName: "Code Review",
          status: "passed",
          startedAt: "2026-07-01T10:04:00.000Z",
          completedAt: "2026-07-01T10:04:30.000Z",
        },
      ],
    }), {
      nowMs: Date.parse("2026-07-01T10:06:00.000Z"),
      pricingOverrides: {
        "test-provider:model-a": { inputPer1M: 1, outputPer1M: 2, cacheReadPer1M: 0.5, cacheWritePer1M: 1.5, source: "test" },
        "test-provider:model-b": { inputPer1M: 3, outputPer1M: 4, cacheReadPer1M: 1, cacheWritePer1M: 2, source: "test" },
      },
    });

    expect(result.metrics.tokens).toMatchObject({
      available: true,
      inputTokens: 3000,
      outputTokens: 750,
      cachedTokens: 120,
      cacheWriteTokens: 30,
      totalTokens: 3900,
      firstUsedAt: "2026-07-01T10:00:00.000Z",
      lastUsedAt: "2026-07-01T10:30:00.000Z",
      cost: { costUnavailable: false, pricingStale: false },
    });
    expect(result.metrics.tokens.perModel).toHaveLength(2);
    expect(result.metrics.tokens.perModel[0]).toMatchObject({
      key: "test-provider:model-a",
      inputTokens: 1500,
      outputTokens: 300,
      cachedTokens: 70,
      cacheWriteTokens: 15,
      totalTokens: 1885,
      firstUsedAt: "2026-07-01T10:00:00.000Z",
      lastUsedAt: "2026-07-01T10:20:00.000Z",
    });
    expect(result.metrics.tokens.perModel[0].cost.usd).toBeCloseTo(0.0021575);
    expect(result.metrics.tokens.perModel[1].cost.usd).toBeCloseTo(0.00638);
    expect(result.metrics.tokens.cost.usd).toBeCloseTo(0.0085375);

    expect(result.metrics.timing).toMatchObject({
      executionStartedAt: "2026-07-01T10:00:00.000Z",
      executionCompletedAt: "2026-07-01T10:05:00.000Z",
      firstExecutionAt: "2026-07-01T09:50:00.000Z",
      endToEndExecutionMs: 300_000,
      wallClockSinceFirstExecutionMs: 900_000,
      activeRuntimeMs: 240_000,
      cumulativeActiveMs: 240_000,
      timedExecutionMs: 120_000,
      logTimingDurationMs: 2_000,
      timingEventCount: 2,
      timedTimingEventCount: 2,
      workflowRuntimeMs: 100_000,
      timedWorkflowStepCount: 2,
      totalExecutionMs: 240_000,
    });
    expect(result.metrics.timing.longestTimingEvent).toMatchObject({ summary: "verify completed", durationMs: 1500 });
    expect(result.metrics.timing.longestWorkflowStep).toMatchObject({ workflowStepName: "Plan Review", durationMs: 70_000 });
    expect(result.summaryText).toContain("3,900 total tokens");
    expect(result.summaryText).toContain("estimated cost $0.0085");
  });

  it("prices current OpenAI Codex runtime identities in task-planner chat metrics", () => {
    const result = formatTaskPlannerChatMetrics(makeTask({
      tokenUsage: {
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        cachedTokens: 500_000,
        cacheWriteTokens: 100_000,
        totalTokens: 1_800_000,
        firstUsedAt: "2026-07-01T10:00:00.000Z",
        lastUsedAt: "2026-07-01T10:30:00.000Z",
        modelProvider: "openai-codex",
        modelId: "gpt-5.5",
      },
    }), { nowMs: Date.parse("2026-07-01T10:31:00.000Z") });

    expect(result.metrics.tokens.cost).toEqual({ usd: 11.25, costUnavailable: false, pricingStale: false });
    expect(result.metrics.tokens.perModel[0].cost).toEqual({ usd: 11.25, costUnavailable: false, pricingStale: false });
    expect(result.summaryText).toContain("estimated cost $11.2500");
    expect(result.summaryText).not.toContain("cost unavailable");
  });

  it("marks unpriced and stale model costs unavailable instead of reporting zero", () => {
    const result = formatTaskPlannerChatMetrics(makeTask({
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 200,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 300,
        firstUsedAt: "not-a-date",
        lastUsedAt: "2026-07-01T10:00:00.000Z",
        modelProvider: "unknown",
        modelId: "unpriced-model",
      },
    }), { nowMs: Date.parse("2027-07-01T00:00:00.000Z") });

    expect(result.metrics.tokens.cost).toEqual({ usd: null, costUnavailable: true, pricingStale: true });
    expect(result.metrics.tokens.perModel[0].cost).toEqual({ usd: null, costUnavailable: true, pricingStale: true });
    expect(result.metrics.tokens.malformedTimestamps).toEqual(["not-a-date"]);
    expect(result.summaryText).toContain("cost unavailable");
    expect(result.summaryText).toContain("pricing is stale");
  });

  it("returns deterministic empty metrics when token and timing data are absent", () => {
    const result = formatTaskPlannerChatMetrics(makeTask({ id: "FN-EMPTY", column: "archived", status: "done" }), {
      nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
    });

    expect(result.metrics.tokens).toMatchObject({
      available: false,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      firstUsedAt: null,
      lastUsedAt: null,
      perModel: [],
      cost: { usd: null, costUnavailable: false, pricingStale: false },
    });
    expect(result.metrics.timing).toMatchObject({
      endToEndExecutionMs: null,
      wallClockSinceFirstExecutionMs: null,
      activeRuntimeMs: null,
      timedExecutionMs: null,
      logTimingDurationMs: null,
      timingEventCount: 0,
      timedWorkflowStepCount: 0,
      workflowRuntimeMs: null,
      totalExecutionMs: null,
      longestTimingEvent: null,
      longestWorkflowStep: null,
    });
  });

  it("uses now for running tasks and malformed workflow timestamps stay bounded", () => {
    const result = formatTaskPlannerChatMetrics(makeTask({
      column: "in-progress",
      executionStartedAt: "2026-07-01T10:00:00.000Z",
      firstExecutionAt: "bad-first",
      cumulativeActiveMs: 60_000,
      log: [{ timestamp: "2026-07-01T10:01:00.000Z", action: "[timing] pending marker without duration" }],
      workflowStepResults: [
        {
          workflowStepId: "running-step",
          workflowStepName: "Running Step",
          status: "pending",
          startedAt: "2026-07-01T10:02:00.000Z",
        },
        {
          workflowStepId: "bad-step",
          workflowStepName: "Bad Step",
          status: "failed",
          startedAt: "not-a-date",
          completedAt: "2026-07-01T10:03:00.000Z",
        },
      ],
    }), { nowMs: Date.parse("2026-07-01T10:05:00.000Z") });

    expect(result.metrics.timing.endToEndExecutionMs).toBe(300_000);
    expect(result.metrics.timing.activeRuntimeMs).toBe(360_000);
    expect(result.metrics.timing.wallClockSinceFirstExecutionMs).toBeNull();
    expect(result.metrics.timing.timingEventCount).toBe(1);
    expect(result.metrics.timing.timedTimingEventCount).toBe(0);
    expect(result.metrics.timing.logTimingDurationMs).toBeNull();
    expect(result.metrics.timing.workflowRuntimeMs).toBe(180_000);
    expect(result.metrics.timing.workflowSteps[0]).toMatchObject({ running: true, durationMs: 180_000 });
    expect(result.metrics.timing.workflowSteps[1]).toMatchObject({ running: false, durationMs: null });
    expect(result.metrics.timing.malformedTimestamps).toContain("bad-first");
    expect(result.metrics.timing.malformedTimestamps).toContain("not-a-date");
  });
});
