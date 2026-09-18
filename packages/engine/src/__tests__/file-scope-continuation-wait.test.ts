import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowWorkItem } from "@fusion/core";
import {
  FILE_SCOPE_CONTINUATION_WAIT_PREFIX,
  releaseFileScopeWaitingContinuations,
  settlePlanningContinuationDispatch,
} from "../runtimes/in-process-runtime.js";

/*
FNXC:OverlapWaitSynchronization 2026-09-17-01:25:
Reimplemented for FN-329 "fix immediate file-scope continuation wake", the prerequisite this
branch's FN-332 cherry-pick also excluded. Covers the park-on-settle / wake-on-release pair that
lets a file-scope-blocked continuation sleep instead of busy-polling.
*/

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id, column: "in-progress", description: id, dependencies: [],
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    ...patch,
  } as Task;
}

describe("settlePlanningContinuationDispatch", () => {
  it("parks the item held with a file-scope reason when the task is still queued behind its overlap blocker", async () => {
    const transitionWorkflowWorkItem = vi.fn(async (_id: string, state: string, patch: Record<string, unknown>) => ({
      id: "item-1", state, blockedReason: patch.blockedReason,
    } as unknown as WorkflowWorkItem));
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", { status: "queued", overlapBlockedBy: "FN-A" })),
      transitionWorkflowWorkItem,
    } as unknown as TaskStore;
    const kick = vi.fn();

    const outcome = await settlePlanningContinuationDispatch({ store, taskId: "FN-WAITING", itemId: "item-1", kick });

    expect(outcome).toBe("waiting");
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith("item-1", "held", expect.objectContaining({
      expectedState: "running",
      blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-A`,
    }));
    expect(kick).not.toHaveBeenCalled();
  });

  it("returns the item to runnable and kicks the drain when the task is no longer queued", async () => {
    const transitionWorkflowWorkItem = vi.fn(async (_id: string, state: string) => ({ id: "item-1", state, blockedReason: null } as unknown as WorkflowWorkItem));
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", { status: undefined })),
      transitionWorkflowWorkItem,
    } as unknown as TaskStore;
    const kick = vi.fn();

    const outcome = await settlePlanningContinuationDispatch({ store, taskId: "FN-WAITING", itemId: "item-1", kick });

    expect(outcome).toBe("runnable");
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith("item-1", "runnable", expect.objectContaining({ expectedState: "running", blockedReason: null }));
    expect(kick).toHaveBeenCalledOnce();
  });

  it("is a no-op when the store cannot transition work items or the task is deleted", async () => {
    expect(await settlePlanningContinuationDispatch({ store: {} as TaskStore, taskId: "FN-1", itemId: "item-1" })).toBe("unchanged");
    const store = {
      getTask: vi.fn(async () => task("FN-1", { deletedAt: "2026-09-01T00:00:00.000Z" } as Partial<Task>)),
      transitionWorkflowWorkItem: vi.fn(),
    } as unknown as TaskStore;
    expect(await settlePlanningContinuationDispatch({ store, taskId: "FN-1", itemId: "item-1" })).toBe("unchanged");
    expect(store.transitionWorkflowWorkItem).not.toHaveBeenCalled();
  });
});

describe("releaseFileScopeWaitingContinuations", () => {
  it("wakes only held items whose blockedReason names the cleared blocker, on a task whose marker actually cleared", async () => {
    const items: WorkflowWorkItem[] = [
      { id: "item-match", state: "held", blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-A` } as WorkflowWorkItem,
      { id: "item-other-blocker", state: "held", blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-B` } as WorkflowWorkItem,
      { id: "item-not-held", state: "runnable", blockedReason: `${FILE_SCOPE_CONTINUATION_WAIT_PREFIX}FN-A` } as WorkflowWorkItem,
    ];
    const transitionWorkflowWorkItem = vi.fn(async (id: string, state: string) => ({ id, state } as unknown as WorkflowWorkItem));
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", { overlapBlockedBy: undefined })),
      listWorkflowWorkItemsForTask: vi.fn(async () => items),
      transitionWorkflowWorkItem,
    } as unknown as TaskStore;

    const released = await releaseFileScopeWaitingContinuations(store, [{ taskId: "FN-WAITING", blockerId: "FN-A" }]);

    expect(released).toEqual(["item-match"]);
    expect(transitionWorkflowWorkItem).toHaveBeenCalledTimes(1);
    expect(transitionWorkflowWorkItem).toHaveBeenCalledWith("item-match", "runnable", expect.objectContaining({ expectedState: "held", blockedReason: null }));
  });

  it("refuses to release while the task's overlap blocker marker is still set", async () => {
    const store = {
      getTask: vi.fn(async () => task("FN-WAITING", { overlapBlockedBy: "FN-A" })),
      listWorkflowWorkItemsForTask: vi.fn(async () => []),
      transitionWorkflowWorkItem: vi.fn(),
    } as unknown as TaskStore;

    const released = await releaseFileScopeWaitingContinuations(store, [{ taskId: "FN-WAITING", blockerId: "FN-A" }]);

    expect(released).toEqual([]);
    expect(store.listWorkflowWorkItemsForTask).not.toHaveBeenCalled();
  });
});
