/**
 * FNXC:CodeOrganization 2026-07-15-00:00:
 * Domain module for task commit-association persistence (was remaining-ops-9).
 * Migrated out of opaque remaining-ops dump naming per package organization plan.
 */

/**
 * remaining-ops-9 operations.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */

import { TaskStore } from "../store.js";
import { normalizeTaskCommitAssociation } from "../task-lineage.js";
import { TaskCommitAssociationRow } from "./row-types.js";
import { TaskCommitAssociation } from "../types.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";


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

