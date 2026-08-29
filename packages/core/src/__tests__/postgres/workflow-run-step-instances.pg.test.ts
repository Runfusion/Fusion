/*
FNXC:WorkflowStepInstancePersistence 2026-07-16-20:25:
Foreach crash-resume state must remain durable when TaskStore runs in PostgreSQL
backend mode. Cover the public async API rather than direct SQL so identity,
ordering, idempotent updates, and run-pruning cannot regress to sync SQLite no-ops.
*/
import { expect, it } from "vitest";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("TaskStore workflow run step-instance PostgreSQL persistence", () => {
  it("round-trips ordered instances, updates in place, and prunes runs", async () => {
    const harness = await createTaskStoreForTest({ prefix: "fusion_step_instances" });
    try {
      const { store } = harness;
      const task = await store.createTask({ description: "workflow instance persistence" });
      const currentRunId = `${task.id}:current`;
      const staleRunId = `${task.id}:stale`;

      await store.saveWorkflowRunStepInstanceAsync({
        taskId: task.id,
        runId: currentRunId,
        foreachNodeId: "foreach",
        stepIndex: 1,
        pinnedStepCount: 2,
        currentNodeId: "execute",
        status: "in-progress",
        baselineSha: "baseline-1",
        checkpointId: "checkpoint-1",
        reworkCount: 0,
        branchName: "fusion/current-step-1",
        updatedAt: "ignored-by-save",
      });
      await store.saveWorkflowRunStepInstanceAsync({
        taskId: task.id,
        runId: currentRunId,
        foreachNodeId: "foreach",
        stepIndex: 0,
        pinnedStepCount: 2,
        status: "pending",
        reworkCount: 0,
        updatedAt: "ignored-by-save",
      });

      await store.saveWorkflowRunStepInstanceAsync({
        taskId: task.id,
        runId: currentRunId,
        foreachNodeId: "foreach",
        stepIndex: 1,
        pinnedStepCount: 2,
        currentNodeId: "review",
        status: "awaiting-integration",
        baselineSha: "baseline-2",
        checkpointId: "checkpoint-2",
        reworkCount: 1,
        branchName: "fusion/current-step-1",
        integratedAt: "2026-07-16T20:25:00.000Z",
        updatedAt: "ignored-by-update",
      });
      await store.saveWorkflowRunStepInstanceAsync({
        taskId: task.id,
        runId: staleRunId,
        foreachNodeId: "foreach",
        stepIndex: 0,
        pinnedStepCount: 1,
        status: "in-progress",
        reworkCount: 0,
        updatedAt: "ignored-by-save",
      });

      const currentRows = await store.loadWorkflowRunStepInstancesAsync(task.id, currentRunId);
      expect(currentRows).toHaveLength(2);
      expect(currentRows.map((row) => row.stepIndex)).toEqual([0, 1]);
      expect(currentRows[1]).toMatchObject({
        taskId: task.id,
        runId: currentRunId,
        foreachNodeId: "foreach",
        stepIndex: 1,
        currentNodeId: "review",
        status: "awaiting-integration",
        baselineSha: "baseline-2",
        checkpointId: "checkpoint-2",
        reworkCount: 1,
        integratedAt: "2026-07-16T20:25:00.000Z",
      });
      expect(currentRows[1]?.updatedAt).not.toBe("ignored-by-update");

      await store.clearWorkflowRunStepInstancesAsync(task.id, currentRunId);
      expect(await store.loadWorkflowRunStepInstancesAsync(task.id, staleRunId)).toEqual([]);
      expect(await store.loadWorkflowRunStepInstancesAsync(task.id, currentRunId)).toHaveLength(2);

      await store.clearWorkflowRunStepInstancesAsync(task.id);
      expect(await store.loadWorkflowRunStepInstancesAsync(task.id, currentRunId)).toEqual([]);
    } finally {
      await harness.teardown();
    }
  });
});
