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
  classifyLifecycleDirection,
  classifyLifecycleRole,
  findWorkflowColumn,
  type CapacityRejectionFacts,
  isHoldToWipBoundary,
  isReviewGateNode,
  resolveColumnFlags,
  TransitionRejectionError,
  emitWorkflowLifecycleEvent,
  type TaskWipAdmissionStallCode,
} from "@fusion/core";
/* FNXC:CapacityGateFacts 2026-11-02-19:56 (RUFU-372): suspended-arm payload type for the gate facts. */
import {
  safeComputeDeferralCapacityGateFacts,
  type CapacityGateFacts,
  type CapacityFactsAmbientSource,
} from "./capacity-gate-facts.js";
/*
FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
The human-hold exclusion for the durable park marker. `execution/wip-admission-park.ts` imports
`@fusion/core` and the logger only, never this file, so this edge introduces no cycle.
*/
import { holdReleaseKind, isHumanOrEventRelease } from "../execution/wip-admission-park.js";

/** Run-audit event emitted by the boundary controller (KTD-12, ids/counts only). */
export type WorkflowColumnBoundaryAuditEvent =
  | {
      type: "task:column-transition";
      taskId: string;
      workflowId: string;
      fromColumn: string;
      toColumn: string;
      irHash: string;
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
  /*
  FNXC:WorkflowIrPin 2026-07-19-21:10 (KTD-3 drift-park loop fix, PR #2342):
  Clear the durable pin the moment drift is DETECTED. The pin that fired the drift
  guard is by definition stale (its node/column/hash no longer exists in the current
  IR); leaving it on the row made the park permanent — every requeue re-loaded the
  same pin, re-fired detectDrift, and re-failed until an operator manually nulled
  the fields. Clearing at drift-park time makes the park self-correcting: the next
  ordinary requeue loads no prior pin, re-resolves the CURRENT IR fresh, and
  proceeds — adopting the changed workflow is exactly the desired outcome.
  Wired to `createStoreIrPinPersistence().clearPin` in production; absent → the
  pre-fix posture (pin left in place) for minimal test harnesses.
  */
  clearPin?: () => void | Promise<void>;
  /** KTD-3: the pin recorded by a prior (possibly crashed) run, for drift check. */
  priorPin?: WorkflowIrPin;
  /** Optional diagnostics sink; never throws into the run. */
  onWarn?: (message: string, detail: Record<string, unknown>) => void;
  /** Persist a durable continuation before control returns to the scheduler. */
  onSuspend?: (suspension: Extract<WorkflowColumnBoundaryEntryResult, { kind: "suspended" }>) => void | Promise<void>;
  /*
  FNXC:EnginePause 2026-08-01-00:20 (Stop AI Engine did not stop the graph):
  Operator-observed regression: with `globalPause: true` the graph runner kept crossing node
  boundaries — a live run started a NEW Plan Review step (fresh model session) two minutes after
  Stop AI Engine, and the plan-review→replan loop kept cycling "attempt N/unbounded". The legacy
  executor loop re-read settings between steps; the graph interpreter never did, and the
  event-driven abort listeners cannot be the only line of defense (they depend on
  `settings:updated` reaching this store instance). This probe is polled at EVERY node entry, so
  a pause takes effect at the next boundary even if no event ever fires.
  */
  isPaused?: () => boolean | Promise<boolean>;
  /*
  FNXC:CapacityGateFacts 2026-11-02-20:30 (RUFU-372):
  Where the capacity snapshot's inputs come from, supplied by the production wiring because the
  controller deliberately owns no store. The boundary itself calls
  `safeComputeDeferralCapacityGateFacts` — the ONLY form legal on a deferral path — so a refusing
  column answers "which gate, how full, who holds the slots" from one snapshot instead of leaving
  the operator to guess between a WIP pool, a worktree pool, and a wedged dispatcher (measured:
  156 `reason=capacity` rows in 50 min with no limit, no used count, no gate identity).
  Absent → no facts are computed and the suspended payload stays byte-identical to the pre-fix
  shape, which is what minimal test harnesses and any store-less wiring depend on.
  */
  capacityFactsSource?: () => CapacityFactsInputSource | undefined | Promise<CapacityFactsInputSource | undefined>;
}

