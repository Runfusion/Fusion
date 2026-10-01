/*
FNXC:StaleReviewCallbackWaiver 2026-10-01-05:08:
A production waiver must traverse the real self-healing decision, TaskStore advisory transaction,
merge gate, terminal finalizer, and dependency-release listener. This regression leaves only the
already-landed merge proof seeded; receipt authority and every subsequent state change are real.
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import "@fusion/core";
import {
  getTaskMergeBlocker,
  resolvePreMergeGateForTask,
  type MergeResult,
  type TaskStore,
} from "@fusion/core";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { SelfHealingManager } from "../self-healing.js";
import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";
import { Scheduler } from "../scheduler.js";

const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
  prefix: "fusion_stale_review_callback_waiver_production",
  projectId: "fusion-stale-review-callback-waiver-production",
});

const SETTLE_MS = 2_000;
const POLL_MS = 25;

pgDescribe("FN-9429 stale review callback waiver production path", () => {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedReviewTask(taskId: string, status: "pending" | "failed"): Promise<void> {
    const store = h.store();
    const startedAt = new Date(Date.now() - 16 * 60_000).toISOString();
    await store.createTaskWithReservedId(
      { description: `stale ${status} code review`, column: "todo" },
      { taskId, applyDefaultWorkflowSteps: false },
    );
    await store.writeTaskWorkflowSelection(taskId, "builtin:coding", ["code-review"]);
    await store.moveTask(taskId, "in-progress", { moveSource: "user" } as never);
    await store.moveTask(taskId, "in-review", { moveSource: "user", allowDirectInReviewMove: true } as never);
    await store.updateTask(taskId, {
      autoMerge: true,
      enabledWorkflowSteps: ["code-review"],
      steps: [{ name: "implementation", status: "done" }],
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        phase: "pre-merge",
        reviewKind: "code",
        status,
        startedAt,
      }],
    });
    store.taskCache.delete(taskId);
  }

  async function waitForDependentRelease(store: TaskStore, dependentId: string): Promise<void> {
    const deadline = Date.now() + SETTLE_MS;
    while (Date.now() < deadline) {
      store.taskCache.delete(dependentId);
      if ((await store.getTask(dependentId))?.blockedBy == null) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    throw new Error("dependent was not released after the waived task finalized");
  }

  it.each(["pending", "failed"] as const)("issues one real receipt for a stale %s callback, clears the real merge gate, then finalizes and releases its dependent", async (status) => {
    const store = h.store();
    const taskId = `FN-9429-${status.toUpperCase()}`;
    const dependentId = `FN-9429-DEPENDENT-${status.toUpperCase()}`;
    await seedReviewTask(taskId, status);

    await store.createTaskWithReservedId(
      { description: "dependent", column: "todo" },
      { taskId: dependentId, applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(dependentId, { dependencies: [taskId], blockedBy: taskId, status: "queued" });

    const manager = new SelfHealingManager(store, { rootDir: h.rootDir() });
    expect(await manager.reconcileOrphanedPendingStepResults()).toBe(1);

    store.taskCache.delete(taskId);
    const waived = await store.getTask(taskId);
    const carrier = waived?.workflowStepResults?.at(-1);
    const receipts = await store.getStaleReviewCallbackWaiverReceipts(taskId);
    expect(carrier).toMatchObject({
      status: "skipped",
      automatedStaleCallbackWaiver: expect.objectContaining({ priorStatus: status }),
      priorAttempts: [expect.objectContaining({ status })],
    });
    expect(carrier?.verdict).toBeUndefined();
    expect(receipts).toHaveLength(1);

    const gate = await resolvePreMergeGateForTask(store, taskId, waived?.enabledWorkflowSteps, waived);
    const mergeContent = { kind: "singular", diff: { state: "empty" } } as const;
    const mergeGateOptions = {
      reviewColumns: gate.reviewColumns,
      requiredPreMergeStepIds: gate.requiredPreMergeStepIds,
      mergeContent,
      staleReviewCallbackWaiver: {
        projectId: "fusion-stale-review-callback-waiver-production",
        effectiveAutoMerge: true,
        hasOpenFindings: false,
        receipts,
      },
    };
    // A carrier that looks complete but lacks the TaskStore-issued receipt remains a failed gate.
    expect(getTaskMergeBlocker(waived!, {
      ...mergeGateOptions,
      staleReviewCallbackWaiver: { ...mergeGateOptions.staleReviewCallbackWaiver, receipts: [] },
    })).toContain("without a current approval");
    expect(getTaskMergeBlocker(waived!, mergeGateOptions)).toBeUndefined();

    // Constructor registration is the production dependency-release listener; do not call a private helper.
    const scheduler = new Scheduler(store, {} as never);
    void scheduler;
    const finalized = await finalizeProvenAutoMergeTask({
      store,
      taskId,
      result: { mergeConfirmed: true, commitSha: `waiver-${status}` } as MergeResult,
      source: "direct-ai-merge",
    });
    expect(finalized.outcome).toBe("done");
    store.taskCache.delete(taskId);
    expect((await store.getTask(taskId))?.column).toBe("done");
    await waitForDependentRelease(store, dependentId);
  });
});
