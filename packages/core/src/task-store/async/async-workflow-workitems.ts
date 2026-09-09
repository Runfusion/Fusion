/**
 * Async Drizzle workflow work-items / completion-handoff helpers (U14).
 *
 * FNXC:TaskStoreWorkflowWorkItems 2026-06-24-08:30:
 * Async equivalents of the sync SQLite workflow-work-item and completion-handoff
 * call sites in store.ts (`upsertWorkflowWorkItem`, `transitionWorkflowWorkItem`,
 * `getWorkflowWorkItem`, `listDueWorkflowWorkItems`, `recordCompletionHandoff`,
 * `getCompletionHandoffMarker`). These helpers target the PostgreSQL
 * `project.workflow_work_items` and `project.completion_handoff_markers` tables
 * via Drizzle.
 *
 * The workflow work-item upsert and transition both run inside a transaction
 * that also records a run-audit event, so the mutation and its audit row commit
 * or roll back together (the run-audit-event-within-transaction behavior).
 *
 * Terminal-state guard: a work item in a terminal state ('completed', 'failed',
 * 'cancelled') cannot be requeued or transitioned to a different state. This
 * mirrors the sync `isTerminalWorkflowWorkItemState` guard.
 *
 * Transition context (see library/taskstore-persistence-notes.md):
 *   `getDatabase()` still returns the sync `Database` until U15 flips it. The
 *   TaskStore facade keeps its sync workflow path (the gate depends on it).
 *   These helpers are the async target the migrating store and the PostgreSQL
 *   integration tests consume.
 */
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../../postgres/data-layer.js";
import { projectScopeFor, recordRunAuditEventWithinTransaction } from "../../postgres/data-layer.js";
import { ACTIVE_WORKFLOW_WORK_ITEM_STATES } from "../../types.js";
import type {
  WorkflowWorkItem,
  WorkflowWorkItemDueFilter,
  WorkflowWorkItemState,
  WorkflowWorkItemTransitionPatch,
  WorkflowWorkItemUpsertInput,
  WorkflowStepResult,
} from "../../types.js";
import type { WorkflowWorkItemRow } from "../row-types.js";
import { isPlanReviewSatisfied } from "../../planner/plan-approval.js";

/**
 * FNXC:TaskStoreWorkflowWorkItems 2026-06-24-08:35:
 * The set of terminal workflow-work-item states. A work item in a terminal
 * state cannot be requeued or transitioned to a different state (the sync
 * `isTerminalWorkflowWorkItemState` guard). This prevents a completed/failed
 * item from being silently resurrected.
 */
const TERMINAL_WORKFLOW_WORK_ITEM_STATES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

const ACTIVE_TASK_CONTINUATION_STATES: WorkflowWorkItemState[] = [...ACTIVE_WORKFLOW_WORK_ITEM_STATES];

/**
 * FNXC:WorkflowSerialization 2026-07-26-12:00:
 * FN-8592 serializes a task's workflow continuation decisions on the logical
 * `(project_id, task_id)` key. This MUST be the first lock in a transaction;
 * callers never hold two task locks. A repair-only lock was rejected because it
 * cannot serialize competing writers, while a partial unique index, in-process
 * mutex, and SERIALIZABLE isolation respectively change valid multi-item
 * behavior, fail across processes, or require retries. PostgreSQL releases the
 * advisory transaction lock on commit/rollback; no migration is required.
 */
