/**
 * Async Drizzle merge-queue / merge-coordination helpers (U13).
 *
 * FNXC:TaskStoreMergeCoordination 2026-06-24-05:00:
 * Async equivalents of the sync SQLite merge-queue call sites in store.ts
 * (`enqueueMergeQueue`, `acquireMergeQueueLease`, `releaseMergeQueueLease`,
 * `recoverExpiredMergeQueueLeases`, `peekMergeQueue`, `cleanupStaleMergeQueueRows`).
 * These helpers target the PostgreSQL `project.merge_queue` table via Drizzle and
 * preserve the two load-bearing merge-coordination invariants:
 *
 *   VAL-DATA-013 — Handoff-to-review mergeQueue transactional invariant. The
 *     column move (`UPDATE tasks SET column = 'in-review'`), the `merge_queue`
 *     insert, and the handoff audit fan-out run in ONE transaction; observers
 *     never see `column = 'in-review'` without the matching queue row. The
 *     `enqueueMergeQueueInTransaction(tx, ...)` helper is the building block
 *     the handoff path composes inside its `transactionImmediate(async (tx) => ...)`.
 *
 *   VAL-DATA-014 — Merge-queue lease semantics. Leases are acquired
 *     priority-first (urgent > high > normal > low), FIFO within priority
 *     (earliest `enqueued_at` first). Expired leases recover WITHOUT
 *     incrementing `attempt_count` (the attempt counter only advances on an
 *     explicit failure release, not on a silent lease expiry).
 *
 * Priority ordering note:
 *   The SQLite path encoded the priority ordering in a raw `CASE` expression
 *   inside the UPDATE...RETURNING lease-acquire query. The async path mirrors
 *   the exact same ordering by computing a priority rank in SQL and ordering
 *   by (rank ASC, enqueued_at ASC). The rank mapping is identical to the sync
 *   CASE: urgent=0, high=1, normal=2, low=3, else=4.
 *
 * Transition context (see library/taskstore-persistence-notes.md):
 *   `getDatabase()` still returns the sync `Database` until U15 flips it. The
 *   TaskStore facade keeps its sync merge-queue path (the gate depends on it).
 *   These helpers are the async target the migrating store and the PostgreSQL
 *   integration tests consume. They program against the stable `AsyncDataLayer`
 *   interface (U4), not the underlying driver.
 */
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import { recordRunAuditEventWithinTransaction, taskProjectScope } from "../postgres/data-layer.js";
import { normalizeTaskPriority } from "../task-priority.js";
import type {
  MergeQueueAcquireOptions,
  MergeQueueEnqueueOptions,
  MergeQueueEntry,
  MergeQueueReleaseOutcome,
  TaskPriority,
} from "../types.js";
import type { MergeQueueRow } from "./row-types.js";

/**
 * FNXC:TaskStoreMergeCoordination 2026-06-24-05:05:
 * The priority-rank SQL fragment used to order the merge queue. This encodes
 * the priority-first ordering (VAL-DATA-014): urgent leases out before high,
 * high before normal, normal before low, and any unrecognized priority sorts
 * last. The mapping is identical to the sync `CASE mq.priority WHEN 'urgent' ...`
 * expression in store.ts so lease-acquisition order is byte-for-byte equivalent.
 */
export const MERGE_QUEUE_PRIORITY_RANK = sql<number>`
  CASE ${schema.project.mergeQueue.priority}
    WHEN 'urgent' THEN 0
    WHEN 'high'   THEN 1
    WHEN 'normal' THEN 2
    WHEN 'low'    THEN 3
    ELSE 4
  END
`;

/**
 * FNXC:TaskStoreMergeCoordination 2026-06-24-05:10:
 * Convert a raw `merge_queue` row into the public `MergeQueueEntry` shape.
 * The `priority` column is free-text in the schema; the public contract normalizes
 * it to the bounded `TaskPriority` union so callers never see an out-of-contract
 * value. This mirrors the sync `rowToMergeQueueEntry` exactly.
 */
