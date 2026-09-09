/**
 * Task move/lifecycle transition operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */
import {type TaskStore, type MoveTaskOptions, type MoveTaskInternalOptions, storeLog} from "../store.js";
import { buildPatchnodeEntryInput } from "../board/patchnode.js";
import { appendPatchnodeEntryInTransaction } from "./async/async-patchnode.js";
import * as schema from "../postgres/schema/index.js";
import {TaskDeletedError, HandoffInvariantViolationError, TransitionRejectionError} from "./errors.js";

/** @internal A fenced terminal-failure apply lost ownership before its move transaction. */
export class TerminalFailureApplyRejected extends Error {
  constructor(readonly outcome: "superseded" | "not-failed" | "deleted" | "no-budget") {
    super(`terminal failure apply ${outcome}`);
  }
}
import {and, eq, sql} from "drizzle-orm";
import type {Task, Column, ColumnId, HandoffToReviewOptions} from "../types.js";
import {VALID_TRANSITIONS, COLUMNS} from "../types.js";
import {serializeWorkflowIr} from "../workflows/workflow-ir.js";
import {emitWorkflowLifecycleEvent} from "../workflow-events.js";
import {resolveAllowedColumns, workflowHasColumn} from "../workflows/workflow-transitions.js";
import {isBuiltinWorkflowId, getBuiltinWorkflow, resolveDefaultWorkflowIr, resolveRetiredBuiltinWorkflowId, DEFAULT_WORKFLOW_ID} from "../workflows/builtin-workflows.js";
import {parseWorkflowIr} from "../workflows/workflow-ir.js";
import {findWorkflowColumn, resolveColumnPluginGates} from "../plugins/plugin-gate-verdict.js";
import {getTraitRegistry, resolveColumnFlags} from "../workflows/trait-registry.js";
import {resolveColumnCapacity, resolveWipBudgetColumns, resolveCapacityPoolId} from "../workflows/workflow-capacity.js";
import {
  type TransitionColumnFacts,
  evaluateCapacityRejection,
  evaluateTransitionInvariants,
} from "../workflows/workflow-transition-policy.js";
import {type DefaultWorkflowMoveContext, applyDefaultWorkflowMoveEffects, isReopenIntoPlanning} from "../workflows/default-workflow-hooks.js";
import {columnsWithFlag, resolveLifecycleColumns, resolveReviewColumns, toTaskMoveLanes} from "../workflows/workflow-lifecycle-traits.js";
import {resolveWorkflowIrForTask} from "../workflows/workflow-ir-resolver.js";
import {makeTransitionRejection, makeTransitionPending} from "../tasks/transition-types.js";
import {writeTransitionPendingAsync, clearTransitionPendingAsync} from "./async/async-transition-pending.js";
import type {WorkflowIr} from "../workflows/workflow-ir-types.js";
import type {DbTransaction} from "../postgres/data-layer.js";
import {acquireTaskAdvisoryXactLock} from "./task-advisory-lock.js";
import "../builtin-traits.js";
import {recordRunAuditEventWithinTransaction} from "../postgres/data-layer.js";
import {getTaskMergeBlocker} from "../merge/task-merge.js";
import {resolveRequiredPreMergeStepIds} from "../merge/required-pre-merge-steps.js";
import {__setTaskActivityLogLimitsForTesting} from "../task-store/comments.js";
import {readTaskRow as readTaskRowAsync, readTaskRowInTransaction, upsertTaskRowInTransaction} from "./async/async-persistence.js";
import {disposeTaskBeforeMove} from "../tasks/task-move-disposer.js";
import {resolveTaskSymbolsForTask} from "../tasks/task-symbol-resolution.js";

/*
FNXC:WorkflowResolvedColumns 2026-07-31-17:25 (fleet — the two fallbacks in this file):
DELIBERATE-LITERAL — the no-resolution default for the review question below.

Named sets rather than inline arms: the census counts an inline comparison regardless of the branch
it sits in (its `traitFallback` hint is advisory and never changes the count), so a converted guard
with an inline legacy arm stays on the backlog permanently.
*/
const LEGACY_REVIEW_LANES: ReadonlySet<string> = new Set(["in-review"]);

/*
FNXC:PostgresCutover 2026-07-05-19:50:
Backend-aware task-workflow IR resolution for move validation. The sync
resolver (resolveTaskWorkflowIrSync) cannot read the task_workflow_selection
row in backend mode (PostgreSQL is async-only) and silently falls back to
builtin:coding — which rejected every move out of a custom workflow column
(e.g. Coding (Ideas) "ideas"). Moves are async, so resolve the selection via
getTaskWorkflowSelectionAsync and map it to the same IR the sync path would.
*/
async function resolveTaskWorkflowIrForMove(store: TaskStore, id: string): Promise<WorkflowIr> {
  const selection = await store.getTaskWorkflowSelectionAsync(id);
  return resolveWorkflowIrForSelectedWorkflowId(store, selection?.workflowId);
}

/*
FNXC:WorkflowCapacity 2026-07-28-16:10 (PR #2499 review — split capacity snapshot):
IR resolution split out of the selection READ so a caller holding an already-read
selection can derive the IR from THAT read instead of issuing a second one.

Why this seam exists at all: the capacity gate derives two things from the task's
workflow selection — the LIMIT (from the IR) and the POOL KEY the occupancy count
buckets on. Resolving them from two independent reads lets them disagree, which is
precisely the R1 sentinel defect in a new costume: gate and counter talking about
different pools, so a finite limit cannot bind. One read in, both derived from it.
*/
async function resolveWorkflowIrForSelectedWorkflowId(store: TaskStore, workflowId: string | undefined): Promise<WorkflowIr> {
  /*
  FNXC:DisabledBuiltinWorkflows 2026-08-19-00:18:
  Move policy resolution is a no-selection path too. Read the store's effective
  project default before falling back to the catalog Coding identity, so a task
  without an explicit selection cannot be evaluated against a disabled workflow.
  */
  const effectiveWorkflowId = workflowId ?? await store.getDefaultWorkflowId();
  /* FNXC:WorkflowBuiltins 2026-07-19-10:24: every no-selection/unresolvable fallback goes through resolveDefaultWorkflowIr() so this resolver and prepareWorkflowMovePolicyPreflightImpl agree on the default IR (see the helper's note on the "preflight is stale" drift). */
  if (!effectiveWorkflowId) {
    return store.applyBuiltInPromptOverridesAsync(DEFAULT_WORKFLOW_ID, resolveDefaultWorkflowIr());
  }
  if (isBuiltinWorkflowId(effectiveWorkflowId)) {
    const builtin = getBuiltinWorkflow(effectiveWorkflowId);
    const ir = builtin?.ir;
    return store.applyBuiltInPromptOverridesAsync(
      effectiveWorkflowId,
      ir === undefined ? resolveDefaultWorkflowIr() : typeof ir === "string" ? parseWorkflowIr(ir) : ir,
    );
  }
  try {
    const def = await store.getWorkflowDefinition(effectiveWorkflowId);
    return def ? parseWorkflowIr(def.ir) : resolveDefaultWorkflowIr();
  } catch {
    return resolveDefaultWorkflowIr();
  }
}
import {enqueueMergeQueueInTransaction, dequeueMergeQueueOnColumnExitInTransaction} from "./async/async-merge-coordination.js";

/*
FNXC:WorkflowCapacity 2026-07-28-16:10 (PR #2499 review — split capacity snapshot):
Read the task's workflow selection ON THE MOVE'S OWN TRANSACTION HANDLE.

`getTaskWorkflowSelectionAsync` issues its query against `layer.db` — a different
connection from the in-flight move transaction — so a selection read through it is
NOT serialized with the occupancy count, which runs on `tx`. Reading the same row
through `tx` puts the snapshot inside the transaction that also does the counting
and the write, so the limit, the pool key, and the count all describe one
consistent state of the world.

Mirrors getTaskWorkflowSelectionAsyncImpl's query exactly, including the
project-id scoping (FNXC:WorkflowModelLanes): shared PostgreSQL deployments reuse
task ids across projects, so an unscoped read could resolve another project's
workflow and gate this move against the wrong pool entirely.

FNXC:WorkflowSuccession 2026-09-06-02:54:
Canonicalize the transaction-local selection before deriving either the IR or pool key. A historical retired identity must use the successor's overrides and capacity budget in the same serialized move snapshot.
*/
async function readTaskWorkflowSelectionInTransaction(
  tx: DbTransaction,
  projectId: string | undefined,
  taskId: string,
): Promise<string | undefined> {
  const scopedProjectId = projectId?.trim() || "__legacy_unscoped__";
  const rows = await tx
    .select({ workflowId: schema.project.taskWorkflowSelection.workflowId })
    .from(schema.project.taskWorkflowSelection)
    .where(and(
      eq(schema.project.taskWorkflowSelection.projectId, scopedProjectId),
      eq(schema.project.taskWorkflowSelection.taskId, taskId),
    ))
    .limit(1);
  const workflowId = rows[0]?.workflowId;
  return typeof workflowId === "string" && workflowId.length > 0
    ? resolveRetiredBuiltinWorkflowId(workflowId)
    : undefined;
}



/*
FNXC:WorkflowReviewGates 2026-07-26-15:05:
Lease length for the symmetric symbol-lock re-acquire on a !wip -> wip crossing. Matches the
engine scheduler's SYMBOL_LOCK_LEASE_MS (10 min) so a lock reclaimed by a lifecycle transition and
one taken at dispatch expire on the same clock; the engine renews both through renewSymbolLocks.
Duplicated rather than imported because @fusion/core must not depend on @fusion/engine.
*/
const SYMBOL_LOCK_REACQUIRE_LEASE_MS = 10 * 60_000;

