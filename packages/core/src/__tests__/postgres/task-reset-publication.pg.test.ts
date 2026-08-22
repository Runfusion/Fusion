import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __setResetPublicationFailureForTesting } from "../../task-store/reset-lifecycle.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:TaskReset 2026-08-19-06:30:
These PostgreSQL tests pin the reset publication boundary rather than a sequence of facade calls. A failure after continuation retirement must roll back the retired row, foreach instance deletion, and task-row reset together; success must expose intake/needs-replan only with all graph cleanup committed.
*/

pgDescribe("TaskStore reset publication", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({ prefix: "fusion_task_reset_publication" });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedPopulatedResetState() {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    const populated = await store.updateTask(task.id, {
      column: "in-progress",
      status: "failed",
      worktree: "/tmp/owned-worktree",
      branch: "fusion/fn-reset",
      checkedOutBy: "agent-reset",
      workflowIrPin: "pin-before-reset",
      workflowStepResults: [{ workflowStepId: "plan-review", status: "failed" }],
      reviewState: { status: "changes-requested" },
      awaitingApprovalReason: "plan-review-replan-cap",
    } as never);
    const continuation = await store.upsertWorkflowWorkItem({
      taskId: task.id,
      runId: `${task.id}:run:active`,
      nodeId: "execute",
      kind: "task",
      state: "running",
      leaseOwner: "executor-reset",
      leaseExpiresAt: null,
    });
    await store.saveWorkflowRunStepInstance({
      taskId: task.id,
      runId: `${task.id}:run:active`,
      foreachNodeId: "steps",
      stepIndex: 0,
      pinnedStepCount: populated.steps.length,
      currentNodeId: "step-execute",
      status: "running",
      reworkCount: 0,
      updatedAt: new Date().toISOString(),
    });
    return { store, task: populated, continuation };
  }

  it("publishes task, continuation retirement, and foreach cleanup together", async () => {
    const { store, task } = await seedPopulatedResetState();

    const reset = await store.resetTaskPublication(task.id, "todo");

    expect(reset.column).toBe("todo");
    expect(reset.status).toBe("needs-replan");
    expect(reset.steps.every((step) => step.status === "pending")).toBe(true);
    expect(reset.worktree).toBeUndefined();
    expect(reset.branch).toBeUndefined();
    expect(reset.checkedOutBy).toBeUndefined();
    expect(reset.workflowIrPin).toBeUndefined();
    expect(reset.workflowStepResults).toEqual([]);
    expect(reset.reviewState).toBeUndefined();
    expect(reset.awaitingApprovalReason).toBeUndefined();
    expect(await store.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] })).toEqual([
      expect.objectContaining({ state: "cancelled" }),
    ]);
    expect(await store.hasWorkflowRunStepInstancesForTask(task.id)).toBe(false);
  });

  it("rolls back every publication participant after workflow mutation failure", async () => {
    const { store, task, continuation } = await seedPopulatedResetState();
    const release = __setResetPublicationFailureForTesting(() => {
      throw new Error("injected reset publication failure");
    });
    try {
      await expect(store.resetTaskPublication(task.id, "todo")).rejects.toThrow("injected reset publication failure");
    } finally {
      release();
    }

    const durable = await store.getTask(task.id);
    expect(durable?.column).toBe("in-progress");
    expect(durable?.status).toBe("failed");
    expect(durable?.worktree).toBe("/tmp/owned-worktree");
    expect(durable?.workflowStepResults).toHaveLength(1);
    expect((await store.listWorkflowWorkItemsForTask(task.id, { kinds: ["task"] })).find((item) => item.id === continuation.id)?.state).toBe("running");
    expect(await store.hasWorkflowRunStepInstancesForTask(task.id)).toBe(true);
  });
});
