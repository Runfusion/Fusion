import { postgresSchema, type AsyncDataLayer, type Column } from "@fusion/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { SnapshotRow } from "./types.js";

const WRITE_CHUNK_SIZE = 250;
const DELETE_CHUNK_SIZE = 250;

function projectIdFor(layer: AsyncDataLayer): string {
  const projectId = layer.projectId?.trim();
  if (!projectId) throw new Error("Even Realities PostgreSQL persistence requires asyncLayer.projectId");
  return projectId;
}

/*
FNXC:EvenRealitiesPostgres 2026-07-14-17:55:
Glasses notification dedupe state is PostgreSQL-only runtime data. Polling compares the current task snapshot with the project-scoped persisted snapshot, writes only changed rows in bounded bulk upserts, and deletes only known-stale IDs in bounded chunks; it must never rebuild every row or generate a board-sized NOT IN predicate on an unchanged poll.
*/
export function changedSnapshotRows(
  snapshot: ReadonlyMap<string, SnapshotRow>,
  rows: ReadonlyArray<SnapshotRow>,
): SnapshotRow[] {
  return rows.filter((row) => {
    const previous = snapshot.get(row.taskId);
    return !previous
      || previous.lastColumn !== row.lastColumn
      || previous.updatedAt !== row.updatedAt;
  });
}

export function missingSnapshotIds(
  snapshot: ReadonlyMap<string, SnapshotRow>,
  presentTaskIds: ReadonlySet<string>,
): string[] {
  return [...snapshot.keys()].filter((taskId) => !presentTaskIds.has(taskId));
}

export async function readSnapshot(layer: AsyncDataLayer): Promise<Map<string, SnapshotRow>> {
  const projectId = projectIdFor(layer);
  const rows = await layer.db
    .select()
    .from(postgresSchema.plugin.evenRealitiesSeenTasks)
    .where(eq(postgresSchema.plugin.evenRealitiesSeenTasks.projectId, projectId));
  return new Map(rows.map((row) => [row.taskId, {
    taskId: row.taskId,
    lastColumn: row.lastColumn as Column,
    updatedAt: row.updatedAt,
  }]));
}

export async function writeSnapshot(layer: AsyncDataLayer, rows: ReadonlyArray<SnapshotRow>): Promise<void> {
  const projectId = projectIdFor(layer);
  if (rows.length === 0) return;
  await layer.transactionImmediate(async (tx) => {
    for (let offset = 0; offset < rows.length; offset += WRITE_CHUNK_SIZE) {
      const chunk = rows.slice(offset, offset + WRITE_CHUNK_SIZE);
      await tx.insert(postgresSchema.plugin.evenRealitiesSeenTasks).values(
        chunk.map((row) => ({
          projectId,
          taskId: row.taskId,
          lastColumn: row.lastColumn,
          updatedAt: row.updatedAt,
        })),
      ).onConflictDoUpdate({
        target: [
          postgresSchema.plugin.evenRealitiesSeenTasks.projectId,
          postgresSchema.plugin.evenRealitiesSeenTasks.taskId,
        ],
        set: {
          lastColumn: sql`excluded.last_column`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
    }
  });
}

export async function pruneMissing(
  layer: AsyncDataLayer,
  presentTaskIds: ReadonlySet<string>,
  snapshot?: ReadonlyMap<string, SnapshotRow>,
): Promise<number> {
  const projectId = projectIdFor(layer);
  const existing = snapshot ?? await readSnapshot(layer);
  const staleIds = missingSnapshotIds(existing, presentTaskIds);
  if (staleIds.length === 0) return 0;

  let deletedCount = 0;
  await layer.transactionImmediate(async (tx) => {
    for (let offset = 0; offset < staleIds.length; offset += DELETE_CHUNK_SIZE) {
      const chunk = staleIds.slice(offset, offset + DELETE_CHUNK_SIZE);
      const deleted = await tx
        .delete(postgresSchema.plugin.evenRealitiesSeenTasks)
        .where(and(
          eq(postgresSchema.plugin.evenRealitiesSeenTasks.projectId, projectId),
          inArray(postgresSchema.plugin.evenRealitiesSeenTasks.taskId, chunk),
        ))
        .returning({ taskId: postgresSchema.plugin.evenRealitiesSeenTasks.taskId });
      deletedCount += deleted.length;
    }
  });
  return deletedCount;
}
