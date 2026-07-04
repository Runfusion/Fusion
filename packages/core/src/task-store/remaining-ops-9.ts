/**
 * remaining-ops-9 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */

import { TaskStore } from "../store.js";
import { type RunAuditSnapshot, validateSnapshotEnvelope } from "../shared-mesh-state.js";
import { normalizeTaskCommitAssociation } from "../task-lineage.js";
import { TaskCommitAssociationRow } from "./row-types.js";
import { TaskCommitAssociation } from "../types.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";

export function applyRunAuditSnapshotImpl(store: TaskStore, snapshot: RunAuditSnapshot): { applied: number; skipped: number } {
    validateSnapshotEnvelope(snapshot);
    /*
    FNXC:PostgresCutover 2026-07-04:
    This is a synchronous mesh state-apply entry point. PostgreSQL inserts are
    async (Drizzle), so we cannot perform them here without converting the
    signature and every caller (the dashboard mesh route wraps this in an async
    applyDomain already). In backend mode, surface the snapshot as fully
    skipped — the authoritative async write path is recordRunAuditEvent /
    recordRunAuditEventWithinTransaction (data-layer.ts), invoked directly by
    the executor and the async mesh-apply route. Returning all-skipped mirrors
    the getTaskWorkflowSelection sync→backend degradation precedent.
    */
    if (store.backendMode) {
      return { applied: 0, skipped: snapshot.payload.entries.length };
    }
    let applied = 0;
    let skipped = 0;

    for (const entry of snapshot.payload.entries) {
      const exists = store.db.prepare("SELECT 1 FROM runAuditEvents WHERE id = ?").get(entry.id);
      if (exists) {
        skipped++;
        continue;
      }
      store.db.prepare(`
        INSERT INTO runAuditEvents (id, timestamp, taskId, agentId, runId, domain, mutationType, target, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id,
        entry.timestamp,
        entry.taskId ?? null,
        entry.agentId,
        entry.runId,
        entry.domain,
        entry.mutationType,
        entry.target,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      );
      applied++;
    }

    return { applied, skipped };
}

/*
FNXC:PostgresCutover 2026-07-04-00:00:
Async mesh state-apply for run_audit_events. Uses Drizzle INSERT ... ON CONFLICT (id) DO NOTHING
with .returning() to count applied vs skipped — preserves the snapshot's id/timestamp/agentId/runId
(NOT recordRunAuditEvent which generates new ids). Idempotent: re-applying the same snapshot is a no-op.
*/
export async function applyRunAuditSnapshotAsyncImpl(store: TaskStore, snapshot: RunAuditSnapshot): Promise<{ applied: number; skipped: number }> {
  validateSnapshotEnvelope(snapshot);
  if (!store.backendMode) return store.applyRunAuditSnapshot(snapshot);
  const entries = snapshot.payload.entries;
  if (entries.length === 0) return { applied: 0, skipped: 0 };
  const layer = store.asyncLayer!;
  let applied = 0;
  let skipped = 0;
  for (const entry of entries) {
    const inserted = await layer.db
      .insert(schema.project.runAuditEvents)
      .values({
        id: entry.id,
        timestamp: entry.timestamp,
        taskId: entry.taskId ?? null,
        agentId: entry.agentId,
        runId: entry.runId,
        domain: entry.domain,
        mutationType: entry.mutationType,
        target: entry.target,
        metadata: entry.metadata ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: schema.project.runAuditEvents.id });
    if (inserted.length > 0) {
      applied++;
    } else {
      skipped++;
    }
  }
  return { applied, skipped };
}

export async function getTaskCommitAssociationsByLineageIdImpl(store: TaskStore, lineageId: string): Promise<TaskCommitAssociation[]> {
    /*
    FNXC:PostgresCutover 2026-07-04:
    Backend-mode read of task_commit_associations by lineage id via async
    Drizzle. Mirrors the SQLite ORDER BY authoredAt DESC, createdAt DESC. The
    Drizzle select returns camelCase columns (schema-mapped), cast to the
    shared TaskCommitAssociationRow shape used by normalizeTaskCommitAssociation.
    */
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      const rows = await layer.db
        .select()
        .from(schema.project.taskCommitAssociations)
        .where(eq(schema.project.taskCommitAssociations.taskLineageId, lineageId))
        .orderBy(
          desc(schema.project.taskCommitAssociations.authoredAt),
          desc(schema.project.taskCommitAssociations.createdAt),
        );
      return (rows as TaskCommitAssociationRow[]).map((row) =>
        normalizeTaskCommitAssociation({
          ...row,
          note: row.note ?? undefined,
          additions: row.additions ?? undefined,
          deletions: row.deletions ?? undefined,
        }),
      );
    }
    const rows = store.db.prepare(
      `SELECT * FROM task_commit_associations WHERE taskLineageId = ? ORDER BY authoredAt DESC, createdAt DESC`,
    ).all(lineageId) as TaskCommitAssociationRow[];
    return rows.map((row) => normalizeTaskCommitAssociation({
      ...row,
      note: row.note ?? undefined,
      additions: row.additions ?? undefined,
      deletions: row.deletions ?? undefined,
    }));
}

export async function replaceLegacyTaskCommitAssociationsImpl(store: TaskStore,
    lineageId: string,
    associations: Array<Omit<TaskCommitAssociation, "id" | "createdAt" | "updatedAt" | "taskLineageId">>,
  ): Promise<void> {
    /*
    FNXC:PostgresCutover 2026-07-04:
    Backend-mode replacement of legacy-matched task_commit_associations: delete
    the legacy-/manual-matched rows for the lineage via async Drizzle, then
    re-insert through store.upsertTaskCommitAssociation (which itself dispatches
    to the async upsert in backend mode). Canonical-lineage-trailer rows are
    preserved (matched only on the three legacy sources), matching the SQLite
    path's IN-filter exactly.
    */
    if (store.backendMode) {
      const layer = store.asyncLayer!;
      await layer.db
        .delete(schema.project.taskCommitAssociations)
        .where(
          and(
            eq(schema.project.taskCommitAssociations.taskLineageId, lineageId),
            inArray(schema.project.taskCommitAssociations.matchedBy, [
              "legacy-task-id-trailer",
              "legacy-subject",
              "manual-reconciliation",
            ]),
          ),
        );
      for (const association of associations) {
        await store.upsertTaskCommitAssociation({ ...association, taskLineageId: lineageId });
      }
      return;
    }
    const deleteStmt = store.db.prepare(
      `DELETE FROM task_commit_associations WHERE taskLineageId = ? AND matchedBy IN ('legacy-task-id-trailer', 'legacy-subject', 'manual-reconciliation')`,
    );
    deleteStmt.run(lineageId);
    for (const association of associations) {
      await store.upsertTaskCommitAssociation({ ...association, taskLineageId: lineageId });
    }
}

