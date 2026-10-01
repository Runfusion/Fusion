import { describe, expect, it, vi } from "vitest";

import { ProjectEngine } from "../../project-engine.js";
import { hasPg, makeReliabilityFixture } from "./_helpers.js";

/*
FNXC:QuarantineLockstep 2026-09-22-02:16:
The SQLite runtime is retired, but user hard-cancel remains a live merge-request lifecycle contract.
Exercise it through the PostgreSQL reliability fixture so this test remains in its real lane instead of preserving a stale SQLite exclusion.
*/
describe("FN-5743 hard-cancel merge-request cutover", () => {
  it.skipIf(!hasPg)("cancels pending merge request on user in-review->todo hard-cancel", async () => {
    const fixture = await makeReliabilityFixture();
    try {
      const { store, task } = fixture;
      await store.moveTask(task.id, "todo");
      await store.moveTask(task.id, "in-progress");
      await store.handoffToReview(task.id, {
        ownerAgentId: "agent",
        evidence: { reason: "fn_task_done", runId: "run-1", agentId: "agent" },
      });

      await store.upsertMergeRequestRecord(task.id, { state: "queued", attemptCount: 1 });
      store.setCompletionHandoffAcceptedMarker(task.id, { source: "executor:fn_task_done" });

      await store.moveTask(task.id, "todo", { moveSource: "user" });

      expect((await store.getMergeRequestRecordAsync(task.id))?.state).toBe("cancelled");
      expect(await store.getCompletionHandoffAcceptedMarker(task.id)).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);


  it("transient merge retry uses merge-request state transitions without todo rebound", async () => {
    let state = "running";
    const fakeStore = {
      getSettings: vi.fn().mockResolvedValue({ mergeRequestContractShadowEnabled: true }),
      getMergeRequestRecord: vi.fn(() => ({ state, attemptCount: 0, lastError: null })),
      getMergeRequestRecordAsync: vi.fn(() => Promise.resolve({ state, attemptCount: 0, lastError: null })),
      transitionMergeRequestState: vi.fn((_taskId: string, toState: string) => {
        state = toState;
      }),
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
      moveTask: vi.fn(),
    } as any;

    const retried = await (ProjectEngine.prototype as any).maybeRetryTransientMerge.call(
      { shuttingDown: false, internalEnqueueMerge: vi.fn() },
      fakeStore,
      "FN-5743",
      { id: "FN-5743", mergeTransientRetryCount: 0 },
      "lease-handoff-failed: target-not-queued",
    );

    expect(retried).toBe(true);
    expect(state).toBe("queued");
    expect(fakeStore.moveTask).not.toHaveBeenCalled();
  });
});
