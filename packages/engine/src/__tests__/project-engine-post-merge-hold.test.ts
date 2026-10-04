import { describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { ProjectEngine } from "../project-engine.js";
import { executingTaskLock } from "../agents/active-session-registry.js";

/*
FNXC:PostMergeEvidenceHold 2026-10-03-23:32:
Exercise the actual shared sweep/pump admission methods: already-landed tasks must stop spinning
on existing post-merge evidence, without deleting results, fabricating approval, or losing merge proof.
*/
function fixture(status = "failed", verdict: string | undefined = "REVISE") {
  const task = {
    id: "FN-post-merge-hold", column: "in-review", status: "landing", updatedAt: "2026-10-03T23:32:00Z",
    steps: [], mergeDetails: { mergeConfirmed: true, commitSha: "landed" },
    enabledWorkflowSteps: ["post-merge-verification"],
    workflowStepResults: [{ workflowStepId: "post-merge-verification", phase: "post-merge", status, verdict }],
  } as unknown as Task;
  const selection = { workflowId: "builtin:coding", stepIds: task.enabledWorkflowSteps! };
  const store = {
    getTaskWorkflowSelection: () => selection,
    getTaskWorkflowSelectionAsync: async () => selection,
    updateTaskAtomic: vi.fn(async (_id: string, update: (task: Task) => Partial<Task> | null) => {
      const patch = update(task);
      return patch ? Object.assign(task, patch) : null;
    }),
    logEntry: vi.fn(async () => undefined),
  } as unknown as TaskStore;
  const self = {
    isMergePending: vi.fn(async () => false), mergeActive: new Set<string>(),
    mergeQueue: [] as string[], capacityDeferredMergeTaskIds: new Set<string>(),
  };
  const methods = ProjectEngine.prototype as unknown as {
    resolveMergeGateBlocker: (store: TaskStore, task: Task, settings: Settings) => Promise<string | undefined>;
    canMergeTask: (task: Task, budget: number, columns: undefined, backoff: boolean, blocker: string | undefined) => boolean;
  };
  const poll = async () => {
    const blocker = await methods.resolveMergeGateBlocker.call(self, store, task, {} as Settings);
    return methods.canMergeTask.call(self, task, 3, undefined, false, blocker);
  };
  return { task, store, self, poll };
}

describe("landed task post-merge holds", () => {
  it("schedules a due evidence recheck once while keeping the merge queue blocked", async () => {
    const { task, store, poll } = fixture();
    task.status = undefined;
    task.autoMerge = true;
    task.workflowStepResults![0].completedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const items: unknown[] = [];
    Object.assign(store, {
      getTask: vi.fn(async () => task), getSettings: vi.fn(async () => ({})),
      listWorkflowWorkItemsForTask: vi.fn(async () => items),
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async (input) => {
        if (items.length) return { seeded: false };
        items.push(input); return { seeded: true };
      }),
    });
    for (let n = 0; n < 3; n++) expect(await poll()).toBe(false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ nodeId: "post-merge-verification", sourceColumn: "in-review", targetColumn: "in-review" });
    expect(task.workflowStepResults![0]).toMatchObject({ status: "failed", verdict: "REVISE" });
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });

  it.each(["failed", "pending", "skipped"])("does not repeatedly admit %s evidence or report active landing", async (status) => {
    const { task, store, poll } = fixture(status);
    const evidence = structuredClone(task.workflowStepResults);
    for (let i = 0; i < 5; i++) expect(await poll()).toBe(false);
    expect(task.status).toBeNull();
    expect(task.column).toBe("in-review");
    expect(task.mergeDetails).toEqual({ mergeConfirmed: true, commitSha: "landed" });
    expect(task.workflowStepResults).toEqual(evidence);
    expect(store.updateTaskAtomic).toHaveBeenCalledTimes(1);
    expect(store.logEntry).toHaveBeenCalledTimes(1);
  });

  it("keeps archived skipped evidence visible and outside merge admission", async () => {
    const { task, store, poll } = fixture("skipped");
    Object.assign(task.workflowStepResults![0], {
      remediationArchivedAt: "2026-10-04T03:11:56Z",
      remediationArchivedFromStatus: "failed",
    });
    const evidence = structuredClone(task.workflowStepResults);

    expect(await poll()).toBe(false);
    expect(task.column).toBe("in-review");
    expect(task.workflowStepResults).toEqual(evidence);
    expect((store as unknown as { seedWorkspaceCodeReviewContinuationIfIdle?: unknown }).seedWorkspaceCodeReviewContinuationIfIdle).toBeUndefined();
  });

  it("re-admits finalization only when the real gate produces approval", async () => {
    const { task, poll } = fixture();
    expect(await poll()).toBe(false);
    Object.assign(task.workflowStepResults![0], { status: "passed", verdict: "APPROVE" });
    expect(await poll()).toBe(true);
  });

  it("still admits absent evidence so existing graph-resume recovery can run", async () => {
    const { task, store, poll } = fixture();
    task.workflowStepResults = [];
    expect(await poll()).toBe(true);
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });

  it.each(["paused", "userPaused"] as const)("does not mutate a %s task", async (key) => {
    const { task, store, poll } = fixture();
    task[key] = true;
    expect(await poll()).toBe(false);
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("does not clear a live merge owner's activity", async () => {
    const { task, store, self, poll } = fixture();
    self.isMergePending.mockResolvedValue(true);
    expect(await poll()).toBe(false);
    expect(task.status).toBe("landing");
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });

  it("does not clear a live executor's activity", async () => {
    const { task, store, poll } = fixture();
    executingTaskLock.tryClaim(task.id);
    try {
      expect(await poll()).toBe(false);
      expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    } finally { executingTaskLock.release(task.id); }
  });

  it("keeps a merge claim that races the initial liveness read", async () => {
    const { task, store, self, poll } = fixture();
    store.updateTaskAtomic = vi.fn(async (_id, update) => {
      self.mergeActive.add(task.id);
      expect(update(task)).toBeNull();
      return null;
    }) as never;
    expect(await poll()).toBe(false);
    expect(task.status).toBe("landing");
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("does not admit duplicate gate results even if one is approved", async () => {
    const { task, poll } = fixture();
    task.workflowStepResults!.push({ ...task.workflowStepResults![0], status: "passed", verdict: "APPROVE" });
    expect(await poll()).toBe(false);
    expect(task.workflowStepResults).toHaveLength(2);
  });

  it("preserves a concurrent task-state change at the atomic write", async () => {
    const { task, store, poll } = fixture();
    store.updateTaskAtomic = vi.fn(async (_id, update) => {
      const current = { ...task, paused: true, updatedAt: "later" };
      expect(update(current)).toBeNull();
      return null;
    }) as never;
    expect(await poll()).toBe(false);
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(task.status).toBe("landing");
  });
});
