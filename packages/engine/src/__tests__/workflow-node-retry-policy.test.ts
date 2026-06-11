import { describe, expect, it } from "vitest";
import { createDefaultNodeHandlers, createNoopLegacySeams } from "../workflow-node-handlers.js";
import { nextWorkflowRetryState, workflowRetryContextPatch } from "../workflow-node-retry-policy.js";

describe("workflow node retry policy", () => {
  it("computes node-scoped retry attempts and retry-after timestamps", () => {
    const retry = nextWorkflowRetryState({
      runId: "run-1",
      taskId: "FN-RETRY",
      nodeId: "merge-retry",
      attempt: 1,
      maxAttempts: 4,
      baseDelayMs: 1_000,
      now: "2026-06-09T00:00:00.000Z",
      lastError: "socket hang up",
    });

    expect(retry).toEqual({
      runId: "run-1",
      taskId: "FN-RETRY",
      nodeId: "merge-retry",
      attempt: 2,
      maxAttempts: 4,
      retryAfter: "2026-06-09T00:00:02.000Z",
      exhausted: false,
      lastError: "socket hang up",
    });
    expect(workflowRetryContextPatch(retry)).toMatchObject({
      "workflow:retry:merge-retry:attempt": 2,
      "workflow:retry:merge-retry:retryAfter": "2026-06-09T00:00:02.000Z",
      "workflow:retry:merge-retry:exhausted": false,
    });
  });

  it("caps exponential retry delay to keep retry-after timestamps valid", () => {
    const retry = nextWorkflowRetryState({
      runId: "run-1",
      taskId: "FN-RETRY",
      nodeId: "merge-retry",
      attempt: 42,
      maxAttempts: 100,
      baseDelayMs: 30_000,
      now: "2026-06-09T00:00:00.000Z",
    });

    expect(retry).toMatchObject({
      attempt: 43,
      exhausted: false,
      retryAfter: "2026-06-10T00:00:00.000Z",
    });
  });

  it("falls back when retry context carries a malformed now timestamp", () => {
    const retry = nextWorkflowRetryState({
      runId: "run-1",
      taskId: "FN-RETRY",
      nodeId: "merge-retry",
      attempt: 0,
      maxAttempts: 3,
      baseDelayMs: 1_000,
      now: "not-a-date",
      fallbackNowMs: Date.parse("2026-06-09T00:00:00.000Z"),
    });

    expect(retry).toMatchObject({
      attempt: 1,
      exhausted: false,
      retryAfter: "2026-06-09T00:00:01.000Z",
    });
  });

  it("routes exhausted retry state to failure without resetting other nodes", async () => {
    const handlers = createDefaultNodeHandlers(createNoopLegacySeams());
    const result = await handlers["retry-backoff"](
      { id: "merge-retry", kind: "retry-backoff", config: { maxAttempts: 2 } },
      {
        task: { id: "FN-RETRY", description: "retry" } as any,
        settings: { experimentalFeatures: {} },
        context: {
          "workflow:run-id": "run-1",
          "workflow:now": "2026-06-09T00:00:00.000Z",
          "workflow:retry:merge-retry:attempt": 1,
          "workflow:retry:execute:attempt": 1,
        },
      },
    );

    expect(result).toMatchObject({
      outcome: "failure",
      value: "retry-exhausted",
      contextPatch: {
        "workflow:retry:merge-retry:attempt": 2,
        "workflow:retry:merge-retry:exhausted": true,
      },
    });
    expect(result.contextPatch).not.toHaveProperty("workflow:retry:execute:attempt");
  });

  it("honors configured retry base delay in the node handler", async () => {
    const handlers = createDefaultNodeHandlers(createNoopLegacySeams());
    const result = await handlers["retry-backoff"](
      { id: "merge-retry", kind: "retry-backoff", config: { maxAttempts: 3, baseDelayMs: 5_000 } },
      {
        task: { id: "FN-RETRY", description: "retry" } as any,
        settings: { experimentalFeatures: {} },
        context: {
          "workflow:run-id": "run-1",
          "workflow:now": "2026-06-09T00:00:00.000Z",
        },
      },
    );

    expect(result).toMatchObject({
      outcome: "success",
      value: "retry-scheduled",
      contextPatch: {
        "workflow:retry:merge-retry:attempt": 1,
        "workflow:retry:merge-retry:retryAfter": "2026-06-09T00:00:05.000Z",
      },
    });
  });
});
