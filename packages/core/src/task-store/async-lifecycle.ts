/**
 * Async Drizzle task-lifecycle / lineage helpers (U13).
 *
 * FNXC:TaskStoreLifecycle 2026-06-24-04:30:
 * Async equivalents of the sync SQLite lineage-integrity and lifecycle call
 * sites in store.ts. These helpers target the PostgreSQL `project.tasks` table
 * via Drizzle and preserve the three load-bearing lineage invariants the
 * migration must not regress:
 *
 *   VAL-DATA-010 — Lineage-integrity gate blocks parent delete with live
 *     children. A parent task that has live (non-archived, non-soft-deleted)
 *     children (rows whose `source_parent_task_id` points at the parent) cannot
 *     be deleted or archived until those children are cleared. This is the
 *     `findLiveLineageChildren` gate that `deleteTask` / `archiveTask` consult.
 *   VAL-DATA-011 — `removeLineageReferences` clears the `source_parent_task_id`
 *     edge on each live child so the parent can then be deleted. The clear is a
 *     plain `UPDATE ... SET source_parent_task_id = NULL` (NULL = no parent).
 *   VAL-DATA-012 — Archived / soft-deleted children do NOT block parent delete.
 *     The lineage-integrity gate only counts children whose `column != 'archived'`
 *     AND whose `deleted_at IS NULL`. A child that was archived or soft-deleted
 *     no longer counts as "live" and does not block the parent.
 *
 * Transition context (see library/taskstore-persistence-notes.md):
 *   `getDatabase()` still returns the sync `Database` until U15 flips it. The
 *   TaskStore facade keeps its sync lifecycle path (the gate depends on it).
 *   These helpers are the async target the migrating store and the PostgreSQL
 *   integration tests consume. They program against the stable `AsyncDataLayer`
 *   interface (U4), not the underlying driver.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import { ACTIVE_TASK_FILTER } from "./async-persistence.js";

/**
 * FNXC:TaskStoreLifecycle 2026-06-24-04:35:
 * The lineage-integrity "live child" predicate. A child counts as live (and
 * therefore blocks parent delete/archive) only when ALL of the following hold:
 *   1. `source_parent_task_id = <parent>` — it is a lineage child of the parent.
 *   2. `id != <parent>` — the parent itself is never its own child.
 *   3. `column != 'archived'` — archived children do not block (VAL-DATA-012).
 *   4. `deleted_at IS NULL` — soft-deleted children do not block (VAL-DATA-012).
 *
 * Condition (4) is the soft-delete visibility filter shared with every live
 * reader. A soft-deleted child has already been moved to `column = 'archived'`
 * by `softDeleteTaskRow`, so condition (3) would already exclude it; condition
 * (4) is kept explicitly for defense-in-depth and to make the soft-delete
 * invariant self-documenting at the call site.
 *
 * This mirrors the sync `findLiveLineageChildren` SQL in store.ts exactly:
 *   SELECT id FROM tasks
 *    WHERE sourceParentTaskId = ? AND id != ? AND "column" != 'archived'
 *      AND <ACTIVE_TASKS_WHERE>
 */
/*
FNXC:ArchiveProjectIsolation 2026-07-14-16:20:
Lineage IDs are project-local. Every lineage gate and rewrite must include the task partition so archiving or deleting a parent cannot inspect or detach a same-ID child owned by another project; unbound compatibility callers stay inside the legacy quarantine.
*/
function projectPartition(projectId?: string): string {
  return projectId?.trim() || "__legacy_unscoped__";
}

export function liveLineageChildFilter(parentId: string, projectId?: string) {
  return and(
    eq(schema.project.tasks.projectId, projectPartition(projectId)),
    eq(schema.project.tasks.sourceParentTaskId, parentId),
    ne(schema.project.tasks.id, parentId),
    ne(schema.project.tasks.column, "archived"),
    ACTIVE_TASK_FILTER,
  );
}