/** What {@link WorkflowColumnBoundaryDeps.capacityFactsSource} may hand back: the ambient snapshot inputs
 *  the controller cannot know (store surface, ceilings, caches, assigned agent). The per-refusal fields —
 *  the resolved IR, the target column, the deferring card, the carried refusal — are filled by the
 *  controller itself, so no wiring site can name a different column than the move it refused. The provider
 *  and resolver fields are excluded: this boundary already IS the provider. */
export type CapacityFactsInputSource = CapacityFactsAmbientSource;

/** The seam the graph executor consumes. */
export interface WorkflowColumnBoundary {
  /** The card's current lifecycle column (updated after each successful move). */
  currentColumn(): string;
  /**
   * Run the pause, event, and IR-pin portion of node entry without crossing columns.
   * A deferred column transition consumes this preflight through `onNodeEntry`.
   */
  preflightNodeEntry?(node: WorkflowIrNode): Promise<WorkflowColumnBoundaryEntryResult | void>;
  /** Cross into `node.column` when it differs from the current column. */
  onNodeEntry(node: WorkflowIrNode): Promise<WorkflowColumnBoundaryEntryResult | void>;
  /** KTD-3 drift guard — run once at graph start. Returns true when the pinned
   *  node/column is gone from the current IR (run must park, not traverse). */
  detectDrift(): Promise<boolean>;
}

export type WorkflowColumnBoundaryEntryResult =
  | { kind: "entered" }
  | {
      kind: "suspended";
      /*
      FNXC:CapacityGateFacts 2026-11-02-19:56 (RUFU-372):
      ONE shared engine-local reason vocabulary for every pre-execution deferral, consumed by
      the boundary result AND the graph executor's suspended marker — previously two parallel
      string unions drifted one word at a time. `scheduler-owned-seam` is the second half of the
      reason-code split: a scheduler-owned hold→WIP seam park that never consulted a capacity
      pool stops claiming `reason: "capacity"` (RunFusion: 235 capacity rows, zero pool facts).
      Deliberately engine-local: the CORE `WorkflowRunSuspendReason` enum stays untouched — the
      locked value set plus a production row with `waitReason='capacity'` at the seam is a
      documented no-migration contract.
      */
      reason: WorkflowDeferralReason;
      nodeId: string;
      fromColumn: string;
      toColumn: string;
      irHash: string;
      /**
       * Which refusal produced the suspend, as a fixed enum the audit row can be grouped by.
       *
       * FNXC:RunAuditCapacityDiagnostic 2026-10-20-20:25 (RUFU-372):
       * `reason: "capacity"` covered two unrelated situations — a scheduler-owned hold→wip seam that
       * never consulted a capacity pool, and a real `capacity-exhausted` transition rejection — so 185
       * rows an hour could not be separated into "pool full" and "waiting for the scheduler". Absent
       * keeps the pre-RUFU-372 shape valid for producers that do not classify yet.
       */
      source?: WorkflowRunSuspendSource;
      /** The gate that refused, with the counts that refused it. Absent when no pool was consulted. */
      capacity?: CapacityRejectionFacts;
      /*
      FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
      What a durable park needs, computed HERE rather than by the consumer. The refusal's identity exists
      at exactly two places in the process — the branch that declined the move and, for a real pool, the
      rejection that carried `CapacityFacts` — and nowhere else: by the time the suspended disposition
      reaches the executor, `reason: "capacity"` is the only surviving fact, and a consumer that
      reconstructed the gate from that word would repeat RUFU-372's exact error of labeling an authority
      hand-off as a full pool. Forwarding the gate plus its eligibility is therefore the only way the
      marker can say something the boundary did not already know.

      `eligible` is false for a hold column whose release is authored `manual` or `external-event`. Those
      cards wait for a person or an event, and parking them as though a pool refused them sends the
      operator to a limit slider that has nothing to do with the hold.
      */
      park?: WipAdmissionParkFacts;
      /*
      FNXC:CapacityGateFacts 2026-11-02-19:56 (RUFU-372):
      Which admission gate bound, from ONE snapshot, computed through the SAFE wrapper only
      (this arm is built inside a deferral catch whose throw would convert an explain-wait into
      a terminal graph-failed park). Carried for every capacity-bearing class so the audit row
      and the card notice read the same facts; absent for the pause gate and when no facts
      provider is wired (minimal harnesses keep the pre-fix payload byte-identical). Unknown +
      nulls is a real answer and still carries the keys.
      */
      capacityFacts?: CapacityGateFacts;
    };