export function rowToMergeQueueEntry(row: MergeQueueRow): MergeQueueEntry {
  return {
    taskId: row.taskId,
    enqueuedAt: row.enqueuedAt,
    priority: normalizeTaskPriority(row.priority) as TaskPriority,
    leasedBy: row.leasedBy,
    leasedAt: row.leasedAt,
    leaseExpiresAt: row.leaseExpiresAt,
    attemptCount: row.attemptCount,
    lastError: row.lastError,
  };
}

/** Predicate: a queue row is leaseable right now (no active holder, or an expired lease). */
function leaseAvailable(now: string) {
  return or(
    isNull(schema.project.mergeQueue.leasedBy),
    lte(schema.project.mergeQueue.leaseExpiresAt, now),
  );
}

/**
 * Predicate: the queue row's task is still in the `in-review` column.
 *
 * FNXC:MultiProjectIsolation 2026-07-10: when `projectId` is bound, the EXISTS
 * additionally requires the task to belong to this project so a project's
 * merger can only lease its OWN queue rows (merge_queue has no project_id, so
 * it is scoped transitively through its task on the shared embedded-PG cluster).
 */
function taskStillInReview(projectId?: string) {
  const projectClause = projectId
    ? sql`AND ${schema.project.tasks.projectId} = ${projectId}`
    : sql``;
  return sql<boolean>`
    EXISTS (
      SELECT 1 FROM ${schema.project.tasks}
      WHERE ${schema.project.tasks.id} = ${schema.project.mergeQueue.taskId}
        AND ${schema.project.tasks.column} = 'in-review'
        ${projectClause}
    )
  `;
}

/**
 * FNXC:TaskStoreMergeCoordination 2026-06-24-05:15:
 * Enqueue a task into the merge queue INSIDE a shared transaction handle
 * (VAL-DATA-013). The handoff-to-review path composes this inside its
 * `transactionImmediate(async (tx) => ...)` so the column move, this queue
 * insert, and the audit row all commit or roll back atomically. Observers
 * never see `column = 'in-review'` without the matching queue row.
 *
 * Semantics (mirrors the sync `enqueueMergeQueue` transaction body):
 *   - Reads the task's `priority` and `column` from `tasks` for the enqueue
 *     decision. The task MUST already be in `in-review` (the column move in
 *     the same transaction establishes this); otherwise the enqueue is rejected
 *     with a column-mismatch error after the caller's transaction.
 *   - Idempotent on `taskId` (the primary key): a re-enqueue for an already-
 *     queued task returns the existing row without inserting a duplicate. The
 *     `ON CONFLICT (task_id) DO NOTHING` makes the insert safe under retry.
 *   - Records a `mergeQueue:enqueue` audit event using the SAME transaction
 *     handle so it commits/rolls back with the enqueue.
 *
 * @param tx The transaction handle from the caller's `transactionImmediate`.
 * @param taskId The task to enqueue (must be in `in-review`).
 * @param opts Enqueue options (explicit priority override, clock injection).
 * @param audit Optional audit context (agentId/runId) for the enqueue event.
 * @returns The enqueued (or pre-existing) queue entry.
 */