/**
 * FNXC:TaskStoreLifecycle 2026-06-24-04:40:
 * Find the ids of live lineage children of a parent task (VAL-DATA-010).
 *
 * A "live" child is one whose `source_parent_task_id` points at the parent,
 * whose id is not the parent itself, whose column is not `archived`, and whose
 * `deleted_at` is NULL. Archived and soft-deleted children are intentionally
 * excluded so they do not block parent deletion (VAL-DATA-012).
 *
 * This is the async equivalent of the sync `findLiveLineageChildren(id)` in
 * store.ts. It is the gate that `deleteTask` / `archiveTask` consult before
 * proceeding: if the returned list is non-empty and the caller did not opt into
 * `removeLineageReferences`, the delete/archive is rejected with
 * `TaskHasLineageChildrenError`.
 *
 * @param db The Drizzle instance or transaction handle to read through.
 * @param parentId The id of the prospective parent being deleted/archived.
 * @returns The ids of live children (empty if none).
 */
export async function findLiveLineageChildren(
  db: AsyncDataLayer["db"] | DbTransaction,
  parentId: string,
  projectId?: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: schema.project.tasks.id })
    .from(schema.project.tasks)
    .where(liveLineageChildFilter(parentId, projectId));
  return rows.map((row) => row.id);
}

/**
 * FNXC:TaskStoreLifecycle 2026-06-24-04:45:
 * Clear the `source_parent_task_id` lineage edge on each live child so the
 * parent can then be deleted (VAL-DATA-011).
 *
 * This is the async equivalent of `rewriteLineageChildrenForRemoval` in
 * store.ts. For each child id, it sets `source_parent_task_id = NULL` and
 * stamps `updated_at`. After this runs, `findLiveLineageChildren(parentId)`
 * returns an empty list, so the lineage-integrity gate no longer blocks the
 * parent delete.
 *
 * The clear is idempotent: re-running against an already-cleared child is a
 * no-op (the UPDATE matches zero rows). It only clears children that still
 * point at THIS parent (the `source_parent_task_id = parentId` guard), so a
 * child that was reparented elsewhere is left untouched.
 *
 * @param tx The transaction handle (the parent delete must run in the SAME
 *   transaction so the lineage clear and the parent soft-delete commit or roll
 *   back atomically).
 * @param parentId The id of the parent being removed.
 * @param childIds The live child ids to clear (from `findLiveLineageChildren`).
 * @param nowIso The timestamp to stamp on `updated_at`.
 * @returns The number of child rows actually updated (cleared).
 */
export async function removeLineageReferences(
  tx: DbTransaction,
  parentId: string,
  childIds: readonly string[],
  nowIso: string,
  projectId?: string,
): Promise<number> {
  // FNXC:TaskStoreLifecycle 2026-06-24-06:05:
  // A single bulk UPDATE clears all children that still point at this parent.
  // The WHERE guards on BOTH id (in the child set) AND source_parent_task_id
  // (still pointing at this parent), so a child that was reparented elsewhere
  // is left untouched. Using an IN-list keeps this to one round-trip regardless
  // of child count. We count affected rows via a RETURNING read so the count is
  // accurate regardless of how the driver exposes rowCount.
  if (childIds.length === 0) {
    return 0;
  }
  const returned = await tx
    .update(schema.project.tasks)
    .set({
      sourceParentTaskId: null,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(schema.project.tasks.projectId, projectPartition(projectId)),
        sql`${schema.project.tasks.id} IN ${childIds}`,
        eq(schema.project.tasks.sourceParentTaskId, parentId),
      ),
    )
    .returning({ id: schema.project.tasks.id });
  return returned.length;
}

/**
 * FNXC:TaskStoreLifecycle 2026-06-24-04:50:
 * Check whether a parent has ANY live lineage children (VAL-DATA-010).
 *
 * This is a cheaper variant of `findLiveLineageChildren` for call sites that
 * only need the boolean (the gate). It uses `LIMIT 1` + an existence check so
 * the query short-circuits on the first live child instead of materializing
 * the full list.
 *
 * @param db The Drizzle instance or transaction handle to read through.
 * @param parentId The id of the prospective parent.
 * @returns `true` if at least one live child exists (delete/archive must be rejected).
 */
export async function hasLiveLineageChildren(
  db: AsyncDataLayer["db"] | DbTransaction,
  parentId: string,
  projectId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(schema.project.tasks)
    .where(liveLineageChildFilter(parentId, projectId))
    .limit(1);
  return rows.length > 0;
}