/*
FNXC:WorkflowTransitionPolicy 2026-07-18-19:52:
Resolve a column's trait-derived facts (id + OR-merged flags) for the shared
transition validator (KTD-5). An unknown/legacy column absent from the workflow
IR resolves to empty flags — the legacy VALID_TRANSITIONS adjacency already
gates those moves, so the invariant policy simply does not fire on them.
*/
function resolveTransitionColumnFacts(ir: WorkflowIr, columnId: string): TransitionColumnFacts {
  const column = findWorkflowColumn(ir, columnId);
  return {
    columnId,
    flags: column ? resolveColumnFlags(column) : {},
  };
}

/*
FNXC:WorkflowReviewGates 2026-07-26-16:40:
Single authority for "is this move a RECOGNISED entry into `in-review`?", consumed by both the
backend-transaction and SQLite-transaction emit sites of `task:handoff-invariant-violation`.

Requirement history: the invariant dates from when `TaskStore.handoffToReview(...)` was the ONLY
legal way into `in-review`, so any other arrival was genuinely suspicious and worth auditing. After
the U1 IR-driven lifecycle cutover the workflow GRAPH owns column transitions — node column
assignment is the authority and the graph column boundary (`workflow-column-boundary.ts`
`onNodeEntry`) performs the move via `store.moveTask`. Moving the pre-merge review gates
(`code-review`, `browser-verification`) into the `in-review` column then made the graph cross that
boundary on EVERY gate entry, so a legitimate, fully-provenanced transition emitted a violation
audit on each crossing (observed on FN-8596 15:19:22: a violation immediately followed by the
`browser-verification` `task:column-transition`).

The fix is narrow ON PURPOSE: the invariant is NOT retired, because it still catches the movers it
was written for — operator drags, merge bounces, self-healing rehomes, and any future call site
that lands a card in review without going through handoff. Only a move carrying the graph's own
provenance is recognised. `workflowMoveSource: "workflow-graph"` is produced at four call sites,
ALL inside the executor's own graph / column-boundary machinery (the boundary hook plus the
graph-owned merge-boundary moves). No non-graph mover writes that literal — operator drags carry
`moveSource:"user"` and recovery sweeps use their own provenance (e.g.
`"self-healing-advanced-triage"`) — so neither can spoof it.
*/
function isRecognizedInReviewEntry(
  options: MoveTaskOptions | undefined,
  internal: MoveTaskInternalOptions,
): boolean {
  if (internal.fromHandoff) return true;
  if (options?.allowDirectInReviewMove === true) return true;
  return options?.workflowMoveSource === "workflow-graph";
}

/*
FNXC:WorkflowCapacity 2026-07-19-10:35:
Shared pooled-capacity enforcement (U4/KTD-9/KTD-10), extracted from the async
(backend transaction) and sync (SQLite transaction) move paths, which had the
identical resolve-budget → count-occupants → verdict → throw sequence inline.
Parameterized by a count callback so each path supplies its own in-transaction
counter. The occupant fold is maybe-async on purpose: the sync SQLite path runs
inside a synchronous `db.transactionImmediate` callback and MUST count, judge,
and throw synchronously (a returned promise there would escape the
transaction), while the backend path awaits the returned promise. Counting
stays sequential in the async case, matching the original per-column awaits
against the same transaction handle. A shared `limitSetting` pools multiple
wip columns, so occupants are summed across every column sharing the target's
budget — a task occupies exactly one column, so the sum never double-counts.
KTD-5: the ONE capacity counter feeds the ONE capacity-verdict authority
(`evaluateCapacityRejection`).
*/
function enforcePooledColumnCapacity(args: {
  workflowIr: WorkflowIr;
  toColumn: string;
  taskId: string;
  capacity: { limit: number; countPending: boolean };
  countOccupants: (budgetColumn: string, countPending: boolean) => number | Promise<number>;
}): void | Promise<void> {
  const { workflowIr, toColumn, taskId, capacity, countOccupants } = args;
  const budgetColumns = resolveWipBudgetColumns(workflowIr, toColumn);
  const judge = (occupants: number): void => {
    const capacityRejection = evaluateCapacityRejection(toColumn, {
      limit: capacity.limit,
      occupants,
    });
    if (capacityRejection) {
      throw new TransitionRejectionError(
        capacityRejection,
        `Cannot move ${taskId} to '${toColumn}': column at capacity (${occupants}/${capacity.limit})`,
      );
    }
  };
  const step = (index: number, occupants: number): void | Promise<void> => {
    if (index >= budgetColumns.length) return judge(occupants);
    const count = countOccupants(budgetColumns[index], capacity.countPending);
    if (typeof count === "number") return step(index + 1, occupants + count);
    return count.then((resolved) => step(index + 1, occupants + resolved));
  };
  return step(0, 0);
}

export async function moveTaskImpl(store: TaskStore, id: string, toColumn: ColumnId, options?: MoveTaskOptions,): Promise<Task> {
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:15:
    // Backend-mode moveTask: the moveTaskInternal orchestration now handles
    // backend mode by using layer.transactionImmediate(async (tx) => ...) instead
    // of sync db.transactionImmediate, and async in-transaction helpers for
    // merge-queue enqueue/dequeue and audit. The transition guards, side effects,
    // and workflow hooks are pure JS and run unchanged. The SQLite path below
    // is byte-identical to before.
    // ColumnId admits workflow-defined custom column ids (KTD-1). Both paths
    // runtime-validate: flag-ON against the task's resolved workflow, flag-OFF
    // via the VALID_TRANSITIONS lookup (non-legacy ids reject as before).
    const movePolicyPreflight = await store.prepareWorkflowMovePolicyPreflight(id, toColumn, options, { fromHandoff: false });
    return store.withTaskLock(id, () => store.moveTaskInternal(id, toColumn, options, { fromHandoff: false, movePolicyPreflight }));
  }

export interface MoveTaskIfResult {
  task: Task;
  moved: boolean;
}

/**
 * FNXC:RuntimeTaskOrchestrationAsync 2026-07-29-12:00:
 * FN-8361 recovery releases must read, predicate, and transition under one task
 * lock because updateTaskAtomic cannot express a column move. `{ task, moved }`
 * is the authoritative applied/skip signal; never nest public moveTask here.
 */
export async function moveTaskIfImpl(
  store: TaskStore,
  id: string,
  toColumn: ColumnId,
  predicate: (live: Task) => boolean | Promise<boolean>,
  options?: MoveTaskOptions,
): Promise<MoveTaskIfResult> {
  const movePolicyPreflight = await store.prepareWorkflowMovePolicyPreflight(id, toColumn, options, { fromHandoff: false });
  return store.withTaskLock(id, async () => {
    const live = await store.readTaskForMove(id);
    if (!await predicate(live) || live.column === toColumn) {
      return { task: live, moved: false };
    }
    const task = await store.moveTaskInternal(id, toColumn, options, {
      fromHandoff: false,
      movePolicyPreflight,
    }, live);
    return { task, moved: true };
  });
}

export async function handoffToReviewImpl(store: TaskStore, taskId: string, opts: HandoffToReviewOptions): Promise<Task> {
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:20:
    // Backend-mode handoffToReview: delegates to moveTaskInternal which now
    // handles backend mode. The handoff transactional invariant (column move +
    // mergeQueue insert + audit in one transaction) is preserved by
    // enqueueMergeQueueInTransaction and recordRunAuditEventWithinTransaction
    // running inside layer.transactionImmediate.
    return store.withTaskLock(taskId, async () => {
      let task: Task;
      try {
        task = await store.readTaskForMove(taskId);
      } catch (error) {
        if (error instanceof TaskDeletedError) {
          // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:45:
          // Backend mode: read the deleted task via async getTask (includeDeleted
          // path). SQLite path: sync readTaskFromDb.
          let deletedTaskColumn: string = "todo";
                    const layer = store.asyncLayer!;
          const pgRow = await readTaskRowAsync(layer, taskId, { includeDeleted: true });
          if (pgRow) {
            deletedTaskColumn = (pgRow.column as string) ?? "todo";
          }

          throw new HandoffInvariantViolationError(
            taskId,
            deletedTaskColumn,
            `Cannot hand off ${taskId} to in-review because the task is deleted`,
          );
        }
        throw error;
      }

      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-12:30:
      Hand-off refuses soft-deleted and historical-sentinel rows. The workflow read is hoisted for
      the review-target resolution below; no archive role exists in live workflow metadata.
      */
      const handoffIr = await resolveWorkflowIrForTask(store, taskId).catch(() => undefined);
      const taskIsHistorical = task.column === "archived";
      if (taskIsHistorical || task.deletedAt != null) {
        throw new HandoffInvariantViolationError(
          taskId,
          task.column,
          `Cannot hand off ${taskId} to in-review from ${task.column}`,
        );
      }

      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-08:20 (batch-core):
      HANDOFF TARGETS THE BOARD'S OWN REVIEW LANE.

      This was the literal `"in-review"`, and the consequence is worse than a guard that fails to
      match: `moveTaskInternal` REJECTS a target the workflow does not declare
      (`TransitionRejectionError: unknown-column`). So on any board that renamed its review lane,
      completion handoff did not silently no-op — it THREW, and every task finishing implementation
      failed to reach review at all.

      Found by a merge-queue regression test that tried to drive the real handoff path; the merge-queue
      guards below could never have been exercised on a renamed board because nothing could get a card
      into review in the first place.

      A SINGLE ID, not the broad set: this is a move TARGET, and a move takes exactly one column. That
      is the opposite arity from the enqueue/dequeue membership guards in this same file — same
      vocabulary, different question. `lifecycle.review` is the first `mergeOrchestration` lane, which
      is the lane a completion handoff belongs in; a `humanReview`-only lane is somewhere a card can BE
      in review, not somewhere the engine should PUT it.
      */
      /* Reuses the IR hoisted for the archive guard above rather than resolving twice. */
      const handoffTarget = (handoffIr ? resolveLifecycleColumns(handoffIr)?.review : undefined) ?? "in-review";

      return store.moveTaskInternal(
        taskId,
        handoffTarget,
        {
          ...opts.moveOptions,
          skipMergeBlocker: true,
          // KTD-9: handoff is an engine/recovery-class move; its skipMergeBlocker
          // maps onto bypassGuards under the flag (identical behavior both paths).
          bypassGuards: true,
        },
        {
          fromHandoff: true,
          runContext: {
            runId: opts.evidence.runId,
            agentId: opts.evidence.agentId,
          },
          ownerAgentId: opts.ownerAgentId,
          evidence: opts.evidence,
          now: opts.now,
        },
        task,
      );
    });
  }

