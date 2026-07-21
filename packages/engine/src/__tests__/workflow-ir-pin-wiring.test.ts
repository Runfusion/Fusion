/*
FNXC:WorkflowIrPin 2026-07-19-18:30 (KTD-3 / U9b):
The durable IR pin seam is WIRED to the U9b task-row fields (workflowIrPin /
workflowIrPinNodeId / workflowIrPinColumnId, migration 0026) through
createStoreIrPinPersistence + the executor's buildColumnBoundaryHooks. These
tests pin the wired contract:
  (a) a real node entry persists the pin through a real-shaped store fake, and
      re-entry / unchanged pins produce NO extra row writes (change-only);
  (b) restart against a mutated IR (pinned node deleted / its column deleted →
      hash mismatch) takes the drift-park path: detectDrift() is true and the
      ids-only `task:reconcile-workflow-drift` audit is emitted;
  (c) restart against an unchanged IR resumes cleanly (no drift, no audit);
  (d) a store lacking the pin surface degrades to the pre-wiring inert no-op
      (no throws, no prior pin, drift guard stays inert).

FNXC:WorkflowIrPin 2026-07-19-21:10 (drift-park loop fix, PR #2342):
The drift park must be SELF-CORRECTING, not a permanent stuck loop. Invariant
under test (FN-5893 posture — the loop, not just the field clear):
  (e) detectDrift() clears the stale `workflowIrPin*` row fields at park time;
  (f) the FULL requeue cycle then proceeds: the next run loads NO prior pin,
      detects no drift against the current IR, and pins fresh — exactly one
      drift audit across the whole cycle (the reported forever-loop is broken);
  (g) handleGraphFailure recognizes WORKFLOW_DRIFT_PARK_CONTEXT_KEY and parks
      with the drift reason — not the misleading `failedNode: 'unknown'`
      terminal sink — without re-emitting the reconcile audit and while
      preserving worktree/branch/step progress.
*/
import { describe, expect, it, vi } from "vitest";
import "@fusion/core"; // registers built-in traits into the shared registry
import type { TaskDetail, WorkflowIr } from "@fusion/core";
import { computeWorkflowIrPin, hashWorkflowIr } from "@fusion/core";

import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { WORKFLOW_DRIFT_PARK_CONTEXT_KEY } from "../workflow-graph-executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import {
  createStoreIrPinPersistence,
  createWorkflowColumnBoundary,
  type WorkflowColumnBoundaryAuditEvent,
  type WorkflowIrPinStoreSurface,
} from "../workflow-column-boundary.js";