export async function enqueueMergeQueueInTransaction(
  tx: DbTransaction,
  taskId: string,
  opts: MergeQueueEnqueueOptions = {},
  audit?: { agentId?: string; runId?: string },
): Promise<MergeQueueEntry> {
  // Read the task row for the column check + priority.
  const taskRows = await tx
    .select({ priority: schema.project.tasks.priority, column: schema.project.tasks.column })
    .from(schema.project.tasks)
    .where(eq(schema.project.tasks.id, taskId))
    .limit(1);
  const taskRow = taskRows[0];
  if (!taskRow) {
    throw new MergeQueueTaskNotFoundError(taskId);
  }
  if (taskRow.column !== "in-review") {
    // Record the rejection inside the transaction so it rolls back with the
    // caller's write if the caller aborts.
    await recordRunAuditEventWithinTransaction(tx, {
      taskId,
      agentId: audit?.agentId ?? "system",
      runId: audit?.runId ?? "unknown",
      domain: "database",
      mutationType: "mergeQueue:enqueue-rejected",
      target: taskId,
      metadata: { taskId, column: taskRow.column, reason: "not-in-review" },
    });
    throw new MergeQueueInvalidColumnError(taskId, taskRow.column);
  }

  const now = opts.now ?? new Date().toISOString();
  const priority = opts.priority ?? normalizeTaskPriority(taskRow.priority);

  // Idempotent insert: ON CONFLICT (task_id) DO NOTHING.
  await tx
    .insert(schema.project.mergeQueue)
    .values({
      taskId,
      enqueuedAt: now,
      priority,
      attemptCount: 0,
    })
    .onConflictDoNothing();

  // Read back the canonical row (whether it pre-existed or was just inserted).
  const rows = await tx
    .select()
    .from(schema.project.mergeQueue)
    .where(eq(schema.project.mergeQueue.taskId, taskId))
    .limit(1);
  const inserted = rows[0] as MergeQueueRow | undefined;
  if (!inserted) {
    throw new Error(`Failed to read merge queue entry for ${taskId} after enqueue`);
  }

  await recordRunAuditEventWithinTransaction(tx, {
    taskId,
    agentId: audit?.agentId ?? "system",
    runId: audit?.runId ?? "unknown",
    domain: "database",
    mutationType: "mergeQueue:enqueue",
    target: taskId,
    metadata: {
      taskId,
      priority: inserted.priority,
      enqueuedAt: inserted.enqueuedAt,
      alreadyEnqueued: inserted.enqueuedAt !== now,
    },
  });

  return rowToMergeQueueEntry(inserted);
}

/**
 * Enqueue a task into the merge queue in its own transaction. This is the
 * standalone variant for call sites that are NOT inside a handoff transaction
 * (e.g. a manual re-enqueue). The handoff-to-review path MUST use
 * `enqueueMergeQueueInTransaction` to preserve the atomic invariant (VAL-DATA-013).
 */
export async function enqueueMergeQueue(
  layer: AsyncDataLayer,
  taskId: string,
  opts: MergeQueueEnqueueOptions = {},
  audit?: { agentId?: string; runId?: string },
): Promise<MergeQueueEntry> {
  return layer.transactionImmediate((tx) =>
    enqueueMergeQueueInTransaction(tx, taskId, opts, audit),
  );
}

/**
 * FNXC:TaskStoreMergeCoordination 2026-06-24-05:20:
 * Clean up stale merge-queue rows: entries whose task was deleted or moved out
 * of `in-review`. This runs at the start of lease acquisition so the queue head
 * reflects only tasks still eligible to merge.
 *
 * A row is stale when its task no longer exists OR its task's column is not
 * `in-review`. Stale rows are deleted and a `mergeQueue:auto-cleanup-stale-row`
 * audit event is recorded. This mirrors the sync `cleanupStaleMergeQueueRows`.
 */
export async function cleanupStaleMergeQueueRowsInTransaction(
  tx: DbTransaction,
  now: string,
): Promise<void> {
  const staleRows = await tx
    .select({
      taskId: schema.project.mergeQueue.taskId,
      leasedBy: schema.project.mergeQueue.leasedBy,
      leaseExpiresAt: schema.project.mergeQueue.leaseExpiresAt,
      column: schema.project.tasks.column,
    })
    .from(schema.project.mergeQueue)
    .leftJoin(schema.project.tasks, eq(schema.project.tasks.id, schema.project.mergeQueue.taskId))
    .where(
      or(
        isNull(schema.project.tasks.id),
        sql`${schema.project.tasks.column} IS DISTINCT FROM 'in-review'`,
      ),
    );

  if (staleRows.length === 0) return;

  // FNXC:TaskStoreMergeCoordination 2026-06-26-10:10:
  // Batch the cleanup to avoid an N+1: previously each stale row cost 2
  // sequential round-trips (DELETE + audit INSERT) inside the transaction,
  // so 20 stale rows = 40 round-trips before the first lease could be
  // acquired. Now the deletes are a single bulk DELETE ... WHERE IN (...) and
  // the audit events are a single bulk INSERT ... VALUES (...). Each metadata
  // payload is still per-row (the column/lease context differs per task).
  const staleTaskIds = staleRows.map((row) => row.taskId);
  await tx
    .delete(schema.project.mergeQueue)
    .where(inArray(schema.project.mergeQueue.taskId, staleTaskIds));

  const auditValues = staleRows.map((row) => ({
    id: randomUUID(),
    timestamp: now,
    taskId: row.taskId,
    agentId: "system",
    runId: "unknown",
    domain: "database",
    mutationType: "mergeQueue:auto-cleanup-stale-row",
    target: row.taskId,
    metadata: {
      taskId: row.taskId,
      column: row.column,
      leasedBy: row.leasedBy,
      leaseExpiresAt: row.leaseExpiresAt,
      cleanedAt: now,
      reason: "not-in-review",
    } as Record<string, unknown>,
  }));
  await tx.insert(schema.project.runAuditEvents).values(auditValues as never);
}

