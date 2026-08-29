/*
FNXC:WorkflowLifecycleTraits 2026-07-19-06:45 (U6 / KTD-10 / R8):
Characterization + trait-rekey coverage for self-healing's recovery rebound.
autoRecoverWorktreeSessionStartFailure now requeues a recovered card to the
workflow's KTD-10 trait-derived backlog column (hold → intake → first) instead of
the literal "todo":
  - builtin:coding resolves to `todo` (its hold column) — BYTE-IDENTICAL to the
    pre-cutover literal (R8 evidence for the recovery surface).
  - a custom workflow that renamed / omitted `todo` lands the recovered card in a
    valid backlog column per KTD-10 fallback ordering.
The test invokes the exported helper directly with a fake store so the assertion
does not depend on the full sweep pipeline.
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
  it("requeues to `todo` for builtin:coding (R8 byte-identical)", async () => {
    const store = fakeStore({ selection: undefined }); // no selection → builtin:coding
    const result = await recover(store, recoveredTask());
    expect(result.outcome).toBe("requeue-todo");
    expect(store.moveTask).toHaveBeenCalledWith("FN-R1", "todo", expect.objectContaining({ recoveryRehome: true }));
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
    await recover(store, recoveredTask());
    expect(store.moveTask).toHaveBeenCalledWith("FN-R1", "backlog", expect.objectContaining({ recoveryRehome: true }));
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
    await recover(store, recoveredTask());
    expect(store.moveTask).toHaveBeenCalledWith("FN-R1", "inbox", expect.objectContaining({ recoveryRehome: true }));
  });

  it("keeps the legacy `todo` fallback when IR resolution fails", async () => {
    const store = {
      updateTask: vi.fn(async () => ({})),
      logEntry: vi.fn(async () => undefined),
      moveTask: vi.fn(async () => ({})),
      getTaskWorkflowSelectionAsync: vi.fn(async () => { throw new Error("selection unavailable"); }),
      getTaskWorkflowSelection: vi.fn(() => { throw new Error("selection unavailable"); }),
    } as unknown as TaskStore;
    await recover(store, recoveredTask());
    expect(store.moveTask).toHaveBeenCalledWith("FN-R1", "todo", expect.objectContaining({ recoveryRehome: true }));
  });

  it("preserves progress on the rebound when the card has step progress", async () => {
    const store = fakeStore({ selection: undefined });
    await recover(store, recoveredTask({ steps: [{ id: "s1", title: "x", status: "done" } as never] }));
    expect(store.moveTask).toHaveBeenCalledWith(
      "FN-R1",
      "todo",
      expect.objectContaining({ recoveryRehome: true, preserveProgress: true }),
    );
  });
});
