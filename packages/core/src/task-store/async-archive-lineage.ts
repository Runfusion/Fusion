/**
 * Async Drizzle archive / lineage helpers (U14).
 *
 * FNXC:TaskStoreArchiveLineage 2026-06-24-07:00:
 * Async equivalents of the sync SQLite archive and lineage call sites in
 * store.ts and archive-db.ts. These helpers target the PostgreSQL
 * `project.archived_tasks`, `archive.archived_tasks`, `project.tasks`, and the
 * document/artifact tables via Drizzle, and preserve the load-bearing archive
 * and lineage invariants:
 *
 *   VAL-CROSS-014 — Soft-deleting a child task allows its parent to be deleted
 *     (the soft-deleted child no longer blocks). The lineage-integrity gate
 *     (from async-lifecycle) excludes soft-deleted children, so a parent whose
 *     only children are soft-deleted can be deleted immediately.
 *   VAL-CROSS-015 — Archiving a parent task scopes its documents/artifacts out
 *     of live views but preserves them for restore. When a task is archived,
 *     its `task_documents` and `artifacts` rows are retained (the FK is
 *     ON DELETE CASCADE, not ON DELETE SET NULL, so an archive — which is a
 *     soft column move, not a row delete — keeps them). Live document/artifact
 *     views filter by the parent task's live state (`deleted_at IS NULL` and
 *     `column != 'archived'`), so the rows disappear from live views but
 *     remain for an unarchive restore.
 *
 * Transition context (see library/taskstore-persistence-notes.md):
 *   `getDatabase()` still returns the sync `Database` until U15 flips it. The
 *   TaskStore facade keeps its sync archive path (the gate depends on it).
 *   These helpers are the async target the migrating store and the PostgreSQL
 *   integration tests consume. They program against the stable `AsyncDataLayer`
 *   interface (U4), not the underlying driver.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import { ACTIVE_TASK_FILTER } from "./async-persistence.js";
import { findLiveLineageChildren, projectPartition, removeLineageReferences } from "./async-lifecycle.js";
import {
  softDeleteTaskRowInTransaction,
  readTaskRowInTransaction,
} from "./async-persistence.js";
import type { ArchivedTaskEntry } from "../types.js";

/**
 * FNXC:TaskStoreArchiveLineage 2026-06-24-07:05:
 * The "live parent" predicate for the document/artifact visibility gate
 * (VAL-CROSS-015). Documents and artifacts scoped to a task are surfaced in
 * live views only when their parent task is live: `deleted_at IS NULL` (not
 * soft-deleted) AND `column != 'archived'` (not archived). When the parent is
 * archived or soft-deleted, the rows are retained but filtered out of live
 * views — they remain for an unarchive/restore.
 *
 * This predicate is the join condition for `task_documents` / `artifacts` →
 * `tasks`. It is the async equivalent of the sync
 * `taskExists && taskExists.column !== 'archived'` check in
 * `upsertTaskDocument` and the `hasActiveTask` gate in `getTaskDocument`.
 */
export function liveParentFilter(taskIdColumn: ReturnType<typeof eq>) {
  // The caller passes an equality fragment like eq(schema.project.tasks.id, taskId).
  // We compose the live-parent conditions on top.
  return and(taskIdColumn, ACTIVE_TASK_FILTER, sql`${schema.project.tasks.column} != 'archived'`);
}

/**
 * FNXC:TaskStoreArchiveLineage 2026-06-24-07:10:
 * Upsert an archived-task snapshot into the cold-storage archive schema
 * (`archive.archived_tasks`). This is the async equivalent of
 * `archiveDb.upsert(entry)` in store.ts. The snapshot is an append-only copy
 * of the task at archive time; it is retained indefinitely for restore and
 * forensic search.
 *
 * The archive schema stores the full task JSON in `task_json` so the restore
 * path can reconstruct the task exactly. The denormalized columns
 * (`title`, `description`, `comments`, timestamps) support cold-storage search
 * without parsing the JSON blob.
 *
 * @param db The Drizzle instance (archive writes are not transactional with
 *   the project archive column move in the sync path; the async path keeps
 *   the same separation — the archive snapshot is written before the project
 *   row is soft-deleted, and a missing snapshot is recoverable from the
 *   project row's pre-archive state).
 * @param entry The archived-task snapshot to upsert.
 */
