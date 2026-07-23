/**
 * FNXC:PostgresCutover 2026-07-10:
 * Async Drizzle counterparts of the sync `transition-pending.ts` helpers for
 * the crash-safe `tasks.transition_pending` marker (U3/KTD-2) in PostgreSQL
 * backend mode. Backend-mode `moveTaskInternal` writes the marker inside the
 * same `transactionImmediate` as the column change and clears it after the
 * post-commit hook runner; `recoverStaleTransitionPendingImpl` sweeps stale
 * markers on startup/maintenance. Before this port, backend mode silently
 * skipped the marker write (clear was a swallowed `store.db` throw) and the
 * recovery sweep threw "SQLite Database is not available in backend mode" —
 * while `countActiveInCapacitySlotAsync` ALREADY counts pending markers in
 * PG, so the marker column is load-bearing for capacity there.
 */

import { eq, isNotNull, isNull, ne, and } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import type { DrizzleDb, DbTransaction } from "../../postgres/data-layer.js";
import {
  type TransitionPending,
  deserializeTransitionPending,
  serializeTransitionPending,
} from "../../tasks/transition-types.js";

type Handle = DrizzleDb | DbTransaction;

/**
 * Read the pending marker for a task. Mirrors the sync contract: `null` when
 * the column is NULL/empty/malformed (a corrupt marker degrades to settled),
 * `undefined` only when the task row does not exist.
 */
export async function readTransitionPendingAsync(
  handle: Handle,
  taskId: string,
): Promise<TransitionPending | null | undefined> {
  const rows = await handle
    .select({ transitionPending: schema.project.tasks.transitionPending })
    .from(schema.project.tasks)
    .where(eq(schema.project.tasks.id, taskId))
    .limit(1);
  const row = rows[0] as { transitionPending: string | null } | undefined;
  if (row === undefined) return undefined;
  if (row.transitionPending == null || row.transitionPending === "") return null;
  return deserializeTransitionPending(row.transitionPending);
}

/** Write (set or replace) the pending marker. Run inside the move transaction. */
export async function writeTransitionPendingAsync(
  handle: Handle,
  taskId: string,
  pending: TransitionPending,
): Promise<void> {
  await handle
    .update(schema.project.tasks)
    .set({ transitionPending: serializeTransitionPending(pending) })
    .where(eq(schema.project.tasks.id, taskId));
}

/** Clear the pending marker (NULL) once post-commit hooks complete. */
export async function clearTransitionPendingAsync(handle: Handle, taskId: string): Promise<void> {
  await handle
    .update(schema.project.tasks)
    .set({ transitionPending: null })
    .where(eq(schema.project.tasks.id, taskId));
}

/**
 * List live task ids carrying a non-empty pending marker — the recovery
 * sweep's scan set. Mirrors the sync sweep's SELECT (non-deleted rows only).
 */
export async function listTransitionPendingTaskIdsAsync(handle: Handle): Promise<string[]> {
  const rows = await handle
    .select({ id: schema.project.tasks.id })
    .from(schema.project.tasks)
    .where(and(
      isNotNull(schema.project.tasks.transitionPending),
      ne(schema.project.tasks.transitionPending, ""),
      isNull(schema.project.tasks.deletedAt),
    ));
  return rows.map((row) => (row as { id: string }).id);
}
