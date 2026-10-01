import { describe, expect, it, vi } from "vitest";
import { resolveWorkflowIrForTask, type Task, type TaskStore } from "@fusion/core";
import { executingTaskLock } from "../agents/active-session-registry.js";

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

  it("persists irreversible merge proof before deferring to an absent post-merge result", async () => {
    const task = {
      id: "FN-PM-proof-before-gate",
      column: "in-review",
      steps: [{ name: "implementation", status: "done" }],
      enabledWorkflowSteps: ["post-merge-verification"],
      workflowStepResults: [],
    } as unknown as Task;
    const store = makeStore(task);

    const result = await finalizeProvenAutoMergeTask({
      store,
      taskId: task.id,
      source: "workflow-graph-merge-finalize",
      result: {
        task,
        mergeConfirmed: true,
        commitSha: "abc123",
      } as never,
    });

    expect(result).toMatchObject({
      outcome: "blocked",
      deferredPostMergeEvidence: true,
    });
    expect(task.column).toBe("in-review");
    expect(task.mergeDetails).toMatchObject({ mergeConfirmed: true, commitSha: "abc123" });
    expect(store.updateTaskAtomic).toHaveBeenCalledWith(task.id, expect.any(Function));
    expect(store.moveTask).not.toHaveBeenCalled();
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

    for (const [workflowStepResults, deferredPostMergeEvidence] of [
      [[], true],
      [[{ workflowStepId: "post-merge-verification", status: "pending" }], undefined],
      [[{ workflowStepId: "post-merge-verification", status: "skipped" }], undefined],
      [[{ workflowStepId: "post-merge-verification", status: "failed", verdict: "REVISE" }], undefined],
    ] as const) {
      task.workflowStepResults = workflowStepResults as Task["workflowStepResults"];
      for (const source of ["direct-ai-merge", "self-healing"] as const) {
        const result = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source });
        expect(result).toMatchObject({
          outcome: "blocked",
          reason: expect.stringContaining("post-merge evidence"),
          deferredPostMergeEvidence,
        });
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

/* FNXC:PostMergeRecovery 2026-10-01-04:43: Lost graph traversal must schedule real evidence, never manufacture approval. */
describe("missing post-merge continuation recovery", () => {
  function recoveryFixture() {
    const task = {
      id: "FN-9368", column: "in-review", updatedAt: "2026-10-01T04:43:00.000Z",
      autoMerge: true, steps: [], mergeDetails: { mergeConfirmed: true },
      enabledWorkflowSteps: ["post-merge-verification"], workflowStepResults: [],
    } as unknown as Task;
    const store = makeStore(task);
    const items: unknown[] = [];
    store.listWorkflowWorkItemsForTask = vi.fn(async () => items) as never;
    store.seedWorkspaceCodeReviewContinuationIfIdle = vi.fn(async (input) => {
      if (items.length) return { seeded: false, reason: "active-continuation" as const };
      items.push(input);
      return { seeded: true, workItemId: "post-merge-continuation" };
    });
    return { task, store, items };
  }

  it("resumes the missing gate exactly once across repeated finalization polls, without merging or completing", async () => {
    const { task, store, items } = recoveryFixture();
    for (const source of ["merge-confirmed-fast-path", "self-healing", "direct-ai-merge"] as const) {
      await expect(finalizeProvenAutoMergeTask({ store, taskId: task.id, source }))
        .resolves.toMatchObject({ outcome: "blocked", deferredPostMergeEvidence: true });
    }
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      nodeId: "post-merge-verification", state: "runnable", kind: "task",
      sourceColumn: "in-review", targetColumn: "in-review", expectedTaskUpdatedAt: task.updatedAt,
      expectedWorkflowSelection: { workflowId: "builtin:coding", stepIds: ["post-merge-verification"] },
    });
    expect(task.workflowStepResults).toEqual([]);
    expect(task.column).toBe("in-review");
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledTimes(1);
  });

  it.each([
    { paused: true }, { userPaused: true }, { autoMerge: false },
    { mergeDetails: undefined }, { deletedAt: "2026-10-01T04:43:00.000Z" },
  ])("preserves an ineligible task %j", async (patch) => {
    const { task, store } = recoveryFixture();
    Object.assign(task, patch);
    await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it.each(["pending", "failed", "skipped", "passed"] as const)("does not replace existing %s evidence", async (status) => {
    const { task, store } = recoveryFixture();
    task.workflowStepResults = [{ workflowStepId: "post-merge-verification", status, verdict: "REVISE" }] as Task["workflowStepResults"];
    await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(task.workflowStepResults[0].status).toBe(status);
  });

  it.each([{ globalPause: true }, { enginePaused: true }])("preserves engine pause %j", async (settings) => {
    const { task, store } = recoveryFixture();
    store.getSettings = vi.fn(async () => settings) as never;
    await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });
    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
  });

  it.each(["merge-confirmed-fast-path", "self-healing"] as const)("refuses %s recovery while a fresh checkout lease owns the task", async (source) => {
    const { task, store } = recoveryFixture();
    Object.assign(task, { checkoutRunId: "checkout-run", checkoutLeaseRenewedAt: new Date().toISOString() });

    await finalizeProvenAutoMergeTask({ store, taskId: task.id, source });

    expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("leaves active execution to traverse its own post-merge edge", async () => {
    const { task, store } = recoveryFixture();
    executingTaskLock.tryClaim(task.id);
    try {
      await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "direct-ai-merge" });
      expect(store.seedWorkspaceCodeReviewContinuationIfIdle).not.toHaveBeenCalled();
    } finally { executingTaskLock.release(task.id); }
  });

  it("resolves custom gate ids rather than hardcoding the builtin gate", async () => {
    const { task, store, items } = recoveryFixture();
    const ir = structuredClone(await resolveWorkflowIrForTask(store, task.id));
    const gate = ir.nodes.find((node) => node.id === "post-merge-verification")!;
    gate.id = "delivery-evidence";
    for (const edge of ir.edges) {
      if (edge.from === "post-merge-verification") edge.from = gate.id;
      if (edge.to === "post-merge-verification") edge.to = gate.id;
    }
    task.enabledWorkflowSteps = [gate.id];
    const selection = { workflowId: "WF-custom", stepIds: task.enabledWorkflowSteps };
    store.getTaskWorkflowSelection = vi.fn(() => selection);
    store.getTaskWorkflowSelectionAsync = vi.fn(async () => selection);
    store.getWorkflowDefinition = vi.fn(async () => ({ ir })) as never;
    await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ nodeId: "delivery-evidence" });
  });

  it("does not claim recovery after the fenced insert loses a task-state race", async () => {
    const { task, store } = recoveryFixture();
    store.seedWorkspaceCodeReviewContinuationIfIdle = vi.fn(async () => ({ seeded: false, reason: "task-state-changed" }));
    await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});