export async function upsertArchivedTaskEntry(
  db: AsyncDataLayer["db"] | DbTransaction,
  entry: ArchivedTaskEntry,
  projectId?: string,
): Promise<void> {
  await db
    .insert(schema.archive.archivedTasks)
    .values({
      id: entry.id,
      // FNXC:MultiProjectIsolation 2026-07-12: stamp the owning project so the
      // shared cold-storage archive can be scoped per project on reads. Stable
      // for the row's lifetime — the conflict-update below never rewrites it.
      projectId: projectPartition(projectId),
      taskJson: JSON.stringify(entry),
      prompt: entry.prompt ?? null,
      archivedAt: entry.archivedAt,
      title: entry.title ?? null,
      description: entry.description,
      comments: entry.comments ?? [],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      columnMovedAt: entry.columnMovedAt ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.archive.archivedTasks.projectId, schema.archive.archivedTasks.id],
      set: {
        taskJson: JSON.stringify(entry),
        prompt: entry.prompt ?? null,
        archivedAt: entry.archivedAt,
        title: entry.title ?? null,
        description: entry.description,
        comments: entry.comments ?? [],
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        columnMovedAt: entry.columnMovedAt ?? null,
      },
    });
}

/**
 * Find an archived-task snapshot by id in the cold-storage archive schema.
 * This is the async equivalent of `archiveDb.get(id)`. Returns `undefined`
 * if no snapshot exists.
 */
export async function findArchivedTaskEntry(
  db: AsyncDataLayer["db"] | DbTransaction,
  id: string,
  projectId?: string,
): Promise<ArchivedTaskEntry | undefined> {
  const rows = await db
    .select({ taskJson: schema.archive.archivedTasks.taskJson })
    .from(schema.archive.archivedTasks)
    .where(and(
      eq(schema.archive.archivedTasks.projectId, projectPartition(projectId)),
      eq(schema.archive.archivedTasks.id, id),
    ))
    .limit(1);
  const row = rows[0];
  if (!row?.taskJson) return undefined;
  try {
    return JSON.parse(row.taskJson) as ArchivedTaskEntry;
  } catch {
    return undefined;
  }
}

/**
 * List all archived-task snapshots, newest-first by archivedAt. This is the
 * async equivalent of `archiveDb.list()`.
 */
export async function listArchivedTaskEntries(
  db: AsyncDataLayer["db"] | DbTransaction,
  projectId?: string,
): Promise<ArchivedTaskEntry[]> {
  const rows = await db
    .select({ taskJson: schema.archive.archivedTasks.taskJson })
    .from(schema.archive.archivedTasks)
    .where(eq(schema.archive.archivedTasks.projectId, projectPartition(projectId)))
    .orderBy(desc(schema.archive.archivedTasks.archivedAt));
  const entries: ArchivedTaskEntry[] = [];
  for (const row of rows) {
    if (!row.taskJson) continue;
    try {
      entries.push(JSON.parse(row.taskJson) as ArchivedTaskEntry);
    } catch {
      // skip malformed
    }
  }
  return entries;
}

/**
 * Delete an archived-task snapshot from cold storage. This is the async
 * equivalent of `archiveDb.delete(id)`. Used when a task is permanently
 * purged or when an unarchive restores the task and the snapshot is no
 * longer needed (the project row becomes the source of truth again).
 */
export async function deleteArchivedTaskEntry(
  db: AsyncDataLayer["db"] | DbTransaction,
  id: string,
  projectId?: string,
): Promise<void> {
  await db
    .delete(schema.archive.archivedTasks)
    .where(and(
      eq(schema.archive.archivedTasks.projectId, projectPartition(projectId)),
      eq(schema.archive.archivedTasks.id, id),
    ));
}

