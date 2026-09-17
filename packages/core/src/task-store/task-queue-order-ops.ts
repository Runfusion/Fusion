/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
FN-509's durable Boost mutation and the SQL half of the shared queue order.

TWO HALVES THAT MUST AGREE. `tasks/task-queue-order.ts` owns the TypeScript comparator; this module
owns the ORDER BY the PostgreSQL readers apply BEFORE their `LIMIT`. Sorting an already-truncated
page would silently drop a boosted card that started beyond the limit, which is precisely the case
the operator cares about, so the rank has to exist in SQL too.

WHY THE SQL EFFECTIVENESS CHECK IS A SUPERSET. A boost is scoped by workflow, column and column
entry. Column and entry are columns of `project.tasks` and are compared exactly here. The effective
WORKFLOW is not: it resolves through a selection table plus project defaults, which is a per-row
lookup rather than an expression. SQL therefore applies the two cheap identity checks and the
TypeScript layer re-resolves the winner — a superset can only admit an extra candidate into the
ordered scan, never hide one, and every admission path re-reads the canonical rank before it
commits to a winner.
*/

import { and, eq, sql, type SQL } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import { taskProjectScope, type DbTransaction } from "../postgres/data-layer.js";
import { acquireTaskAdvisoryXactLock } from "./task-advisory-lock.js";
import { readTaskRowInTransaction } from "./async/async-persistence.js";
import {
  normalizeTaskQueueBoost,
  resolveTaskColumnEntryAt,
  type TaskQueueBoost,
} from "../tasks/task-queue-order.js";
import type { Task } from "../types.js";
import type { TaskStore } from "../store.js";

const tasks = schema.project.tasks;

/**
 * `true` when the stored boost still belongs to the row's CURRENT stay.
 *
 * Mirrors `resolveEffectiveQueueBoost` minus the workflow check (see the module header).
 */
export const QUEUE_BOOST_EFFECTIVE: SQL<boolean> = sql<boolean>`(
  ${tasks.queueBoost} IS NOT NULL
  AND ${tasks.queueBoost}->>'column' = ${tasks.column}
  AND ${tasks.queueBoost}->>'columnEntryAt' = COALESCE(${tasks.columnMovedAt}, ${tasks.createdAt})
  AND ${tasks.queueBoost}->>'sequence' ~ '^[0-9]{1,32}$'
)`;

/**
 * The boost sequence as a numeric, or 0 when no effective boost applies.
 *
 * `numeric` rather than `bigint` so a sequence beyond 2^63 still compares correctly, matching the
 * TypeScript comparator's arbitrary-precision decimal-string compare.
 */
export const QUEUE_BOOST_SEQUENCE: SQL<string> = sql<string>`(
  CASE WHEN ${QUEUE_BOOST_EFFECTIVE} THEN (${tasks.queueBoost}->>'sequence')::numeric ELSE 0 END
)`;

/**
 * The numeric id suffix expression shared by every queue ORDER BY and keyset predicate.
 *
 * FNXC:TaskQueueOrder 2026-09-17-13:51:
 * ONE expression for both halves: an ORDER BY term and its keyset predicate must be written from the
 * same expression, or a page walk can repeat or drop rows around a non-numeric id suffix.
 */
const ID_NUMERIC_SUFFIX: SQL<string> = sql`COALESCE(NULLIF(regexp_replace(${tasks.id}, '^.*-', ''), '')::numeric, 0)`;

/**
 * The canonical queue ORDER BY: boosted first (latest boost at the head), then arrival
 * (`created_at` ASC with invalid/missing values last), then the id's numeric suffix, then the id.
 *
 * Apply this BEFORE any `LIMIT`. The numeric-suffix expression mirrors `compareTaskIdNumeric`, so a
 * `FN-2`/`FN-10` tie resolves identically in SQL and TypeScript.
 */
export function taskQueueOrderBy(): SQL[] {
  return [
    sql`${QUEUE_BOOST_SEQUENCE} DESC`,
    sql`(CASE WHEN ${tasks.createdAt} IS NULL THEN 1 ELSE 0 END) ASC`,
    sql`${tasks.createdAt} ASC NULLS LAST`,
    sql`${ID_NUMERIC_SUFFIX} ASC`,
    sql`${tasks.id} ASC`,
  ];
}

/** Manual-intake display order: newest first, deterministic descending id tiebreak. */
export function taskIntakeDisplayOrderBy(): SQL[] {
  return [
    sql`${tasks.createdAt} DESC NULLS LAST`,
    sql`${ID_NUMERIC_SUFFIX} DESC`,
    sql`${tasks.id} DESC`,
  ];
}

// ── Keyset continuation ─────────────────────────────────────────────────────

