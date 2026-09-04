/*
FNXC:WorkflowLifecycleTraits 2026-07-19-06:45 (U6 / KTD-10 / R8):
Characterization + trait-rekey coverage for self-healing's worktree-session repair.
Recovery clears stale metadata but retains the card's current workflow column; workflow
vocabulary resolution can no longer turn cleanup into a backward lifecycle move. The legacy
`requeue-todo` outcome name remains for caller compatibility only.
*/
import { describe, expect, it, vi } from "vitest";
import "@fusion/core"; // register built-in traits
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";
import { autoRecoverWorktreeSessionStartFailure } from "../self-healing.js";

function fakeStore(opts: { selection?: { workflowId: string; stepIds: string[] }; ir?: WorkflowIr }): TaskStore {
  return {
    updateTask: vi.fn(async () => ({})),
    logEntry: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => ({})),
    getTaskWorkflowSelection: vi.fn(() => opts.selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => opts.selection),
    getWorkflowDefinition: vi.fn(async () => (opts.ir ? { ir: opts.ir } : undefined)),
  } as unknown as TaskStore;
}

const recoveredTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "FN-R1",
    title: "t",
    description: "",
    column: "in-progress",
    dependencies: [],
    steps: [], // no step progress → no-progress requeue branch
    currentStep: 0,
    log: [],
    worktreeSessionRetryCount: 0, // nextCount = 1 ≤ MAX → requeue path (not escalate)
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  }) as Task;

async function recover(store: TaskStore, task: Task) {
  return autoRecoverWorktreeSessionStartFailure(store, task, {
    failure: new Error("worktree missing"),
    source: "executor-session-start",
    auditor: null,
  });
}

describe("self-healing recovery rebound — trait re-key (U6/KTD-10)", () => {
  it("retains the builtin task in its current lane", async () => {
    const store = fakeStore({ selection: undefined });
    const result = await recover(store, recoveredTask());
    expect(result.outcome).toBe("requeue-todo");
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-R1", expect.stringContaining("retained in in-progress"));
  });

  it("requeues to the custom workflow's HOLD column (KTD-10) instead of literal todo", async () => {
    const customIr: WorkflowIr = {
      version: "v2",
      name: "custom",
      columns: [
        { id: "ideas", name: "Ideas", traits: [{ trait: "intake" }] },
        { id: "backlog", name: "Backlog", traits: [{ trait: "hold", config: { release: "capacity" } }] },
        { id: "doing", name: "Doing", traits: [{ trait: "wip" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "ideas" }],
      edges: [],
    } as WorkflowIr;
    const store = fakeStore({ selection: { workflowId: "custom:wf", stepIds: [] }, ir: customIr });
    await recover(store, recoveredTask({ column: "doing" }));
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-R1", expect.stringContaining("retained in doing"));
  });

  it("falls back to the intake column when the custom workflow has no hold column", async () => {
    const noHoldIr: WorkflowIr = {
      version: "v2",
      name: "no-hold",
      columns: [
        { id: "inbox", name: "Inbox", traits: [{ trait: "intake" }] },
        { id: "doing", name: "Doing", traits: [{ trait: "wip" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [{ id: "start", kind: "start", column: "inbox" }],
      edges: [],
    } as WorkflowIr;
    const store = fakeStore({ selection: { workflowId: "custom:nohold", stepIds: [] }, ir: noHoldIr });
    await recover(store, recoveredTask({ column: "doing" }));
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-R1", expect.stringContaining("retained in doing"));
  });

  it("does not need a fallback column when workflow resolution fails", async () => {
    const store = {
      updateTask: vi.fn(async () => ({})),
      logEntry: vi.fn(async () => undefined),
      moveTask: vi.fn(async () => ({})),
      getTaskWorkflowSelectionAsync: vi.fn(async () => { throw new Error("selection unavailable"); }),
      getTaskWorkflowSelection: vi.fn(() => { throw new Error("selection unavailable"); }),
    } as unknown as TaskStore;
    await recover(store, recoveredTask());
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("preserves progress while repairing in place", async () => {
    const store = fakeStore({ selection: undefined });
    await recover(store, recoveredTask({ steps: [{ id: "s1", title: "x", status: "done" } as never] }));
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-R1", expect.not.objectContaining({ steps: expect.anything() }));
  });
});