/**
 * FNXC:TaskStoreArchiveLineage 2026-06-24-07:15:
 * Filter the given ids down to those that have an archived-task snapshot.
 * This is the async equivalent of `archiveDb.filterArchived(ids)`. The sync
 * `checkForChanges` loop uses it to distinguish a real task deletion (row gone
 * from `tasks`, not in archive) from an archive (row gone from `tasks`, present
 * in archive). Single-shot query, chunked to stay under parameter limits.
 *
 * @param db The Drizzle instance.
 * @param ids The task ids to check.
 * @returns The subset of `ids` that have an archived snapshot.
 */
export async function filterArchivedTaskEntries(
  db: AsyncDataLayer["db"] | DbTransaction,
  ids: readonly string[],
  projectId?: string,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const result = new Set<string>();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await db
      .select({ id: schema.archive.archivedTasks.id })
      .from(schema.archive.archivedTasks)
      .where(and(
        eq(schema.archive.archivedTasks.projectId, projectPartition(projectId)),
        inArray(schema.archive.archivedTasks.id, chunk),
      ));
    for (const row of rows) result.add(row.id);
  }
  return result;
}

/**
 * FNXC:TaskStoreArchiveLineage 2026-06-24-07:20:
 * Archive a parent task atomically: lineage gate, lineage clear, archive
 * snapshot insert, and soft-delete, all in one transaction. This composes the
 * async-lifecycle and async-persistence helpers into the archive path.
 *
 * Behavioral contract (VAL-CROSS-014 + VAL-CROSS-015):
 *   1. **Lineage gate** — if the parent has live children and the caller did
 *      not pass `removeLineageReferences: true`, the archive is rejected
 *      (throws `TaskHasLineageChildrenError`-equivalent by returning the live
 *      child ids). Soft-deleted children are excluded by the gate, so a parent
 *      whose only child was soft-deleted archives immediately (VAL-CROSS-014).
 *   2. **Lineage clear** — when `removeLineageReferences: true`, the live
 *      children's `source_parent_task_id` is cleared so they no longer block.
 *   3. **Archive snapshot** — a cold-storage snapshot is written to
 *      `archive.archived_tasks` for restore (VAL-CROSS-015).
 *   4. **Soft-delete** — the project row is soft-deleted (`deleted_at` set,
 *      `column = 'archived'`). The documents and artifacts rows are retained
 *      (the FK is ON DELETE CASCADE, and a soft-delete is an UPDATE not a
 *      DELETE, so the rows survive). They are scoped out of live views because
 *      the parent task is now archived (VAL-CROSS-015).
 *
 * @param layer The async data layer.
 * @param taskId The task to archive.
 * @param entry The archive snapshot to write (caller builds this from the task).
 * @param options Archive options.
 * @returns The live child ids that blocked the archive (empty if it succeeded),
 *   or `null` if the archive succeeded.
 */
export async function archiveParentTaskWithLineageGate(
  layer: AsyncDataLayer,
  taskId: string,
  entry: ArchivedTaskEntry,
  options: { removeLineageReferences?: boolean; now?: string } = {},
): Promise<{ archived: true } | { archived: false; liveChildIds: string[] }> {
  const now = options.now ?? new Date().toISOString();

  return layer.transactionImmediate(async (tx) => {
    // 1. Lineage gate — check for live children inside the transaction.
    const liveChildIds = await findLiveLineageChildren(tx, taskId, layer.projectId);
    if (liveChildIds.length > 0 && !options.removeLineageReferences) {
      return { archived: false as const, liveChildIds };
    }

    // 2. Lineage clear (if requested and there are live children).
    if (liveChildIds.length > 0 && options.removeLineageReferences) {
      await removeLineageReferences(tx, taskId, liveChildIds, now, layer.projectId);
    }

    // 3. Archive snapshot to cold storage (VAL-CROSS-015 — preserves for restore).
    // FNXC:MultiProjectIsolation 2026-07-12: stamped with the bound project.
    await upsertArchivedTaskEntry(tx, entry, layer.projectId);

    // 4. Soft-delete the project row. Documents/artifacts are retained because
    //    this is an UPDATE, not a DELETE — the ON DELETE CASCADE FK does not
    //    fire. They are scoped out of live views because the parent is now
    //    archived (column = 'archived', deleted_at IS NOT NULL).
    //
    //    HAZARD FIX (runtime-workflow-async): use softDeleteTaskRowInTransaction(tx)
    //    so the UPDATE participates in this transaction. The previous call used
    //    softDeleteTaskRow(layer) which bound layer.db and ran OUTSIDE the txn,
    //    breaking atomicity (a later rollback left the soft-delete persisted).
    await softDeleteTaskRowInTransaction(tx, taskId, now, false, layer.projectId);

    return { archived: true as const };
  });
}