/** The exact sort key of one row under `taskQueueOrderBy()` / `taskIntakeDisplayOrderBy()`. */
export interface TaskQueuePageKey {
  /** The SQL-effective boost sequence, or `"0"` when the row carries no effective boost. */
  sequence: string;
  createdAt: string;
  id: string;
}

/**
 * The SQL-effective boost sequence of an already-hydrated task.
 *
 * FNXC:TaskQueueOrder 2026-09-17-13:51:
 * A keyset cursor is only safe when the key it stores is the key the database sorted by, so this
 * mirrors `QUEUE_BOOST_SEQUENCE` exactly — including the deliberate omission of the workflow check
 * that the module header explains. Resolving the boost in TypeScript with the workflow identity
 * would produce `0` for a row SQL ranked above `0`, and pagination would then skip rows.
 */
export function sqlEffectiveBoostSequence(
  task: Pick<Task, "column" | "columnMovedAt" | "createdAt" | "queueBoost">,
): string {
  const boost = normalizeTaskQueueBoost(task.queueBoost);
  if (!boost) return "0";
  if (boost.column !== task.column) return "0";
  if (boost.columnEntryAt !== resolveTaskColumnEntryAt(task)) return "0";
  return /^[0-9]{1,32}$/.test(boost.sequence) ? boost.sequence : "0";
}

/** Read the exact page key of a hydrated row for the given order. */
export function taskQueuePageKey(
  task: Pick<Task, "id" | "column" | "columnMovedAt" | "createdAt" | "queueBoost">,
): TaskQueuePageKey {
  return { sequence: sqlEffectiveBoostSequence(task), createdAt: task.createdAt, id: task.id };
}

/**
 * Exclusive keyset predicate for `taskQueueOrderBy()`.
 *
 * FNXC:TaskQueueOrder 2026-09-17-13:51:
 * ORDER and CONTINUATION are one invariant. Every ORDER BY term appears here in the same direction,
 * otherwise a page walk silently repeats or drops rows. Rows with a NULL `created_at` sort last
 * inside their sequence group, so they are admitted once the cursor is inside that group.
 */
export function taskQueueOrderCursorPredicate(cursor: TaskQueuePageKey): SQL {
  const seq = sql`${cursor.sequence}::numeric`;
  const suffix = sql`COALESCE(NULLIF(regexp_replace(${cursor.id}, '^.*-', ''), '')::numeric, 0)`;
  return sql`(
    ${QUEUE_BOOST_SEQUENCE} < ${seq}
    OR (${QUEUE_BOOST_SEQUENCE} = ${seq} AND ${tasks.createdAt} IS NULL)
    OR (${QUEUE_BOOST_SEQUENCE} = ${seq} AND ${tasks.createdAt} > ${cursor.createdAt})
    OR (${QUEUE_BOOST_SEQUENCE} = ${seq} AND ${tasks.createdAt} = ${cursor.createdAt} AND ${ID_NUMERIC_SUFFIX} > ${suffix})
    OR (${QUEUE_BOOST_SEQUENCE} = ${seq} AND ${tasks.createdAt} = ${cursor.createdAt} AND ${ID_NUMERIC_SUFFIX} = ${suffix} AND ${tasks.id} > ${cursor.id})
  )`;
}

/** Exclusive keyset predicate for `taskIntakeDisplayOrderBy()` (newest first). */
export function taskIntakeDisplayCursorPredicate(cursor: Pick<TaskQueuePageKey, "createdAt" | "id">): SQL {
  const suffix = sql`COALESCE(NULLIF(regexp_replace(${cursor.id}, '^.*-', ''), '')::numeric, 0)`;
  return sql`(
    ${tasks.createdAt} IS NULL
    OR ${tasks.createdAt} < ${cursor.createdAt}
    OR (${tasks.createdAt} = ${cursor.createdAt} AND ${ID_NUMERIC_SUFFIX} < ${suffix})
    OR (${tasks.createdAt} = ${cursor.createdAt} AND ${ID_NUMERIC_SUFFIX} = ${suffix} AND ${tasks.id} < ${cursor.id})
  )`;
}

// ── boostTask ───────────────────────────────────────────────────────────────

export type BoostTaskRefusalReason =
  | "not-found"
  | "deleted"
  | "active"
  | "scope-changed"
  | "no-queue";

export interface BoostTaskOptions {
  /**
   * Caller-supplied idempotency key. A retried network call carrying the SAME id returns the
   * existing rank unchanged; a genuinely new click must carry a new id and mints a new sequence.
   */
  requestId: string;
  /** The effective workflow the caller believes the card is running; revalidated here. */
  workflowId: string;
  /** Optional precondition: refuse when the card's column is no longer this one. */
  expectedColumn?: string;
  /** Optional precondition: refuse when the card's stay marker has moved on. */
  expectedColumnEntryAt?: string;
  /** Resolved liveness for the card; a claimed, already-running card is never re-ranked. */
  isActive?: (task: Task) => boolean;
}

