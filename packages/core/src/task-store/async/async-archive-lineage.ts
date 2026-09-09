/**
 * Async Drizzle archive / lineage helpers (U14).
 *
 * FNXC:TaskStoreArchiveLineage 2026-06-24-07:00:
 * Async equivalents of the sync SQLite archive and lineage call sites in
 * store.ts and archive-db.ts. These helpers target the PostgreSQL
 * `project.archived_tasks`, `archive.archived_tasks`, `project.tasks`, and the
 * document/artifact tables via Drizzle. Cold snapshot helpers remain for startup
 * reintegration and forensic compatibility only; no live task-archive operation calls them.
 * Soft-deleted and historical-sentinel parents stay outside ordinary document/artifact views,
 * while restoration moves recoverable snapshots directly into Complete.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { access } from "node:fs/promises";
import * as schema from "../../postgres/schema/index.js";
import { projectScopeFor, type AsyncDataLayer, type DbTransaction } from "../../postgres/data-layer.js";
import { ACTIVE_TASK_FILTER } from "./async-persistence.js";
import { projectPartition } from "./async-lifecycle.js";
import { buildTaskInsertValues, insertTaskRowInTransaction, readTaskRowInTransaction } from "./async-persistence.js";
import { acquireTaskAdvisoryXactLock } from "../task-advisory-lock.js";
import type { ArchivedTaskEntry, Task } from "../../types.js";
import { ARCHIVE_RESTORABLE_PERSISTENCE_COLUMNS } from "../archive-restoration-contract.js";
import { archiveEntryToTask } from "../serialization.js";

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
export interface TolerantArchivedTaskEntryRow {
  id: string;
  entry?: ArchivedTaskEntry;
  malformed: boolean;
}

/*
FNXC:TaskArchiveReintegration 2026-09-06-08:39:
Historical JSON corruption is isolated per archive row. The cursor still receives one carrier for
that row, so it can report and step past unreadable proof without deleting it or starving later tasks.
*/
export async function listArchivedTaskEntriesPageTolerant(
  db: AsyncDataLayer["db"] | DbTransaction,
  limit: number,
  offset: number,
  projectId?: string,
): Promise<TolerantArchivedTaskEntryRow[]> {
  if (limit <= 0) return [];
  const numericTaskSuffix = sql`COALESCE(substring(${schema.archive.archivedTasks.id} from '-([0-9]+)$')::numeric, 0)`;
  const rows = await db
    .select({
      id: schema.archive.archivedTasks.id,
      taskJson: schema.archive.archivedTasks.taskJson,
    })
    .from(schema.archive.archivedTasks)
    .where(eq(schema.archive.archivedTasks.projectId, projectPartition(projectId)))
    .orderBy(
      desc(schema.archive.archivedTasks.archivedAt),
      desc(numericTaskSuffix),
      desc(schema.archive.archivedTasks.id),
    )
    .limit(limit)
    .offset(offset);
  return rows.map((row) => {
    try {
      return { id: row.id, entry: JSON.parse(row.taskJson) as ArchivedTaskEntry, malformed: false };
    } catch {
      return { id: row.id, malformed: true };
    }
  });
}

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
 * FNXC:TaskStoreArchiveLineage 2026-06-24-07:25:
 * Reintegrate a task from its historical archive snapshot during store open.
 * It re-inserts the project row from the snapshot, clears historical archive
 * state, and removes the cold-storage snapshot once the live row is authoritative.
 *
 * Documents and artifacts retained with the historical snapshot re-appear
 * because the parent task is live again (VAL-CROSS-015 —
 * "preserves them for restore").
 *
 * @param layer The async data layer.
 * @param entry The archive snapshot to restore from.
 * @param taskRecord The task fields to re-insert (caller builds from the entry).
 * @param context Serialization context for the task insert.
 */
