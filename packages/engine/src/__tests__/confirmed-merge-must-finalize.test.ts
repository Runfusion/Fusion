import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";

import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";

/*
 * FNXC:ConfirmedMergeMustFinalize 2026-08-23-09:15:
 * FN-180 treats a confirmed integration write as irreversible. Stale checklist state is reconciled
 * before the terminal move; only independent blockers may defer finalization.
 */
function makeStore(task: Task): TaskStore {
  const store = {
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(task, patch)),
    updateTaskAtomic: vi.fn(async (_id: string, update: (current: Task) => Partial<Task>) => Object.assign(task, update(task))),
    moveTask: vi.fn(async (_id: string, column: string) => Object.assign(task, { column })),
    logEntry: vi.fn(), recordRunAuditEvent: vi.fn(), getSettings: vi.fn(async () => ({})),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps ?? [] })),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
  } as unknown as TaskStore;
  store.moveTaskIf = vi.fn(async (_id, column, predicate, options) => {
    if (!await predicate(task)) return { task, moved: false };
    return { task: await store.moveTask(task.id, column, options), moved: true };
  });
  return store;
}

describe("FN-180 confirmed merge must finalize", () => {
  it("reconciles an incomplete checklist instead of writing a failed park", async () => {
    const task = {
      id: "FN-180", column: "in-review", steps: [{ name: "implementation", status: "done" }, { name: "verification", status: "pending" }],
      mergeDetails: { mergeConfirmed: true }, enabledWorkflowSteps: [], workflowStepResults: [],
    } as unknown as Task;
    const store = makeStore(task);

    const result = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "direct-ai-merge" });
    expect(result.outcome).toBe("done");
    expect(task.column).toBe("done");
    expect(task.steps.map((step) => step.status)).toEqual(["done", "skipped"]);
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "failed" }));
  });

  it("blocks direct and self-healing finalization until the enabled post-merge gate approves", async () => {
    const task = {
      id: "FN-PM-finalize",
      column: "in-review",
      steps: [{ name: "implementation", status: "done" }],
      mergeDetails: { mergeConfirmed: true },
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [],
    } as unknown as Task;
    const store = makeStore(task);

    for (const workflowStepResults of [
      [],
      [{ workflowStepId: "post-merge-verification", status: "pending" }],
      [{ workflowStepId: "post-merge-verification", status: "skipped" }],
      [{ workflowStepId: "post-merge-verification", status: "failed", verdict: "REVISE" }],
    ]) {
      task.workflowStepResults = workflowStepResults as Task["workflowStepResults"];
      for (const source of ["direct-ai-merge", "self-healing"] as const) {
        const result = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source });
        expect(result).toMatchObject({ outcome: "blocked", reason: expect.stringContaining("post-merge evidence") });
        expect(task.column).toBe("in-review");
        expect(store.moveTask).not.toHaveBeenCalled();
      }
    }

    task.workflowStepResults = [{
      workflowStepId: "post-merge-verification",
      status: "passed",
      verdict: "APPROVE",
    }] as Task["workflowStepResults"];
    const approved = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });
    expect(approved.outcome).toBe("done");
    expect(task.column).toBe("done");
  });

  it("refuses completion when approval is superseded after the optimistic evidence read", async () => {
    const task = {
      id: "FN-PM-finalization-race",
      column: "in-review",
      steps: [{ name: "implementation", status: "done" }],
      mergeDetails: { mergeConfirmed: true },
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [{ workflowStepId: "post-merge-verification", status: "passed", verdict: "APPROVE" }],
    } as unknown as Task;
    const store = makeStore(task);
    const standardMove = store.moveTaskIf.getMockImplementation()!;
    store.moveTaskIf = vi.fn(async (id, column, predicate, options) => {
      task.workflowStepResults = [];
      return standardMove(id, column, predicate, options);
    });

    await expect(finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" }))
      .resolves.toMatchObject({ outcome: "blocked", reason: expect.stringContaining("post-merge evidence") });
    expect(task.column).toBe("in-review");
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("does not treat an already-complete card as converged without enabled post-merge approval", async () => {
    const task = {
      id: "FN-PM-already-done",
      column: "done",
      steps: [{ name: "implementation", status: "done" }],
      mergeDetails: { mergeConfirmed: true },
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [],
    } as unknown as Task;
    const store = makeStore(task);

    await expect(finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" }))
      .resolves.toMatchObject({ outcome: "blocked", reason: expect.stringContaining("post-merge evidence") });
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("finalizes a merge-confirmed review card parked failed by lifecycle F3", async () => {
    const task = {
      id: "FN-221",
      column: "in-review",
      status: "failed",
      error: "Cannot move FN-221 to 'done': Forbidden lifecycle path F3…",
      steps: [{ name: "implementation", status: "done" }],
      mergeDetails: { mergeConfirmed: true },
      enabledWorkflowSteps: [],
      workflowStepResults: [],
    } as unknown as Task;
    const store = makeStore(task);

    const result = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });

    expect(result.outcome).toBe("done");
    expect(task.column).toBe("done");
    expect(task.status).toBeNull();
    expect(task.error).toBeNull();
    expect(store.updateTaskAtomic).toHaveBeenCalledWith(task.id, expect.any(Function));
  });
});