export type BoostTaskResult =
  | { ok: true; task: Task; boost: TaskQueueBoost; idempotent: boolean }
  | { ok: false; reason: BoostTaskRefusalReason; task?: Task };

/*
FNXC:TaskQueueOrder 2026-09-17-12:07:
The ONLY writer of `queueBoost`. Everything else — create, clone, refinement, import, revert,
restore, every generic `updateTask`/`updateTaskAtomic` patch and every self-healing sweep — is
forbidden from minting one, because a rank that a sweep can invent is a hidden priority.

ORDERING AND NON-PREEMPTION. The sequence is allocated INSIDE the same transaction as the write, so
two concurrent clicks are ordered by the database rather than by whichever browser's clock ran fast.
A card that is already active is refused rather than re-ranked: selection that has already been
accepted is never taken back to serve a boost that arrived afterwards.

LOCK ORDER. Task advisory lock first, then the row — the repository-wide order. The mutation writes
ONLY the rank plus the publication freshness stamp, so it cannot clobber a concurrent lifecycle
patch, and no model call or network emit happens while the transaction is open.
*/
export async function boostTaskImpl(
  store: TaskStore,
  id: string,
  options: BoostTaskOptions,
): Promise<BoostTaskResult> {
  const outcome = await store.withTaskLock(id, async () => {
    const layer = store.asyncLayer!;
    return layer.transactionImmediate(async (tx: DbTransaction): Promise<BoostTaskResult> => {
      await acquireTaskAdvisoryXactLock(tx, layer.projectId, id);
      const row = await readTaskRowInTransaction(tx, id, { includeDeleted: true }, layer.projectId);
      if (!row) return { ok: false, reason: "not-found" };
      if (row.deletedAt) return { ok: false, reason: "deleted" };

      const current = store.rowToTask(store.pgRowToTaskRow(row));
      const columnEntryAt = resolveTaskColumnEntryAt(current);

      if (options.expectedColumn !== undefined && options.expectedColumn !== current.column) {
        return { ok: false, reason: "scope-changed", task: current };
      }
      if (options.expectedColumnEntryAt !== undefined && options.expectedColumnEntryAt !== columnEntryAt) {
        return { ok: false, reason: "scope-changed", task: current };
      }
      if (options.isActive?.(current) === true) {
        return { ok: false, reason: "active", task: current };
      }

      // Idempotent retry: the same request id already holds this stay's rank.
      const existing = normalizeTaskQueueBoost(current.queueBoost);
      if (
        existing &&
        existing.requestId === options.requestId &&
        existing.column === current.column &&
        existing.columnEntryAt === columnEntryAt &&
        existing.workflowId === options.workflowId
      ) {
        return { ok: true, task: current, boost: existing, idempotent: true };
      }

      const [sequenceRow] = (await tx.execute(
        sql`SELECT nextval('project.task_queue_boost_seq')::text AS sequence`,
      )) as unknown as Array<{ sequence: string }>;
      const sequence = sequenceRow?.sequence;
      if (!sequence) throw new Error(`Failed to allocate a queue boost sequence for ${id}`);

      const boost: TaskQueueBoost = {
        sequence,
        workflowId: options.workflowId,
        column: current.column,
        columnEntryAt,
        requestId: options.requestId,
      };

      const [updatedRow] = await tx
        .update(tasks)
        .set({ queueBoost: boost, updatedAt: new Date().toISOString() })
        .where(and(eq(tasks.id, id), taskProjectScope(layer)))
        .returning();
      if (!updatedRow) return { ok: false, reason: "not-found" };

      return {
        ok: true,
        task: store.rowToTask(store.pgRowToTaskRow(updatedRow)),
        boost,
        idempotent: false,
      };
    });
  });

  /*
  Publish only AFTER commit. A failed cosmetic projection must not make a committed rank invisible
  on re-read, so the task.json mirror is best-effort while the cache and the `task:updated` event
  carry the canonical row.
  */
  if (outcome.ok) {
    try {
      await store.writeTaskJsonFile(store.taskDir(id), outcome.task);
    } catch {
      // Intentionally swallowed: the durable rank is already committed in PostgreSQL.
    }
    if (store.isWatching) store.taskCache.set(id, { ...outcome.task });
    store.emitTaskLifecycleEventSafely("task:updated", [outcome.task]);
  }
  return outcome;
}