export async function withTaskWorkflowSerialization<T>(
  tx: DbTransaction,
  projectId: string | undefined,
  taskId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${projectId ?? ""}), hashtext(${taskId}))`);
  return fn();
}

/**
 * Normalize a workflow-work-item state string. Unknown values default to
 * 'runnable' (the sync `normalizeWorkflowWorkItemState` behavior).
 */
function normalizeWorkflowWorkItemState(state: string | null | undefined): WorkflowWorkItemState {
  if (!state) return "runnable";
  return state as WorkflowWorkItemState;
}

function isTerminalWorkflowWorkItemState(state: string | null | undefined): boolean {
  return state != null && TERMINAL_WORKFLOW_WORK_ITEM_STATES.has(state);
}

/**
 * Convert a raw `workflow_work_items` row into the public `WorkflowWorkItem`
 * shape. Mirrors the sync `rowToWorkflowWorkItem`.
 */
export function rowToWorkflowWorkItem(row: WorkflowWorkItemRow): WorkflowWorkItem {
  return {
    id: row.id,
    runId: row.runId,
    taskId: row.taskId,
    nodeId: row.nodeId,
    kind: row.kind as WorkflowWorkItem["kind"],
    state: normalizeWorkflowWorkItemState(row.state),
    attempt: row.attempt,
    retryAfter: row.retryAfter,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    lastError: row.lastError,
    blockedReason: row.blockedReason,
    stableWorkflowRunId: row.stableWorkflowRunId,
    continuationSequence: row.continuationSequence,
    waitReason: row.waitReason === "planning" || row.waitReason === "capacity" ? row.waitReason : null,
    sourceColumn: row.sourceColumn,
    targetColumn: row.targetColumn,
    irHash: row.irHash,
    principalAgentId: row.principalAgentId,
    workflowRole: row.workflowRole as WorkflowWorkItem["workflowRole"],
    authorityKind: row.authorityKind as WorkflowWorkItem["authorityKind"],
    nodeInstanceId: row.nodeInstanceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Read a workflow work item by id. Returns `null` if not found.
 */
export async function getWorkflowWorkItem(
  db: AsyncDataLayer["db"] | DbTransaction,
  id: string,
  projectId?: string,
): Promise<WorkflowWorkItem | null> {
  const rows = await db
    .select()
    .from(schema.project.workflowWorkItems)
    .where(and(
      eq(schema.project.workflowWorkItems.id, id),
      projectScopeFor(schema.project.workflowWorkItems.projectId, projectId),
    ))
    .limit(1);
  const row = rows[0] as WorkflowWorkItemRow | undefined;
  return row ? rowToWorkflowWorkItem(row) : null;
}

/**
 * FNXC:TaskStoreWorkflowWorkItems 2026-06-24-08:40:
 * Upsert a workflow work item INSIDE a transaction, with a run-audit event
 * that commits/rolls back atomically (the run-audit-event-within-transaction
 * behavior). This is the async equivalent of `upsertWorkflowWorkItem`.
 *
 * The upsert is keyed on the composite unique constraint
 * (runId, taskId, nodeId, kind). A terminal-state work item cannot be
 * requeued to a different state (the terminal guard throws).
 *
 * @param layer The async data layer (the upsert runs in its own transaction).
 * @param input The work-item upsert input.
 * @returns The upserted work item.
 */
export async function upsertWorkflowWorkItem(
  layer: AsyncDataLayer,
  input: WorkflowWorkItemUpsertInput,
  existingTx?: DbTransaction,
): Promise<WorkflowWorkItem> {
  // FNXC:PostgresCutover 2026-06-27-10:15:
  // Accept an optional existing transaction so callers can thread an outer tx
  // through (e.g. handoff-to-review in moves.ts). If no tx is provided, a new
  // transactionImmediate is opened (preserving existing behavior).
  const doWork = async (tx: DbTransaction): Promise<WorkflowWorkItem> => {
    // Read the existing row (if any) keyed on the composite unique constraint.
    const existingRows = await tx
      .select()
      .from(schema.project.workflowWorkItems)
      .where(
        and(
          projectScopeFor(schema.project.workflowWorkItems.projectId, layer.projectId),
          eq(schema.project.workflowWorkItems.runId, input.runId),
          eq(schema.project.workflowWorkItems.taskId, input.taskId),
          eq(schema.project.workflowWorkItems.nodeId, input.nodeId),
          eq(schema.project.workflowWorkItems.kind, input.kind),
        ),
      )
      .limit(1);
    const existing = existingRows[0] as WorkflowWorkItemRow | undefined;

    const now = input.now ?? new Date().toISOString();
    const existingState = existing ? normalizeWorkflowWorkItemState(existing.state) : null;
    const state = input.state ?? existingState ?? "runnable";

    // Terminal-state guard: a terminal item cannot be requeued.
    if (existingState && isTerminalWorkflowWorkItemState(existingState) && existingState !== state) {
      throw new Error(
        `Workflow work item ${existing?.id ?? input.id ?? input.nodeId} is terminal (${existingState}) and cannot be requeued as ${state}`,
      );
    }

    const id = existing?.id ?? input.id ?? randomUUID();

    await tx
      .insert(schema.project.workflowWorkItems)
      .values({
        id,
        runId: input.runId,
        taskId: input.taskId,
        nodeId: input.nodeId,
        kind: input.kind,
        state,
        attempt: input.attempt ?? existing?.attempt ?? 0,
        retryAfter: input.retryAfter === undefined ? existing?.retryAfter ?? null : input.retryAfter,
        leaseOwner: input.leaseOwner === undefined ? existing?.leaseOwner ?? null : input.leaseOwner,
        leaseExpiresAt:
          input.leaseExpiresAt === undefined ? existing?.leaseExpiresAt ?? null : input.leaseExpiresAt,
        lastError: input.lastError === undefined ? existing?.lastError ?? null : input.lastError,
        blockedReason:
          input.blockedReason === undefined ? existing?.blockedReason ?? null : input.blockedReason,
        stableWorkflowRunId: input.stableWorkflowRunId === undefined ? existing?.stableWorkflowRunId ?? null : input.stableWorkflowRunId,
        continuationSequence: input.continuationSequence === undefined ? existing?.continuationSequence ?? null : input.continuationSequence,
        waitReason: input.waitReason === undefined ? existing?.waitReason ?? null : input.waitReason,
        sourceColumn: input.sourceColumn === undefined ? existing?.sourceColumn ?? null : input.sourceColumn,
        targetColumn: input.targetColumn === undefined ? existing?.targetColumn ?? null : input.targetColumn,
        irHash: input.irHash === undefined ? existing?.irHash ?? null : input.irHash,
        // FNXC:WorkflowAgentRouting 2026-08-07-03:25:
        // Preserve a claimed principal on resume; a new route can only be
        // fenced by explicitly providing these fields before session creation.
        principalAgentId: input.principalAgentId === undefined ? existing?.principalAgentId ?? null : input.principalAgentId,
        workflowRole: input.workflowRole === undefined ? existing?.workflowRole ?? null : input.workflowRole,
        authorityKind: input.authorityKind === undefined ? existing?.authorityKind ?? null : input.authorityKind,
        nodeInstanceId: input.nodeInstanceId === undefined ? existing?.nodeInstanceId ?? null : input.nodeInstanceId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.project.workflowWorkItems.projectId,
          schema.project.workflowWorkItems.runId,
          schema.project.workflowWorkItems.taskId,
          schema.project.workflowWorkItems.nodeId,
          schema.project.workflowWorkItems.kind,
        ],
        set: {
          state,
          attempt: input.attempt ?? existing?.attempt ?? 0,
          retryAfter: input.retryAfter === undefined ? existing?.retryAfter ?? null : input.retryAfter,
          leaseOwner:
            input.leaseOwner === undefined ? existing?.leaseOwner ?? null : input.leaseOwner,
          leaseExpiresAt:
            input.leaseExpiresAt === undefined ? existing?.leaseExpiresAt ?? null : input.leaseExpiresAt,
          lastError: input.lastError === undefined ? existing?.lastError ?? null : input.lastError,
          blockedReason:
            input.blockedReason === undefined ? existing?.blockedReason ?? null : input.blockedReason,
          stableWorkflowRunId: input.stableWorkflowRunId === undefined ? existing?.stableWorkflowRunId ?? null : input.stableWorkflowRunId,
          continuationSequence: input.continuationSequence === undefined ? existing?.continuationSequence ?? null : input.continuationSequence,
          waitReason: input.waitReason === undefined ? existing?.waitReason ?? null : input.waitReason,
          sourceColumn: input.sourceColumn === undefined ? existing?.sourceColumn ?? null : input.sourceColumn,
          targetColumn: input.targetColumn === undefined ? existing?.targetColumn ?? null : input.targetColumn,
          irHash: input.irHash === undefined ? existing?.irHash ?? null : input.irHash,
          principalAgentId: input.principalAgentId === undefined ? existing?.principalAgentId ?? null : input.principalAgentId,
          workflowRole: input.workflowRole === undefined ? existing?.workflowRole ?? null : input.workflowRole,
          authorityKind: input.authorityKind === undefined ? existing?.authorityKind ?? null : input.authorityKind,
          nodeInstanceId: input.nodeInstanceId === undefined ? existing?.nodeInstanceId ?? null : input.nodeInstanceId,
          updatedAt: now,
        },
      });

    const row = await getWorkflowWorkItem(tx, id, layer.projectId);
    if (!row) throw new Error(`Failed to upsert workflow work item ${id}`);

    // Run-audit event inside the same transaction (commits/rolls back together).
    await recordRunAuditEventWithinTransaction(tx, {
      taskId: row.taskId,
      agentId: "system",
      runId: row.runId,
      domain: "database",
      mutationType: "workflowWorkItem:upsert",
      target: row.id,
      metadata: {
        id: row.id,
        nodeId: row.nodeId,
        kind: row.kind,
        state: row.state,
        attempt: row.attempt,
      },
    });

    return row;
  };
  // FNXC:WorkflowSerialization 2026-07-26-14:15:
  // FN-8592 requires every possible ACTIVE continuation writer to take the
  // shared task lock, including generic upserts that default to `runnable`.
  // The lock wraps the read and write in this transaction so a conditional
  // stranded-card seed cannot observe an idle graph while this upsert lands.
  const serialized = (tx: DbTransaction) => withTaskWorkflowSerialization(
    tx,
    layer.projectId,
    input.taskId,
    () => doWork(tx),
  );
  return existingTx ? serialized(existingTx) : layer.transactionImmediate(serialized);
}

/** Atomically retire the current task continuation and persist its successor. */
export async function replaceActiveTaskWorkflowContinuation(
  layer: AsyncDataLayer,
  input: WorkflowWorkItemUpsertInput & { kind: "task" },
): Promise<WorkflowWorkItem> {
  return layer.transactionImmediate(async (tx) => withTaskWorkflowSerialization(tx, layer.projectId, input.taskId, async () => {
    const activeRows = await tx.select().from(schema.project.workflowWorkItems).where(and(
      eq(schema.project.workflowWorkItems.taskId, input.taskId),
      eq(schema.project.workflowWorkItems.kind, "task"),
      inArray(schema.project.workflowWorkItems.state, ACTIVE_TASK_CONTINUATION_STATES),
    ));
    for (const row of activeRows as WorkflowWorkItemRow[]) {
      if (row.runId === input.runId && row.nodeId === input.nodeId && row.kind === input.kind) continue;
      await transitionWorkflowWorkItem(layer, row.id, "succeeded", { leaseOwner: null, leaseExpiresAt: null, lastError: null }, tx);
    }
    /*
    FNXC:WorkflowAgentRouting 2026-08-08-02:10:
    A NEW ATTEMPT AT THE SAME NODE IS A NEW WORK ITEM.

    The upsert keys on (project_id, run_id, task_id, node_id, kind), and a node's run id is
    DERIVED, not per-attempt (`<taskId>:<workflowId>:<nodeInstanceId>`), so every attempt at a
    given node instance lands on the same row. `upsertWorkflowWorkItem` then refuses, by design,
    to requeue a terminal row — and a fence row is terminalized at the END OF EVERY RUN. So the
    second visit to any node threw `is terminal (succeeded|failed|cancelled) and cannot be
    requeued as running`, which fails the fence closed and parks the card. Retries, rework
    (`maxReworkCycles`), and operator re-dispatch all make a second visit ordinary, so this hit
    every task that did not finish a node on its first pass.

    The guard is right; the identity was wrong. Replace is the sanctioned single writer for a
    task continuation and its whole contract is "retire the predecessor, install the successor",
    so it drops a TERMINAL row occupying the target key and inserts fresh. Bounded and
    non-destructive in practice: at most one row per (task, node instance), the predecessor is
    finished work, and its transitions are already recorded in run-audit. Only the exact target
    key is dropped — terminal rows for other nodes are untouched, and `upsertWorkflowWorkItem`
    keeps refusing to resurrect a terminal row for every other caller.
    */
    const collidingRows = await tx.select().from(schema.project.workflowWorkItems).where(and(
      projectScopeFor(schema.project.workflowWorkItems.projectId, layer.projectId),
      eq(schema.project.workflowWorkItems.runId, input.runId),
      eq(schema.project.workflowWorkItems.taskId, input.taskId),
      eq(schema.project.workflowWorkItems.nodeId, input.nodeId),
      eq(schema.project.workflowWorkItems.kind, input.kind),
    )).limit(1);
    const colliding = collidingRows[0] as WorkflowWorkItemRow | undefined;
    const collidingState = colliding ? normalizeWorkflowWorkItemState(colliding.state) : null;
    const targetState = input.state ?? collidingState ?? "runnable";
    if (colliding && collidingState && isTerminalWorkflowWorkItemState(collidingState) && collidingState !== targetState) {
      await tx.delete(schema.project.workflowWorkItems).where(and(
        projectScopeFor(schema.project.workflowWorkItems.projectId, layer.projectId),
        eq(schema.project.workflowWorkItems.id, colliding.id),
      ));
    }
    return upsertWorkflowWorkItem(layer, input, tx);
  }));
}

/**
 * FNXC:StrandedHoldContinuation 2026-07-26-12:00:
 * FN-8592 repairs only an idle graph: this operation checks every active
 * work-item kind and passed plan-review result after taking the shared
 * advisory lock. A false result is a race loss for an already-qualified caller
 * and mutates nothing.
 *
 * FNXC:PlanningHandoffAtomicity 2026-08-13-04:20:
 * No longer strictly insert-only: on the SUCCESS path a caller-named
 * `retirePredecessorId` row is transitioned to succeeded in the same
 * transaction as the successor insert (see the block comment below). A bailed
 * seed still mutates nothing — the checks run before the retirement.
 */
/*
FNXC:WorkspaceReviewReroute 2026-08-21-19:52:
Workspace merge evidence can become stale after a completed review. The recovery owner must claim
an idle graph atomically, rather than replacing a live continuation or relying on a later sweep.
*/
export async function seedWorkspaceCodeReviewContinuationIfIdle(
  layer: AsyncDataLayer,
  input: WorkflowWorkItemUpsertInput & { kind: "task" },
): Promise<{ seeded: boolean; reason?: "active-continuation"; workItemId?: string }> {
  return layer.transactionImmediate(async (tx) => withTaskWorkflowSerialization(tx, layer.projectId, input.taskId, async () => {
    const active = await tx.select({ id: schema.project.workflowWorkItems.id }).from(schema.project.workflowWorkItems).where(and(
      projectScopeFor(schema.project.workflowWorkItems.projectId, layer.projectId),
      eq(schema.project.workflowWorkItems.taskId, input.taskId),
      inArray(schema.project.workflowWorkItems.state, [...ACTIVE_WORKFLOW_WORK_ITEM_STATES]),
    ));
    if (active.length > 0) return { seeded: false, reason: "active-continuation" as const };
    const item = await upsertWorkflowWorkItem(layer, input, tx);
    return { seeded: true, workItemId: item.id };
  }));
}

export async function seedStrandedPlanReviewContinuation(
  layer: AsyncDataLayer,
  input: WorkflowWorkItemUpsertInput & { kind: "task" },
  options: { retirePredecessorId?: string } = {},
): Promise<{ seeded: boolean; reason?: "active-continuation" | "plan-review-passed"; workItemId?: string }> {
  return layer.transactionImmediate(async (tx) => withTaskWorkflowSerialization(tx, layer.projectId, input.taskId, async () => {
    /*
    FNXC:PlanningHandoffAtomicity 2026-08-13-03:49:
    The normal planning handoff must retire its own predecessor continuation and install the
    successor in ONE transaction under the task lock. Before this, triage announced specification
    completion BEFORE its finally block marked the plan work item terminal, so the seeder's
    all-kinds idle check saw the caller's own still-running plan row, bailed with
    "active-continuation", and the result was silently dropped — the card stranded in the hold
    column until FN-8592 self-healing re-seeded it ~10 minutes later (529 occurrences in 18 days).
    `retirePredecessorId` names the finished planning row: the idle check excludes it, and if the
    seed qualifies the row is transitioned to succeeded in the same transaction as the successor
    insert, so BOTH orderings of "announce completion" vs "finally marks terminal" converge on the
    successor being installed. A terminal or missing predecessor is not an error — it means the
    caller's finally won the race, which is fine.

    FNXC:PlanningHandoffAtomicity 2026-08-13-04:20:
    The retirement runs AFTER the bail checks, immediately before the successor insert (review
    finding: retiring first meant a bailed seed still committed the predecessor's transition,
    contradicting the "a false result mutates nothing" contract). Only the named predecessor is
    ever retired; any OTHER active row still blocks the seed and leaves the predecessor untouched.
    */
    // FNXC:StrandedHoldContinuation 2026-07-27-01:15:
    // FN-8592's all-kinds idle check is project-partitioned as well as task
    // partitioned. Task ids can collide across embedded-PG projects, so a
    // different project's continuation or review result must not block repair.
    const active = await tx.select({ id: schema.project.workflowWorkItems.id }).from(schema.project.workflowWorkItems).where(and(
      projectScopeFor(schema.project.workflowWorkItems.projectId, layer.projectId),
      eq(schema.project.workflowWorkItems.taskId, input.taskId),
      inArray(schema.project.workflowWorkItems.state, [...ACTIVE_WORKFLOW_WORK_ITEM_STATES]),
    ));
    const blocking = options.retirePredecessorId
      ? active.filter((row) => row.id !== options.retirePredecessorId)
      : active;
    if (blocking.length > 0) return { seeded: false, reason: "active-continuation" as const };
    const taskRows = await tx.select({ workflowStepResults: schema.project.tasks.workflowStepResults }).from(schema.project.tasks).where(and(
      projectScopeFor(schema.project.tasks.projectId, layer.projectId),
      eq(schema.project.tasks.id, input.taskId),
    )).limit(1);
    const results = taskRows[0]?.workflowStepResults as WorkflowStepResult[] | null | undefined;
    if (results?.some(isPlanReviewSatisfied)) return { seeded: false, reason: "plan-review-passed" as const };
    if (options.retirePredecessorId) {
      const predRows = await tx.select().from(schema.project.workflowWorkItems).where(and(
        projectScopeFor(schema.project.workflowWorkItems.projectId, layer.projectId),
        eq(schema.project.workflowWorkItems.id, options.retirePredecessorId),
        eq(schema.project.workflowWorkItems.taskId, input.taskId),
      )).limit(1);
      const pred = predRows[0] as WorkflowWorkItemRow | undefined;
      if (pred && !isTerminalWorkflowWorkItemState(normalizeWorkflowWorkItemState(pred.state))) {
        await transitionWorkflowWorkItem(layer, pred.id, "succeeded", { leaseOwner: null, leaseExpiresAt: null, lastError: null }, tx);
      }
    }
    const item = await upsertWorkflowWorkItem(layer, input, tx);
    return { seeded: true, workItemId: item.id };
  }));
}

/**
 * FNXC:TaskStoreWorkflowWorkItems 2026-06-24-08:45:
 * Transition a workflow work item to a new state INSIDE a transaction, with a
 * run-audit event that commits/rolls back atomically. This is the async
 * equivalent of `transitionWorkflowWorkItem`.
 *
 * The terminal-state guard prevents transitioning a terminal item to a
 * different state.
 *
 * @param layer The async data layer (the transition runs in its own transaction).
 * @param id The work-item id.
 * @param state The target state.
 * @param patch Optional field patches (attempt, retryAfter, lease fields, etc.).
 * @returns The transitioned work item.
 */
export async function transitionWorkflowWorkItem(
  layer: AsyncDataLayer,
  id: string,
  state: WorkflowWorkItemState,
  patch: WorkflowWorkItemTransitionPatch = {},
  existingTx?: DbTransaction,
): Promise<WorkflowWorkItem> {
  // FNXC:PostgresCutover 2026-06-27-10:15:
  // Accept an optional existing transaction for outer-tx threading.
  const doWork = async (tx: DbTransaction): Promise<WorkflowWorkItem> => {
    const now = patch.now ?? new Date().toISOString();
    const existingRows = await tx
      .select()
      .from(schema.project.workflowWorkItems)
      .where(and(
        eq(schema.project.workflowWorkItems.id, id),
        projectScopeFor(schema.project.workflowWorkItems.projectId, layer.projectId),
      ))
      .limit(1);
    const existing = existingRows[0] as WorkflowWorkItemRow | undefined;
    if (!existing) throw new Error(`Workflow work item ${id} not found`);

    const fromState = normalizeWorkflowWorkItemState(existing.state);
    /*
    FNXC:WorkflowWorkItemCas 2026-07-27-22:10 (U7, PR #2491 review — greptile P1):
    Compare-and-set no-op. The state is re-read inside this transaction, so an
    `expectedState` mismatch means another writer moved the row after the caller's
    snapshot. Return it untouched rather than overwriting: a blind write here would
    reset a `running` claim to `runnable` and let the item be claimed twice.
    Not an error — losing this race is an ordinary outcome for a snapshot-driven
    caller, and the correct response is to leave the newer state alone.
    */
    if (patch.expectedState !== undefined && fromState !== patch.expectedState) {
      return rowToWorkflowWorkItem(existing);
    }
    /*
    FNXC:WorkflowWorkItemLeaseCas 2026-09-06-01:28:
    Re-reading the owner in this transaction closes the same-state handoff gap: a stale planner may
    observe `running` after another worker has reclaimed the row, but it no longer renews or
    terminalizes that worker's lease. A mismatch is the same ordinary no-op as a state CAS loss.

    FNXC:WorkflowWorkItemLeaseCas 2026-09-06-01:52:
    The preliminary read is diagnostic only: under PostgreSQL READ COMMITTED, another process can
    replace the lease owner after that SELECT and before this UPDATE. Repeat every requested CAS in
    the UPDATE predicate itself (including SQL IS NULL owner semantics), and treat zero returned
    rows as an ordinary lost race. This prevents an old planner renewal from reclaiming a successor's
    same-state lease even when the competing writer does not participate in our advisory lock.
    */
    if (patch.expectedLeaseOwner !== undefined && existing.leaseOwner !== patch.expectedLeaseOwner) {
      return rowToWorkflowWorkItem(existing);
    }
    if (isTerminalWorkflowWorkItemState(fromState) && fromState !== state) {
      throw new Error(
        `Workflow work item ${id} is terminal (${fromState}) and cannot transition to ${state}`,
      );
    }

    const updateConditions = [
      eq(schema.project.workflowWorkItems.id, id),
      projectScopeFor(schema.project.workflowWorkItems.projectId, layer.projectId),
    ];
    if (patch.expectedState !== undefined) {
      updateConditions.push(eq(schema.project.workflowWorkItems.state, patch.expectedState));
    }
    if (patch.expectedLeaseOwner !== undefined) {
      updateConditions.push(patch.expectedLeaseOwner === null
        ? isNull(schema.project.workflowWorkItems.leaseOwner)
        : eq(schema.project.workflowWorkItems.leaseOwner, patch.expectedLeaseOwner));
    }

    const updatedRows = await tx
      .update(schema.project.workflowWorkItems)
      .set({
        state,
        attempt: patch.attempt ?? existing.attempt,
        retryAfter: patch.retryAfter === undefined ? existing.retryAfter : patch.retryAfter,
        leaseOwner: patch.leaseOwner === undefined ? existing.leaseOwner : patch.leaseOwner,
        leaseExpiresAt:
          patch.leaseExpiresAt === undefined ? existing.leaseExpiresAt : patch.leaseExpiresAt,
        lastError: patch.lastError === undefined ? existing.lastError : patch.lastError,
        blockedReason: patch.blockedReason === undefined ? existing.blockedReason : patch.blockedReason,
        principalAgentId: patch.principalAgentId === undefined ? existing.principalAgentId : patch.principalAgentId,
        workflowRole: patch.workflowRole === undefined ? existing.workflowRole : patch.workflowRole,
        authorityKind: patch.authorityKind === undefined ? existing.authorityKind : patch.authorityKind,
        nodeInstanceId: patch.nodeInstanceId === undefined ? existing.nodeInstanceId : patch.nodeInstanceId,
        updatedAt: now,
      })
      .where(and(...updateConditions))
      .returning();

    let updated = updatedRows[0] as WorkflowWorkItemRow | undefined;
    if (!updated) {
      const currentRows = await tx
        .select()
        .from(schema.project.workflowWorkItems)
        .where(and(
          eq(schema.project.workflowWorkItems.id, id),
          projectScopeFor(schema.project.workflowWorkItems.projectId, layer.projectId),
        ))
        .limit(1);
      updated = currentRows[0] as WorkflowWorkItemRow | undefined;
      if (!updated) throw new Error(`Workflow work item ${id} disappeared`);
      return rowToWorkflowWorkItem(updated);
    }

    // Run-audit event inside the same transaction.
    await recordRunAuditEventWithinTransaction(tx, {
      taskId: updated.taskId,
      agentId: "system",
      runId: updated.runId,
      domain: "database",
      mutationType: "workflowWorkItem:transition",
      target: updated.id,
      metadata: {
        id: updated.id,
        fromState,
        toState: state,
        attempt: updated.attempt,
      },
    });

    return rowToWorkflowWorkItem(updated);
  };
  // A transition can move an item from a non-active state to an ACTIVE state;
  // resolve its owner before taking the shared lock so it participates in the
  // same FN-8592 serialization protocol as inserts.
  const serialized = async (tx: DbTransaction): Promise<WorkflowWorkItem> => {
    const owner = await tx.select({ taskId: schema.project.workflowWorkItems.taskId })
      .from(schema.project.workflowWorkItems)
      .where(and(
        eq(schema.project.workflowWorkItems.id, id),
        projectScopeFor(schema.project.workflowWorkItems.projectId, layer.projectId),
      ))
      .limit(1);
    const taskId = owner[0]?.taskId;
    if (!taskId) return doWork(tx);
    return withTaskWorkflowSerialization(tx, layer.projectId, taskId, () => doWork(tx));
  };
  return existingTx ? serialized(existingTx) : layer.transactionImmediate(serialized);
}

/**
 * FNXC:TaskStoreWorkflowWorkItems 2026-06-24-08:50:
 * List due workflow work items: items whose retryAfter has passed (or is null)
 * and whose lease has expired (or is null), optionally filtered by kinds and
 * states. This is the scheduler's due-poll query. Ordered by createdAt ASC
 * (FIFO within the due set).
 */
export async function listDueWorkflowWorkItems(
  db: AsyncDataLayer["db"] | DbTransaction,
  filter: WorkflowWorkItemDueFilter = {},
): Promise<WorkflowWorkItem[]> {
  const now = filter.now ?? new Date().toISOString();
  const conditions = [
    projectScopeFor(schema.project.workflowWorkItems.projectId, filter.projectId),
    // retryAfter is null OR retryAfter <= now.
    or(
      sql`${schema.project.workflowWorkItems.retryAfter} IS NULL`,
      lte(schema.project.workflowWorkItems.retryAfter, now),
    ),
    // leaseExpiresAt is null OR leaseExpiresAt <= now.
    or(
      sql`${schema.project.workflowWorkItems.leaseExpiresAt} IS NULL`,
      lte(schema.project.workflowWorkItems.leaseExpiresAt, now),
    ),
  ];

  if (filter.kinds && filter.kinds.length > 0) {
    conditions.push(inArray(schema.project.workflowWorkItems.kind, filter.kinds));
  }
  if (filter.states && filter.states.length > 0) {
    conditions.push(inArray(schema.project.workflowWorkItems.state, filter.states));
  }

  const query = db
    .select()
    .from(schema.project.workflowWorkItems)
    .where(and(...conditions))
    .orderBy(asc(schema.project.workflowWorkItems.createdAt));

  const rows = filter.limit
    ? await query.limit(filter.limit)
    : await query;
  return (rows as WorkflowWorkItemRow[]).map((row) => rowToWorkflowWorkItem(row));
}

// ── Completion handoff markers ───────────────────────────────────────

/**
 * FNXC:TaskStoreWorkflowWorkItems 2026-06-24-08:55:
 * Record a completion-handoff marker for a task. This is the async equivalent
 * of `recordCompletionHandoff`. The marker indicates that a task's completion
 * was accepted by a downstream consumer (the engine handoff path). The
 * `taskId` is the primary key, so a re-record is an idempotent upsert.
 *
 * @param db The Drizzle instance.
 * @param taskId The task whose completion was handed off.
 * @param source The handoff source (e.g. 'engine', 'manual').
 * @param acceptedAt The acceptance timestamp (defaults to now).
 */
export async function recordCompletionHandoff(
  db: AsyncDataLayer["db"] | DbTransaction,
  taskId: string,
  source: string,
  acceptedAt?: string,
): Promise<void> {
  const now = acceptedAt ?? new Date().toISOString();
  await db
    .insert(schema.project.completionHandoffMarkers)
    .values({
      taskId,
      acceptedAt: now,
      source,
    })
    .onConflictDoUpdate({
      target: [
        schema.project.completionHandoffMarkers.projectId,
        schema.project.completionHandoffMarkers.taskId,
      ],
      set: {
        acceptedAt: now,
        source,
      },
    });
}

/**
 * Read the completion-handoff marker for a task. Returns `null` if none.
 */
export async function getCompletionHandoffMarker(
  db: AsyncDataLayer["db"] | DbTransaction,
  taskId: string,
): Promise<{ taskId: string; acceptedAt: string; source: string } | null> {
  const rows = await db
    .select()
    .from(schema.project.completionHandoffMarkers)
    .where(eq(schema.project.completionHandoffMarkers.taskId, taskId))
    .limit(1);
  const row = rows[0];
  return row
    ? { taskId: row.taskId, acceptedAt: row.acceptedAt, source: row.source }
    : null;
}

/**
 * Delete the completion-handoff marker for a task (used on un-archive / re-open).
 */
export async function clearCompletionHandoffMarker(
  db: AsyncDataLayer["db"] | DbTransaction,
  taskId: string,
): Promise<void> {
  await db
    .delete(schema.project.completionHandoffMarkers)
    .where(eq(schema.project.completionHandoffMarkers.taskId, taskId));
}