/**
 * FNXC:TaskStoreArchiveLineage 2026-06-24-07:25:
 * Restore a task from its archive snapshot (the unarchive path). This is the
 * async equivalent of `restoreFromArchive(entry)`. It re-inserts the project
 * row from the snapshot, clears the soft-delete, and removes the cold-storage
 * snapshot (the project row is the source of truth again).
 *
 * Documents and artifacts that were scoped out of live views during the
 * archive re-appear because the parent task is live again (VAL-CROSS-015 —
 * "preserves them for restore").
 *
 * @param layer The async data layer.
 * @param entry The archive snapshot to restore from.
 * @param taskRecord The task fields to re-insert (caller builds from the entry).
 * @param context Serialization context for the task insert.
 */
export async function restoreTaskFromArchive(
  layer: AsyncDataLayer,
  entry: ArchivedTaskEntry,
  options: { now?: string } = {},
): Promise<void> {
  const now = options.now ?? new Date().toISOString();

  await layer.transactionImmediate(async (tx) => {
    // Clear the soft-delete: set column back from 'archived', clear deleted_at.
    // The project row may still exist (soft-delete path) or may have been
    // hard-deleted (cleanup path). Handle both.
    //
    // HAZARD FIX (runtime-workflow-async): use readTaskRowInTransaction(tx) so
    // the read participates in this transaction (consistent snapshot). The
    // previous call used readTaskRow(layer) which bound layer.db and read
    // OUTSIDE the txn.
    const existing = await readTaskRowInTransaction(tx, entry.id, { includeDeleted: true }, layer.projectId);
    if (existing) {
      // Row exists (was soft-deleted). Restore it: clear deleted_at, keep
      // column as "archived" so the caller (unarchiveTaskImpl) can verify the
      // task is in the archived column and then moveTask it to the target
      // column. Setting column to "done" here would break the unarchive guard
      // ("task is in 'done', must be in 'archived'").
      await tx
        .update(schema.project.tasks)
        .set({
          deletedAt: null,
          column: "archived",
          updatedAt: now,
        })
        .where(and(
          eq(schema.project.tasks.projectId, projectPartition(layer.projectId)),
          eq(schema.project.tasks.id, entry.id),
        ));
    } else {
      // Row was hard-deleted. We cannot fully reconstruct it from the archive
      // snapshot alone here (the entry carries the public Task shape, not the
      // full row). The caller (store.ts unarchive path) handles full
      // reconstruction via the task-dir files. This helper clears the archive
      // snapshot so the next read falls through to the project row.
    }

    // Remove the cold-storage snapshot (project row is the source of truth again).
    await deleteArchivedTaskEntry(tx, entry.id, layer.projectId);
  });
}

// ── Document / artifact live-view scoping (VAL-CROSS-015) ───────────────

/**
 * FNXC:TaskStoreArchiveLineage 2026-06-24-07:30:
 * List task documents for a LIVE parent task only (VAL-CROSS-015). Documents
 * scoped to an archived or soft-deleted task are NOT surfaced in this live
 * view — they are retained in the database for restore but filtered out.
 *
 * This is the async equivalent of the sync `hasActiveTask(taskId)` gate in
 * `getTaskDocument` / `listTaskDocuments`. The join to `tasks` with the
 * live-parent filter ensures documents disappear from live views when their
 * parent is archived, and re-appear when the parent is unarchived.
 *
 * @param db The Drizzle instance.
 * @param taskId The parent task id.
 * @returns The live documents for the task, or an empty array if the task is
 *   archived/soft-deleted/not found.
 */
