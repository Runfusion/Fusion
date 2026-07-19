/*
FNXC:WorkflowColumnBoundary 2026-07-18-20:35:
U1 — the graph is the sole lifecycle driver. As traversal crosses from a node in
column A into a node in column B, the card MOVES to column B through the store's
trait-hook `moveTask` path. This controller is the seam the graph executor calls
on every real-node entry; it owns the trait decision (move vs. park), the audit
emission (KTD-12), and the durable IR pin / drift guard (KTD-3).

Rules encoded here:
  - KTD-1: `end` and failure-terminal arrivals never move — the executor never
    calls `onNodeEntry` for a node without a column, and failure edges in the
    benchmark terminate at `end` (columnless), so the card stays put and parks in
    place. Only column-bearing node entries move.
  - KTD-2: a hold→wip boundary is NEVER graph-moved. The graph parks the card at
    the ready-for-release seam and the scheduler's capacity sweep (U4) is the sole
    actor that performs the hold→wip move. This controller records the seam and
    performs no move on that boundary.
  - KTD-3: each node entry pins the resolved IR (version/content hash) durably on
    the run state; `detectDrift` compares the stored pin against the current IR at
    run start and parks with `task:reconcile-workflow-drift` on mismatch instead
    of traversing a mutated graph.
  - KTD-12: `task:column-transition` and `task:reconcile-workflow-drift` carry
    ids/counts/outcomes-only metadata — no prose, no model ids.

Idempotency (U1 scenario 4 — kill/restart mid-transition settles exactly once):
the controller tracks the card's current column and only moves when the entered
node's column differs. A re-entered node (rework loop) or a re-run after restart
in the same column is a no-op, so exactly one move + one audit event is produced
per real boundary crossing. The crash-safe `transitionPending` marker written
in-txn by `moveTaskInternal` is the store-level half of that guarantee.
*/

import {
  type WorkflowIr,
  type WorkflowIrNode,
  type WorkflowIrPin,
  computeWorkflowIrPin,
  detectWorkflowDrift,
  findWorkflowColumn,
  isHoldToWipBoundary,
  resolveColumnFlags,
} from "@fusion/core";

/** Run-audit event emitted by the boundary controller (KTD-12, ids/counts only). */
export type WorkflowColumnBoundaryAuditEvent =
  | {
      type: "task:column-transition";
      taskId: string;
      workflowId: string;
      fromColumn: string;
      toColumn: string;
      nodeId: string;
    }
  | {
      type: "task:reconcile-workflow-drift";
      taskId: string;
      workflowId: string;
      pinnedNodeId: string;
      reason: string;
    };

/** The single store move seam. Wired to `store.moveTask(id, toColumn, {
 *  moveSource: "engine", workflowMoveSource: "workflow-graph" })`. */
export type WorkflowColumnMove = (
  toColumn: string,
  ctx: { fromColumn: string; nodeId: string },
) => Promise<void>;

export interface WorkflowColumnBoundaryDeps {
  taskId: string;
  workflowId: string;
  ir: WorkflowIr;
  /** The card's lifecycle column at run start (task.column). */
  initialColumn: string;
  /** The store move seam. Absent → the controller records intent but performs no
   *  move (byte-inert; used by unit tests that assert decisions only). */
  moveTask?: WorkflowColumnMove;
  /** Emit an ids/counts/outcomes-only run-audit event (KTD-12). */
  emitAudit?: (event: WorkflowColumnBoundaryAuditEvent) => void | Promise<void>;
  /** KTD-3: persist the per-node-entry IR pin (wired to the task row's
   *  `workflowIrPin*` fields via `createStoreIrPinPersistence` in production). */
  pinNodeEntry?: (pin: WorkflowIrPin) => void | Promise<void>;
  /** KTD-3: the pin recorded by a prior (possibly crashed) run, for drift check. */
  priorPin?: WorkflowIrPin;
  /** Optional diagnostics sink; never throws into the run. */
  onWarn?: (message: string, detail: Record<string, unknown>) => void;
}

/** The seam the graph executor consumes. */
export interface WorkflowColumnBoundary {
  /** The card's current lifecycle column (updated after each successful move). */
  currentColumn(): string;
  /** Cross into `node.column` when it differs from the current column. */
  onNodeEntry(node: WorkflowIrNode): Promise<void>;
  /** KTD-3 drift guard — run once at graph start. Returns true when the pinned
   *  node/column is gone from the current IR (run must park, not traverse). */
  detectDrift(): Promise<boolean>;
}

/*
FNXC:WorkflowIrPin 2026-07-19-18:30 (KTD-3 / U9b):
Store-backed KTD-3 pin persistence. The U9b schema landed the durable pin as three
task-row fields (`workflowIrPin` = content hash, `workflowIrPinNodeId`,
`workflowIrPinColumnId` — migration 0026), threaded through updateTask /
serialization / slim projections in core. This factory binds that row surface to
the boundary's `pinNodeEntry` / `loadPriorPin` seams:
  - pinNodeEntry writes via `updateTask` ONLY when the pin actually changed
    (same node re-entry / rework loops and same-hash chains are free — one row
    write per real node entry, not per traversal step);
  - loadPriorPin reads the fields back off the task row at run start so a
    restart/re-entry compares the crashed run's pin against the CURRENT IR and
    takes the drift-park path (`task:reconcile-workflow-drift`) on mismatch.
Degradation: a store lacking `updateTask`/`getTask`, or whose rows do not carry
the pin fields (in-memory fakes, pre-U9b DBs), yields no prior pin and no-op
writes — exactly the pre-wiring inert posture, so legacy harnesses are untouched.
*/

