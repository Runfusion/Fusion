import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../db.js";
import { InsightLifecycleError, InsightStore } from "../insight-store.js";
import { classifyInsightRunError, executeInsightRunLifecycle, retryInsightRunLifecycle } from "../insight-run-executor.js";

function createStore(): InsightStore {
  const fusionDir = mkdtempSync(join(tmpdir(), "fn-insight-executor-"));
  const db = createDatabase(fusionDir, { inMemory: true });
  db.init();
  return new InsightStore(db);
}

describe("classifyInsightRunError", () => {
  it("classifies cancellation", () => {
    const result = classifyInsightRunError(new DOMException("Aborted", "AbortError"));
    expect(result.failureClass).toBe("cancelled");
  });

  it("classifies timeout", () => {
    const result = classifyInsightRunError(new Error("timed out while calling provider"));
    expect(result.failureClass).toBe("timed_out");
    expect(result.retryable).toBe(true);
  });

  it("classifies transient provider errors as retryable", () => {
    const result = classifyInsightRunError(new Error("HTTP 503 from provider"));
    expect(result.failureClass).toBe("retryable_transient");
    expect(result.retryable).toBe(true);
  });

  it("classifies deterministic failures as non-retryable", () => {
    const result = classifyInsightRunError(new Error("invalid JSON contract response"));
    expect(result.failureClass).toBe("non_retryable");
    expect(result.retryable).toBe(false);
  });
});

describe("executeInsightRunLifecycle", () => {
  it("completes and persists events", async () => {
    const store = createStore();
    const run = await executeInsightRunLifecycle({
      store,
      projectId: "proj",
      input: { trigger: "manual" },
      executeAttempt: async () => ({
        summary: "done",
        insightsCreated: 2,
        insightsUpdated: 1,
      }),
    });

    expect(run.status).toBe("completed");
    const events = store.listRunEvents(run.id);
    expect(events.map((event) => event.type)).toEqual(["status_changed", "status_changed", "info", "status_changed"]);
  });

  it("retries transient failures with bounded attempts", async () => {
    const store = createStore();
    let calls = 0;

    const run = await executeInsightRunLifecycle({
      store,
      projectId: "proj",
      input: { trigger: "manual" },
      maxAttempts: 2,
      retryDelayMs: 0,
      executeAttempt: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("HTTP 503");
        }
        return {
          summary: "recovered",
          insightsCreated: 1,
          insightsUpdated: 0,
        };
      },
    });

    expect(calls).toBe(2);
    expect(run.status).toBe("completed");
    const events = store.listRunEvents(run.id);
    expect(events.some((event) => event.type === "retry_scheduled")).toBe(true);
  });

  it("fails non-retryable errors without retry", async () => {
    const store = createStore();
    const run = await executeInsightRunLifecycle({
      store,
      projectId: "proj",
      input: { trigger: "manual" },
      maxAttempts: 3,
      executeAttempt: async () => {
        throw new Error("validation failed");
      },
    });

    expect(run.status).toBe("failed");
    expect(run.lifecycle.failureClass).toBe("non_retryable");
    expect(run.lifecycle.retryable).toBe(false);
  });

  it("blocks duplicate active runs for same project+trigger", async () => {
    const store = createStore();
    store.createRun("proj", { trigger: "manual" });

    await expect(() => executeInsightRunLifecycle({
      store,
      projectId: "proj",
      input: { trigger: "manual" },
      executeAttempt: async () => ({ insightsCreated: 0, insightsUpdated: 0 }),
    })).rejects.toMatchObject({ code: "active_run_conflict" } satisfies Partial<InsightLifecycleError>);
  });

  it("marks timeout as terminal failure classification", async () => {
    const store = createStore();
    const run = await executeInsightRunLifecycle({
      store,
      projectId: "proj",
      input: { trigger: "manual" },
      timeoutMs: 10,
      maxAttempts: 1,
      executeAttempt: async ({ signal }) => {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, 50);
          signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(signal.reason ?? new Error("aborted"));
          });
        });
        return { insightsCreated: 0, insightsUpdated: 0 };
      },
    });

    expect(run.status).toBe("failed");
    expect(run.lifecycle.failureClass).toBe("timed_out");
  });
});

describe("retryInsightRunLifecycle", () => {
  it("creates a new run from retryable failed run", async () => {
    const store = createStore();
    const failed = await executeInsightRunLifecycle({
      store,
      projectId: "proj",
      input: { trigger: "manual" },
      maxAttempts: 1,
      executeAttempt: async () => {
        throw new Error("HTTP 503");
      },
    });

    const retried = await retryInsightRunLifecycle({
      store,
      runId: failed.id,
      executeAttempt: async () => ({ insightsCreated: 1, insightsUpdated: 0 }),
    });

    expect(retried.run.id).not.toBe(failed.id);
    expect(retried.run.lifecycle.retryOfRunId).toBe(failed.id);
    expect(retried.run.status).toBe("completed");
  });

  it("rejects retry for non-retryable failures", async () => {
    const store = createStore();
    const failed = await executeInsightRunLifecycle({
      store,
      projectId: "proj",
      input: { trigger: "manual" },
      maxAttempts: 1,
      executeAttempt: async () => {
        throw new Error("invalid input");
      },
    });

    await expect(retryInsightRunLifecycle({
      store,
      runId: failed.id,
      executeAttempt: async () => ({ insightsCreated: 1, insightsUpdated: 0 }),
    })).rejects.toMatchObject({ code: "not_retryable" } satisfies Partial<InsightLifecycleError>);
  });
});
