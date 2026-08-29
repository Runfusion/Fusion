import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";

/*
 * FNXC:ConfirmedMergeMustFinalize 2026-08-23-09:15:
 * FN-180 treats a confirmed integration write as irreversible. Stale checklist state is reconciled
 * before the terminal move; only independent blockers may defer finalization.
 */
describe("FN-180 confirmed merge must finalize", () => {
  it("reconciles an incomplete checklist instead of writing a failed park", async () => {
    const task = {
      id: "FN-180", column: "in-review", steps: [{ name: "implementation", status: "done" }, { name: "verification", status: "pending" }],
      mergeDetails: { mergeConfirmed: true }, workflowStepResults: [],
    } as unknown as Task;
    const store = {
      getTask: vi.fn(async () => task),
      updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
      moveTask: vi.fn(async (_id: string, column: string) => Object.assign(task, { column })),
      logEntry: vi.fn(), recordRunAuditEvent: vi.fn(), getSettings: vi.fn(async () => ({})),
      getTaskWorkflowSelection: vi.fn(() => undefined), getTaskWorkflowSelectionAsync: vi.fn(async () => undefined),
      getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    } as unknown as TaskStore;

    const result = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "direct-ai-merge" });
    expect(result.outcome).toBe("done");
    expect(task.column).toBe("done");
    expect(task.steps.map((step) => step.status)).toEqual(["done", "skipped"]);
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "failed" }));
  });
});