/** The minimal task-row surface the pin persistence needs. Structural on purpose
 *  so real stores and test fakes both fit without importing the full TaskStore. */
export interface WorkflowIrPinStoreSurface {
  updateTask?: (
    id: string,
    updates: {
      workflowIrPin?: string | null;
      workflowIrPinNodeId?: string | null;
      workflowIrPinColumnId?: string | null;
    },
  ) => unknown;
  getTask?: (id: string) => Promise<{
    workflowIrPin?: string;
    workflowIrPinNodeId?: string;
    workflowIrPinColumnId?: string;
  }>;
}

/** Build the store-backed `pinNodeEntry`/`loadPriorPin` pair for one task. */
export function createStoreIrPinPersistence(
  store: WorkflowIrPinStoreSurface,
  taskId: string,
): {
  pinNodeEntry: (pin: WorkflowIrPin) => Promise<void>;
  loadPriorPin: () => Promise<WorkflowIrPin | undefined>;
} {
  // Last pin known to be on the row (loaded or written) — the change-only gate.
  let lastPin: WorkflowIrPin | undefined;
  const samePin = (a: WorkflowIrPin, b: WorkflowIrPin): boolean =>
    a.nodeId === b.nodeId && a.irHash === b.irHash && a.columnId === b.columnId;

  return {
    pinNodeEntry: async (pin) => {
      if (typeof store.updateTask !== "function") return; // no-op degradation
      if (lastPin && samePin(lastPin, pin)) return; // unchanged → no row write
      await store.updateTask(taskId, {
        workflowIrPin: pin.irHash,
        workflowIrPinNodeId: pin.nodeId,
        workflowIrPinColumnId: pin.columnId ?? null,
      });
      lastPin = pin;
    },
    loadPriorPin: async () => {
      if (typeof store.getTask !== "function") return undefined;
      try {
        const row = await store.getTask(taskId);
        if (!row?.workflowIrPin || !row.workflowIrPinNodeId) return undefined;
        const pin: WorkflowIrPin = {
          nodeId: row.workflowIrPinNodeId,
          irHash: row.workflowIrPin,
          columnId: row.workflowIrPinColumnId ?? undefined,
        };
        lastPin = pin;
        return pin;
      } catch {
        // A store that cannot read the row degrades to "no prior pin" — the
        // drift guard stays inert rather than failing the run on bookkeeping.
        return undefined;
      }
    },
  };
}

/**
 * Build the boundary controller for one graph run. Additive: when the executor
 * has no `columnBoundary` dep wired it performs no lifecycle moves at all, so
 * every legacy runner/executor test stays byte-identical.
 */
export function createWorkflowColumnBoundary(
  deps: WorkflowColumnBoundaryDeps,
): WorkflowColumnBoundary {
  let column = deps.initialColumn;

  const warn = (message: string, detail: Record<string, unknown>): void => {
    try {
      deps.onWarn?.(message, detail);
    } catch {
      /* diagnostics must never affect the run */
    }
  };

  const flagsFor = (columnId: string) => {
    const col = findWorkflowColumn(deps.ir, columnId);
    return col ? resolveColumnFlags(col) : {};
  };

  return {
    currentColumn: () => column,

    async detectDrift(): Promise<boolean> {
      const pin = deps.priorPin;
      if (!pin) return false;
      const reason = detectWorkflowDrift(deps.ir, pin);
      if (!reason) return false;
      try {
        await deps.emitAudit?.({
          type: "task:reconcile-workflow-drift",
          taskId: deps.taskId,
          workflowId: deps.workflowId,
          pinnedNodeId: pin.nodeId,
          reason,
        });
      } catch (err) {
        warn("drift audit emit failed", { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    },

    async onNodeEntry(node: WorkflowIrNode): Promise<void> {
      const toColumn = node.column;
      // KTD-1: a columnless node (e.g. `end`) never moves the card.
      if (!toColumn) return;

      // KTD-3: pin the resolved IR for this node-entry (durable seam).
      try {
        await deps.pinNodeEntry?.(computeWorkflowIrPin(deps.ir, node.id));
      } catch (err) {
        warn("ir pin write failed", { nodeId: node.id, error: err instanceof Error ? err.message : String(err) });
      }

      // Idempotent: a re-entered/rework node or a same-column node chain no-ops.
      if (toColumn === column) return;

      const fromColumn = column;

      // KTD-2: never graph-move a hold→wip boundary — the scheduler is the sole
      // mover there; the card parks at the ready-for-release seam (U4 performs the
      // actual release). Record the seam but perform no move here.
      if (isHoldToWipBoundary(flagsFor(fromColumn), flagsFor(toColumn))) {
        warn("hold→wip boundary parked at ready-for-release seam (scheduler-owned)", {
          fromColumn,
          toColumn,
          nodeId: node.id,
        });
        return;
      }

      // The single mover: the store's trait-hook moveTask path.
      if (deps.moveTask) {
        try {
          await deps.moveTask(toColumn, { fromColumn, nodeId: node.id });
        } catch (err) {
          // A rejected move (capacity, invariant) leaves the card in its current
          // column; routing/parking is U4/U5. Do not advance `column` and do not
          // emit a transition audit for a move that did not happen.
          warn("graph column move rejected", {
            fromColumn,
            toColumn,
            nodeId: node.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }

      column = toColumn;
      try {
        await deps.emitAudit?.({
          type: "task:column-transition",
          taskId: deps.taskId,
          workflowId: deps.workflowId,
          fromColumn,
          toColumn,
          nodeId: node.id,
        });
      } catch (err) {
        warn("column-transition audit emit failed", {
          fromColumn,
          toColumn,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
