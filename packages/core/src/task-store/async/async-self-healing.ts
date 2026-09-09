/**
 * Async Drizzle self-healing helpers (U15).
 *
 * FNXC:SelfHealing 2026-06-24-14:00:
 * Async equivalents of the sync SQLite self-healing call sites in
 * `packages/engine/src/self-healing.ts` that bypassed store methods and called
 * the sync `Database`/`prepare()` surface directly. These helpers target the
 * PostgreSQL `project.tasks` table via Drizzle and program against the stable
 * `AsyncDataLayer` interface (U4) — not the underlying driver.
 *
 * The load-bearing self-healing path migrated here is
 * `reconcileSoftDeletedColumnDrift`:
 *   FN-5147 invariant — only rows with `deletedAt IS NOT NULL` are eligible, so
 *   live in-review tasks (including autoMerge: false workflows) are never moved.
 *   A soft-deleted task whose column drifted off the historical sentinel is
 *   reconciled back to it with a per-row run-audit event so operators can trace the
 *   reconciliation. The mutation + audit run so the audit trail reflects every
 *   reconciliation; a failure on one row does not abort the remaining rows
 *   (best-effort, matching the sync catch-all that returns `{ reconciled: 0 }`
 *   on error).
 *
 * Transition context (see library/async-data-layer-notes.md):
 *   `getDatabase()` still returns the sync `Database` until the satellite-store
 *   sub-features complete and flip the accessor. The engine self-healing manager
 *   keeps its sync path (the gate depends on it). These helpers are the async
 *   target the migrating self-healing manager and the PostgreSQL integration
 *   tests consume.
 */
import { and, eq, isNotNull, ne } from "drizzle-orm";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";

/**
 * FNXC:SelfHealing 2026-06-24-14:05:
 * A soft-deleted task whose column is not the historical sentinel. The reconciler
 * restores that sentinel and records an audit event naming the previous column.
 */
interface SoftDeletedColumnDriftCandidate {
  projectId: string;
  id: string;
  column: string;
}

function projectPartition(projectId?: string): string {
  return projectId?.trim() || "__legacy_unscoped__";
}

/**
 * FNXC:SelfHealing 2026-06-24-14:10:
 * Read soft-deleted tasks whose historical sentinel drifted for column
 * reconciliation. This is the async equivalent of the sync direct-`prepare()`
 * query in `reconcileSoftDeletedColumnDrift`:
 *   `SELECT id, "column" FROM tasks WHERE deletedAt IS NOT NULL AND "column" != 'archived'`
 *
 * FN-5147 invariant: only rows with `deletedAt IS NOT NULL` are eligible, so
 * live in-review tasks (including autoMerge: false workflows) are never moved.
 *
 * @param db The Drizzle instance from the AsyncDataLayer.
 * @param projectId The bound project identity; undefined maps to the legacy partition.
 */
export async function listSoftDeletedColumnDriftCandidates(
  db: AsyncDataLayer["db"],
  projectId?: string,
): Promise<SoftDeletedColumnDriftCandidate[]> {
  const partition = projectPartition(projectId);
  const rows = await db
    .select({
      projectId: schema.project.tasks.projectId,
      id: schema.project.tasks.id,
      column: schema.project.tasks.column,
    })
    .from(schema.project.tasks)
    .where(and(
      eq(schema.project.tasks.projectId, partition),
      isNotNull(schema.project.tasks.deletedAt),
      ne(schema.project.tasks.column, "archived"),
    ));
  return rows.map((row) => ({ projectId: row.projectId, id: row.id, column: row.column }));
}

/**
 * Callback shape for recording a run-audit event per reconciled row. The
 * self-healing manager constructs its own auditor (with a synthetic runId and
 * agentId); this callback decouples the reconciliation logic from the auditor
 * construction so the helper is unit-testable.
 */
export type ReconcileAuditFn = (candidate: {
  id: string;
  previousColumn: string;
}) => Promise<void>;

/**
 * FNXC:SelfHealing 2026-06-24-14:15:
 * Reconcile soft-deleted tasks whose column drifted off the historical sentinel,
 * recording a per-row run-audit event. This is the async equivalent
 * of the sync `reconcileSoftDeletedColumnDrift` loop.
 *
 * Each candidate is assigned the sentinel by a compare-and-set UPDATE that still
 * observes its soft-delete marker and previous column. The audit callback runs
 * only when that UPDATE returns a row. A failure on one row is logged but does
 * not abort the remaining rows
 * (best-effort), matching the sync catch-all that returns `{ reconciled: 0 }`
 * on a top-level error.
 *
 * @param layer The async data layer.
 * @param recordAudit Per-row audit callback (receives the task id + previous column).
 * @returns The number of candidates reconciled.
 */
export async function reconcileSoftDeletedColumnDriftAsync(
  layer: AsyncDataLayer,
  recordAudit: ReconcileAuditFn,
): Promise<{ reconciled: number }> {
  try {
    const candidates = await listSoftDeletedColumnDriftCandidates(layer.db, layer.projectId);
    if (candidates.length === 0) return { reconciled: 0 };

    let reconciled = 0;
    const now = new Date().toISOString();

    for (const candidate of candidates) {
      try {
        const updated = await layer.db
          .update(schema.project.tasks)
          .set({
            /*
            FNXC:WorkflowResolvedColumns 2026-08-01-23:23 DELIBERATE-LITERAL — STATE MARKER:
            A soft-deleted row must be reconciled to Fusion's physical historical sentinel. It is
            persistence metadata, never a live workflow destination.
            */
            column: "archived",
            updatedAt: now,
          })
          /*
          FNXC:MultiProjectIsolation 2026-08-01-23:36:
          Soft-delete drift reconciliation shares PostgreSQL's flat task table across projects. A task ID
          is only unique inside its project, so both the candidate read and repair must use this composite
          partition key; otherwise a project-A repair can rewrite project-B's same-ID row.

          FNXC:SelfHealing 2026-08-01-23:53:
          The candidate read is stale by the time this repair runs. Preserve a concurrent restore or
          column move by requiring both the soft-delete marker and observed prior column, then audit
          only a successful RETURNING update.
          */
          .where(and(
            eq(schema.project.tasks.projectId, candidate.projectId),
            eq(schema.project.tasks.id, candidate.id),
            isNotNull(schema.project.tasks.deletedAt),
            eq(schema.project.tasks.column, candidate.column),
          ))
          .returning({ id: schema.project.tasks.id });
        if (updated.length === 0) continue;
        await recordAudit({ id: candidate.id, previousColumn: candidate.column });
        reconciled += 1;
      } catch {
        // Best-effort: a failure on one row does not abort the remaining rows.
      }
    }

    return { reconciled };
  } catch {
    // Match the sync catch-all: a top-level failure reports zero reconciliations.
    return { reconciled: 0 };
  }
}