export async function moveTaskInternalImpl(store: TaskStore, id: string, toColumn: ColumnId, options: MoveTaskOptions | undefined, internal: MoveTaskInternalOptions, currentTask?: Task,): Promise<Task> {
    const dir = store.taskDir(id);
    let task = currentTask ?? await store.readTaskForMove(id);
    /*
    FNXC:TaskMovement 2026-06-22-18:20:
    Public moveTask calls without an explicit source keep the legacy emitted source of "engine", but they do not inherit workflow guard bypass. Engine, scheduler, handoff, and recovery call sites opt into bypass semantics with an explicit moveSource or skipMergeBlocker.
    */
    const moveSource = options?.moveSource ?? "engine";

    // ── U4: flag-gated workflow-resolved transition path (KTD-8) ─────────────
    // Flag OFF (default): the legacy `VALID_TRANSITIONS` / inline-side-effect
    // path below runs byte-identical (proven by the characterization suite).
    // FNXC:WorkflowColumns 2026-06-22-18:22:
    // The flag-OFF path is still an active compatibility contract for changed-test recovery: it must throw bare Error for invalid legacy moves, persist v1 workflow IR, and support ON→OFF evacuation. Do not route flag-OFF callers through typed workflow-column rejections until the legacy path is intentionally removed.
    // Flag ON: validate against the task's resolved workflow column graph, run
    // sync trait guards (unless bypassed), and route the legacy per-column side
    // effects through the default-workflow trait hooks.
    // `experimentalFeatures` is a global-scoped setting, so the project-only
    // `getSettingsSync()` row would miss it — read merged settings (global +
    // project) via getSettingsFast(). This is an async read taken before the
    // lock-sensitive transaction; it does not touch the task lock.
    const mergedSettingsForMove = await store.getSettingsFast();
    // bypassGuards (KTD-9): engine-sourced moves + the existing skipMergeBlocker
    // call sites map onto it. Capacity (KTD-10) is NEVER bypassed by this — the
    // capacity check is not a guard (U6 fills the enforcement; U4 leaves a
    // pass-through slot). An explicit option value wins; otherwise derive it.
    const bypassGuards = store.resolveWorkflowBypassGuards(moveSource, options);
    /*
    FNXC:WorkflowCapacity 2026-07-28-19:05 (pool-id sentinel fix):
    ONE selection read, TWO derived ids, because they are two different things
    that were previously conflated into one variable — and the conflation is the
    defect. The capacity POOL key must match how the counter buckets rows
    (`resolveCapacityPoolId`, shared); the WORKFLOW id is telemetry and must stay
    a real workflow id, never the bucketing sentinel.
    */
    /*
    FNXC:WorkflowCapacity 2026-07-28-10:20 (R2 — make the gate bind for real projects):
    The selection is read REGARDLESS of the compatibility flag. Previously this was
    flag-gated, which is one of the two reasons the gate could not bind.

    FNXC:WorkflowCapacity 2026-07-28-16:10 (PR #2499 review — split capacity state):
    This read now serves TELEMETRY ONLY. The capacity pool id is no longer derived
    here: it is taken from a single snapshot read on the move's own transaction
    handle, alongside the IR, so the limit and the occupancy pool cannot come from
    two different observations of the selection. Deriving a pool id at this point
    again would reintroduce that split — the telemetry read is pre-transaction and
    is allowed to be stale; a capacity decision is not.
    */
    const workflowSelectionForMove = await store.getTaskWorkflowSelectionAsync(id);
    /*
    FNXC:WorkflowColumns 2026-07-30-05:25 (PR #2655 review — greptile P2 follow-through):
    `effectiveWorkflowIdForMove` is DELETED. It existed only to feed the emitted `workflowId`, and it
    applied a `?? DEFAULT_WORKFLOW_ID` fallback — so keeping it would have meant either an unused
    binding or the very fallback-as-authoritative stamp that review flagged. The emit site now reads
    the SELECTION directly, so the absence signal is preserved and there is nothing left to guess.
    */
    // FNXC:WorkflowColumns 2026-07-30-04:00 (U12): resolved unconditionally — the gate is gone, so
    // `undefined` now means only "no IR on this path or a v1 column-less IR", never "flag off".
    const workflowIr: WorkflowIr | undefined = await resolveTaskWorkflowIrForMove(store, id);
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-23:30 (fleet: moves.ts):
    ONE lifecycle resolution for the whole move, derived from the IR resolved on the line above — so
    every role guard below costs nothing extra on the hottest lifecycle path in the system. The local
    that used to compute this further down now aliases it rather than resolving a second time.
    
    `undefined` means no IR on this path or a v1 column-less IR, so each site keeps its legacy id as
    the fallback: a move must behave exactly as before when there is no basis to resolve from.
    */
    const moveLifecycle = workflowIr ? resolveLifecycleColumns(workflowIr) : undefined;
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-07:45 (batch-core):
    The BROAD review set for the merge-queue pair below. Resolved once here, beside `moveLifecycle`,
    and handed to both `enqueueMergeQueueInTransaction` and
    `dequeueMergeQueueOnColumnExitInTransaction` — those run inside the move transaction with only a
    `tx` handle and cannot resolve it themselves.

    Broad rather than `moveLifecycle.review`: enqueue/dequeue ask "is this card in / has it left a
    review lane", which is MEMBERSHIP. A board may declare a merge-orchestration lane and a separate
    human sign-off lane, and a card moving between them has not left review — the narrow single-id
    answer would dequeue it and drop it out of the merge queue mid-review.

    `undefined` when the workflow could not be read, which is what makes the helpers fall back to the
    legacy id rather than to an empty set that matches nothing.
    */
    const moveReviewColumns = workflowIr ? new Set(resolveReviewColumns(workflowIr)) : undefined;

    if (task.column === toColumn && !internal.terminalFailureApply) {
      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-17:20 (fleet — the same-column handoff target):
      A MOVE TARGET, resolved from the set already computed three lines above.

      This branch takes the backend-mode path for a handoff that lands the card in review. Against
      the literal it never fired on a renamed board, so a same-column handoff into a renamed review
      lane silently took the OTHER path — the sync-SQLite branch — which throws under PostgreSQL.

      `moveReviewColumns` is the broad membership set (merge-orchestration ∪ mergeBlocker ∪
      humanReview) already resolved here for the merge-queue pair; asking it costs nothing extra and
      cannot disagree with the enqueue/dequeue calls that receive the same value.
      */
      if (internal.fromHandoff && (moveReviewColumns ?? LEGACY_REVIEW_LANES).has(toColumn)) {
        // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:25:
        // Backend-mode same-column handoff: use layer.transactionImmediate with
        // async in-transaction helpers (enqueueMergeQueueInTransaction,
        // recordRunAuditEventWithinTransaction) instead of sync SQLite.
                const layer = store.asyncLayer!;
        await layer.transactionImmediate(async (tx) => {
          const liveRow = await readTaskRowInTransaction(tx, id, { includeDeleted: true }, layer.projectId);
          if (liveRow?.deletedAt) {
            throw new HandoffInvariantViolationError(
              id,
              task.column,
              `Cannot hand off ${id} to in-review because the task is deleted`,
            );
          }
          const existingRows = await tx
            .select({ one: sql`1` })
            .from(schema.project.mergeQueue)
            .where(eq(schema.project.mergeQueue.taskId, id))
            .limit(1);
          const existing = existingRows.length > 0;
          await recordRunAuditEventWithinTransaction(tx, {
            taskId: id,
            agentId: internal.runContext?.agentId ?? "system",
            runId: internal.runContext?.runId ?? "unknown",
            domain: "database",
            mutationType: "task:move",
            target: id,
            metadata: {
              from: task.column,
              to: toColumn,
              moveSource,
            },
          });
          await enqueueMergeQueueInTransaction(tx, id, { priority: task.priority, now: internal.now }, {
            agentId: internal.runContext?.agentId,
            runId: internal.runContext?.runId,
          }, moveReviewColumns);
          // FNXC:PostgresCutover 2026-07-15-12:00:
          // Same-column retries must share the outer handoff transaction too,
          // so workflow work cannot survive a rolled-back queue/audit handoff.
          await store.createCompletionHandoffWorkflowWork(task, {
            runId: internal.runContext?.runId,
            now: internal.now,
            source: internal.evidence?.reason,
          }, tx);
          await recordRunAuditEventWithinTransaction(tx, {
            taskId: id,
            agentId: internal.runContext?.agentId ?? "system",
            runId: internal.runContext?.runId ?? "unknown",
            domain: "database",
            mutationType: "task:handoff",
            target: id,
            metadata: {
              taskId: id,
              fromColumn: task.column,
              ownerAgentId: internal.ownerAgentId ?? null,
              reason: internal.evidence?.reason,
              runId: internal.runContext?.runId,
              agentId: internal.runContext?.agentId,
              alreadyEnqueued: existing,
            },
          });
          /*
          FNXC:HandoffFailureInjection 2026-07-15-12:00:
          The legacy sync SQLite enqueue arm was deleted 2026-07-31 (no callers).
          This test-only no-op seam runs after every VAL-DATA-013 sub-write
          (move, queue, workflow work, and handoff audit), so an injected throw
          proves this transaction rolls all of them back.
          */
          await store.__invokeHandoffMergeQueueFailureInjectorForTesting(id);
        });
        return task;
}

      if (toColumn === (moveLifecycle?.complete ?? "done") && store.clearDoneTransientFields(task)) {
        task.updatedAt = new Date().toISOString();
        await store.atomicWriteTaskJson(dir, task);
        if (store.isWatching) store.taskCache.set(id, { ...task });
        store.emit("task:updated", task);
      }
      if (toColumn === (moveLifecycle?.complete ?? "done")) {
        /*
        FNXC:WorkflowResolvedColumns 2026-07-31-04:20 (#2823 review — greptile):
        PASS THE COLUMN THE CARD ACTUALLY REACHED, not the legacy name for it.

        The gate above already resolves the complete lane, so on a renamed board this fires correctly
        — and then handed the consumer `column: "done"`, a column that board does not declare. The
        consumer resolves the canonical's flags for the column it is GIVEN, so it asked "is `done`
        terminal here?", got no, and left every duplicate marker in place. The conversion downstream
        was inert through this path for exactly the boards it was written for.

        `toColumn` is the lane the card reached; the resolved-vs-literal question is already settled
        by the gate one line up.
        */
        await store.clearNearDuplicateReferencesToFailSoft(id, {
          column: toColumn,
          reason: "done",
        });
      }
      return task;
    }

    const fromColumn = task.column;
    // A fenced recovery apply may already be in its rebound column; it still needs the transaction
    // to persist the failure clear and consume the fence, but must not become an invalid self-move.
    const terminalFailureApplySameColumn = internal.terminalFailureApply !== undefined && fromColumn === toColumn;

    if (workflowIr) {
      // ── Flag-ON validation + sync guards (typed rejections, KTD-3/R13) ─────
      // 1. Target column must exist in the task's workflow → unknown-column.
      //    #1411: a recoveryRehome move to a LEGACY column (todo/archived/…) is
      //    the engine's self-healing rescue path — those targets are guaranteed
      //    safe landing columns even when a custom workflow never defined them.
      //    recoveryRehome already skips adjacency (below); it must likewise skip
      //    the unknown-column rejection for legacy recovery targets, otherwise a
      //    custom-workflow card could never be rescued to todo/archived and would
      //    stay stuck — the exact bug #1411 describes. Non-legacy unknown targets
      //    still reject (a genuine programming error), and normal (non-recovery)
      //    moves are unaffected.
      const recoveryToLegacy =
        options?.recoveryRehome === true && (COLUMNS as readonly string[]).includes(toColumn);
      if (!workflowHasColumn(workflowIr, toColumn) && !recoveryToLegacy) {
        throw new TransitionRejectionError(
          makeTransitionRejection(
            "unknown-column",
            "transition.rejected.unknownColumn",
            false,
            `Column '${toColumn}' is not defined in this task's workflow`,
          ),
          `Invalid transition: '${fromColumn}' → '${toColumn}'. Unknown column for this workflow.`,
        );
      }
      // 2. Column-graph adjacency. For the default workflow this reproduces
      //    VALID_TRANSITIONS verbatim (resolveAllowedColumns); the
      //    transition-parity suite machine-checks the equivalence. A U5 recovery
      //    re-home (recoveryRehome) skips this so a stranded card can reach its
      //    new workflow's entry column from any current column.
      const allowed = resolveAllowedColumns(workflowIr, fromColumn);
      if (!terminalFailureApplySameColumn && options?.recoveryRehome !== true && !allowed.includes(toColumn)) {
        throw new TransitionRejectionError(
          makeTransitionRejection(
            "guard-rejected",
            "transition.rejected.invalidTransition",
            false,
            `Valid targets: ${allowed.join(", ") || "none"}`,
          ),
          `Invalid transition: '${fromColumn}' → '${toColumn}'. ` +
            `Valid targets: ${allowed.join(", ") || "none"}`,
        );
      }
      const skipWorkflowMovePolicies = store.shouldSkipWorkflowMovePolicies({
        fromColumn,
        toColumn,
        moveSource,
        bypassGuards,
        options,
      });
      if (!skipWorkflowMovePolicies) {
        if (
          internal.movePolicyPreflight?.fromColumn !== fromColumn ||
          internal.movePolicyPreflight?.toColumn !== toColumn ||
          internal.movePolicyPreflight?.workflowSignature !== serializeWorkflowIr(workflowIr)
        ) {
          throw new TransitionRejectionError(
            makeTransitionRejection(
              "guard-rejected",
              "transition.rejected.workflowMovePolicy",
              true,
              "Workflow move policy preflight is stale; retry the move",
            ),
            `Cannot move ${id} to '${toColumn}': workflow move policy preflight is stale`,
          );
        }
      }
      // ── KTD-5: shared transition-policy invariants (single validator) ───────
      // FNXC:WorkflowTransitionPolicy 2026-07-18-19:55:
      // Every mover funnels through here. The structural invariants (merge-blocker
      // on complete-bound entry; terminal→wip re-entry) live in the pure
      // workflow-transition-policy module so graph, scheduler, self-healing,
      // operator, and dashboard moves all reject identically. Merge-blocker
      // enforcement preserves the legacy bypass contract (engine/recovery moves
      // that set bypassGuards/skipMergeBlocker are trusted to have proven the
      // blocker clear — the finalizer's proven-merge path), so the blocker fact is
      // only resolved when NOT bypassed. Terminal→wip re-entry is a new capability
      // invariant that holds for all movers (builtin:coding never crosses it, so
      // the characterization oracle stays byte-identical).
      //
      // FNXC:WorkflowTransitionPolicy 2026-07-19-10:20:
      // The blocker fact is resolved only when the SOURCE column carries the
      // `merge-blocker` trait flag — the trait-level generalization of the legacy
      // `fromColumn === (moveLifecycle?.review ?? "in-review")` gate. Resolving it for every complete-bound
      // move re-hardcoded the review lane: `getTaskMergeBlocker` rejects any
      // source column that is not literally "in-review", which broke the
      // six-column benchmark's merging → done edge and the builtin
      // in-progress → done mission-validation edge that legacy allowed unchecked.
      // The column-identity precondition inside `getTaskMergeBlocker` is
      // skipped via the explicit `skipColumnIdentityCheck` option (PR #2341
      // review — previously this spoofed `column: "in-review"`, which would
      // silently misapply any future column-dependent logic there): the
      // fromFacts `mergeBlocker` flag IS the workflow's review-lane identity,
      // so only the content checks (paused / blocking status / incomplete
      // steps / pre-merge step results) decide. For builtin:coding this is
      // byte-identical — its only merge-blocker column is literally
      // "in-review".
      {
        const fromFacts = resolveTransitionColumnFacts(workflowIr, fromColumn);
        const toFacts = resolveTransitionColumnFacts(workflowIr, toColumn);
        const mergeBlockerReason =
          !bypassGuards && toFacts.flags.complete && fromFacts.flags.mergeBlocker === true
            ? (getTaskMergeBlocker(task, {
              skipColumnIdentityCheck: true,
              requiredPreMergeStepIds: resolveRequiredPreMergeStepIds(workflowIr, task.enabledWorkflowSteps, task),
            }) ?? null)
            : null;
        /*
        FNXC:LifecycleContainment 2026-08-28-01:09:
        FN-207 applies the direction policy even to bypassed and recovery-rehome
        moves, so this in-lock validator receives the raw option rather than the
        resolved `moveSource`. An absent option remains an operator-compatible,
        fail-open legacy route; explicit engine/scheduler movers are covered by
        the move-reason census and forbidden-path tests.
        */
        const decision = evaluateTransitionInvariants({
          taskId: id,
          from: fromFacts,
          to: toFacts,
          mergeBlockerReason,
          moveSource: options?.moveSource,
          lifecycleReason: options?.lifecycleReason,
        });
        if (!decision.allow) {
          throw new TransitionRejectionError(
            decision.rejection,
            `Cannot move ${id} to '${toColumn}': ${decision.rejection.detail ?? decision.rejection.code}`,
          );
        }
      }
      // 4. Sync trait guards (in-lock) — plugin gate re-check. Skipped entirely
      //    when bypassGuards (engine/recovery moves, KTD-9).
      if (!bypassGuards) {
        // 4. Plugin gate verdict re-check (U8, KTD-2). For each PLUGIN gate trait
        //    on the target column, consume the pre-evaluated verdict (recorded by
        //    the engine's trait adapter outside the lock). A blocking gate with
        //    no recorded `allow` verdict fails closed (typed rejection); advisory
        //    gates record-and-allow. Built-in gates are handled by their own
        //    path; this guard is the plugin gate surface only.
        const registry = getTraitRegistry();
        const pluginGates = resolveColumnPluginGates(
          findWorkflowColumn(workflowIr, toColumn),
          (tid) => registry.getTrait(tid),
        );
        if (pluginGates.length > 0) {
          const recorded = store.consumePluginGateVerdicts(id, toColumn);
          const byTrait = new Map(recorded.map((v) => [v.traitId, v]));
          for (const gate of pluginGates) {
            if (gate.gateMode === "advisory") continue; // record-and-allow
            // Degraded (force-disabled) plugin gate: its hook impl is gone, so
            // the registry resolves it to a no-op + audit warning (KTD-7). A
            // degraded gate is PASSIVE — the column never blocks the card; the
            // registry's warning is the audit signal. Cards remain movable.
            const resolved = registry.resolveTraitHook(gate.traitId, "gate");
            if (resolved.warning) continue;
            const verdict = byTrait.get(gate.traitId);
            // Fail closed: a blocking gate with no recorded allow verdict rejects.
            if (!verdict || !verdict.allow) {
              const reason =
                verdict?.detail ??
                (verdict
                  ? `Gate '${gate.traitId}' did not pass`
                  : `Gate '${gate.traitId}' has not been evaluated for this move`);
              throw new TransitionRejectionError(
                makeTransitionRejection(
                  "merge-blocked",
                  "transition.rejected.gateBlocked",
                  true,
                  reason,
                ),
                `Cannot move ${id} to '${toColumn}': ${reason}`,
              );
            }
          }
        }
      }
    } else {
      // ── Flag-OFF legacy path (unchanged) ───────────────────────────────────
      // A task can sit in a custom column when the flag was toggled ON→OFF;
      // `VALID_TRANSITIONS` only keys the legacy columns, so a missing entry
      // degrades to the legacy "Invalid transition" error instead of a TypeError.
      // #1409: flag-OFF evacuation. A recoveryRehome move OUT of a non-legacy
      // (custom) column into a legacy target is the ON→OFF evacuation path —
      // `VALID_TRANSITIONS` never keys a custom source column, so the legacy
      // check below would strand the card forever. Allow it through (bypassing
      // only the adjacency check; this is unreachable for normal flag-OFF moves,
      // which never set recoveryRehome and always start from a legacy column, so
      // characterization behavior is byte-identical).
      const sourceIsLegacy = (COLUMNS as readonly string[]).includes(task.column);
      const isEvacuation =
        options?.recoveryRehome === true &&
        !sourceIsLegacy &&
        (COLUMNS as readonly string[]).includes(toColumn);
      /*
      FNXC:AutoMergeLifecycle 2026-07-07-12:00:
      Signature 1 (FN-7641 / NEXT-010): a proven-merge recovery rehome can also run
      LEGACY -> LEGACY (e.g. `todo -> done` when finalizeProvenAutoMergeTask reaches a
      task whose column drifted to `todo`/`in-progress`/`triage` before workspace-merge
      finalization runs). VALID_TRANSITIONS['todo'] never lists 'done' -- that adjacency
      graph encodes the NORMAL flow, not proven-merge recovery -- so the legacy adjacency
      check below rejected the finalizer's `store.moveTask(id, 'done', { recoveryRehome:
      true, preserveProgress: true })` call with "Invalid transition: 'todo' -> 'done'.
      Valid targets: in-progress, triage, archived", stranding the card in `todo` forever
      even though `finalizeProvenAutoMergeTask` already verified `hasDurableMergeProof`
      and `getTaskHardMergeBlocker` before calling moveTask. Bypass ONLY the adjacency
      check for a recoveryRehome move between two legacy columns; the merge-blocker guard
      below (fromColumn === 'in-review' && toColumn === 'done') and the finalizer's own
      hard-blocker gate are untouched, so non-recovery moves and genuine merge blockers
      are not weakened.
      */
      const isLegacyRecoveryRehome =
        options?.recoveryRehome === true &&
        sourceIsLegacy &&
        (COLUMNS as readonly string[]).includes(toColumn);
      /*
      FNXC:WorkflowColumns 2026-07-13-11:50 (merge port from main):
      Third recoveryRehome carve-out: a recovery move INTO a custom column the task's OWN
      workflow declares (e.g. the integrity pass re-homing a workflow-edit orphan to a custom
      entry column). The two carve-outs above only cover legacy targets, so every
      custom-target repair threw the legacy "Invalid transition" Error, which rehomeOccupant
      swallowed as moved:false — the repair silently no-oped on every store open.
      Recovery-only, so normal moves keep the characterization contract byte-identical.
      */
      // Backend-aware IR resolution (resolveTaskWorkflowIrForMove): upstream's
      // sync resolver falls back to builtin:coding in PG mode, which would make
      // this carve-out silently never fire for custom columns on the default
      // backend — the exact bug it exists to fix.
      const isWorkflowDeclaredRecoveryRehome =
        options?.recoveryRehome === true &&
        !(COLUMNS as readonly string[]).includes(toColumn) &&
        workflowHasColumn(await resolveTaskWorkflowIrForMove(store, id), toColumn);
      if (!terminalFailureApplySameColumn && !isEvacuation && !isLegacyRecoveryRehome && !isWorkflowDeclaredRecoveryRehome) {
        /*
        FNXC:WorkflowColumns 2026-07-05-19:30:
        Workflow columns graduated to always-on (no experimental flag emitted), so this "flag-OFF"
        branch is the DEFAULT move path for nearly every project — the strict compat flag reads false
        because nothing sets it. Legacy columns (triage/todo/in-progress/in-review/done/archived) are
        validated verbatim by VALID_TRANSITIONS, preserving the legacy bare-Error contract. But a task
        can legitimately sit in a NON-legacy workflow column now (e.g. Coding (Ideas) → "ideas"), which
        VALID_TRANSITIONS cannot key — the old code returned `?? []` and rejected EVERY move out of it
        ("Invalid transition: 'ideas' → 'todo'. Valid targets: none"). Resolve a non-legacy source
        column's targets from the task's own workflow adjacency instead, still throwing the same
        legacy-style bare Error (not TransitionRejectionError) so the flag-OFF characterization contract
        holds for legacy columns. Ported from main's FN-7591 fix into the extracted moves.ts.

        FNXC:CodingIdeasWorkflow 2026-07-25-10:05:
        A LEGACY source column must also honor the task's own workflow adjacency, not only
        VALID_TRANSITIONS. Symptom: in Coding (Ideas) an operator could move Ideas → Todo but the
        reverse drag/menu action ("Move to Ideas") failed with "Invalid transition: 'todo' → 'ideas'.
        Valid targets: in-progress, triage, archived" — `todo` IS a legacy column, so the legacy branch
        ran and VALID_TRANSITIONS (a closed six-id map that cannot know about "ideas") had the final
        say. Both the Board drag pre-check and the context menu already offered the move, so the
        rejection surfaced only after the optimistic move snapped back.
        Fix: UNION the legacy targets with the workflow-resolved adjacency for legacy sources. This
        only ever RELAXES (never narrows) the legacy set, so builtin:coding stays byte-identical — its
        resolved adjacency reproduces VALID_TRANSITIONS verbatim — while any workflow that inserts its
        own column beside a legacy one (Ideas ↔ Todo here) becomes freely movable in both directions.
        The workflow IR is resolved lazily, only when VALID_TRANSITIONS alone would reject, so the
        happy-path move cost is unchanged.
        */
        const legacyTargets: readonly string[] = sourceIsLegacy
          ? (VALID_TRANSITIONS[task.column as Column] ?? [])
          : [];
        if (!legacyTargets.includes(toColumn)) {
          const workflowTargets = resolveAllowedColumns(
            await resolveTaskWorkflowIrForMove(store, id),
            task.column,
          );
          const validTargets = [...new Set([...legacyTargets, ...workflowTargets])];
          if (!validTargets.includes(toColumn)) {
            throw new Error(
              `Invalid transition: '${task.column}' → '${toColumn}'. ` +
                `Valid targets: ${validTargets.join(", ") || "none"}`,
            );
          }
        }
      }

      if (fromColumn === (moveLifecycle?.review ?? "in-review") && toColumn === (moveLifecycle?.complete ?? "done") && !options?.skipMergeBlocker) {
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-30-00:20 (batch-core feed):
        Hand the merge blocker the lane this guard JUST resolved.

        The condition above resolves both columns from the workflow; the call below re-asked with the
        literal and refused, so on a renamed board a legal review → complete move threw
        `Cannot move FN-1 to done: task is in 'signoff', must be in 'in-review'` — the transition was
        validated as legal and then rejected by its own guard. Passing the resolved lane is what makes
        the outer and inner questions the same question.
        */
        const mergeBlocker = getTaskMergeBlocker(task, {
          reviewColumns: moveLifecycle?.review ? new Set([moveLifecycle.review]) : undefined,
          requiredPreMergeStepIds: resolveRequiredPreMergeStepIds(workflowIr, task.enabledWorkflowSteps, task),
        });
        if (mergeBlocker) {
          throw new Error(`Cannot move ${id} to done: ${mergeBlocker}`);
        }
      }
    }

    /*
    FNXC:TaskMovement 2026-07-18-14:32:
    A user in-progress -> todo move is a hard cancel. Run the engine-owned,
    store-scoped disposer after every transition guard passes but before the
    task object or durable row changes column. The dashboard cannot observe a
    Todo row until the agent, workflow, configured command, and CLI execution
    surfaces have stopped.
    */
    await disposeTaskBeforeMove(store, {
      task,
      from: fromColumn,
      to: toColumn,
      source: moveSource,
    });

    const movedAt = internal.now ?? new Date().toISOString();
    // FNXC:TaskTiming 2026-07-20-10:00: column dwell is wall-clock stage data,
    // accumulated before replacing the prior column anchor and never used as AI active time.
    const priorColumnMovedAt = Date.parse(task.columnMovedAt ?? "");
    const moveMs = Date.parse(movedAt);
    if (fromColumn !== toColumn && Number.isFinite(priorColumnMovedAt) && Number.isFinite(moveMs)) {
      task.columnDwellMs = { ...(task.columnDwellMs ?? {}), [fromColumn]: Math.max(0, task.columnDwellMs?.[fromColumn] ?? 0) + Math.max(0, moveMs - priorColumnMovedAt) };
    }
    task.column = toColumn;
    task.columnMovedAt = movedAt;
    task.updatedAt = movedAt;

    /*
    FNXC:WorkflowColumns 2026-07-30-04:00 (U12 — the compatibility flag is RESOLVED):
    Column side effects run through the default-workflow TRAIT HOOKS unconditionally. The
    `if (useWorkflow)` gate and its inline legacy `else` branch are DELETED, not converted —
    converting a branch we intended to delete would have left a second definition of every
    column side effect alive to drift.

    WHY THIS WAS SAFE TO FLIP, evidenced rather than asserted:
      - `moves-flag-equivalence.test.ts` runs the SAME journey under both flag states against live
        PostgreSQL and diffs the persisted row: identical across 128 fields plus an equal timing
        shape, over todo -> in-progress -> in-review -> todo -> in-progress. Mutation-verified in
        both directions (stamping this branch, and diverging the reopen hook, each fail it).
      - The flag was read by NOTHING in production: `experimentalFeatures.workflowColumns` is
        global-only and no module writes it, so this branch had never run for any project that did
        not carry a stale persisted value. That is also why "the suite is green" was never evidence
        on its own — both paths were individually valid and only one was live.
      - Target-column validation was NOT introduced by this flip. I claimed it was, twice, and
        reproduced the opposite: a move to a column the task's workflow does not declare already
        rejects on the legacy path with `Invalid transition: ... Valid targets: ...`. See the seam-2
        cases in that same test file.
    */
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-08:10 (Phase C convergence):
      Resolved ONCE for both the hook context and the store's own reopen check, so the two
      cannot be handed different answers. `undefined` here means either no IR on this path
      or a v1 column-less IR; the hooks treat that as "no basis" and keep the legacy names,
      which is the only case where a legacy literal is legitimate.
      */
      const moveLifecycleColumns = moveLifecycle;
      // ── Flag-ON: route the legacy per-column side effects through the
      //    default-workflow trait hooks (timing, reset-on-entry, abort-on-exit,
      //    merge.onEnter). "Moved, not duplicated" applies to this path; the
      //    flag-off branch below keeps the legacy inline code verbatim. ───────
      const ctx: DefaultWorkflowMoveContext = {
        task,
        fromColumn,
        toColumn,
        moveSource,
        // FNXC:WorkflowReviewGates 2026-07-26-14:25: graph-owned-crossing discriminator consumed
        // by applyReopenFieldClears; set only by the graph column boundary.
        workflowMoveSource: options?.workflowMoveSource,
        bypassGuards,
        movedAt,
        settings: undefined,
        options: {
          preserveStatus: options?.preserveStatus,
          preserveResumeState: options?.preserveResumeState,
          preserveProgress: options?.preserveProgress,
          preserveWorktree: options?.preserveWorktree,
          preservePause: options?.preservePause,
        },
        resetSteps: () => store.resetAllStepsToPending(task),
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-30-08:10 (Phase C convergence):
        The hooks are sync and in-lock, so they cannot resolve a workflow themselves — but
        this path already holds `workflowIr`, so the roles cost one trait resolution and no
        extra read. Without them the hooks compared against the DEFAULT lineage's column
        names on every workflow, so a renamed board got no reopen effects at all.
        */
        lifecycleColumns: moveLifecycleColumns,
        /*
        FNXC:WorkflowLifecycleColumns 2026-07-30-09:05 (PR #2734 review — greptile):
        The SET-shaped roles beside the singular ones. `workflowIr` is already in hand here, so these
        cost three trait scans and no extra read — and they are what let the timing hook treat a move
        BETWEEN two WIP lanes as staying in WIP rather than as an exit plus a re-entry.
        */
        lifecycleColumnSets: workflowIr === undefined
          ? undefined
          : {
              wip: columnsWithFlag(workflowIr, "countsTowardWip"),
              complete: columnsWithFlag(workflowIr, "complete"),
              /*
              FNXC:WorkflowLifecycleColumns 2026-07-30-15:10 (PR #2734 review — greptile, on my own
              code): `mergeOrchestration` ALONE was the wrong set. A workflow may host review on a
              `humanReview`- or `mergeBlocker`-only lane, and entering it then skipped
              `applyInReviewEnterEffects` entirely — the enter-effects simply did not run for a card
              plainly in review.

              `resolveReviewColumns` (core, merged in #2730) is the shared answer to exactly this
              question, so this becomes the first consumer to use it instead of a fifth inline union.
              Note it is the BROAD set — correct here, because these hooks ASK "is this card in a review
              lane" and do not move anything on the answer. A caller that ADMITS and then MOVES wants the
              narrow single lane instead; #2750 documents that split at the helper.
              */
              review: resolveReviewColumns(workflowIr),
            },
      };
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-08:10: the store's own copy of the reopen
      predicate now CALLS the hooks' version instead of restating its column list. The
      comment below used to say "parity mirror" — two hand-written copies of one predicate,
      which is a divergence waiting for whichever copy the next edit misses.
      */
      const isReopenToTodoOrTriage = isReopenIntoPlanning(moveLifecycleColumns, fromColumn, toColumn);
      const hasNonPendingStepProgress = task.steps.some((step) => step.status !== "pending");
      const preserveStepProgress =
        options?.preserveResumeState ||
        (options?.preserveProgress === true && hasNonPendingStepProgress);
      const { warnings } = applyDefaultWorkflowMoveEffects(ctx);
      for (const warning of warnings) {
        storeLog.warn("Default-workflow trait hook degraded to no-op", {
          phase: "moveTaskInternal:workflow-hooks",
          taskId: id,
          ...warning,
        });
      }
      // Store-owned effects the hooks intentionally do NOT perform (filesystem /
      // store-private): clearing done transient fields + prompt-checkbox reset.
      if (toColumn === (moveLifecycle?.complete ?? "done")) {
        store.clearDoneTransientFields(task);
      }
      if (isReopenToTodoOrTriage && !preserveStepProgress) {
        await store.resetPromptCheckboxes(dir);
      }

    if (toColumn === (moveLifecycle?.wip ?? "in-progress") && !task.worktree && options?.allocateWorktree) {
      const allocator = options.allocateWorktree;
      const allocated = await store.withWorktreeAllocationLock(async () => {
        const others = await store.listTasks({ slim: true, includeArchived: false });
        const reservedNames = new Set<string>();
        for (const other of others) {
          if (other.id === id || !other.worktree) continue;
          const name = other.worktree.split("/").filter(Boolean).pop();
          if (name) reservedNames.add(name);
        }
        return allocator(reservedNames);
      });
      if (allocated) {
        task.worktree = allocated;
      }
    }

    let deletedAt: string | undefined;
    let alreadyEnqueued = false;
    // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:30:
    // Backend-mode main move transaction: use layer.transactionImmediate with
    // async in-transaction helpers. The capacity check, upsert, audit,
    // dequeue/enqueue all run inside the async transaction so they commit or
    // roll back atomically (VAL-DATA-002/003/013). The transition guards and
    // side effects above are pure JS and already ran unchanged.
        const layer = store.asyncLayer!;
    const context = store.createTaskPersistSerializationContext(task);
    await layer.transactionImmediate(async (tx) => {
      // Capacity check (KTD-10). In backend mode, count active tasks in the
      // target column via async Drizzle instead of the sync helper.
      /*
      FNXC:WorkflowCapacity 2026-07-28-10:20 (R2 — make the gate bind for real projects):
      NO LONGER GATED ON `useWorkflow`. `workflow-capacity.ts` states this enforcement
      "runs INSIDE moveTaskInternal's transaction and is NEVER bypassable"; that was
      false twice over. Phase A3 R1 was the pool-id sentinel (fixed separately). R2 is
      this condition: `useWorkflow` reads `experimentalFeatures.workflowColumns`, which
      is absent from DEFAULT_GLOBAL_SETTINGS and has no production writer, so the whole
      block was unreachable on the path every real project takes. A limit the product
      documents and the UI exposes was silently not enforced.

      SCOPE, deliberately narrow: only the CAPACITY check is un-gated. `workflowIr`
      stays flag-gated so transition VALIDATION keeps its current behavior — the
      inline path's bare-Error/"Valid targets:" contract is unchanged, and none of the
      Phase A2 divergences are flipped here. `capacityIr` is resolved separately for
      this one purpose, so a flag-off project pays one extra IR resolution per
      cross-column move and gets its configured limit actually enforced.
      */
      /*
      FNXC:WorkflowCapacity 2026-07-28-16:10 (PR #2499 review — greptile: split capacity state):
      ONE selection snapshot, read on `tx`, feeding BOTH derived values.

      The defect this replaces: the pool id came from `capacityPoolIdForMove`
      (resolved pre-transaction, near the top of the move) while the IR came from a
      SECOND, independent `getTaskWorkflowSelectionAsync` inside
      `resolveTaskWorkflowIrForMove`. A workflow-selection change landing between
      those two reads made the gate resolve its LIMIT from workflow B's IR while
      counting occupancy in workflow A's POOL — an empty pool measured against a
      populated column's limit, so the move is admitted into a full pool.

      That is the SAME SHAPE as the R1 sentinel this PR's sibling fixed: gate and
      counter disagreeing about which pool, so a finite limit cannot bind. It is
      not acceptable to argue the window is small — this PR is the moment capacity
      starts actually binding, so a gate that leaks under concurrent selection
      change is a defect introduced exactly where operators begin depending on it.

      Deliberately NOT reusing `workflowIr` here even when the compatibility flag is
      on: that value is resolved pre-transaction from its own separate read, so
      reusing it would preserve the very split this fixes on the flag-on path.
      `workflowIr` remains the input to transition VALIDATION, which is a different
      question asked at a different time and is unchanged.
      */
      /*
      FNXC:WorkflowCapacity 2026-07-28-18:05 (PR #2499 review — cross-process race):
      Take the per-task advisory lock BEFORE reading the selection.

      A consistent snapshot alone fixed only the INTRA-process split. The read was
      still unlocked: `transactionImmediate` runs at READ COMMITTED, where a plain
      SELECT takes no row lock, so another TaskStore on another node sharing the
      same central database could change this task's workflow selection right after
      the read. The move would then enforce the OLD workflow's pool and limit while
      committing the task under the NEW one — the gate leaking at exactly the moment
      operators start trusting it.

      `withTaskLock`, which the selection writer holds, does NOT help here: it is an
      in-process promise chain, so it serializes one store instance and nothing
      across nodes. Multi-node is several nodes against one PostgreSQL database, so
      this is a supported deployment shape, not a hypothetical.

      With the lock held for the rest of this transaction, the selection cannot
      change until the move commits or rolls back — so the pool id and limit
      enforced below are the ones the commit lands under. The matching acquire is in
      `writeTaskWorkflowSelectionImpl`; both go through
      `acquireTaskAdvisoryXactLock` so neither side can restate the key differently
      (the failure mode that made the R1 sentinel unbindable).
      */
      await acquireTaskAdvisoryXactLock(tx, layer.projectId, id);
      if (internal.terminalFailureApply) {
        /*
        FNXC:TaskWedgeNotifications 2026-08-10-20:40:
        The apply fence is checked after the database advisory lock, inside the same transaction
        that writes the cleared task and its column move. `withTaskLock` serializes only one
        process; without this re-read, two engines can both carry a previously-valid token into
        separate move transactions and the loser can requeue a card after the winner has advanced it.
        */
        const row = await readTaskRowInTransaction(tx, id, { includeDeleted: true }, layer.projectId);
        if (!row) throw new TerminalFailureApplyRejected("no-budget");
        const live = store.rowToTask(store.pgRowToTaskRow(row));
        const budget = live.wedgeNotification?.autoRecovery;
        if (!budget) throw new TerminalFailureApplyRejected("no-budget");
        if (live.deletedAt != null) throw new TerminalFailureApplyRejected("deleted");
        if (live.status !== "failed") throw new TerminalFailureApplyRejected("not-failed");
        if (live.column !== internal.terminalFailureApply.expectedColumn || budget.applyToken !== internal.terminalFailureApply.applyToken) {
          throw new TerminalFailureApplyRejected("superseded");
        }
        const now = new Date().toISOString();
        const { applyToken: _token, lastApplyStartedAt: _started, ...remainingBudget } = budget;
        task = {
          ...live,
          ...internal.terminalFailureApply.patch,
          wedgeNotification: {
            ...live.wedgeNotification!,
            budgetRevision: (live.wedgeNotification!.budgetRevision ?? 0) + 1,
            autoRecovery: { ...remainingBudget, retryAppliedAt: now, lastBudgetWriteAt: now },
          },
        } as Task;
      }
      const capacityWorkflowId = await readTaskWorkflowSelectionInTransaction(tx, layer.projectId, id);
      const capacityPoolId = resolveCapacityPoolId(capacityWorkflowId);
      const capacityIr = await resolveWorkflowIrForSelectedWorkflowId(store, capacityWorkflowId);
      if (capacityIr && fromColumn !== toColumn) {
        const capacity = resolveColumnCapacity(capacityIr, toColumn, mergedSettingsForMove);
        if (capacity.hasCapacity && Number.isFinite(capacity.limit)) {
          // Shared pooled-budget enforcement (see enforcePooledColumnCapacity);
          // this path supplies the async in-transaction counter.
          await enforcePooledColumnCapacity({
            workflowIr: capacityIr,
            toColumn,
            taskId: id,
            capacity,
            countOccupants: (budgetColumn, countPending) =>
              store.countActiveInCapacitySlotAsync({
                tx,
                targetColumn: budgetColumn,
                workflowId: capacityPoolId,
                countPending,
                excludeTaskId: id,
              }),
          });
        }
      }

      // Upsert the task row (update column + all mutated fields).
      // FNXC:MultiProjectIsolation 2026-07-10: pass the bound projectId (stamped
      // on insert, preserved on update) so partitioning survives moves.
      await upsertTaskRowInTransaction(tx, task as unknown as Record<string, unknown>, context, layer.projectId);

      // U4 (flag-ON) parity with the SQLite branch below: write the
      // crash-safe transitionPending marker in the SAME transaction as the
      // column change (KTD-2). countActiveInCapacitySlotAsync already counts
      // pending markers in PG, so this is load-bearing for capacity too.
      {
        await writeTransitionPendingAsync(
          tx,
          id,
          makeTransitionPending(toColumn, ["default-workflow:postCommit"], Date.parse(movedAt) || Date.now()),
        );
      }

      // Audit: task:move
      await recordRunAuditEventWithinTransaction(tx, {
        taskId: id,
        agentId: internal.runContext?.agentId ?? "system",
        runId: internal.runContext?.runId ?? "unknown",
        domain: "database",
        mutationType: "task:move",
        target: id,
        metadata: {
          from: fromColumn,
          to: toColumn,
          moveSource,
        },
      });

      /*
      FNXC:PatchnodeLedger 2026-08-28-12:16:
      Each genuine entry into the completion lane snapshots this delivery under its columnMovedAt occurrence. The next move overwrites that evidence, so this insert commits in the move transaction and intentionally aborts the move on failure; the move's early return, not conflict handling, prevents duplicate capture.

      FNXC:PatchnodeLedger 2026-08-28-13:35:
      Completion capture requires the store's real project partition. An unbound writer must fail this transaction instead of manufacturing a legacy project id whose entry the project-scoped feed can never read.
      */
      if (toColumn === (moveLifecycle?.complete ?? "done") && fromColumn !== toColumn && !internal.terminalFailureApply) {
        await appendPatchnodeEntryInTransaction(
          tx,
          layer.projectId ?? "",
          buildPatchnodeEntryInput(task, "completed", task.columnMovedAt ?? movedAt),
        );
      }

      // Dequeue from merge queue on column exit (if leaving in-review).
      await dequeueMergeQueueOnColumnExitInTransaction(tx, id, fromColumn, toColumn, movedAt, moveReviewColumns);

      // FNXC:WorkflowReviewGates 2026-07-26-16:40: see isRecognizedInReviewEntry — a
      // graph-owned crossing into the review column is a legitimate arrival, not a violation.
      if (toColumn === (moveLifecycle?.review ?? "in-review") && !isRecognizedInReviewEntry(options, internal)) {
        await recordRunAuditEventWithinTransaction(tx, {
          taskId: id,
          agentId: internal.runContext?.agentId ?? "system",
          runId: internal.runContext?.runId ?? "unknown",
          domain: "database",
          mutationType: "task:handoff-invariant-violation",
          target: id,
          metadata: {
            taskId: id,
            fromColumn,
            callerStack: new Error().stack?.split("\n").slice(0, 8).join("\n"),
          },
        });
      }

      if (internal.fromHandoff) {
        const existingRows = await tx
          .select({ one: sql`1` })
          .from(schema.project.mergeQueue)
          .where(eq(schema.project.mergeQueue.taskId, id))
          .limit(1);
        alreadyEnqueued = existingRows.length > 0;
        await enqueueMergeQueueInTransaction(tx, id, { priority: task.priority, now: internal.now }, {
          agentId: internal.runContext?.agentId,
          runId: internal.runContext?.runId,
        }, moveReviewColumns);
        // FNXC:PostgresCutover 2026-06-27-10:25:
        // Thread the outer move transaction so cancel + upsert commit
        // atomically with the handoff (no orphaned merge-gate items on rollback).
        await store.createCompletionHandoffWorkflowWork(task, {
          runId: internal.runContext?.runId,
          now: internal.now,
          source: internal.evidence?.reason,
        }, tx);
        await recordRunAuditEventWithinTransaction(tx, {
          taskId: id,
          agentId: internal.runContext?.agentId ?? "system",
          runId: internal.runContext?.runId ?? "unknown",
          domain: "database",
          mutationType: "task:handoff",
          target: id,
          metadata: {
            taskId: id,
            fromColumn,
            ownerAgentId: internal.ownerAgentId ?? null,
            reason: internal.evidence?.reason,
            runId: internal.runContext?.runId,
            agentId: internal.runContext?.agentId,
            alreadyEnqueued,
          },
        });
        /*
        FNXC:HandoffFailureInjection 2026-07-15-12:00:
        The legacy sync SQLite enqueue arm was deleted 2026-07-31 (no callers).
        This test-only no-op seam runs after every VAL-DATA-013 sub-write
        (move, queue, workflow work, and handoff audit), so an injected throw
        proves this transaction rolls all of them back.
        */
        await store.__invokeHandoffMergeQueueFailureInjectorForTesting(id);
      }
    });
 // end of else (non-backend sync path)

    if (deletedAt) {
      if (internal.fromHandoff) {
        throw new HandoffInvariantViolationError(
          id,
          fromColumn,
          `Cannot hand off ${id} to in-review because the task is deleted`,
        );
      }
      store.throwSoftDeletedWriteBlocked(id, deletedAt, "moveTaskInternal", {
        agentId: internal.runContext?.agentId,
        runId: internal.runContext?.runId,
        timestamp: movedAt,
      });
    }

    await store.writeTaskJsonFile(dir, task);

    /*
    FNXC:MissionSymbolAdmission 2026-07-19-22:04:
    FN-8306 makes the central lifecycle transition the primary symbol-lock
    release authority. A durable lock belongs only to active implementation;
    handoff to review, cancellation/requeue, and terminal moves therefore release
    the task's declared symbols here. Active implementation is the workflow's
    countsTowardWip trait, not the legacy `in-progress` id: custom WIP columns
    must retain and renew locks between internal WIP transitions, then release
    them only when leaving WIP. PostgreSQL owns durable locks; SQLite has no
    symbol-lock table and remains on coarse scheduling behavior.
    */
    const lifecycleWorkflowIr = workflowIr ?? await resolveTaskWorkflowIrForMove(store, id);
    const fromIsImplementation = resolveTransitionColumnFacts(lifecycleWorkflowIr, fromColumn).flags.countsTowardWip === true;
    const toIsImplementation = resolveTransitionColumnFacts(lifecycleWorkflowIr, toColumn).flags.countsTowardWip === true;
    if (store.backendMode && fromIsImplementation && !toIsImplementation) {
      const symbols = resolveTaskSymbolsForTask(task);
      if (symbols.resolvable) {
        await store.releaseSymbolLocks(symbols.symbols, id);
      }
    }
    /*
    FNXC:WorkflowReviewGates 2026-07-26-15:05:
    Symmetric RE-ACQUIRE on the reverse crossing (!wip -> wip). FN-8306 made the lifecycle
    transition the release authority but wrote no counterpart, which was harmless while a task only
    ever left WIP at handoff/terminal. It stopped being harmless when the pre-merge review gates
    moved into `in-review`: the gate crossing releases the task's declared symbols, then the paired
    remediation node re-enters `in-progress` and edits the SAME files in the SAME live worktree with
    its fine-grained locks gone. The only two acquire sites (the scheduler's todo->in-progress
    dispatch and `claimDueWorkflowWorkItem`) are not on the graph's re-entry path, so nothing
    reclaimed them.

    Deliberately BEST-EFFORT: on conflict we log and proceed unlocked rather than rejecting the
    move. Rejecting would park the remediation behind a symbol another task now holds — turning a
    lock-granularity problem into the stranding failure this whole change set exists to avoid — and
    would need a new `TransitionRejectionCode`. Proceeding unlocked is exactly the pre-fix posture,
    so the contended case is no worse than today while the common (symbol free) case is repaired.
    Coarse protection still applies via `shouldHoldActiveFileScopeLease`, which keeps a live
    in-review task's file-scope lease held against scheduler todo-dispatch overlap.
    */
    if (store.backendMode && !fromIsImplementation && toIsImplementation) {
      const symbols = resolveTaskSymbolsForTask(task);
      if (symbols.resolvable && symbols.symbols.length > 0) {
        try {
          const reacquired = await store.acquireSymbolLocks(
            symbols.symbols,
            { ownerTaskId: id, missionId: task.missionId, agentId: "lifecycle-transition" },
            SYMBOL_LOCK_REACQUIRE_LEASE_MS,
          );
          if (!reacquired.acquired) {
            const conflict = reacquired.conflicts[0];
            storeLog.warn("symbol lock re-acquire on WIP re-entry lost to another holder", {
              phase: "moveTaskInternal:symbol-reacquire",
              taskId: id,
              fromColumn,
              toColumn,
              symbolKey: conflict?.symbolKey,
              ownerTaskId: conflict?.ownerTaskId,
            });
          }
        } catch (error) {
          // Never fail a lifecycle transition on lock bookkeeping.
          storeLog.warn("symbol lock re-acquire failed", {
            phase: "moveTaskInternal:symbol-reacquire",
            taskId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    /*
    FNXC:WorkflowTaskCancellation 2026-07-30-23:05 (PR #2705 review — greptile):
    HOLD, THEN INTAKE, THEN THE LEGACY ID. A workflow may declare an intake column and NO hold column
    (Coding (Ideas)'s `ideas` is the shipped example). `?? "todo"` then names a column that workflow
    does not declare, so this comparison never matches and the operator's hard cancel silently does
    nothing: the merge request stays live and the active work items are never cancelled, while the
    card moves anyway. Failing OPEN on a cancellation contract is the worst available outcome.

    Same precedence the replan target settled on in #2659, and for the same reason — the
    pre-implementation lane is hold when one exists and intake otherwise.
    */
    if (fromColumn === (moveLifecycle?.review ?? "in-review") && toColumn === (moveLifecycle?.hold ?? moveLifecycle?.intake ?? "todo") && moveSource === "user") {
      const handoffAccepted = await store.getCompletionHandoffAcceptedMarker(id);
      const mergeRequest = await store.getMergeRequestRecordAsync(id);
      if (handoffAccepted && mergeRequest && mergeRequest.state !== "succeeded" && mergeRequest.state !== "cancelled") {
        if (mergeRequest.state === "queued" || mergeRequest.state === "running" || mergeRequest.state === "retrying" || mergeRequest.state === "manual-required") {
          await store.transitionMergeRequestState(id, "cancelled", {
            attemptCount: mergeRequest.attemptCount,
            lastError: mergeRequest.lastError ?? "cancelled-by-user-hard-cancel",
          });
        }
      }
      void store.cancelActiveWorkflowWorkItemsForTask(id, {
        kinds: ["merge", "manual-hold"],
        now: movedAt,
        lastError: "cancelled-by-user-hard-cancel",
      });
      void store.clearCompletionHandoffAcceptedMarker(id);
    }
    if (toColumn === (moveLifecycle?.hold ?? moveLifecycle?.intake ?? "todo") && moveSource === "user" && (fromIsImplementation || fromColumn === (moveLifecycle?.review ?? "in-review"))) {
      // FNXC:WorkflowTaskCancellation 2026-07-21-11:51:
      // The task move is already committed here. Continuation cleanup is
      // best-effort so a storage fault cannot suppress task:moved or strand
      // transitionPending after a successful operator hard-cancel.
      try {
        await store.cancelActiveWorkflowWorkItemsForTask(id, {
          kinds: ["task"],
          now: movedAt,
          lastError: "cancelled-by-user-hard-cancel",
        });
      } catch (err) {
        storeLog.warn("Failed to cancel active task workflow continuation on user todo move (degraded)", {
          phase: "moveTaskInternal:cancel-task-continuation",
          taskId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (toColumn === (moveLifecycle?.complete ?? "done")) {
      // FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-16:00:
      // Backend mode: clearLinkedAgentTaskIds is a sync SQLite operation; skip
      // it in backend mode (the agent cleanup is best-effort and handled by
      // the async satellite stores when needed).
      
    }

    if (store.isWatching) store.taskCache.set(id, { ...task });

    // U4 (flag-ON): post-commit hook completion. The default-workflow field
    // effects already ran in-lock and committed; the post-commit phase here is
    // the fire-and-forget hook runner per KTD-2. It is idempotent and clears the
    // transitionPending marker once done. A crash before this point leaves the
    // marker for the recovery sweep to re-run (re-running is a no-op for the
    // default workflow's already-committed field effects).
    //
    // Residual C (U8): AFTER the built-in effects, invoke registered PLUGIN
    // onExit (from column) / onEnter (to column) trait hook impls, recording
    // per-hook completion in the marker's hooksRemaining. A throwing plugin hook
    // DEGRADES (audit) and never wedges the lock or strands the marker — the
    // marker is always cleared at the end regardless of hook failures.
    {
      // Plugin hooks are skipped on engine/recovery-sourced moves (KTD-9 — those
      // bypass trait effects) and on same-column no-ops.
      if (!bypassGuards && fromColumn !== toColumn && workflowIr) {
        try {
          await store.runPluginColumnTransitionHooks(id, workflowIr, fromColumn, toColumn);
        } catch (err) {
          // The runner itself swallows per-hook failures; this is a final guard
          // so a runner-level fault never strands the marker.
          storeLog.warn("Plugin column transition hook runner faulted (degraded)", {
            phase: "moveTaskInternal:plugin-hooks",
            taskId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      try {
                await clearTransitionPendingAsync(store.asyncLayer!.db, id);

      } catch {
        // Clearing is best-effort; the marker recovery sweep is the backstop.
      }
    }

    if (fromColumn !== toColumn) {
      /*
      FNXC:WorkflowEvents 2026-07-31-21:00 (fleet):
      Resolve the moving task's lanes HERE, once, and hand them to every listener. This is the emit
      path real moves take, and it is already async and already post-commit, so the resolution costs
      one IR read on a transition that has just done database work.

      Listeners could not do this for themselves: they run synchronously, the only sync resolver
      answers with the DEFAULT workflow in production, and awaiting inside the listener breaks the
      scheduler's synchronous snapshot invalidation. Fail-soft to undefined — "unknown", never
      "legacy" — so a listener keeps its own fallback rather than being handed a wrong answer.
      */
      const lanes = toTaskMoveLanes(await resolveWorkflowIrForTask(store, task.id).catch(() => undefined));
      /* FNXC:WorkflowEvents 2026-08-22-00:13: an unresolved payload is unknown; retain a warm real cache answer until its TTL expires. */
      if (lanes) store.laneCache.set(task.id, lanes);
      store.emit("task:moved", {
        task,
        from: fromColumn,
        to: toColumn,
        source: moveSource,
        lanes,
        requestedSource: options?.moveSource,
        lifecycleReason: options?.lifecycleReason,
        /*
        FNXC:LifecycleContainment 2026-08-28-04:47:
        FN-207 — the canonical emitter is the only place that holds the mover's graph provenance at
        emit time. Withholding it made every forward graph transition unattributable downstream, so
        the lifecycle log could only say "unattributed automatic move" for moves that were in fact
        fully provenanced. Forward the raw option; the listener decides how to render it.
        */
        workflowMoveSource: options?.workflowMoveSource,
      });
      /*
      FNXC:WorkflowEvents 2026-07-27-11:45 (U3 / R5, R6):
      THE post-commit emit point for lifecycle transitions. Its position is the
      contract, not a detail: everything above has committed (the row upsert,
      the capacity reservation, the in-transaction outbox writes), so an emitted
      `TaskTransitioned` implies a durable transition and a rolled-back
      transaction emits nothing at all — the transaction throws out of the
      `layer.transactionImmediate` block long before reaching here.

      It sits beside the existing `task:moved` store event rather than replacing
      it: `task:moved` carries the whole task object to in-process listeners
      (triage's column-wake handler), which the ids-only rule forbids on the
      bus. U7 migrates that listener onto the bus as a subscriber; until then
      the two coexist and neither is authoritative — a lifecycle decision reads
      the task row, never an event.

      Fire-and-forget by construction: `emit` never throws and never awaits
      subscribers, so no subscriber can slow, fail, or reorder a transition.
      */
      emitWorkflowLifecycleEvent({
        type: "TaskTransitioned",
        taskId: id,
        at: movedAt,
        from: fromColumn,
        to: toColumn,
        moveSource,
        ...(internal.runContext?.runId ? { runId: internal.runContext.runId } : {}),
        /*
        FNXC:WorkflowEvents 2026-07-27-15:10 (U3, PR #2467 review):
        OMIT rather than guess. An absent `workflowId` means "not resolved here";
        a subscriber that needs it reads the selection itself.

        FNXC:WorkflowColumns 2026-07-30-05:20 (PR #2655 review — greptile P2):
        The flag deletion nearly destroyed that signal. `effectiveWorkflowIdForMove`
        is `selection?.workflowId ?? DEFAULT_WORKFLOW_ID`, so emitting it
        unconditionally would stamp `builtin:coding` onto every task that has no
        explicit selection — reporting a FALLBACK as an authoritative choice, which
        is the same "wrong value baked into a wire field" this note was written to
        prevent, arrived at from the other direction.

        So the condition survives the flag: emit only when the selection genuinely
        resolved. `builtin:coding` still appears here for tasks that really select
        it, and is absent for tasks that merely default to it.
        */
        ...(workflowSelectionForMove?.workflowId ? { workflowId: workflowSelectionForMove.workflowId } : {}),
      });
    }
    if (toColumn === (moveLifecycle?.complete ?? "done")) {
      /* FNXC:WorkflowResolvedColumns 2026-07-31-04:20 (#2823 review): the sibling of the call above —
         same gate, same hardcoded argument, same inert result. Both move together. */
      await store.clearNearDuplicateReferencesToFailSoft(id, {
        column: toColumn,
        reason: "done",
      });
    }
    return task;
  }