/**
 * FNXC:TaskStoreMergeCoordination 2026-06-24-05:25:
 * Acquire a merge-queue lease (VAL-DATA-014). Leases are acquired
 * priority-first (urgent > high > normal > low), FIFO within priority
 * (earliest `enqueued_at` first). Only queue rows whose task is in `in-review`
 * and whose lease is available (no holder, or an expired lease) are eligible.
 *
 * Two modes:
 *   - **Targeted** (`opts.targetTaskId` set): attempt to lease the specific
 *     task first. If it is unavailable (held by another active lease, or not
 *     in `in-review`), record a `mergeQueue:lease-target-unavailable` audit
 *     event and return null (do NOT fall back to the queue head). This mirrors
 *     the sync targeted-acquire path.
 *   - **Queue head** (no target): lease the highest-priority, earliest-enqueued
 *     available row whose task is in `in-review`.
 *
 * Expired leases are treated as available: a row whose `lease_expires_at <= now`
 * is eligible for immediate takeover. This is what makes expired leases
 * "recoverable" — a subsequent acquire does not need to wait for an explicit
 * release.
 *
 * @param layer The async data layer (the acquire runs in its own transaction).
 * @param workerId The id of the worker acquiring the lease.
 * @param opts Lease options (duration, clock injection, optional target).
 * @param audit Optional audit context.
 * @returns The leased entry, or null if the queue is empty / the target is unavailable.
 */