export async function listLiveTaskDocuments(
  db: AsyncDataLayer["db"] | DbTransaction,
  taskId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select({
      id: schema.project.taskDocuments.id,
      taskId: schema.project.taskDocuments.taskId,
      key: schema.project.taskDocuments.key,
      content: schema.project.taskDocuments.content,
      revision: schema.project.taskDocuments.revision,
      author: schema.project.taskDocuments.author,
      metadata: schema.project.taskDocuments.metadata,
      createdAt: schema.project.taskDocuments.createdAt,
      updatedAt: schema.project.taskDocuments.updatedAt,
    })
    .from(schema.project.taskDocuments)
    .innerJoin(
      schema.project.tasks,
      eq(schema.project.tasks.id, schema.project.taskDocuments.taskId),
    )
    .where(
      and(
        eq(schema.project.taskDocuments.taskId, taskId),
        ACTIVE_TASK_FILTER,
        sql`${schema.project.tasks.column} != 'archived'`,
      ),
    );
  return rows as unknown as Record<string, unknown>[];
}

/**
 * FNXC:TaskStoreArchiveLineage 2026-06-24-07:35:
 * List artifacts for a LIVE parent task only (VAL-CROSS-015). Artifacts
 * scoped to an archived or soft-deleted task are NOT surfaced in this live
 * view — they are retained for restore but filtered out.
 *
 * @param db The Drizzle instance.
 * @param taskId The parent task id.
 * @returns The live artifacts for the task, or an empty array if the task is
 *   archived/soft-deleted/not found.
 */
export async function listLiveArtifacts(
  db: AsyncDataLayer["db"] | DbTransaction,
  taskId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select({
      id: schema.project.artifacts.id,
      type: schema.project.artifacts.type,
      title: schema.project.artifacts.title,
      description: schema.project.artifacts.description,
      mimeType: schema.project.artifacts.mimeType,
      sizeBytes: schema.project.artifacts.sizeBytes,
      uri: schema.project.artifacts.uri,
      content: schema.project.artifacts.content,
      authorId: schema.project.artifacts.authorId,
      authorType: schema.project.artifacts.authorType,
      taskId: schema.project.artifacts.taskId,
      metadata: schema.project.artifacts.metadata,
      createdAt: schema.project.artifacts.createdAt,
      updatedAt: schema.project.artifacts.updatedAt,
    })
    .from(schema.project.artifacts)
    .innerJoin(
      schema.project.tasks,
      eq(schema.project.tasks.id, schema.project.artifacts.taskId),
    )
    .where(
      and(
        eq(schema.project.artifacts.taskId, taskId),
        ACTIVE_TASK_FILTER,
        sql`${schema.project.tasks.column} != 'archived'`,
      ),
    );
  return rows as unknown as Record<string, unknown>[];
}

/**
 * FNXC:TaskStoreArchiveLineage 2026-06-24-07:40:
 * Forensic read: list ALL task documents for a task, including those scoped
 * to an archived or soft-deleted parent. This is the admin/restore view that
 * VAL-CROSS-015 references ("preserves them for restore"). Live views use
 * `listLiveTaskDocuments` instead.
 *
 * @param db The Drizzle instance.
 * @param taskId The parent task id.
 * @returns All documents for the task, regardless of parent live state.
 */
export async function listAllTaskDocuments(
  db: AsyncDataLayer["db"] | DbTransaction,
  taskId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select()
    .from(schema.project.taskDocuments)
    .where(eq(schema.project.taskDocuments.taskId, taskId));
  return rows as unknown as Record<string, unknown>[];
}

/**
 * Forensic read: list ALL artifacts for a task, including those scoped to an
 * archived or soft-deleted parent. Companion to `listAllTaskDocuments`.
 */
export async function listAllArtifacts(
  db: AsyncDataLayer["db"] | DbTransaction,
  taskId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select()
    .from(schema.project.artifacts)
    .where(eq(schema.project.artifacts.taskId, taskId));
  return rows as unknown as Record<string, unknown>[];
}
