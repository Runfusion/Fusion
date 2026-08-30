import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";

/*
 * FNXC:ConfirmedMergeMustFinalize 2026-08-23-09:15:
 * FN-180 treats a confirmed integration write as irreversible. Stale checklist state is reconciled
 * before the terminal move; only independent blockers may defer finalization.
 */
function makeStore(task: Task): TaskStore {
  return {
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    moveTask: vi.fn(async (_id: string, column: string) => Object.assign(task, { column })),
    logEntry: vi.fn(), recordRunAuditEvent: vi.fn(), getSettings: vi.fn(async () => ({})),
    getTaskWorkflowSelection: vi.fn(() => undefined), getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
  } as unknown as TaskStore;
}

describe("FN-180 confirmed merge must finalize", () => {
  it("reconciles an incomplete checklist instead of writing a failed park", async () => {
    const task = {
      id: "FN-180", column: "in-review", steps: [{ name: "implementation", status: "done" }, { name: "verification", status: "pending" }],
      mergeDetails: { mergeConfirmed: true }, workflowStepResults: [],
    } as unknown as Task;
    const store = makeStore(task);

    const result = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "direct-ai-merge" });
    expect(result.outcome).toBe("done");
    expect(task.column).toBe("done");
    expect(task.steps.map((step) => step.status)).toEqual(["done", "skipped"]);
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "failed" }));
  });

  it("finalizes a merge-confirmed review card parked failed by lifecycle F3", async () => {
    const task = {
      id: "FN-221",
      column: "in-review",
      status: "failed",
      error: "Cannot move FN-221 to 'done': Forbidden lifecycle path F3…",
      steps: [{ name: "implementation", status: "done" }],
      mergeDetails: { mergeConfirmed: true },
      workflowStepResults: [],
    } as unknown as Task;
    const store = makeStore(task);

    const result = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });

    expect(result.outcome).toBe("done");
    expect(task.column).toBe("done");
    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    expect(store.updateTask).toHaveBeenCalledWith(task.id, expect.objectContaining({
      status: null,
      error: null,
    }));
  });
});
