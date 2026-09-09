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
 *     be deleted until those children are cleared. This is the
 *     `findLiveLineageChildren` gate that `deleteTask` consults.
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
import * as schema from "../../postgres/schema/index.js";
import { type AsyncDataLayer, type DbTransaction } from "../../postgres/data-layer.js";
import { ACTIVE_TASK_FILTER } from "./async-persistence.js";
import { createCurrentPlanEvidence } from "../../planner/spec-lock.js";
import { appendPlanEvidenceInTransaction, PlanEvidenceAppendError } from "../plan-evidence.js";
import { storeLog } from "../../store.js";

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
FNXC:ArchiveProjectIsolation 2026-07-14-21:48:
Task and lineage IDs are project-local. Archive, lineage, comment, document, artifact, and log gates share this partition resolver so same-ID rows cannot be read or mutated across projects; unbound compatibility callers remain confined to the explicit legacy quarantine.
*/
export function projectPartition(projectId?: string): string {
  return projectId?.trim() || "__legacy_unscoped__";
}

/**
 * Find active same-project rows that still carry an incoming dependency edge.
 * The project predicate is mandatory because task IDs are project-local.
 */
export async function findLiveDependencyDependents(
  db: AsyncDataLayer["db"] | DbTransaction,
  dependencyId: string,
  projectId?: string,
): Promise<string[]> {
  const rows = await db.select({ id: schema.project.tasks.id })
    .from(schema.project.tasks)
    .where(and(
      eq(schema.project.tasks.projectId, projectPartition(projectId)),
      ACTIVE_TASK_FILTER,
      sql`${schema.project.tasks.dependencies} @> ${JSON.stringify([dependencyId])}::jsonb`,
    ));
  return rows.map((row) => row.id);
}

export function liveLineageChildFilter(
  parentId: string,
  projectId?: string,
  /*
  FNXC:TaskArchiveRemoval 2026-09-04-18:25 DELIBERATE-LITERAL:
  Live-lineage scans exclude the fixed historical persistence sentinel, not a workflow role. The
  optional set exists for compatibility test/data-layer callers; omitting it uses `archived`.
  */
  historicalSentinelColumns?: ReadonlySet<string>,
) {
  const archivedExclusions = historicalSentinelColumns && historicalSentinelColumns.size > 0
    ? [...historicalSentinelColumns].map((lane) => ne(schema.project.tasks.column, lane))
    : [ne(schema.project.tasks.column, "archived")];
  return and(
    eq(schema.project.tasks.projectId, projectPartition(projectId)),
    eq(schema.project.tasks.sourceParentTaskId, parentId),
    ne(schema.project.tasks.id, parentId),
    ...archivedExclusions,
    ACTIVE_TASK_FILTER,
  );
}

/**
 * FNXC:TaskStoreLifecycle 2026-06-24-04:40:
 * Find the ids of live lineage children of a parent task (VAL-DATA-010).
 *
 * A "live" child is one whose `source_parent_task_id` points at the parent,
 * whose id is not the parent itself, whose column is not the historical
 * `archived` sentinel, and whose `deleted_at` is NULL. Historical and soft-deleted
 * children are intentionally excluded so they do not block parent deletion (VAL-DATA-012).
 *
 * This is the async equivalent of the sync `findLiveLineageChildren(id)` in
 * store.ts. It is the gate that `deleteTask` consults before
 * proceeding: if the returned list is non-empty and the caller did not opt into
 * `removeLineageReferences`, deletion is rejected with
 * `TaskHasLineageChildrenError`.
 *
 * @param db The Drizzle instance or transaction handle to read through.
 * @param parentId The id of the prospective parent being deleted.
 * @returns The ids of live children (empty if none).
 */