/** A capacity suspension's park identity, carried from the branch that refused the crossing. */
export interface WipAdmissionParkFacts {
  /** Which gate refused, in the durable episode's own vocabulary. */
  code: TaskWipAdmissionStallCode;
  /** False when the hold is released by a human or an external event — never park those as capacity. */
  eligible: boolean;
  /** The refusing pool's identity, when a pool was consulted. */
  poolId?: string;
  occupants?: number;
  limit?: number;
  /*
  FNXC:CapacityGateFacts 2026-11-02-22:30 (RUFU-372):
  Who holds the pool and how long its longest-held occupant has been there, forwarded from the same
  snapshot the audit row reports. They ride the refusal's own park facts rather than being re-read at
  notice time, so the History line, the durable episode, the card face, and the audit row all describe the
  instant the pool refused — three surfaces agreeing is the deliverable, and a second read is how they
  stop agreeing. Absent means unrecorded (no pool consulted, or the holder walk could not run), which the
  notice must render as unrecorded rather than as an empty pool.
  */
  holderIds?: string[];
  oldestHolderAgeMs?: number;
}

/** Fixed vocabulary for what made a graph run suspend at a column boundary. */
export type WorkflowRunSuspendSource =
  /** A hold→wip boundary the scheduler owns; no capacity pool was consulted. */
  | "scheduler-seam"
  /** A real column move refused by the in-transaction capacity gate. */
  | "column-capacity"
  /** A capacity rejection that arrived without structured facts (older writer or lost hop). */
  | "capacity-rejection-without-facts";

/*
FNXC:CapacityGateFacts 2026-11-02-19:56 (RUFU-372):
The engine-local deferral-reason vocabulary shared by the boundary result and the executor's
suspended marker. `scheduler-owned-seam` separates a scheduler-owned authority hand-off from a
refused capacity crossing — the two shapes that made RunFusion's 235 `reason=capacity` rows
undiagnosable. `hold` is the executor marker's human-wait class (the FN-514 merge-delivery barrier).
`hold` and `pause` are structurally never capacity-bearing, so they never grow capacity keys — but the
principal-routing / overlap-wait hold does NOT suspend as `hold`, it suspends as `capacity` and carries its
identity in the marker's `irHash` sentinel (see `STRUCTURAL_HOLD_IR_HASHES` below), so the reason alone is
not a complete class test. This union must NOT leak
into the core `WorkflowRunSuspendReason` storage enum — a seam park's continuation keeps
`waitReason: 'capacity'` by the documented no-migration contract (see
workflow-column-boundary-hooks.ts onSuspend).
*/
export const WORKFLOW_DEFERRAL_REASONS = ["capacity", "pause", "hold", "scheduler-owned-seam"] as const;
export type WorkflowDeferralReason = (typeof WORKFLOW_DEFERRAL_REASONS)[number];