/** Minimal v2 IR: in-progress → in-review → done, benchmark-slice shaped. */
function baseIr(): WorkflowIr {
  return {
    version: "v2",
    name: "pin-wiring",
    columns: [
      { id: "in-progress", name: "In-progress", traits: [{ trait: "wip" }] },
      { id: "in-review", name: "In-review", traits: [{ trait: "human-review" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "in-progress" },
      { id: "execute", kind: "prompt", column: "in-progress" },
      { id: "review", kind: "prompt", column: "in-review" },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "execute" },
      { from: "execute", to: "review", condition: "success" },
      { from: "review", to: "end", condition: "success" },
    ],
  } as unknown as WorkflowIr;
}

interface FakeRow {
  workflowIrPin?: string;
  workflowIrPinNodeId?: string;
  workflowIrPinColumnId?: string;
}

/** Real-shaped store fake: updateTask merges pin fields onto a row with the
 *  production null-clears semantics (task-update.ts); getTask returns the row. */
function fakeStore(initial?: FakeRow) {
  const row: FakeRow = { ...initial };
  const updates: Array<Record<string, unknown>> = [];
  const store: Required<WorkflowIrPinStoreSurface> = {
    updateTask: (id, patch) => {
      updates.push({ id, ...patch });
      for (const key of ["workflowIrPin", "workflowIrPinNodeId", "workflowIrPinColumnId"] as const) {
        const value = patch[key];
        if (value === null) row[key] = undefined;
        else if (value !== undefined) row[key] = value;
      }
      return Promise.resolve();
    },
    getTask: (_id) => Promise.resolve({ ...row }),
  };
  return { store, row, updates };
}

function boundaryFor(opts: {
  ir: WorkflowIr;
  store: WorkflowIrPinStoreSurface;
  taskId?: string;
  priorPin?: ReturnType<typeof computeWorkflowIrPin>;
  audit?: WorkflowColumnBoundaryAuditEvent[];
}) {
  const taskId = opts.taskId ?? "T-PIN";
  const persistence = createStoreIrPinPersistence(opts.store, taskId);
  return {
    persistence,
    boundary: createWorkflowColumnBoundary({
      taskId,
      workflowId: "wf-pin",
      ir: opts.ir,
      initialColumn: "in-progress",
      moveTask: async () => {},
      emitAudit: (event) => {
        opts.audit?.push(event);
      },
      pinNodeEntry: persistence.pinNodeEntry,
      priorPin: opts.priorPin,
      // Production wiring (buildColumnBoundaryHooks): drift detection clears the
      // stale pin so the park self-corrects on the next requeue.
      clearPin: persistence.clearPin,
    }),
  };
}

const nodeOf = (ir: WorkflowIr, id: string) => ir.nodes.find((n) => n.id === id)!;

describe("KTD-3 IR pin wiring (U9b task-row persistence)", () => {
  it("(a) persists the pin on node entry through a real-shaped store fake, change-only", async () => {
    const ir = baseIr();
    const { store, row, updates } = fakeStore();
    const { boundary } = boundaryFor({ ir, store });

    await boundary.onNodeEntry(nodeOf(ir, "execute"));
    expect(updates).toHaveLength(1);
    expect(row).toEqual({
      workflowIrPin: hashWorkflowIr(ir),
      workflowIrPinNodeId: "execute",
      workflowIrPinColumnId: "in-progress",
    });

    // Re-entered node (rework loop) → identical pin → NO second row write.
    await boundary.onNodeEntry(nodeOf(ir, "execute"));
    expect(updates).toHaveLength(1);

    // A real new node entry writes exactly once more.
    await boundary.onNodeEntry(nodeOf(ir, "review"));
    expect(updates).toHaveLength(2);
    expect(row.workflowIrPinNodeId).toBe("review");
    expect(row.workflowIrPinColumnId).toBe("in-review");
  });

  it("(b) restart with the pinned node deleted parks via the drift path", async () => {
    const originalIr = baseIr();
    const { store } = fakeStore();
    // Run 1: pin `review` durably.
    const first = boundaryFor({ ir: originalIr, store });
    await first.boundary.onNodeEntry(nodeOf(originalIr, "review"));

    // Restart against a mutated IR: `review` deleted.
    const mutated = baseIr();
    mutated.nodes = mutated.nodes.filter((n) => n.id !== "review");
    mutated.edges = [
      { from: "start", to: "execute" },
      { from: "execute", to: "end", condition: "success" },
    ] as typeof mutated.edges;

    const priorPin = await createStoreIrPinPersistence(store, "T-PIN").loadPriorPin();
    expect(priorPin?.nodeId).toBe("review");

    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    const second = boundaryFor({ ir: mutated, store, priorPin, audit });
    await expect(second.boundary.detectDrift()).resolves.toBe(true);
    expect(audit).toEqual([
      {
        type: "task:reconcile-workflow-drift",
        taskId: "T-PIN",
        workflowId: "wf-pin",
        pinnedNodeId: "review",
        reason: "node-deleted",
      },
    ]);
  });

  it("(b) restart with the pinned node's column deleted parks via the drift path", async () => {
    const originalIr = baseIr();
    const { store } = fakeStore();
    const first = boundaryFor({ ir: originalIr, store });
    await first.boundary.onNodeEntry(nodeOf(originalIr, "review"));

    // The node survives but its column was renamed/deleted out from under it.
    const mutated = baseIr();
    (mutated as { columns: Array<{ id: string }> }).columns = (
      mutated as { columns: Array<{ id: string; name: string; traits: unknown[] }> }
    ).columns.map((c) => (c.id === "in-review" ? { ...c, id: "qa" } : c));

    const priorPin = await createStoreIrPinPersistence(store, "T-PIN").loadPriorPin();
    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    const second = boundaryFor({ ir: mutated, store, priorPin, audit });
    await expect(second.boundary.detectDrift()).resolves.toBe(true);
    expect(audit[0]).toMatchObject({
      type: "task:reconcile-workflow-drift",
      pinnedNodeId: "review",
      reason: "column-deleted",
    });
  });

  it("(c) restart with an unchanged IR resumes cleanly (no drift, no audit)", async () => {
    const ir = baseIr();
    const { store } = fakeStore();
    const first = boundaryFor({ ir, store });
    await first.boundary.onNodeEntry(nodeOf(ir, "review"));

    const priorPin = await createStoreIrPinPersistence(store, "T-PIN").loadPriorPin();
    expect(priorPin).toEqual(computeWorkflowIrPin(ir, "review"));

    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    // A byte-identical re-resolved IR (fresh object, same content hash).
    const second = boundaryFor({ ir: baseIr(), store, priorPin, audit });
    await expect(second.boundary.detectDrift()).resolves.toBe(false);
    expect(audit).toHaveLength(0);
  });

  it("(d) a store without the pin surface degrades to the inert no-op seam", async () => {
    const ir = baseIr();
    // No updateTask / no getTask at all (minimal in-memory fake).
    const bare: WorkflowIrPinStoreSurface = {};
    const persistence = createStoreIrPinPersistence(bare, "T-PIN");
    await expect(persistence.pinNodeEntry(computeWorkflowIrPin(ir, "execute"))).resolves.toBeUndefined();
    await expect(persistence.loadPriorPin()).resolves.toBeUndefined();

    // Node entries through the boundary never throw with the degraded seam.
    const { boundary } = boundaryFor({ ir, store: bare });
    await expect(boundary.onNodeEntry(nodeOf(ir, "execute"))).resolves.toBeUndefined();

    // A row that predates the U9b fields (getTask works, fields absent) also
    // yields no prior pin — the drift guard stays inert.
    const legacy: WorkflowIrPinStoreSurface = { getTask: () => Promise.resolve({}) };
    await expect(createStoreIrPinPersistence(legacy, "T-PIN").loadPriorPin()).resolves.toBeUndefined();

    // And a getTask that throws (store races/bookkeeping) degrades the same way.
    const throwing: WorkflowIrPinStoreSurface = { getTask: () => Promise.reject(new Error("no row")) };
    await expect(createStoreIrPinPersistence(throwing, "T-PIN").loadPriorPin()).resolves.toBeUndefined();
  });
});

describe("KTD-3 drift park self-correction (stuck-loop fix, PR #2342)", () => {
  /** Mutated IR: the pinned `review` node was deleted by an operator edit. */
  function mutatedIr(): WorkflowIr {
    const mutated = baseIr();
    mutated.nodes = mutated.nodes.filter((n) => n.id !== "review");
    mutated.edges = [
      { from: "start", to: "execute" },
      { from: "execute", to: "end", condition: "success" },
    ] as typeof mutated.edges;
    return mutated;
  }

  it("(e) drift detection clears the stale workflowIrPin* row fields at park time", async () => {
    const originalIr = baseIr();
    const { store, row } = fakeStore();
    const first = boundaryFor({ ir: originalIr, store });
    await first.boundary.onNodeEntry(nodeOf(originalIr, "review"));
    expect(row.workflowIrPinNodeId).toBe("review");

    const priorPin = await createStoreIrPinPersistence(store, "T-PIN").loadPriorPin();
    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    const second = boundaryFor({ ir: mutatedIr(), store, priorPin, audit });
    await expect(second.boundary.detectDrift()).resolves.toBe(true);

    // The stale pin is gone from the row — all three fields nulled through the
    // same updateTask surface createStoreIrPinPersistence writes through.
    expect(row).toEqual({
      workflowIrPin: undefined,
      workflowIrPinNodeId: undefined,
      workflowIrPinColumnId: undefined,
    });
    expect(audit).toHaveLength(1);
  });

  it("(f) the requeue cycle after a drift park resolves the current IR and proceeds — the loop is broken", async () => {
    // Run 1 pins `review`; operator mutates the workflow; run 2 drift-parks.
    const originalIr = baseIr();
    const { store, row } = fakeStore();
    const first = boundaryFor({ ir: originalIr, store });
    await first.boundary.onNodeEntry(nodeOf(originalIr, "review"));

    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    const parkedPin = await createStoreIrPinPersistence(store, "T-PIN").loadPriorPin();
    const parkedRun = boundaryFor({ ir: mutatedIr(), store, priorPin: parkedPin, audit });
    await expect(parkedRun.boundary.detectDrift()).resolves.toBe(true);

    // The reported cycle: self-healing requeues → the next run loads the prior
    // pin exactly like production (loadPriorPin off the row). Pre-fix this
    // returned the SAME stale pin and drift fired forever. Post-fix: no prior
    // pin → no drift → the run traverses the CURRENT IR and pins fresh.
    const requeuePin = await createStoreIrPinPersistence(store, "T-PIN").loadPriorPin();
    expect(requeuePin).toBeUndefined();

    const requeueRun = boundaryFor({ ir: mutatedIr(), store, priorPin: requeuePin, audit });
    await expect(requeueRun.boundary.detectDrift()).resolves.toBe(false);
    await requeueRun.boundary.onNodeEntry(nodeOf(mutatedIr(), "execute"));

    // Invariant (FN-5893): exactly ONE drift audit across the whole cycle and a
    // fresh pin against the current IR — no requeue→drift→fail loop.
    expect(audit.filter((e) => e.type === "task:reconcile-workflow-drift")).toHaveLength(1);
    expect(row).toEqual({
      workflowIrPin: hashWorkflowIr(mutatedIr()),
      workflowIrPinNodeId: "execute",
      workflowIrPinColumnId: "in-progress",
    });
  });

  it("(g) handleGraphFailure parks a drift exit with the drift reason, not failedNode:'unknown', and does not double-emit the audit", async () => {
    resetExecutorMocks();
    const store = createMockStore();
    const task = {
      id: "FN-DRIFT",
      title: "Drift park",
      description: "Workflow changed mid-run",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Implement", status: "in-progress" }],
      currentStep: 0,
      log: [],
      branch: "fusion/fn-drift",
      baseBranch: "main",
      worktree: "/tmp/fusion-fn-drift",
      status: null,
      error: null,
      paused: false,
      userPaused: false,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    } as unknown as TaskDetail;
    store.getTask.mockResolvedValue(task);
    store.updateTask.mockImplementation(async (_id: string, patch: Partial<TaskDetail>) => Object.assign(task, patch));
    store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const executor = new TaskExecutor(store, "/tmp/test");

    await (executor as any).handleGraphFailure(task, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: [],
      context: { [WORKFLOW_DRIFT_PARK_CONTEXT_KEY]: true },
    });

    // Accurate drift park — not the generic terminal sink's misleading message.
    expect(task.status).toBe("failed");
    expect(task.error).toContain("Workflow drift park");
    expect(task.error).not.toContain("failed at node 'unknown'");
    expect(task.error).not.toContain("Workflow graph terminated with failure");

    // Worktree/branch/step progress preserved for the requeue.
    expect(task.worktree).toBe("/tmp/fusion-fn-drift");
    expect(task.branch).toBe("fusion/fn-drift");
    expect(task.steps).toEqual([{ name: "Implement", status: "in-progress" }]);
    for (const call of store.updateTask.mock.calls) {
      for (const key of ["worktree", "branch", "steps"] as const) {
        expect(call[1] ?? {}).not.toHaveProperty(key);
      }
    }

    // detectDrift already emitted the ids-only reconcile audit at detection
    // time; the park must not double-emit it.
    expect(
      (store.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => (call[0] as { mutationType?: string })?.mutationType === "task:reconcile-workflow-drift",
      ),
    ).toHaveLength(0);
  });
});
