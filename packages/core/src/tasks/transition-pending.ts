/**
 * Store-side read/write helpers for the crash-safe `tasks.transitionPending`
 * marker (U3).
 *
 * These operate on a minimal db handle (anything exposing a `prepare` that
 * returns a statement with `.get`/`.run`) so they can be unit-tested against a
 * raw {@link import("../db/db.js").Database} without dragging in `store.ts`. U4 owns
 * wiring these into `moveTaskInternal`'s transaction and the recovery sweep;
 * this module is the clean seam they will call.
 *
 * The marker is written in the same transaction as the column change (KTD-2) and
 * cleared once post-commit hooks complete. Recovery reads it back exclusively
 * from SQLite (the authoritative store per ADR-0001).
 */

import {
  type TransitionPending,
  deserializeTransitionPending,
  serializeTransitionPending,
} from "./transition-types.js";

/** Minimal statement surface the helpers need (subset of node:sqlite's StatementSync). */
interface MarkerStatement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

/** Minimal db handle: just enough to prepare statements. Satisfied by `Database`. */
export interface TransitionPendingDbHandle {
  prepare(sql: string): MarkerStatement;
}

/**
 * Read the pending marker for a task. Returns `null` when the column is NULL,
 * empty, or holds malformed JSON (a corrupt marker must never throw on a
 * recovery path — it degrades to "no pending work" and the row is treated as
 * settled). Returns `undefined` only when the task row does not exist.
 */
export function readTransitionPending(
  db: TransitionPendingDbHandle,
  taskId: string,
): TransitionPending | null | undefined {
  const row = db
    .prepare(`SELECT transitionPending FROM tasks WHERE id = ?`)
    .get(taskId) as { transitionPending: string | null } | undefined;
  if (row === undefined) return undefined;
  if (row.transitionPending == null || row.transitionPending === "") return null;
  return deserializeTransitionPending(row.transitionPending);
}

/**
 * Write (set or replace) the pending marker for a task. Intended to run inside
 * the same transaction as the column change (U4). Stores the JSON-serialized
 * marker into `tasks.transitionPending`.
 */
export function writeTransitionPending(
  db: TransitionPendingDbHandle,
  taskId: string,
  pending: TransitionPending,
): void {
  db.prepare(`UPDATE tasks SET transitionPending = ? WHERE id = ?`).run(
    serializeTransitionPending(pending),
    taskId,
  );
}

/**
 * Clear the pending marker for a task (sets the column to NULL). Called once all
 * post-commit hooks for the transition have completed.
 */
export function clearTransitionPending(db: TransitionPendingDbHandle, taskId: string): void {
  db.prepare(`UPDATE tasks SET transitionPending = NULL WHERE id = ?`).run(taskId);
}

/** Result of reconciling a marker's `hooksRemaining` against the known hook set. */
export interface ReconcileHooksResult {
  /** Hooks that survived: still registered/known and owed execution. */
  hooksRemaining: string[];
  /**
   * Audit warnings for each dropped hook entry — e.g. a hook belonging to a
   * now-uninstalled plugin. One human-readable message per dropped entry so the
   * recovery sweep can emit a degraded-hook audit event and complete the marker
   * rather than leaving the card stuck waiting for a missing handler.
   */
  warnings: string[];
}

/**
 * Reconcile a marker's `hooksRemaining` against the set of currently-known hook
 * IDs. Entries no longer present (e.g. a plugin hook removed by uninstall) are
 * dropped and surfaced as audit warnings. Pure — no DB access — so U4/U8 can
 * call it in or out of a transaction.
 *
 * This covers the U3-level slice of the "missing-plugin-hook" scenario: the
 * type/helper guarantees a dangling hook entry resolves to a dropped entry plus
 * a warning, never an indefinitely-stuck marker. The actual recovery wiring is
 * U4/U8.
 */
export function reconcileHooksRemaining(
  hooksRemaining: readonly string[],
  knownHookIds: ReadonlySet<string>,
): ReconcileHooksResult {
  const surviving: string[] = [];
  const warnings: string[] = [];
  for (const hookId of hooksRemaining) {
    if (knownHookIds.has(hookId)) {
      surviving.push(hookId);
    } else {
      warnings.push(
        `Dropping unknown transition hook "${hookId}" from transitionPending marker (handler not registered; likely an uninstalled plugin)`,
      );
    }
  }
  return { hooksRemaining: surviving, warnings };
}