/*
FNXC:CapacityGateFacts 2026-11-02-20:45 (RUFU-372):
The two reason spellings as named constants, because the split is the deliverable and a bare
string literal at four call sites is how the two classes drift back together. A producer picks
one of these two; nothing else in the engine writes either.
*/
/** A real capacity refusal: a pool was consulted, it was full, waiting relieves it. */
export const CAPACITY_REFUSAL = "capacity" as const satisfies WorkflowDeferralReason;
/** A structural hand-off park: only the scheduler may cross, so waiting inside the run never does. */
export const SCHEDULER_OWNED_SEAM = "scheduler-owned-seam" as const satisfies WorkflowDeferralReason;

/*
FNXC:CapacityGateFacts 2026-11-02-21:45 (RUFU-372 code review P0):
The REASON value does not separate every structural park from every resource refusal, and the code that
assumed it did was wrong about a reachable class. The principal-routing / overlap-wait hold suspends with
`reason: "capacity"` (workflow-graph-executor.ts, the preflight refusal) and the human merge-delivery
barrier with `reason: "hold"` — both carry their identity in the marker's `irHash`, not in the reason, so
`capacity` alone cannot be the class test. Left as a reason test, the principal sentinel took the refusal
arm and grew `capacityGate: "unknown"` plus `capacityComputeOutcome: "complete"` on a row that also still
matched a `reason=capacity` monitor — the exact misleading-unknown + inflated-monitor pair this task exists
to delete. These two sentinels are therefore the class test: a structural hold is recognized by its
`irHash` BEFORE any reason comparison, and no capacity evidence is computed for it at all. The vocabulary
lives here, next to the reason constants, because a consumer that classifies deferrals must consult one
list rather than re-derive it from two throw sites.
*/
/** Principal-routing / overlap-wait hold — the marker's own refusal reason stays `capacity`. */
export const WORKFLOW_PRINCIPAL_HOLD_IR_HASH = "workflow-principal-hold" as const;
/** FN-514 human merge-delivery barrier hold — suspends with `reason: "hold"`. */
export const HUMAN_MERGE_APPROVAL_HOLD_IR_HASH = "human-merge-approval-hold" as const;

/** Every marker `irHash` that names a structural hold rather than a pinned workflow IR. A real pinned
 *  IR hash is a content hash, so these literals cannot collide with one by accident. */
export const STRUCTURAL_HOLD_IR_HASHES = [
  WORKFLOW_PRINCIPAL_HOLD_IR_HASH,
  HUMAN_MERGE_APPROVAL_HOLD_IR_HASH,
] as const;

/** Is this marker a structural hold the graph is waiting on a human or a router for? True means the
 *  row may not carry capacity evidence: no pool was consulted for this deferral at all. */
