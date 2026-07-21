/*
FNXC:WorkflowColumnBoundary 2026-07-18-21:10:
U1 — graph-driven column transitions. Covers the seven U1 scenarios from the
cutover plan across two levels: the boundary controller in isolation (move
decisions, hold→wip park, drift, idempotency) and the graph executor invoking the
controller through real traversal (single move per boundary, same-column chains,
failure-to-end park). All lifecycle moves flow through the store's `moveTask`
trait-hook seam here modeled by a fake that records (fromColumn, toColumn).
*/
import { describe, expect, it, vi } from "vitest";
import "@fusion/core"; // registers built-in traits into the shared registry
import type { TaskDetail, WorkflowIr } from "@fusion/core";
import { computeWorkflowIrPin } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflow-graph-executor.js";
import {
  type WorkflowColumnBoundaryAuditEvent,
  createWorkflowColumnBoundary,
} from "../workflow-column-boundary.js";

function settingsOn() {
  return { experimentalFeatures: { workflowGraphExecutor: true } };
}

/** A minimal v2 IR for the In-progress(wip) → In-review(human-review) benchmark
 *  slice, with a same-column completion-summary chain and a done(complete)
 *  terminal reached only on success. */
function benchmarkSliceIr(): WorkflowIr {
  return {
    version: "v2",
    name: "benchmark-slice",
    columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "In-progress", traits: [{ trait: "wip" }, { trait: "timing" }] },
      { id: "in-review", name: "In-review", traits: [{ trait: "human-review" }, { trait: "merge-blocker" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "in-progress" },
      { id: "execute", kind: "prompt", column: "in-progress" },
      { id: "review", kind: "prompt", column: "in-review" },
      { id: "summary", kind: "prompt", column: "in-review" },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [
      { from: "start", to: "execute" },
      { from: "execute", to: "review", condition: "success" },
      { from: "review", to: "summary", condition: "success" },
      { from: "summary", to: "end", condition: "success" },
    ],
  };
}

interface MoveRecord {
  toColumn: string;
  fromColumn: string;
  nodeId: string;
}

/** Build a controller wired to recording fakes. */
function wiredController(opts: {
  ir: WorkflowIr;
  initialColumn: string;
  moves: MoveRecord[];
  audit: WorkflowColumnBoundaryAuditEvent[];
  pins?: string[];
  priorPin?: ReturnType<typeof computeWorkflowIrPin>;
  rejectMove?: (toColumn: string) => boolean;
}) {
  return createWorkflowColumnBoundary({
    taskId: "T-1",
    workflowId: "wf-benchmark",
    ir: opts.ir,
    initialColumn: opts.initialColumn,
    moveTask: async (toColumn, ctx) => {
      if (opts.rejectMove?.(toColumn)) throw new Error(`rejected move to ${toColumn}`);
      opts.moves.push({ toColumn, ...ctx });
    },
    emitAudit: (event) => {
      opts.audit.push(event);
    },
    pinNodeEntry: (pin) => {
      opts.pins?.push(pin.nodeId);
    },
    priorPin: opts.priorPin,
  });
}

describe("WorkflowColumnBoundary controller", () => {
  it("moves once across a graph-owned boundary and emits one column-transition (scenario 1)", async () => {
    const ir = benchmarkSliceIr();
    const moves: MoveRecord[] = [];
    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    const c = wiredController({ ir, initialColumn: "in-progress", moves, audit });

    await c.onNodeEntry(ir.nodes.find((n) => n.id === "review")!);

    expect(moves).toEqual([{ fromColumn: "in-progress", toColumn: "in-review", nodeId: "review" }]);
    expect(audit.filter((e) => e.type === "task:column-transition")).toHaveLength(1);
    expect(c.currentColumn()).toBe("in-review");
  });

  it("produces zero moves for a same-column node chain (scenario 2)", async () => {
    const ir = benchmarkSliceIr();
    const moves: MoveRecord[] = [];
    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    const c = wiredController({ ir, initialColumn: "in-review", moves, audit });

    await c.onNodeEntry(ir.nodes.find((n) => n.id === "review")!);
    await c.onNodeEntry(ir.nodes.find((n) => n.id === "summary")!);

    expect(moves).toHaveLength(0);
    expect(audit).toHaveLength(0);
    expect(c.currentColumn()).toBe("in-review");
  });

  it("never moves on a hold→wip boundary — parks at the scheduler seam (KTD-2, scenario 4-adjacent)", async () => {
    const ir = benchmarkSliceIr();
    const moves: MoveRecord[] = [];
    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    const warnings: string[] = [];
    const c = createWorkflowColumnBoundary({
      taskId: "T-1",
      workflowId: "wf",
      ir,
      initialColumn: "todo",
      moveTask: async (toColumn, ctx) => { moves.push({ toColumn, ...ctx }); },
      emitAudit: (e) => { audit.push(e); },
      onWarn: (m) => { warnings.push(m); },
    });

    // execute lives in the wip column; entering it from the hold column must NOT move.
    await c.onNodeEntry(ir.nodes.find((n) => n.id === "execute")!);

    expect(moves).toHaveLength(0);
    expect(audit).toHaveLength(0);
    expect(c.currentColumn()).toBe("todo");
    expect(warnings.some((w) => w.includes("hold→wip"))).toBe(true);
  });

  it("settles a repeated transition exactly once (scenario 4: kill/restart idempotency)", async () => {
    const ir = benchmarkSliceIr();
    const moves: MoveRecord[] = [];
    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    const c = wiredController({ ir, initialColumn: "in-progress", moves, audit });

    const reviewNode = ir.nodes.find((n) => n.id === "review")!;
    await c.onNodeEntry(reviewNode);
    await c.onNodeEntry(reviewNode); // re-entry after a simulated restart/rework

    expect(moves).toHaveLength(1);
    expect(audit.filter((e) => e.type === "task:column-transition")).toHaveLength(1);
  });

  it("does not advance or emit when the move is rejected (capacity/invariant)", async () => {
    const ir = benchmarkSliceIr();
    const moves: MoveRecord[] = [];
    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    const c = wiredController({
      ir,
      initialColumn: "in-progress",
      moves,
      audit,
      rejectMove: (to) => to === "in-review",
    });

    await c.onNodeEntry(ir.nodes.find((n) => n.id === "review")!);

    expect(moves).toHaveLength(0);
    expect(audit).toHaveLength(0);
    expect(c.currentColumn()).toBe("in-progress");
  });

  it("parks with reconcile-workflow-drift when the pinned node was deleted (scenario 5)", async () => {
    const ir = benchmarkSliceIr();
    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    // Pin a node id that no longer exists in the current IR.
    const stalePin = { nodeId: "deleted-node", irHash: "stale:0", columnId: "in-progress" };
    const c = createWorkflowColumnBoundary({
      taskId: "T-1",
      workflowId: "wf",
      ir,
      initialColumn: "in-progress",
      emitAudit: (e) => { audit.push(e); },
      priorPin: stalePin,
    });

    const drifted = await c.detectDrift();

    expect(drifted).toBe(true);
    const driftEvents = audit.filter((e) => e.type === "task:reconcile-workflow-drift");
    expect(driftEvents).toHaveLength(1);
    expect(driftEvents[0]).toMatchObject({ pinnedNodeId: "deleted-node", reason: "node-deleted" });
  });

  it("reports no drift when the current pin still resolves", async () => {
    const ir = benchmarkSliceIr();
    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    const freshPin = computeWorkflowIrPin(ir, "review");
    const c = createWorkflowColumnBoundary({
      taskId: "T-1",
      workflowId: "wf",
      ir,
      initialColumn: "in-progress",
      emitAudit: (e) => { audit.push(e); },
      priorPin: freshPin,
    });

    expect(await c.detectDrift()).toBe(false);
    expect(audit).toHaveLength(0);
  });
});

describe("WorkflowGraphExecutor × column boundary (integration)", () => {
  it("drives one move per real boundary through traversal and no move to done on success-to-end (scenarios 1-3)", async () => {
    const ir = benchmarkSliceIr();
    const moves: MoveRecord[] = [];
    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    const pins: string[] = [];
    const boundary = wiredController({ ir, initialColumn: "in-progress", moves, audit, pins });

    const handler = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({ handlers: { prompt: handler }, columnBoundary: boundary });

    const task = { id: "T-1", column: "in-progress" } as TaskDetail;
    const result = await executor.run(task, settingsOn(), ir);

    expect(result.outcome).toBe("success");
    // Exactly one lifecycle move: in-progress → in-review. `end` is column `done`
    // but is a terminal (KTD-1) — the executor never calls onNodeEntry for it, so
    // the card never moves to a complete column on the success-to-end edge.
    expect(moves).toEqual([{ fromColumn: "in-progress", toColumn: "in-review", nodeId: "review" }]);
    expect(moves.some((m) => m.toColumn === "done")).toBe(false);
    expect(audit.filter((e) => e.type === "task:column-transition")).toHaveLength(1);
    // Every executed real node pinned the IR on entry (KTD-3 seam).
    expect(pins).toContain("execute");
    expect(pins).toContain("review");
  });

  it("parks failed in place on a failure edge to end — no move, no complete (scenario 3)", async () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "fail-in-place",
      columns: [
        { id: "in-progress", name: "In-progress", traits: [{ trait: "wip" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "in-progress" },
        { id: "execute", kind: "prompt", column: "in-progress" },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "execute" },
        { from: "execute", to: "end", condition: "failure" },
      ],
    };
    const moves: MoveRecord[] = [];
    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    const boundary = wiredController({ ir, initialColumn: "in-progress", moves, audit });
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: async () => ({ outcome: "failure" as const }) },
      columnBoundary: boundary,
    });

    const task = { id: "T-1", column: "in-progress" } as TaskDetail;
    const result = await executor.run(task, settingsOn(), ir);

    expect(result.outcome).toBe("failure");
    expect(moves).toHaveLength(0); // card parks in the wip column it already occupied
    expect(boundary.currentColumn()).toBe("in-progress");
  });

  it("parks the run without traversal when the pinned node drifted (scenario 5)", async () => {
    const ir = benchmarkSliceIr();
    const moves: MoveRecord[] = [];
    const audit: WorkflowColumnBoundaryAuditEvent[] = [];
    const boundary = wiredController({
      ir,
      initialColumn: "in-progress",
      moves,
      audit,
      priorPin: { nodeId: "deleted-node", irHash: "stale:0" },
    });
    const handler = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({ handlers: { prompt: handler }, columnBoundary: boundary });

    const task = { id: "T-1", column: "in-progress" } as TaskDetail;
    const result = await executor.run(task, settingsOn(), ir);

    expect(result.outcome).toBe("failure");
    expect(result.context["workflow:driftPark"]).toBe(true);
    expect(handler).not.toHaveBeenCalled(); // no traversal of the mutated graph
    expect(moves).toHaveLength(0);
    expect(audit.filter((e) => e.type === "task:reconcile-workflow-drift")).toHaveLength(1);
  });
});
