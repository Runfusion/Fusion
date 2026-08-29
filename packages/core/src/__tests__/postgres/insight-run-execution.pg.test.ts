/**
 * FNXC:InsightStore 2026-06-28-10:20:
 * PostgreSQL integration coverage for the insight-run EXECUTOR store-access path.
 * The dashboard `POST /api/insights/run` + `POST /api/insights/runs/:id/retry`
 * previously 503'd in PG backend mode because the executor + sweeper called the
 * sync `InsightStore` synchronously. The executor now types `store` as
 * `InsightStore | AsyncInsightStore` and `await`s every store call, so a run can
 * be created → advanced → persisted against the AsyncDataLayer-backed
 * AsyncInsightStore.
 *
 * This drives `executeInsightRunLifecycle` / `retryInsightRunLifecycle` against
 * embedded PG with a STUBBED `executeAttempt` (NO real AI) and asserts the run
 * lifecycle persists through the AsyncInsightStore: pending→running→completed
 * with completedAt + summary + counts, the create→fail path on a thrown attempt,
 * status_changed/info events in seq order, and a retryable_transient failure that
 * `retryInsightRunLifecycle` re-runs to completion. Runs in the blocking gate
 * (test:pg-gate).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  executeInsightRunLifecycle,
  retryInsightRunLifecycle,
} from "../../insights/insight-run-executor.js";
import type { AsyncInsightStore } from "../../async-stores/async-insight-store.js";

const pgTest = pgDescribe;

pgTest("Insight run execution (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_insight_run_exec",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // In backend mode getInsightStore() returns AsyncInsightStore (async methods).
  const insights = (): AsyncInsightStore => h.store().getInsightStore() as AsyncInsightStore;

  it("executeInsightRunLifecycle persists a full create→running→completed lifecycle", async () => {
    const store = insights();

    const run = await executeInsightRunLifecycle({
      store,
      projectId: "P-EXEC-OK",
      input: { trigger: "manual" },
      maxAttempts: 1,
      retryDelayMs: 0,
      executeAttempt: async () => ({
        summary: "extracted 2 insights",
        insightsCreated: 2,
        insightsUpdated: 1,
      }),
    });

    expect(run.id).toMatch(/^INSR-/);
    expect(run.status).toBe("completed");
    expect(run.summary).toBe("extracted 2 insights");
    expect(run.insightsCreated).toBe(2);
    expect(run.insightsUpdated).toBe(1);
    expect(run.startedAt).toBeTruthy();
    expect(run.completedAt).toBeTruthy();

    // Persisted independently: re-read through the store.
    const reloaded = await store.getRun(run.id);
    expect(reloaded?.status).toBe("completed");
    expect(reloaded?.completedAt).toBeTruthy();

    // Lifecycle events recorded in seq order through the async appendRunEvent path.
    const events = await store.listRunEvents(run.id);
    const statusChanges = events.filter((e) => e.type === "status_changed").map((e) => e.status);
    expect(statusChanges).toEqual(["pending", "running", "completed"]);
    // seq is monotonically increasing (auto-incremented per run).
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    // Run is no longer active once terminal.
    expect(await store.findActiveRun("P-EXEC-OK", "manual")).toBeUndefined();
  });

  it("records a failed run when the attempt throws (no AI provider path)", async () => {
    const store = insights();

    const run = await executeInsightRunLifecycle({
      store,
      projectId: "P-EXEC-FAIL",
      input: { trigger: "manual" },
      maxAttempts: 1,
      retryDelayMs: 0,
      executeAttempt: async () => {
        // Mirrors the real executor failing at the AI step with no provider.
        throw new Error("No AI provider configured");
      },
    });

    expect(run.status).toBe("failed");
    expect(run.error).toContain("No AI provider configured");
    expect(run.completedAt).toBeTruthy();
    expect(run.lifecycle.failureClass).toBe("non_retryable");

    const reloaded = await store.getRun(run.id);
    expect(reloaded?.status).toBe("failed");

    const events = await store.listRunEvents(run.id);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("retryInsightRunLifecycle re-runs a retryable_transient failure to completion", async () => {
    const store = insights();

    // First attempt fails with a transient error → terminal failed + retryable.
    const failed = await executeInsightRunLifecycle({
      store,
      projectId: "P-EXEC-RETRY",
      input: { trigger: "manual" },
      maxAttempts: 1,
      retryDelayMs: 0,
      executeAttempt: async () => {
        throw new Error("ECONNRESET while contacting provider");
      },
    });

    expect(failed.status).toBe("failed");
    expect(failed.lifecycle.failureClass).toBe("retryable_transient");
    expect(failed.lifecycle.retryable).toBe(true);

    // Retry succeeds; lifecycle links back to the original via retryOf.
    const { run, retryOf } = await retryInsightRunLifecycle({
      store,
      runId: failed.id,
      maxAttempts: 1,
      retryDelayMs: 0,
      executeAttempt: async () => ({
        summary: "succeeded on retry",
        insightsCreated: 1,
        insightsUpdated: 0,
      }),
    });

    expect(retryOf.id).toBe(failed.id);
    expect(run.id).not.toBe(failed.id);
    expect(run.status).toBe("completed");
    expect(run.summary).toBe("succeeded on retry");
    expect(run.lifecycle.retryOfRunId).toBe(failed.id);

    const reloaded = await store.getRun(run.id);
    expect(reloaded?.status).toBe("completed");
  });
});