export async function findLiveLineageChildren(
  db: AsyncDataLayer["db"] | DbTransaction,
  parentId: string,
  projectId?: string,
  /** Historical sentinel columns; omitted → `archived`. See `liveLineageChildFilter`. */
  historicalSentinelColumns?: ReadonlySet<string>,
): Promise<string[]> {
  const rows = await db
    .select({ id: schema.project.tasks.id })
    .from(schema.project.tasks)
    .where(liveLineageChildFilter(parentId, projectId, historicalSentinelColumns));
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
export class LineageEvidenceAppendError extends Error {
  constructor(public readonly childId: string, public readonly attempts: number, public readonly reason: "no-durable-version" | "matched-row-not-truthful") {
    super(`Could not resolve truthful lineage evidence for ${childId}: ${reason}`);
    this.name = "LineageEvidenceAppendError";
  }
}

export type LineageRemovalOutcome = { clearedChildIds: string[]; evidenceVersionByChild: Map<string, number>; evidenceUnavailableChildIds: string[]; evidenceInsertAttempts: number };

/**
 * FNXC:SpecLockLineageInvalidation 2026-08-10-14:33:
 * The lineage edge, approval fingerprint, and successor evidence are one transaction: a cleared
 * parent binding can never retain approval or commit without truthful evidence. Report publication
 * is deliberately outside this helper because it must evaluate committed state and is retryable.
 */
export async function removeLineageReferences(
  tx: DbTransaction,
  parentId: string,
  childIds: readonly string[],
  nowIso: string,
  projectId?: string,
  promptByChildId: ReadonlyMap<string, string> = new Map(),
  evidenceTargetVersionForTest?: (childId: string, computed: number, attempt: number) => number,
): Promise<LineageRemovalOutcome> {
  if (childIds.length === 0) return { clearedChildIds: [], evidenceVersionByChild: new Map(), evidenceUnavailableChildIds: [], evidenceInsertAttempts: 0 };
  const returned = await tx.update(schema.project.tasks).set({ sourceParentTaskId: null, approvedPlanFingerprint: null, awaitingApprovalReason: null, updatedAt: nowIso })
    .where(and(eq(schema.project.tasks.projectId, projectPartition(projectId)), sql`${schema.project.tasks.id} IN ${childIds}`, eq(schema.project.tasks.sourceParentTaskId, parentId)))
    .returning({ id: schema.project.tasks.id, dependencies: schema.project.tasks.dependencies, missionId: schema.project.tasks.missionId, sliceId: schema.project.tasks.sliceId });
  const evidenceVersionByChild = new Map<string, number>();
  const evidenceUnavailableChildIds: string[] = [];
  let evidenceInsertAttempts = 0;
  /*
  FNXC:SpecLockLineageInvalidation 2026-08-11-02:04:
  FN-8969 converges lineage writes on the shared helper: it writes the trigger-compatible blank
  value but reads with unbound-safe project scope, derives versions from the durable column, and
  dedupes only by sourceHash while preserving this path's lineage truthfulness validator.
  */
  for (const child of returned) {
    const prompt = promptByChildId.get(child.id);
    if (prompt === undefined) {
      evidenceUnavailableChildIds.push(child.id);
      // A missing plan is the sole evidence-less commit: make the repairable input absence visible.
      storeLog.warn(`[spec-lock] lineage evidence unavailable: missing PROMPT.md for ${child.id}`);
      continue;
    }
    try {
      const result = await appendPlanEvidenceInTransaction(tx, {
        projectId,
        taskId: child.id,
        maxAttempts: 3,
        buildEvidence: (computed, attempt) => {
          evidenceInsertAttempts += 1;
          return createCurrentPlanEvidence({ version: evidenceTargetVersionForTest?.(child.id, computed, attempt) ?? computed, sourceRevision: Date.now(), capturedAt: nowIso, prompt, bindings: { dependencies: (child.dependencies as string[] | undefined) ?? [], missionId: child.missionId ?? undefined, sliceId: child.sliceId ?? undefined } });
        },
        validateMatchedEvidence: (snapshot, _version, attempt) => {
          if (snapshot.plan.sections.lineage.canonical.split("\n").includes(`parent-task:${parentId}`)) throw new LineageEvidenceAppendError(child.id, attempt + 1, "matched-row-not-truthful");
        },
      });
      evidenceVersionByChild.set(child.id, result.version);
    } catch (error) {
      if (error instanceof PlanEvidenceAppendError) throw new LineageEvidenceAppendError(child.id, 3, "no-durable-version");
      throw error;
    }
  }
  return { clearedChildIds: returned.map((row) => row.id), evidenceVersionByChild, evidenceUnavailableChildIds, evidenceInsertAttempts };
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
 * @returns `true` if at least one live child exists (deletion must be rejected).
 */
export async function hasLiveLineageChildren(
  db: AsyncDataLayer["db"] | DbTransaction,
  parentId: string,
  projectId?: string,
  /** Historical sentinel columns; omitted → `archived`. Threaded so this and
   *  `findLiveLineageChildren` cannot disagree about which children are live. */
  historicalSentinelColumns?: ReadonlySet<string>,
): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(schema.project.tasks)
    .where(liveLineageChildFilter(parentId, projectId, historicalSentinelColumns))
    .limit(1);
  return rows.length > 0;
}
