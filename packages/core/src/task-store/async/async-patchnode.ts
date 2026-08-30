import { and, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { buildPatchnodeEntryId, buildPatchnodeEntryInput } from "../../board/patchnode.js";
import { storeLog } from "../../store.js";
import * as schema from "../../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../../postgres/data-layer.js";
import type { Column, Task } from "../../types.js";
import type { PatchnodeEntry, PatchnodeQuery } from "../../types/task/patchnode.js";

/*
FNXC:PatchnodeLedger 2026-08-28-12:16:
This accessor follows the project-scoped append-only activity shape but deliberately has no expiry, deletion, or size-limit path. Patchnode is permanent operator history, not a short-lived activity window.

FNXC:PatchnodeLedger 2026-08-28-12:16:
Backfill is bounded and insert-only. A delivery superseded before Patchnode shipped left no durable lane, occurrence, or point-in-time summary evidence, so reconciliation must not invent one from a later task state.
*/

const RECONCILE_PAGE_SIZE = 500;
const RECONCILE_MAX_PAGES = 40;

type PatchnodeRow = typeof schema.project.patchnodeEntries.$inferSelect;
type PatchnodeInput = Omit<PatchnodeEntry, "revertedAt" | "revertedCommitSha"> & {
  revertedAt?: string | null;
  revertedCommitSha?: string | null;
};

const mapPatchnodeRow = (row: PatchnodeRow): PatchnodeEntry => ({
  entryId: row.entryId,
  taskId: row.taskId,
  kind: row.kind as PatchnodeEntry["kind"],
  occurrenceKey: row.occurrenceKey,
  day: row.day,
  occurredAt: row.occurredAt,
  title: row.title,
  body: row.body,
  revertsEntryId: row.revertsEntryId,
  revertedAt: row.revertedAt,
  revertedCommitSha: row.revertedCommitSha,
});

function requireProjectId(layer: AsyncDataLayer): string {
  if (!layer.projectId) throw new Error("Patchnode requires AsyncDataLayer.projectId");
  return layer.projectId;
}

export async function appendPatchnodeEntryInTransaction(
  tx: DbTransaction,
  projectId: string,
  input: PatchnodeInput,
): Promise<PatchnodeEntry | null> {
  const scopedProjectId = projectId.trim();
  if (!scopedProjectId) throw new Error("Patchnode transaction write requires projectId");
  const rows = await tx.insert(schema.project.patchnodeEntries).values({
    projectId: scopedProjectId,
    entryId: input.entryId,
    taskId: input.taskId,
    kind: input.kind,
    occurrenceKey: input.occurrenceKey,
    day: input.day,
    occurredAt: input.occurredAt,
    title: input.title,
    body: input.body,
    revertsEntryId: input.revertsEntryId ?? null,
    revertedAt: input.revertedAt ?? null,
    revertedCommitSha: input.revertedCommitSha ?? null,
    createdAt: input.occurredAt,
  }).onConflictDoNothing().returning();
  return rows[0] ? mapPatchnodeRow(rows[0]) : null;
}

export async function appendPatchnodeEntry(layer: AsyncDataLayer, input: PatchnodeInput): Promise<PatchnodeEntry | null> {
  const projectId = requireProjectId(layer);
  return layer.transactionImmediate((tx) => appendPatchnodeEntryInTransaction(tx, projectId, input));
}

export async function capturePatchnodeCompletionInTransaction(
  tx: DbTransaction,
  projectId: string,
  task: Task,
  completeColumns: ReadonlySet<string>,
): Promise<PatchnodeEntry | null> {
  if (!completeColumns.has(task.column) || !task.columnMovedAt || !Number.isFinite(Date.parse(task.columnMovedAt))) return null;
  return appendPatchnodeEntryInTransaction(tx, projectId, buildPatchnodeEntryInput(task, "completed", task.columnMovedAt));
}

async function findLatestCompletionWithDb(
  db: AsyncDataLayer["db"] | DbTransaction,
  projectId: string,
  taskId: string,
  options: { noLaterThan?: string } = {},
): Promise<PatchnodeEntry | null> {
  const table = schema.project.patchnodeEntries;
  const markerMs = options.noLaterThan === undefined ? undefined : Date.parse(options.noLaterThan);
  if (markerMs !== undefined && !Number.isFinite(markerMs)) return null;
  const occurrenceAtOrBeforeMarker = markerMs === undefined
    ? undefined
    : sql<boolean>`CASE WHEN ${table.occurrenceKey} ~ '^[0-9]+$' THEN (${table.occurrenceKey})::numeric <= ${markerMs} ELSE false END`;
  const rows = await db.select().from(table).where(and(
    eq(table.projectId, projectId),
    eq(table.taskId, taskId),
    eq(table.kind, "completed"),
    occurrenceAtOrBeforeMarker,
  )).orderBy(
    markerMs === undefined
      ? desc(table.occurredAt)
      : desc(sql<number>`CASE WHEN ${table.occurrenceKey} ~ '^[0-9]+$' THEN (${table.occurrenceKey})::numeric END`),
    desc(table.entryId),
  ).limit(1);
  return rows[0] ? mapPatchnodeRow(rows[0]) : null;
}

export async function findLatestPatchnodeCompletion(layer: AsyncDataLayer, taskId: string): Promise<PatchnodeEntry | null> {
  return findLatestCompletionWithDb(layer.db, requireProjectId(layer), taskId);
}

/*
FNXC:PatchnodeRevertReconciliation 2026-08-28-22:17:
A cancellation names the delivery that was in effect when it happened, so `noLaterThan` fences the pairing to a delivery at or before that instant. A retried already-reverted revert therefore re-affirms its original episode instead of cancelling a re-delivery that shipped afterwards; a genuine new revert still pairs with the latest delivery.
*/
export async function findLatestPatchnodeCompletionInTransaction(
  tx: DbTransaction,
  projectId: string,
  taskId: string,
  options: { noLaterThan?: string } = {},
): Promise<PatchnodeEntry | null> {
  return findLatestCompletionWithDb(tx, projectId, taskId, options);
}

async function findPatchnodeRevertForMarker(
  layer: AsyncDataLayer,
  taskId: string,
  revertedAt: string,
): Promise<PatchnodeEntry | null> {
  const rows = await layer.db.select().from(schema.project.patchnodeEntries).where(and(
    eq(schema.project.patchnodeEntries.projectId, requireProjectId(layer)),
    eq(schema.project.patchnodeEntries.taskId, taskId),
    eq(schema.project.patchnodeEntries.kind, "reverted"),
    eq(schema.project.patchnodeEntries.occurredAt, revertedAt),
  )).orderBy(desc(schema.project.patchnodeEntries.entryId)).limit(1);
  return rows[0] ? mapPatchnodeRow(rows[0]) : null;
}

async function markRevertedWithDb(
  db: AsyncDataLayer["db"] | DbTransaction,
  projectId: string,
  entryId: string,
  patch: { revertedAt: string; revertedCommitSha?: string },
): Promise<PatchnodeEntry | null> {
  const rows = await db.update(schema.project.patchnodeEntries).set({
    revertedAt: patch.revertedAt,
    revertedCommitSha: patch.revertedCommitSha ?? null,
  }).where(and(
    eq(schema.project.patchnodeEntries.projectId, projectId),
    eq(schema.project.patchnodeEntries.entryId, entryId),
    isNull(schema.project.patchnodeEntries.revertedAt),
  )).returning();
  return rows[0] ? mapPatchnodeRow(rows[0]) : null;
}

export async function markPatchnodeEntryReverted(
  layer: AsyncDataLayer,
  entryId: string,
  patch: { revertedAt: string; revertedCommitSha?: string },
): Promise<PatchnodeEntry | null> {
  return markRevertedWithDb(layer.db, requireProjectId(layer), entryId, patch);
}

export async function markPatchnodeEntryRevertedInTransaction(
  tx: DbTransaction,
  projectId: string,
  entryId: string,
  patch: { revertedAt: string; revertedCommitSha?: string },
): Promise<PatchnodeEntry | null> {
  return markRevertedWithDb(tx, projectId, entryId, patch);
}

function escapedLike(query: string): string {
  return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export async function queryPatchnodeEntries(
  layer: AsyncDataLayer,
  query: PatchnodeQuery = {},
): Promise<{ entries: PatchnodeEntry[]; totalEntries: number; hasMore: boolean }> {
  const projectId = requireProjectId(layer);
  const table = schema.project.patchnodeEntries;
  const normalizedQuery = query.query?.trim();
  const textClause = normalizedQuery
    ? or(ilike(table.taskId, escapedLike(normalizedQuery)), ilike(table.title, escapedLike(normalizedQuery)), ilike(table.body, escapedLike(normalizedQuery)))
    : undefined;
  const where = and(
    eq(table.projectId, projectId),
    textClause,
    query.from ? gte(table.day, query.from) : undefined,
    query.to ? lte(table.day, query.to) : undefined,
  );
  const requestedLimit = Number.isFinite(query.limit) ? Math.trunc(query.limit!) : 100;
  const limit = Math.min(200, Math.max(1, requestedLimit));
  const offset = Number.isFinite(query.offset) ? Math.max(0, Math.trunc(query.offset!)) : 0;
  const [rows, counts] = await Promise.all([
    layer.db.select().from(table).where(where).orderBy(desc(table.day), desc(table.occurredAt), desc(table.entryId)).limit(limit + 1).offset(offset),
    layer.db.select({ count: sql<number>`count(*)::int` }).from(table).where(where),
  ]);
  return {
    entries: rows.slice(0, limit).map(mapPatchnodeRow),
    totalEntries: Number(counts[0]?.count ?? 0),
    hasMore: rows.length > limit,
  };
}

export type PatchnodeReconcileResult = {
  completedInserted: number;
  revertedInserted: number;
  archivedBackfilled: number;
  truncated: boolean;
};

type ReconcileTaskRow = {
  id: string;
  title: string | null;
  summary: string | null;
  column: string;
  columnMovedAt: string | null;
  sourceMetadata: unknown;
  deletedAt: string | null;
};

const asTaskSnapshot = (row: ReconcileTaskRow): Task => ({
  id: row.id,
  title: row.title ?? undefined,
  description: "",
  summary: row.summary ?? undefined,
  column: row.column as Column,
  currentStep: 0,
  priority: "normal",
  steps: [],
  dependencies: [],
  log: [],
  createdAt: row.columnMovedAt ?? new Date(0).toISOString(),
  updatedAt: row.columnMovedAt ?? new Date(0).toISOString(),
  columnMovedAt: row.columnMovedAt ?? undefined,
});

function revertedMarker(metadata: unknown): { revertedAt: string; revertedCommitSha?: string } | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = metadata as Record<string, unknown>;
  const revertedAt = typeof value.revertedAt === "string" ? value.revertedAt.trim() : "";
  if (!revertedAt) return null;
  return {
    revertedAt,
    ...(typeof value.revertedCommitSha === "string" && value.revertedCommitSha.trim()
      ? { revertedCommitSha: value.revertedCommitSha.trim() }
      : {}),
  };
}

export async function reconcilePatchnodeFromLiveTasks(
  layer: AsyncDataLayer,
  completeColumns: ReadonlySet<string>,
): Promise<PatchnodeReconcileResult> {
  const projectId = requireProjectId(layer);
  const result: PatchnodeReconcileResult = { completedInserted: 0, revertedInserted: 0, archivedBackfilled: 0, truncated: false };
  const tasks = schema.project.tasks;
  const selectShape = {
    id: tasks.id,
    title: tasks.title,
    summary: tasks.summary,
    column: tasks.column,
    columnMovedAt: tasks.columnMovedAt,
    sourceMetadata: tasks.sourceMetadata,
    deletedAt: tasks.deletedAt,
  };

  let completionCursor: { occurredAt: string; id: string } | undefined;
  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
    const rows = await layer.db.select(selectShape).from(tasks).where(and(
      eq(tasks.projectId, projectId),
      isNull(tasks.deletedAt),
      inArray(tasks.column, [...completeColumns]),
      isNotNull(tasks.columnMovedAt),
      completionCursor ? or(lt(tasks.columnMovedAt, completionCursor.occurredAt), and(eq(tasks.columnMovedAt, completionCursor.occurredAt), lt(tasks.id, completionCursor.id))) : undefined,
    )).orderBy(desc(tasks.columnMovedAt), desc(tasks.id)).limit(RECONCILE_PAGE_SIZE) as ReconcileTaskRow[];
    for (const row of rows) {
      if (!row.columnMovedAt || !Number.isFinite(Date.parse(row.columnMovedAt))) continue;
      if (await appendPatchnodeEntry(layer, buildPatchnodeEntryInput(asTaskSnapshot(row), "completed", row.columnMovedAt))) result.completedInserted += 1;
    }
    if (rows.length < RECONCILE_PAGE_SIZE) break;
    const last = rows.at(-1)!;
    completionCursor = { occurredAt: last.columnMovedAt!, id: last.id };
    if (page === RECONCILE_MAX_PAGES - 1) result.truncated = true;
  }

  let revertCursor = "";
  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
    const rows = await layer.db.select(selectShape).from(tasks).where(and(
      eq(tasks.projectId, projectId),
      isNull(tasks.deletedAt),
      revertCursor ? gt(tasks.id, revertCursor) : undefined,
    )).orderBy(tasks.id).limit(RECONCILE_PAGE_SIZE) as ReconcileTaskRow[];
    for (const row of rows) {
      const marker = revertedMarker(row.sourceMetadata);
      if (!marker) continue;
      /*
      FNXC:PatchnodeRevertReconciliation 2026-08-28-13:26:
      The task marker is latest-only and remains after re-delivery. Match its timestamp to the cancellation episode already in the ledger before consulting the latest completion, or an old marker would incorrectly cancel the new delivery. Re-marking the episode's own completion also repairs an interrupted earlier reconciliation without redirecting the marker.

      FNXC:PatchnodeRevertReconciliation 2026-08-28-13:35:
      A legacy marker may predate every completion still represented in the ledger when its original delivery was superseded before reconciliation. Pair only to a completion at or before the marker; otherwise preserve the cancellation as the documented unpaired legacy episode so a later delivery remains effective.
      */
      const recordedRevert = await findPatchnodeRevertForMarker(layer, row.id, marker.revertedAt);
      if (recordedRevert) {
        if (recordedRevert.revertsEntryId) {
          await markPatchnodeEntryReverted(layer, recordedRevert.revertsEntryId, marker);
        }
        continue;
      }
      const completion = await findLatestCompletionWithDb(layer.db, projectId, row.id, { noLaterThan: marker.revertedAt });
      const occurrenceKey = completion?.occurrenceKey ?? "none";
      const input: PatchnodeInput = {
        ...buildPatchnodeEntryInput(asTaskSnapshot(row), "reverted", marker.revertedAt),
        entryId: buildPatchnodeEntryId("reverted", row.id, occurrenceKey),
        occurrenceKey,
        revertsEntryId: completion?.entryId ?? null,
        revertedCommitSha: marker.revertedCommitSha ?? null,
      };
      if (await appendPatchnodeEntry(layer, input)) result.revertedInserted += 1;
      if (completion) await markPatchnodeEntryReverted(layer, completion.entryId, marker);
    }
    if (rows.length < RECONCILE_PAGE_SIZE) break;
    revertCursor = rows.at(-1)!.id;
    if (page === RECONCILE_MAX_PAGES - 1) result.truncated = true;
  }

  let archivedCursor = "";
  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
    const rows = await layer.db.select(selectShape).from(tasks).where(and(
      eq(tasks.projectId, projectId),
      eq(tasks.column, "archived"),
      isNotNull(tasks.deletedAt),
      archivedCursor ? gt(tasks.id, archivedCursor) : undefined,
    )).orderBy(tasks.id).limit(RECONCILE_PAGE_SIZE) as ReconcileTaskRow[];
    if (rows.length) {
      const snapshots = await layer.db.select({ id: schema.archive.archivedTasks.id, taskJson: schema.archive.archivedTasks.taskJson })
        .from(schema.archive.archivedTasks)
        .where(and(eq(schema.archive.archivedTasks.projectId, projectId), inArray(schema.archive.archivedTasks.id, rows.map((row) => row.id))));
      const byId = new Map(snapshots.map((snapshot) => {
        try { return [snapshot.id, JSON.parse(snapshot.taskJson) as { preArchiveColumn?: string }] as const; }
        catch { return [snapshot.id, undefined] as const; }
      }));
      for (const row of rows) {
        if (!completeColumns.has(byId.get(row.id)?.preArchiveColumn ?? "") || !row.columnMovedAt || !Number.isFinite(Date.parse(row.columnMovedAt))) continue;
        if (await appendPatchnodeEntry(layer, buildPatchnodeEntryInput(asTaskSnapshot(row), "completed", row.columnMovedAt))) result.archivedBackfilled += 1;
      }
    }
    if (rows.length < RECONCILE_PAGE_SIZE) break;
    archivedCursor = rows.at(-1)!.id;
    if (page === RECONCILE_MAX_PAGES - 1) result.truncated = true;
  }

  if (result.truncated) storeLog.warn(`[patchnode] reconciliation truncated after ${RECONCILE_MAX_PAGES * RECONCILE_PAGE_SIZE} rows per pass`, result);
  return result;
}