async function pathExists(path: unknown): Promise<boolean> {
  if (typeof path !== "string" || !path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * FNXC:TaskStoreArchiveLineage 2026-08-15-05:39:
 * Archive disposal removes each workspace worktree and its `fusion/<id>` branch but does not
 * persist its in-memory map mutation. Restore therefore drops only entries whose exact recorded
 * paths are gone, preventing reconcileWorkspacePartialLands FORK-A from parking the card failed.
 */
async function reconcileRestoredWorktreeState(
  workspaceWorktrees: unknown,
  worktree: unknown,
): Promise<{ workspaceWorktrees: Record<string, unknown> | null; worktree: string | null }> {
  const entries = workspaceWorktrees && typeof workspaceWorktrees === "object" && !Array.isArray(workspaceWorktrees)
    ? Object.entries(workspaceWorktrees as Record<string, unknown>)
    : [];
  const surviving = await Promise.all(entries.map(async ([repoRel, value]) => {
    const worktreePath = value && typeof value === "object" && !Array.isArray(value)
      ? (value as { worktreePath?: unknown }).worktreePath
      : undefined;
    return typeof worktreePath === "string" && await pathExists(worktreePath) ? [repoRel, value] as const : undefined;
  }));
  const retained = surviving.filter((entry): entry is readonly [string, unknown] => entry !== undefined);
  return {
    workspaceWorktrees: retained.length > 0 ? Object.fromEntries(retained) : null,
    worktree: typeof worktree === "string" && await pathExists(worktree) ? worktree : null,
  };
}

export type RestoreArchivedTaskOutcome = "restored" | "live-won" | "user-paused";

function collectMissingHistoricalValues(
  existing: Record<string, unknown> | undefined,
  evidence: Record<string, unknown>,
  projectId: string | undefined,
  lineageId: string,
): { values: Record<string, unknown>; fields: string[] } {
  const evidenceValues = buildTaskInsertValues(evidence, { lineageId }, projectId);
  const values: Record<string, unknown> = {};
  const fields: string[] = [];
  for (const [field, columns] of Object.entries(ARCHIVE_RESTORABLE_PERSISTENCE_COLUMNS)) {
    if (evidence[field] === undefined) continue;
    let recovered = false;
    for (const column of columns) {
      const liveValue = existing?.[column];
      const evidenceValue = evidenceValues[column];
      if ((liveValue === null || liveValue === undefined) && evidenceValue !== null && evidenceValue !== undefined) {
        values[column] = evidenceValue;
        recovered = true;
      }
    }
    if (recovered) fields.push(field);
  }
  return { values, fields };
}

export interface SupplementTaskHistoryResult {
  outcome: "supplemented" | "no-op" | "missing" | "user-paused";
  fields: string[];
}

/*
FNXC:TaskArchiveReintegration 2026-09-06-08:39:
Operational repair accepts only exact structured evidence and fills NULL historical columns under the
same project/task advisory lock as archive restoration. Existing values, deleted rows, runtime fields,
and user-paused tasks remain untouched; dry-run executes the same classification without writing.
*/
export async function supplementTaskHistoryFromEvidence(
  layer: AsyncDataLayer,
  taskId: string,
  evidence: Partial<Task>,
  options: { dryRun?: boolean } = {},
): Promise<SupplementTaskHistoryResult> {
  return await layer.transactionImmediate(async (tx) => {
    await acquireTaskAdvisoryXactLock(tx, layer.projectId, taskId);
    const existing = await readTaskRowInTransaction(tx, taskId, { includeDeleted: true }, layer.projectId);
    if (!existing || existing.deletedAt) return { outcome: "missing", fields: [] };
    if (existing.userPaused) return { outcome: "user-paused", fields: [] };
    const supplement = collectMissingHistoricalValues(
      existing as unknown as Record<string, unknown>,
      evidence as Record<string, unknown>,
      layer.projectId,
      existing.lineageId as string,
    );
    if (supplement.fields.length === 0) return { outcome: "no-op", fields: [] };
    if (!options.dryRun) {
      await tx.update(schema.project.tasks).set(supplement.values).where(and(
        eq(schema.project.tasks.projectId, projectPartition(layer.projectId)),
        eq(schema.project.tasks.id, taskId),
      ));
    }
    return { outcome: "supplemented", fields: supplement.fields };
  });
}

/**
 * Atomically make one historical cold snapshot subordinate to the live task table.
 *
 * FNXC:TaskArchiveRemoval 2026-09-04-19:28:
 * The one-way archive migration is serialized by the same project/task advisory lock as ordinary
 * lifecycle mutations. A surviving live row wins a collision, a legacy soft-deleted row is revived,
 * and a snapshot whose project row was physically removed is recreated from `taskRecord`; only then
 * is the cold row deleted. User-paused rows retain both representations for a later maintenance pass.
 */
export async function restoreTaskFromArchive(
  layer: AsyncDataLayer,
  entry: ArchivedTaskEntry,
  options: { now?: string; targetColumn?: string; taskRecord?: Record<string, unknown> } = {},
): Promise<{ outcome: RestoreArchivedTaskOutcome; moved: boolean }> {
  const now = options.now ?? new Date().toISOString();

  return await layer.transactionImmediate(async (tx) => {
    await acquireTaskAdvisoryXactLock(tx, layer.projectId, entry.id);
    const existing = await readTaskRowInTransaction(tx, entry.id, { includeDeleted: true }, layer.projectId);
    if (existing?.userPaused) {
      return { outcome: "user-paused", moved: false };
    }

    const taskRecord = options.taskRecord ?? archiveEntryToTask(entry);
    const missingHistoricalValues = collectMissingHistoricalValues(
      existing as unknown as Record<string, unknown> | undefined,
      taskRecord as Record<string, unknown>,
      layer.projectId,
      entry.lineageId,
    ).values;

    if (existing && !existing.deletedAt) {
      const moved = existing.column === "archived" && options.targetColumn !== undefined;
      /*
      FNXC:TaskArchiveReintegration 2026-09-06-08:39:
      A live row remains authoritative during a cold-snapshot collision, but NULL historical columns
      are not authoritative evidence. Fill only those gaps from the exact snapshot under the same
      project/task lock, then delete the cold proof after the update succeeds.
      */
      await tx
        .update(schema.project.tasks)
        .set({
          ...missingHistoricalValues,
          ...(moved ? {
            column: options.targetColumn,
            columnMovedAt: now,
          } : {}),
          updatedAt: now,
        })
        .where(and(
          eq(schema.project.tasks.projectId, projectPartition(layer.projectId)),
          eq(schema.project.tasks.id, entry.id),
        ));
      await deleteArchivedTaskEntry(tx, entry.id, layer.projectId);
      return { outcome: "live-won", moved };
    }

    if (existing) {
      const reconciledWorktreeState = await reconcileRestoredWorktreeState(
        existing.workspaceWorktrees,
        existing.worktree,
      );
      await tx
        .update(schema.project.tasks)
        .set({
          ...missingHistoricalValues,
          deletedAt: null,
          workspaceWorktrees: reconciledWorktreeState.workspaceWorktrees,
          worktree: reconciledWorktreeState.worktree,
          /*
          FNXC:TaskStoreArchiveLineage 2026-08-01-23:23 DELIBERATE-LITERAL — STATE MARKER:
          Restore exposes the durable row before the caller's validated move out of the archive state.
          This is a physical transition sentinel, not a workflow lane id.
          */
          column: options.targetColumn ?? "archived",
          ...(options.targetColumn ? { columnMovedAt: now } : {}),
          updatedAt: now,
        })
        .where(and(
          eq(schema.project.tasks.projectId, projectPartition(layer.projectId)),
          eq(schema.project.tasks.id, entry.id),
        ));
    } else {
      await insertTaskRowInTransaction(
        tx,
        {
          ...taskRecord,
          column: options.targetColumn ?? "archived",
          columnMovedAt: options.targetColumn ? now : taskRecord.columnMovedAt,
          updatedAt: now,
          deletedAt: undefined,
        },
        { lineageId: entry.lineageId },
        layer.projectId,
      );
    }

    await deleteArchivedTaskEntry(tx, entry.id, layer.projectId);
    return { outcome: "restored", moved: true };
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
  projectId?: string,
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
      and(
        eq(schema.project.tasks.id, schema.project.artifacts.taskId),
        eq(schema.project.tasks.projectId, schema.project.artifacts.projectId),
      ),
    )
    .where(
      and(
        eq(schema.project.artifacts.taskId, taskId),
        projectScopeFor(schema.project.artifacts.projectId, projectId),
        projectScopeFor(schema.project.tasks.projectId, projectId),
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
  projectId?: string,
): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select()
    .from(schema.project.artifacts)
    .where(and(
      eq(schema.project.artifacts.taskId, taskId),
      projectScopeFor(schema.project.artifacts.projectId, projectId),
    ));
  return rows as unknown as Record<string, unknown>[];
}