export async function acquireMergeQueueLease(
  layer: AsyncDataLayer,
  workerId: string,
  opts: MergeQueueAcquireOptions,
  audit?: { agentId?: string; runId?: string },
): Promise<MergeQueueEntry | null> {
  if (opts.leaseDurationMs <= 0) {
    throw new InvalidMergeQueueLeaseDurationError(opts.leaseDurationMs);
  }

  // FNXC:MultiProjectIsolation 2026-07-10: the merger's lease candidate scans
  // must be scoped to this project so a project's merger can never lease (and
  // then merge in the wrong repo) another project's in-review task.
  const projectId = layer.projectId;
  return layer.transactionImmediate(async (tx) => {
    const now = opts.now ?? new Date().toISOString();
    const leaseExpiresAt = new Date(Date.parse(now) + opts.leaseDurationMs).toISOString();
    await cleanupStaleMergeQueueRowsInTransaction(tx, now);

    if (opts.targetTaskId) {
      // ── Targeted acquire: lease this specific task or fail ──────────────
      const candidateRows = await tx
        .select({ taskId: schema.project.mergeQueue.taskId })
        .from(schema.project.mergeQueue)
        .where(
          and(
            eq(schema.project.mergeQueue.taskId, opts.targetTaskId),
            taskStillInReview(projectId),
            leaseAvailable(now),
          ),
        )
        .limit(1);

      if (candidateRows.length === 0) {
        // Target unavailable — record diagnostics and return null.
        const headRows = await tx
          .select({
            taskId: schema.project.mergeQueue.taskId,
            leasedBy: schema.project.mergeQueue.leasedBy,
            column: schema.project.tasks.column,
          })
          .from(schema.project.mergeQueue)
          .leftJoin(
            schema.project.tasks,
            eq(schema.project.tasks.id, schema.project.mergeQueue.taskId),
          )
          .orderBy(MERGE_QUEUE_PRIORITY_RANK, schema.project.mergeQueue.enqueuedAt)
          .limit(1);
        const head = headRows[0];
        await recordRunAuditEventWithinTransaction(tx, {
          taskId: opts.targetTaskId,
          agentId: audit?.agentId ?? "system",
          runId: audit?.runId ?? "unknown",
          domain: "database",
          mutationType: "mergeQueue:lease-target-unavailable",
          target: opts.targetTaskId,
          metadata: {
            targetTaskId: opts.targetTaskId,
            workerId,
            queueHeadTaskId: head?.taskId ?? null,
            queueHeadLeasedBy: head?.leasedBy ?? null,
            queueHeadColumn: head?.column ?? null,
          },
        });
        return null;
      }

      // Acquire: UPDATE ... SET lease fields WHERE the row is still available.
      // The WHERE re-checks availability so a concurrent acquire that grabbed
      // the row between our SELECT and UPDATE updates zero rows.
      const acquired = await tx
        .update(schema.project.mergeQueue)
        .set({
          leasedBy: workerId,
          leasedAt: now,
          leaseExpiresAt,
        })
        .where(
          and(
            eq(schema.project.mergeQueue.taskId, opts.targetTaskId),
            taskStillInReview(projectId),
            leaseAvailable(now),
          ),
        )
        .returning();
      const leasedRow = acquired[0] as MergeQueueRow | undefined;
      if (!leasedRow) {
        // Lost the race between SELECT and UPDATE; treat as unavailable.
        return null;
      }

      const entry = rowToMergeQueueEntry(leasedRow);
      await recordRunAuditEventWithinTransaction(tx, {
        taskId: entry.taskId,
        agentId: audit?.agentId ?? "system",
        runId: audit?.runId ?? "unknown",
        domain: "database",
        mutationType: "mergeQueue:lease-acquired",
        target: entry.taskId,
        metadata: {
          taskId: entry.taskId,
          workerId,
          leaseExpiresAt: entry.leaseExpiresAt,
          priority: entry.priority,
        },
      });
      return entry;
    }

    // ── Queue-head acquire: lease the highest-priority, earliest available row ──
    // Select the candidate first (priority-first, FIFO within priority), then
    // UPDATE it while re-checking availability to avoid a lost-update race.
    const headRows = await tx
      .select({ taskId: schema.project.mergeQueue.taskId })
      .from(schema.project.mergeQueue)
      .innerJoin(
        schema.project.tasks,
        eq(schema.project.tasks.id, schema.project.mergeQueue.taskId),
      )
      .where(
        and(
          eq(schema.project.tasks.column, "in-review"),
          // FNXC:MultiProjectIsolation 2026-07-10: only this project's tasks.
          taskProjectScope(layer),
          leaseAvailable(now),
        ),
      )
      .orderBy(MERGE_QUEUE_PRIORITY_RANK, schema.project.mergeQueue.enqueuedAt)
      .limit(1);
    const head = headRows[0];
    if (!head) {
      return null;
    }

    const acquired = await tx
      .update(schema.project.mergeQueue)
      .set({
        leasedBy: workerId,
        leasedAt: now,
        leaseExpiresAt,
      })
      .where(
        and(
          eq(schema.project.mergeQueue.taskId, head.taskId),
          leaseAvailable(now),
        ),
      )
      .returning();
    const leasedRow = acquired[0] as MergeQueueRow | undefined;
    if (!leasedRow) {
      // Lost the race; caller can retry.
      return null;
    }

    const entry = rowToMergeQueueEntry(leasedRow);
    await recordRunAuditEventWithinTransaction(tx, {
      taskId: entry.taskId,
      agentId: audit?.agentId ?? "system",
      runId: audit?.runId ?? "unknown",
      domain: "database",
      mutationType: "mergeQueue:lease-acquired",
      target: entry.taskId,
      metadata: {
        taskId: entry.taskId,
        workerId,
        leaseExpiresAt: entry.leaseExpiresAt,
        priority: entry.priority,
      },
    });
    return entry;
  });
}

