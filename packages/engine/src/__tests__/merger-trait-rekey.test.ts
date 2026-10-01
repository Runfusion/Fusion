/*
FNXC:WorkflowMergeLifecycle 2026-07-19-08:00 (U7 / R2/R3/KTD-1/KTD-10):
Merger + finalization trait re-key. Finalization moves a confirmed-merged card to
the workflow's COMPLETE-trait column (not the literal "done"); builtin:coding
resolves to `done` (R8 byte-identical), a custom/benchmark workflow to its own
complete column. Done-only-on-confirmed-merge is preserved: no path enters a
complete column without durable merge proof. Scenario 4 (dependents unblock on
terminal arrival, not mere column entry) holds by construction here: the card
only ENTERS the complete column when finalization confirms the merge — for the
benchmark whose Done is terminal, complete-column entry IS the success terminal.
*/
import { describe, expect, it, vi } from "vitest";
import "@fusion/core";
import type { MergeResult, Task, TaskStore, WorkflowIr } from "@fusion/core";
import { finalizeProvenAutoMergeTask } from "../merge/auto-merge-finalization.js";

function benchmarkIr(): WorkflowIr {
  return {
    version: "v2", name: "benchmark",
    columns: [
      { id: "in-review", name: "In review", traits: [{ trait: "human-review" }] },
      { id: "merging", name: "Merging", traits: [{ trait: "merge" }, { trait: "merge-blocker" }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "merging" },
      { id: "merge-gate", kind: "merge-gate", column: "merging" },
      { id: "end", kind: "end", column: "shipped" },
    ],
    edges: [{ from: "start", to: "merge-gate" }, { from: "merge-gate", to: "end", condition: "success" }],
  } as WorkflowIr;
}

function makeStore(task: Task, ir?: WorkflowIr): TaskStore {
  const selection = ir ? { workflowId: "custom:bench", stepIds: [] } : undefined;
  return {
    getTask: vi.fn(async () => task),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => { Object.assign(task, patch); return task; }),
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (current: Task) => Partial<Task> | undefined | Promise<Partial<Task> | undefined>) => {
      const patch = await mutate(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    moveTask: vi.fn(async (_id: string, column: string) => { task.column = column; return task; }),
    /*
    FNXC:PostMergeFinalizationFixture 2026-09-23-11:20:
    FN-9370 moved terminal completion to a predicate-fenced durable move. This custom-column
    fixture executes the predicate against its current task to retain that production contract.
    */
    moveTaskIf: vi.fn(async (_id: string, column: string, predicate: (live: Task) => boolean | Promise<boolean>, options?: unknown) => {
      if (!await predicate(task)) return { moved: false, task };
      void options;
      task.column = column;
      return { moved: true, task };
    }),
    logEntry: vi.fn(async () => undefined),
    getSettings: vi.fn(async () => ({ maxConcurrent: 2 })),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => (ir ? { ir } : undefined)),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
  } as unknown as TaskStore;
}

const baseTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "FN-M1",
    title: "t",
    description: "",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    // This finalization-focused fixture owns no external post-merge evidence gate.
    enabledWorkflowSteps: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  }) as Task;

const confirmedResult: MergeResult = { mergeConfirmed: true } as MergeResult;

describe("finalizeProvenAutoMergeTask — complete-trait column (U7)", () => {
  it("moves a confirmed-merged builtin card to `done` (R8 byte-identical)", async () => {
    const task = baseTask({ column: "in-review", mergeDetails: { mergeConfirmed: true } as never });
    const store = makeStore(task); // no ir → builtin:coding
    const res = await finalizeProvenAutoMergeTask({ store, taskId: task.id, result: confirmedResult, source: "direct-ai-merge" });
    expect(res.outcome).toBe("done");
    expect(store.moveTaskIf).toHaveBeenCalledWith("FN-M1", "done", expect.any(Function), expect.objectContaining({
      moveSource: "engine",
      workflowMoveSource: "auto-merge-finalization",
    }));
  });

  it("moves a confirmed-merged custom/benchmark card to its OWN complete column (`shipped`)", async () => {
    const task = baseTask({ column: "merging", mergeDetails: { mergeConfirmed: true } as never });
    const store = makeStore(task, benchmarkIr());
    const res = await finalizeProvenAutoMergeTask({ store, taskId: task.id, result: confirmedResult, source: "workflow-graph-merge-finalize" });
    expect(res.outcome).toBe("done");
    expect(store.moveTaskIf).toHaveBeenCalledWith("FN-M1", "shipped", expect.any(Function), expect.anything());
  });

  it("done-only-on-confirmed-merge: refuses to finalize without durable merge proof (no move)", async () => {
    const task = baseTask({ column: "in-review", mergeDetails: undefined });
    const store = makeStore(task);
    const res = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toBe("missing-merge-confirmation");
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });

  it("treats a card ALREADY in the custom complete column as already-done (columnHasFlag, not literal 'done')", async () => {
    const task = baseTask({ column: "shipped", mergeDetails: { mergeConfirmed: true } as never });
    const store = makeStore(task, benchmarkIr());
    const res = await finalizeProvenAutoMergeTask({ store, taskId: task.id, result: confirmedResult, source: "direct-ai-merge" });
    expect(res.outcome).toBe("already-done");
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });

  /*
  FNXC:WorkflowMergeFinalization 2026-07-19-09:40 (R2/R7b regression):
  Transition-race recovery must work for CUSTOM complete columns: when a racing
  finalizer already landed the card in `shipped` and our moveTask throws
  "Invalid transition: ... → 'shipped'", the classifier must match the resolved
  complete column (not the literal "done") so the path gracefully returns
  already-done instead of rethrowing and stranding a proven-merged task.
  */
  it("recovers a transition race into a CUSTOM complete column as already-done (classifier not hardcoded to 'done')", async () => {
    const task = baseTask({ column: "merging", mergeDetails: { mergeConfirmed: true } as never });
    const store = makeStore(task, benchmarkIr());
    (store.moveTaskIf as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // Simulate the racing winner having already moved the card to `shipped`.
      task.column = "shipped";
      throw new Error("Invalid transition: 'merging' → 'shipped' is not allowed");
    });
    const res = await finalizeProvenAutoMergeTask({ store, taskId: task.id, result: confirmedResult, source: "direct-ai-merge" });
    expect(res.outcome).toBe("already-done");
    expect(res.task?.column).toBe("shipped");
  });

  it("blocks a card sitting in the custom complete column WITHOUT merge proof (done-without-merge guard on custom id)", async () => {
    const task = baseTask({ column: "shipped", mergeDetails: undefined });
    const store = makeStore(task, benchmarkIr());
    const res = await finalizeProvenAutoMergeTask({ store, taskId: task.id, source: "self-healing" });
    expect(res.outcome).toBe("blocked");
    // Blocked without merge proof (the reason string itself is cosmetic and still
    // keyed on the literal "done" inside validateWorkflowDoneMergeProof).
    expect(res.reason).toMatch(/merge-confirmation/);
    expect(store.moveTaskIf).not.toHaveBeenCalled();
  });
});