export function isStructuralHoldSentinel(irHash: string | undefined): boolean {
  return irHash !== undefined && (STRUCTURAL_HOLD_IR_HASHES as readonly string[]).includes(irHash);
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
  clearPin: () => Promise<void>;
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
    // FNXC:WorkflowIrPin 2026-07-19-21:10: null all three row fields (production
    // task-update.ts treats null as clear-to-undefined) so a requeued run loads
    // NO prior pin and re-resolves the current IR instead of re-firing drift.
    clearPin: async () => {
      if (typeof store.updateTask !== "function") return; // no-op degradation
      await store.updateTask(taskId, {
        workflowIrPin: null,
        workflowIrPinNodeId: null,
        workflowIrPinColumnId: null,
      });
      lastPin = undefined;
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
  /*
  FNXC:WorkflowColumnBoundary 2026-10-01-05:32:
  A deferred post-merge gate preflights its parent before traversing template children.
  Children also enter this shared boundary, so deferred state is keyed by node identity rather
  than a single slot; a child must never consume the approved parent's deferred completion hop.
  */
  const preflightedNodeIds = new Set<string>();

  const validateNodeEntry = async (node: WorkflowIrNode): Promise<WorkflowColumnBoundaryEntryResult> => {
    const toColumn = node.column;

    /*
    FNXC:EnginePause 2026-08-01-00:20:
    Pause gates EVERY node entry — columnless and same-column nodes included, because each node
    can start a real AI session regardless of whether the card moves. Suspend with the same
    durable-continuation mechanism capacity uses, so unpause resumes at exactly this node; the
    drain refuses to dispatch continuations while paused, which closes the resume loop.
    */
    if (await deps.isPaused?.()) {
      const pauseSuspension = {
        kind: "suspended",
        reason: "pause",
        nodeId: node.id,
        fromColumn: column,
        toColumn: toColumn ?? column,
        irHash: computeWorkflowIrPin(deps.ir, node.id).irHash,
      } as const;
      await deps.onSuspend?.(pauseSuspension);
      emitWorkflowLifecycleEvent({
        type: "RunSuspended",
        taskId: deps.taskId,
        at: new Date().toISOString(),
        workflowId: deps.workflowId,
        nodeId: node.id,
        reason: "pause",
        fromColumn: column,
        toColumn: toColumn ?? column,
      });
      return pauseSuspension;
    }

    emitWorkflowLifecycleEvent({
      type: "NodeEntered",
      taskId: deps.taskId,
      at: new Date().toISOString(),
      workflowId: deps.workflowId,
      nodeId: node.id,
      ...(toColumn ? { column: toColumn } : {}),
    });

    if (toColumn) {
      try {
        await deps.pinNodeEntry?.(computeWorkflowIrPin(deps.ir, node.id));
      } catch (err) {
        warn("ir pin write failed", { nodeId: node.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { kind: "entered" };
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
      // FNXC:WorkflowIrPin 2026-07-19-21:10 (drift-park loop fix): the pin that
      // fired the guard is stale — clear it NOW so the park self-corrects on the
      // next requeue (fresh IR resolution) instead of looping forever. Fail-soft:
      // a failed clear merely re-fires drift next run (the pre-fix behavior),
      // never fails this run's bookkeeping.
      try {
        await deps.clearPin?.();
      } catch (err) {
        warn("stale drift pin clear failed", { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    },

    async preflightNodeEntry(node: WorkflowIrNode): Promise<WorkflowColumnBoundaryEntryResult> {
      const entry = await validateNodeEntry(node);
      if (entry.kind === "entered") preflightedNodeIds.add(node.id);
      return entry;
    },

    async onNodeEntry(node: WorkflowIrNode): Promise<WorkflowColumnBoundaryEntryResult> {
      const toColumn = node.column;
      const wasPreflighted = preflightedNodeIds.delete(node.id);
      if (!wasPreflighted) {
        const entry = await validateNodeEntry(node);
        if (entry.kind === "suspended") return entry;
      }

      // KTD-1: a columnless node (e.g. `end`) never moves the card.
      if (!toColumn) return { kind: "entered" };

      // Idempotent: a re-entered/rework node or a same-column node chain no-ops.
      if (toColumn === column) return { kind: "entered" };

      const fromColumn = column;

      /*
      FNXC:LifecycleContainment 2026-09-02-10:36:
      FN-9243 preserves FN-207's no-backward-authority rule for graph routing. A review gate authored
      in a WIP column runs where an in-review card already is, rather than attempting the rejected
      backward move that killed the graph and stranded both unrun gates and stale-content reroutes.

      FNXC:LifecycleContainment 2026-09-02-22:41:
      RUFU-178: the review-gate predicate is now the shared core helper, so the FN-9243 unrun-gate
      re-seed clamps its continuation targetColumn with the EXACT same decision this boundary makes
      — the seed can never name a column the card will not actually stand in.
      */
      const isReviewGate = isReviewGateNode(node);
      const direction = classifyLifecycleDirection(
        classifyLifecycleRole(flagsFor(fromColumn)),
        classifyLifecycleRole(flagsFor(toColumn)),
      );
      if (isReviewGate && direction === "backward") {
        warn("review gate entered in place to preserve lifecycle containment", { fromColumn, toColumn, nodeId: node.id });
        return { kind: "entered" };
      }

      // KTD-2: never graph-move a hold→wip boundary — the scheduler is the sole
      // mover there; the card parks at the ready-for-release seam (U4 performs the
      // actual release). Record the seam but perform no move here.
      if (isHoldToWipBoundary(flagsFor(fromColumn), flagsFor(toColumn))) {
        warn("hold→wip boundary parked at ready-for-release seam (scheduler-owned)", {
          fromColumn,
          toColumn,
          irHash: computeWorkflowIrPin(deps.ir, node.id).irHash,
          nodeId: node.id,
        });
        const suspension = {
          kind: "suspended",
          /*
          FNXC:CapacityGateFacts 2026-11-02-20:35 (RUFU-372 second revision):
          This park is STRUCTURAL, not a resource refusal. Under KTD-2 the graph may never cross a
          hold→WIP boundary itself — the hold/release sweep is the sole mover — so waiting inside the
          run can never resolve it, while a `capacity-exhausted` rejection two branches below clears
          by itself once a slot frees. Opposite remedies may not share one reason value: measured on
          SKEN-009, 98 of 152 `reason=capacity` rows in one 30-minute window were a single card in a
          project with ZERO in-progress cards and zero worktree holders, so a monitor counting
          capacity suspends was reporting an unrelievable wait as if it were relievable pressure.
          `scheduler-owned-seam` is therefore the machine-readable discriminator, emitted on BOTH
          halves of this pair (the suspension marker here and its paired RunSuspended event below).
          No gate facts are attached at the seam — no pool is consulted here; the audit emit records
          what a live snapshot can prove there, and `unknown` beside this reason honestly means
          "look at the scheduler, not at a limit slider".
          */
          reason: SCHEDULER_OWNED_SEAM,
          nodeId: node.id,
          fromColumn,
          toColumn,
          irHash: computeWorkflowIrPin(deps.ir, node.id).irHash,
          /*
          FNXC:RunAuditCapacityDiagnostic 2026-10-20-20:25 (RUFU-372):
          Named `scheduler-seam`, deliberately NOT `column-capacity`: this branch never asks a capacity
          pool, it declines to move because the scheduler is the sole hold→wip mover. Without the name
          the seam and a full WIP pool were the same audit row, which is why a board idling here read
          like capacity exhaustion. No `capacity` block exists to report.
          */
          source: "scheduler-seam",
          /*
          FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
          The durable-park identity for the seam. `code` stays `scheduler-seam` and NO occupancy is
          reported, because this branch never asked a pool — RUFU-372 removed a fabricated zero from this
          exact spot, and a fabricated `at-limit` here would be that defect rewritten. `eligible` carries
          the human-hold exclusion: a card behind a `manual` or `external-event` release waits for a person
          or an event, and parking it as capacity is the mislabel this task exists to stop. The sweep,
          which DOES read the pool and the readiness probes, overwrites this with its own specific arm; the
          floor in `wipAdmissionStallWrite` is what makes two writers safe.
          */
          park: {
            code: "scheduler-seam",
            eligible: !isHumanOrEventRelease(holdReleaseKind(deps.ir, fromColumn)),
          },
        } as const;
        await deps.onSuspend?.(suspension);
        /*
        FNXC:WorkflowEvents 2026-07-27-12:05 (U3 / R5):
        Emitted AFTER `onSuspend` has persisted the durable continuation, so an
        observed `RunSuspended` implies the continuation exists. The continuation
        — not this event — is what the scheduler resumes from; dropping the event
        costs a notification, never a stranded run.
        */
        emitWorkflowLifecycleEvent({
          type: "RunSuspended",
          taskId: deps.taskId,
          at: new Date().toISOString(),
          workflowId: deps.workflowId,
          nodeId: node.id,
          /* FNXC:CapacityGateFacts 2026-11-02-20:35 (RUFU-372): the paired half of the seam park —
             the marker and the event must carry the SAME reason, or a monitor counting the event
             and a reader counting the row disagree about which waits are capacity waits. */
          reason: SCHEDULER_OWNED_SEAM,
          fromColumn,
          toColumn,
        });
        return suspension;
      }

      // The single mover: the store's trait-hook moveTask path.
      if (deps.moveTask) {
        try {
          await deps.moveTask(toColumn, { fromColumn, nodeId: node.id });
        } catch (err) {
          /*
          FNXC:WorkflowReviewGates 2026-07-26-13:40:
          A CAPACITY rejection on a real (non-hold→wip) boundary is transient, not a graph failure.
          This became reachable once the pre-merge review gates moved into `in-review`: the paired
          remediation node crosses in-review → in-progress, and that crossing re-enters a
          capacity-bearing column. Capacity is enforced in-transaction and is never bypassable, so
          if the pool filled while the gate ran, the move is rejected — and rethrowing here killed
          the run at the remediation node, stranding the card in `in-review` behind a failed
          pre-merge step with nothing scheduled to fix it.
          Park it the same way the hold→wip seam parks instead: a `suspended` result unwinds to a
          clean `outcome: "success"` with a suspension marker (no failure recorded, worktree/branch
          and the durable failed gate result preserved), so the next graph re-run retries the
          remediation move once a slot frees. Non-capacity rejections (invariant violations) are
          real errors and still propagate.
          */
          if (err instanceof TransitionRejectionError && err.rejection.code === "capacity-exhausted") {
            warn("graph column move parked — column at capacity (will retry on next run)", {
              fromColumn,
              toColumn,
              nodeId: node.id,
            });
            /*
            FNXC:CapacityGateFacts 2026-11-02-20:40 / 23:58 (RUFU-372):
            A real refusal is the class where the numbers are worth having, so take ONE live snapshot
            here — the rejection's own `CapacityRejectionFacts` is an input to the classification, not a
            substitute for it, because the store refuses with a column/occupants/limit triple only and
            can never see the agent gate or the holder ages. This branch is already inside a `catch`, and
            in this file a throw from a catch converts an explain-wait into a terminal `task:graph-failed`
            park plus `task.error`, so ONLY the safe wrapper is legal and it must be the ONE await this
            path performs: the wiring hands over a provider the wrapper resolves inside its own bound,
            rather than this branch awaiting a store read the wrapper cannot bound. The wrapper never
            rethrows and returns whatever it proved before its bound as a bounded `partial`.
            Without a wired source (minimal harnesses, store-less wiring) no facts are attached and the
            payload stays byte-identical to the pre-fix shape.
            */
            const capacityFacts = deps.capacityFactsSource
              ? await safeComputeDeferralCapacityGateFacts({
                sourceProvider: deps.capacityFactsSource,
                ir: deps.ir,
                targetColumn: toColumn,
                deferredTaskId: deps.taskId,
                ...(err.rejection.capacity ? { carried: err.rejection.capacity } : {}),
              })
              : undefined;
            const suspension = {
              kind: "suspended",
              /*
              FNXC:CapacityGateFacts 2026-11-02-20:40 (RUFU-372 second revision):
              This pair KEEPS `capacity`, and that is the point: a capacity-exhausted refusal is a
              transient resource refusal whose remedy is to wait for a slot, which is exactly what the
              seam park above is not. A monitor may therefore count `reason=capacity` rows and count
              only true refusals. Both halves keep the same value, and now also carry the binding
              gate's facts, so the reason alone separates the classes with no column-traits lookup.
              */
              reason: CAPACITY_REFUSAL,
              nodeId: node.id,
              fromColumn,
              toColumn,
              irHash: computeWorkflowIrPin(deps.ir, node.id).irHash,
              /*
              FNXC:RunAuditCapacityDiagnostic 2026-10-20-20:25 (RUFU-372):
              This is the one branch that was actually refused by a finite pool, and the refusal already
              knew the column, the occupants, and the limit (`CapacityFacts`). Forwarding them is the whole
              fix: the audit row can now answer which gate was hit and how full it was instead of leaving
              the operator to guess between a WIP pool, a worktree pool, and a wedged dispatcher. A
              rejection without structured facts (written by an older build, or restored from a persisted
              payload that dropped them) says so explicitly rather than looking like a zero-occupant pool.
              */
              source: err.rejection.capacity ? ("column-capacity" as const) : ("capacity-rejection-without-facts" as const),
              ...(err.rejection.capacity ? { capacity: err.rejection.capacity } : {}),
              /*
              FNXC:WipAdmissionPark 2026-11-02-07:10 (RUFU-393):
              A finite pool refused this move, so the park names the pool and its first sample. `poolId` is
              the refusing COLUMN — the pool identity the rejection actually carries; inventing a
              shared-budget id here would be a claim this branch cannot support. A refusal that arrived
              without facts parks as unproven rather than as a zero-occupant pool, matching the source enum
              one line above. Any column that can refuse a move for capacity is by definition not a human
              release gate, so eligibility is unconditional here.
              */
              park: err.rejection.capacity
                ? {
                    code: "column-capacity" as TaskWipAdmissionStallCode,
                    eligible: true,
                    poolId: err.rejection.capacity.column,
                    occupants: err.rejection.capacity.occupants,
                    limit: err.rejection.capacity.limit,
                    /*
                    FNXC:CapacityGateFacts 2026-11-02-22:30 (RUFU-372):
                    The holder facts join the park identity from the SAME snapshot, so the durable episode,
                    its History line, and the audit row are one measurement. A snapshot that could not walk
                    the holders simply omits them — the notice then says "holders are not recorded", which is
                    the honest rendering, rather than "held by nobody", which would send the operator to look
                    for a stuck card that does not exist.
                    */
                    ...(capacityFacts?.capacityHeldBy ? { holderIds: capacityFacts.capacityHeldBy } : {}),
                    ...(typeof capacityFacts?.capacityOldestHolderAgeMs === "number"
                      ? { oldestHolderAgeMs: capacityFacts.capacityOldestHolderAgeMs }
                      : {}),
                  }
                : { code: "capacity-rejection-without-facts" as TaskWipAdmissionStallCode, eligible: true },
              ...(capacityFacts ? { capacityFacts } : {}),
            } as const;
            await deps.onSuspend?.(suspension);
            // FNXC:WorkflowEvents 2026-07-27-12:06 (U3): see the hold→wip seam above.
            emitWorkflowLifecycleEvent({
              type: "RunSuspended",
              taskId: deps.taskId,
              at: new Date().toISOString(),
              workflowId: deps.workflowId,
              nodeId: node.id,
              // FNXC:CapacityGateFacts 2026-11-02-20:40 (RUFU-372): rejection class keeps `capacity`.
              reason: CAPACITY_REFUSAL,
              fromColumn,
              toColumn,
            });
            return suspension;
          }
          // A rejected move (invariant) leaves the card in its current column;
          // routing/parking is U4/U5. Do not advance `column` and do not emit a
          // transition audit for a move that did not happen.
          warn("graph column move rejected", {
            fromColumn,
            toColumn,
            nodeId: node.id,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
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
          irHash: computeWorkflowIrPin(deps.ir, node.id).irHash,
          nodeId: node.id,
        });
      } catch (err) {
        warn("column-transition audit emit failed", {
          fromColumn,
          toColumn,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return { kind: "entered" };
    },
  };
}
