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

export function applyRunAuditSnapshotImpl(store: TaskStore, snapshot: RunAuditSnapshot): { applied: number; skipped: number } {
    validateSnapshotEnvelope(snapshot);
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

export async function getTaskCommitAssociationsByLineageIdImpl(store: TaskStore, lineageId: string): Promise<TaskCommitAssociation[]> {
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
    const deleteStmt = store.db.prepare(
      `DELETE FROM task_commit_associations WHERE taskLineageId = ? AND matchedBy IN ('legacy-task-id-trailer', 'legacy-subject', 'manual-reconciliation')`,
    );
    deleteStmt.run(lineageId);
    for (const association of associations) {
      await store.upsertTaskCommitAssociation({ ...association, taskLineageId: lineageId });
    }
}