/**
 * FNXC:TaskStoreMergeCoordination 2026-06-24-05:30:
 * Release a held merge-queue lease (VAL-DATA-014).
 *
 * Two outcomes:
 *   - **success**: the task merged successfully. The queue row is DELETED (the
 *     task leaves the queue for good) and a `mergeQueue:lease-released` audit
 *     event with `outcome: "success"` is recorded.
 *   - **failure**: the merge failed. The queue row is retained, the lease is
 *     cleared (`leased_by`/`leased_at`/`lease_expires_at` set to NULL), and
 *     `attempt_count` is incremented by 1. A `mergeQueue:lease-released` audit
 *     event with `outcome: "failure"` is recorded. The row returns to the
 *     available pool for a subsequent acquire.
 *
 * Ownership check: only the current lease holder may release. A release from a
 * different worker is rejected with `MergeQueueLeaseOwnershipError`.
 *
 * NOTE on the attempt counter (VAL-DATA-014): `attempt_count` advances ONLY on
 * an explicit failure release. It does NOT advance on a silent lease expiry
 * (see `recoverExpiredMergeQueueLeases`). This distinguishes a genuine merge
 * failure from a worker that crashed mid-lease.
 *
 * @param layer The async data layer (the release runs in its own transaction).
 * @param taskId The task whose lease is being released.
 * @param workerId The worker that holds the lease.
 * @param outcome The release outcome (success deletes; failure increments).
 * @param audit Optional audit context.
 */
export async function releaseMergeQueueLease(
  layer: AsyncDataLayer,
  taskId: string,
  workerId: string,
  outcome: MergeQueueReleaseOutcome,
  audit?: { agentId?: string; runId?: string },
): Promise<void> {
  await layer.transactionImmediate(async (tx) => {
    const currentRows = await tx
      .select({ leasedBy: schema.project.mergeQueue.leasedBy })
      .from(schema.project.mergeQueue)
      .where(eq(schema.project.mergeQueue.taskId, taskId))
      .limit(1);
    const current = currentRows[0];
    if (!current || current.leasedBy !== workerId) {
      throw new MergeQueueLeaseOwnershipError(taskId, workerId, current?.leasedBy ?? null);
    }

    if (outcome.kind === "success") {
      await tx
        .delete(schema.project.mergeQueue)
        .where(
          and(
            eq(schema.project.mergeQueue.taskId, taskId),
            eq(schema.project.mergeQueue.leasedBy, workerId),
          ),
        );
      await recordRunAuditEventWithinTransaction(tx, {
        taskId,
        agentId: audit?.agentId ?? "system",
        runId: audit?.runId ?? "unknown",
        domain: "database",
        mutationType: "mergeQueue:lease-released",
        target: taskId,
        metadata: { taskId, workerId, outcome: "success" },
      });
      return;
    }

    // Failure: clear the lease, increment attempt_count, retain the row.
    const released = await tx
      .update(schema.project.mergeQueue)
      .set({
        leasedBy: null,
        leasedAt: null,
        leaseExpiresAt: null,
        attemptCount: sql`${schema.project.mergeQueue.attemptCount} + 1`,
        lastError: outcome.error,
      })
      .where(
        and(
          eq(schema.project.mergeQueue.taskId, taskId),
          eq(schema.project.mergeQueue.leasedBy, workerId),
        ),
      )
      .returning();
    const releasedRow = released[0] as MergeQueueRow | undefined;
    if (!releasedRow) {
      throw new MergeQueueLeaseOwnershipError(taskId, workerId, null);
    }

    const entry = rowToMergeQueueEntry(releasedRow);
    await recordRunAuditEventWithinTransaction(tx, {
      taskId,
      agentId: audit?.agentId ?? "system",
      runId: audit?.runId ?? "unknown",
      domain: "database",
      mutationType: "mergeQueue:lease-released",
      target: taskId,
      metadata: {
        taskId,
        workerId,
        outcome: "failure",
        attemptCount: entry.attemptCount,
        error: outcome.error,
      },
    });
  });
}

