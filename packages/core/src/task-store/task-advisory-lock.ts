import { sql } from "drizzle-orm";
import type { DbTransaction } from "../postgres/data-layer.js";

/*
FNXC:WorkflowCapacity 2026-07-28-18:05 (PR #2499 review — cross-process selection race):
THE one place the per-task cross-process mutual-exclusion key is expressed.

WHY A DATABASE LOCK AND NOT THE EXISTING ONE. `TaskStore.withTaskLock` is an
IN-PROCESS promise-chain mutex over a `Map` (`task-id-integrity.ts`), so it
serializes callers inside a single TaskStore instance and nothing else. Fusion's
multi-node shape is several nodes against ONE central PostgreSQL database, so two
stores mutating the same task concurrently is a supported deployment, not an edge
case. Any invariant that must hold across nodes needs a lock the DATABASE
arbitrates.

WHY AN ADVISORY LOCK AND NOT `SELECT ... FOR UPDATE`. The capacity gate must
serialize against a selection row that MAY NOT EXIST — a task with no workflow
selection resolves to the default pool, and `FOR UPDATE` on a missing row locks
nothing, leaving a concurrent INSERT free to land (the classic phantom). An
advisory key covers the absent-row case identically to the present-row case.

WHY `_xact_` (transaction-scoped). It releases on COMMIT or ROLLBACK with no
unlock call, so an exception between acquire and commit cannot strand a lock that
would wedge every later move of that task across every node. There is no code path
that can leak it.

DEADLOCK ORDERING. Every holder acquires THIS lock first and row locks after, so
the acquisition order is global and consistent. Do not invert it.

Precedent: `chat-store.ts` uses the same `pg_advisory_xact_lock(hashtextextended(...))`
shape for pin-mutation serialization.
*/

/**
 * Namespaced advisory-lock key for one task.
 *
 * Project-scoped because shared PostgreSQL deployments reuse task ids across
 * projects (FNXC:WorkflowModelLanes) — an unscoped key would make two unrelated
 * projects' tasks contend, and would let one project's move serialize against
 * another's selection write.
 */
export function taskAdvisoryLockKey(projectId: string | undefined, taskId: string): string {
  const scopedProjectId = projectId?.trim() || "__legacy_unscoped__";
  return `task:${scopedProjectId}:${taskId}`;
}

/**
 * Take the per-task advisory lock for the remainder of `tx`.
 *
 * Blocks until any other holder's transaction commits or rolls back. Callers that
 * then read state and act on it are guaranteed that state cannot change under
 * them before their own commit — which is the property the capacity gate needs:
 * the pool id and limit it enforces against are the ones the commit lands under.
 */
export async function acquireTaskAdvisoryXactLock(
  tx: DbTransaction,
  projectId: string | undefined,
  taskId: string,
): Promise<void> {
  const key = taskAdvisoryLockKey(projectId, taskId);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