/**
 * FNXC:TaskStoreMergeCoordination 2026-06-24-05:35:
 * Recover expired leases WITHOUT incrementing `attempt_count` (VAL-DATA-014).
 *
 * A lease whose `lease_expires_at <= now` is considered expired: the holding
 * worker is presumed to have crashed or stalled. This helper clears the lease
 * fields (`leased_by`/`leased_at`/`lease_expires_at` set to NULL) so the row
 * returns to the available pool for a subsequent acquire. Critically, the
 * `attempt_count` is NOT incremented — a crashed worker is not a merge failure,
 * and the scheduler should retry without penalizing the task's attempt budget.
 *
 * This mirrors the sync `recoverExpiredMergeQueueLeases`. It runs in its own
 * transaction and records a `mergeQueue:lease-expired` audit event per
 * recovered row (with the previous holder + expiry for forensics).
 *
 * @param layer The async data layer.
 * @param now Optional clock injection (defaults to now).
 * @returns The recovered entries (now available for re-acquire).
 */
export async function recoverExpiredMergeQueueLeases(
  layer: AsyncDataLayer,
  now: string = new Date().toISOString(),
): Promise<MergeQueueEntry[]> {
  return layer.transactionImmediate(async (tx) => {
    const expiredRows = await tx
      .select()
      .from(schema.project.mergeQueue)
      .where(
        and(
          sql`${schema.project.mergeQueue.leasedBy} IS NOT NULL`,
          lte(schema.project.mergeQueue.leaseExpiresAt, now),
        ),
      )
      .orderBy(schema.project.mergeQueue.leaseExpiresAt, schema.project.mergeQueue.enqueuedAt);
    if (expiredRows.length === 0) {
      return [];
    }

    // Clear the lease fields for all expired rows. The RETURNING clause gives
    // us the post-clear state for the audit fan-out.
    const recoveredRows = await tx
      .update(schema.project.mergeQueue)
      .set({
        leasedBy: null,
        leasedAt: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          sql`${schema.project.mergeQueue.leasedBy} IS NOT NULL`,
          lte(schema.project.mergeQueue.leaseExpiresAt, now),
        ),
      )
      .returning();

    const previousByTaskId = new Map(expiredRows.map((row) => [row.taskId, row]));
    for (const row of recoveredRows) {
      const previous = previousByTaskId.get(row.taskId);
      await recordRunAuditEventWithinTransaction(tx, {
        taskId: row.taskId,
        agentId: "system",
        runId: "unknown",
        domain: "database",
        mutationType: "mergeQueue:lease-expired",
        target: row.taskId,
        metadata: {
          taskId: row.taskId,
          previousLeasedBy: previous?.leasedBy ?? null,
          previousLeaseExpiresAt: previous?.leaseExpiresAt ?? null,
          recoveredAt: now,
        },
      });
    }

    return recoveredRows.map((row) => rowToMergeQueueEntry(row as MergeQueueRow));
  });
}

/**
 * Peek at the full merge queue, ordered priority-first then FIFO within priority.
 * Read-only; does not take a lease.
 */
export async function peekMergeQueue(layer: AsyncDataLayer): Promise<MergeQueueEntry[]> {
  const rows = await layer.db
    .select()
    .from(schema.project.mergeQueue)
    .orderBy(MERGE_QUEUE_PRIORITY_RANK, schema.project.mergeQueue.enqueuedAt);
  return rows.map((row) => rowToMergeQueueEntry(row as MergeQueueRow));
}

/**
 * Peek at the queue head: the task id, its current lease holder, and its task's
 * column. Read-only. Returns null if the queue is empty.
 */
export async function peekMergeQueueHead(
  layer: AsyncDataLayer,
): Promise<{ taskId: string; leasedBy: string | null; column: string | null } | null> {
  const rows = await layer.db
    .select({
      taskId: schema.project.mergeQueue.taskId,
      leasedBy: schema.project.mergeQueue.leasedBy,
      column: schema.project.tasks.column,
    })
    .from(schema.project.mergeQueue)
    .leftJoin(
      schema.project.tasks,
      eq(schema.project.tasks.id, schema.project.mergeQueue.taskId),
    )
    .orderBy(MERGE_QUEUE_PRIORITY_RANK, schema.project.mergeQueue.enqueuedAt)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * FNXC:TaskStoreMergeCoordination 2026-06-24-05:40:
 * Remove a task from the merge queue when it leaves the `in-review` column
 * (the sync `dequeueMergeQueueOnColumnExit`). If the task is moving OUT of
 * `in-review` and its lease is free or expired, the queue row is deleted and a
 * `mergeQueue:auto-cleanup-stale-row` audit event is recorded. If the task
 * still holds an active lease, a `mergeQueue:stale-lease-on-column-exit` event
 * is recorded instead (the lease is left in place for the holder to release).
 *
 * This runs INSIDE the move transaction so the dequeue commits atomically with
 * the column change.
 */
export async function dequeueMergeQueueOnColumnExitInTransaction(
  tx: DbTransaction,
  taskId: string,
  previousColumn: string,
  nextColumn: string,
  now: string,
): Promise<void> {
  if (previousColumn !== "in-review" || nextColumn === "in-review") {
    return;
  }

  const queueRows = await tx
    .select({
      leasedBy: schema.project.mergeQueue.leasedBy,
      leaseExpiresAt: schema.project.mergeQueue.leaseExpiresAt,
    })
    .from(schema.project.mergeQueue)
    .where(eq(schema.project.mergeQueue.taskId, taskId))
    .limit(1);
  const queueRow = queueRows[0];
  if (!queueRow) {
    return;
  }

  const leaseIsExpired =
    queueRow.leaseExpiresAt != null && queueRow.leaseExpiresAt <= now;
  if (!queueRow.leasedBy || leaseIsExpired) {
    await tx
      .delete(schema.project.mergeQueue)
      .where(eq(schema.project.mergeQueue.taskId, taskId));
    await recordRunAuditEventWithinTransaction(tx, {
      taskId,
      agentId: "system",
      runId: "unknown",
      domain: "database",
      mutationType: "mergeQueue:auto-cleanup-stale-row",
      target: taskId,
      metadata: {
        taskId,
        previousColumn,
        nextColumn,
        leasedBy: queueRow.leasedBy,
        leaseExpiresAt: queueRow.leaseExpiresAt,
        cleanedAt: now,
        reason: "column-exit",
      },
    });
    return;
  }

  await recordRunAuditEventWithinTransaction(tx, {
    taskId,
    agentId: "system",
    runId: "unknown",
    domain: "database",
    mutationType: "mergeQueue:stale-lease-on-column-exit",
    target: taskId,
    metadata: {
      taskId,
      previousColumn,
      nextColumn,
      leasedBy: queueRow.leasedBy,
      leaseExpiresAt: queueRow.leaseExpiresAt,
    },
  });
}

// ── Merge-queue error classes ──────────────────────────────────────────
// These mirror the sync error classes in store.ts so the async path produces
// the same error types callers already handle.

/**
 * FNXC:TaskStoreMergeCoordination 2026-06-24-05:45:
 * Thrown when `enqueueMergeQueue` is called for a task id that does not exist.
 */
export class MergeQueueTaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`Task ${taskId} not found; cannot enqueue into merge queue`);
    this.name = "MergeQueueTaskNotFoundError";
  }
}

/**
 * Thrown when `enqueueMergeQueue` is called for a task that is not in the
 * `in-review` column.
 */
export class MergeQueueInvalidColumnError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly column: string,
  ) {
    super(`Task ${taskId} is in column '${column}', not 'in-review'; cannot enqueue`);
    this.name = "MergeQueueInvalidColumnError";
  }
}

/**
 * Thrown when `acquireMergeQueueLease` is called with a non-positive duration.
 */
export class InvalidMergeQueueLeaseDurationError extends Error {
  constructor(public readonly leaseDurationMs: number) {
    super(`Invalid merge-queue lease duration: ${leaseDurationMs}ms (must be > 0)`);
    this.name = "InvalidMergeQueueLeaseDurationError";
  }
}

/**
 * Thrown when `releaseMergeQueueLease` is called by a worker that does not hold
 * the lease.
 */
export class MergeQueueLeaseOwnershipError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly workerId: string,
    public readonly actualHolder: string | null,
  ) {
    super(
      `Worker ${workerId} does not hold the lease for ${taskId}` +
        (actualHolder ? ` (held by ${actualHolder})` : " (no holder)"),
    );
    this.name = "MergeQueueLeaseOwnershipError";
  }
}
