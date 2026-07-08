/**
 * Async Drizzle ArchiveDatabase helpers (U6 satellite-central-archive-db).
 *
 * FNXC:ArchiveDatabase 2026-06-24-19:00:
 * Async equivalents of the sync SQLite ArchiveDatabase call sites in
 * archive-db.ts. The archive database is the cold-storage log of archived
 * task snapshots (`archive.archived_tasks`), append-only and queryable by
 * archivedAt/createdAt and (in the SQLite build) FTS5. Under PostgreSQL the
 * relational snapshot lives in the `archive` schema; the FTS5 virtual table is
 * replaced by a tsvector/GIN index in the fts-replacement feature (U7), so
 * this helper programs the relational table and provides an ILIKE-based
 * search fallback that mirrors the sync `search()` LIKE path. The tsvector
 * search path slots in here once U7 lands.
 *
 * SQLite → PostgreSQL notes (see library/satellite-store-migration-pattern.md):
 *   - `db.prepare(sql).get/run/all()` → awaited Drizzle queries against
 *     `schema.archive.archivedTasks`.
 *   - The `comments` column is `jsonb` in PostgreSQL (VAL-SCHEMA-004), so
 *     Drizzle returns it already-parsed. The sync store wrote it as a
 *     TEXT-serialized `JSON.stringify(entry.comments ?? [])`; under jsonb the
 *     value is an array. On write we pass the array directly; on read it is
 *     already an array.
 *   - The whole archived task is also persisted in the `task_json` text column
 *     (a serialized ArchivedTaskEntry), matching the SQLite design where
 *     taskJson is the canonical restore payload. `taskJson` stays TEXT in
 *     PostgreSQL (it is a freeze-frame snapshot, not a query target), so it
 *     is `JSON.stringify()`'d on write and `JSON.parse()`'d on read.
 *   - The SQLite `INSERT OR REPLACE` upsert maps to Drizzle
 *     `insert().onConflictDoUpdate()` on the primary key (id).
 *   - FTS5-specific helpers (`rebuildFts5Index`, `optimizeFts5`,
 *     `getFtsIndexBytes`) have no PostgreSQL equivalent in this feature —
 *     they are reworked in U7 (tsvector/GIN). The relational CRUD and the
 *     ILIKE search path are migrated here.
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `ArchiveDatabase` until the
 *   coordinated `getDatabase()` flip. The sync ArchiveDatabase keeps its sync
 *   path (the gate depends on it). These helpers are the async target the
 *   PostgreSQL integration tests consume. They target the stable
 *   `AsyncDataLayer` interface (U4), not the underlying driver.
 */
import { desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import type { ArchivedTaskEntry } from "./types.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

/**
 * FNXC:ArchiveDatabase 2026-06-24-19:05:
 * `comments` is jsonb so Drizzle returns it as a parsed JS value (array).
 * `taskJson` is text (the serialized ArchivedTaskEntry snapshot). Call sites
 * cast the returned rows to `{ taskJson: string }` for deserialization.
 */

const archivedTaskColumns = {
  id: schema.archive.archivedTasks.id,
  taskJson: schema.archive.archivedTasks.taskJson,
  prompt: schema.archive.archivedTasks.prompt,
  archivedAt: schema.archive.archivedTasks.archivedAt,
  title: schema.archive.archivedTasks.title,
  description: schema.archive.archivedTasks.description,
  comments: schema.archive.archivedTasks.comments,
  createdAt: schema.archive.archivedTasks.createdAt,
  updatedAt: schema.archive.archivedTasks.updatedAt,
  columnMovedAt: schema.archive.archivedTasks.columnMovedAt,
};

/**
 * FNXC:ArchiveDatabase 2026-06-24-19:10:
 * Upsert (insert-or-replace) an archived task snapshot. Mirrors sync
 * `ArchiveDatabase.upsert()`. The whole entry is serialized into `task_json`
 * (the canonical restore payload), and the indexed columns
 * (title/description/comments) are denormalized for search and listing.
 *
 * On the PostgreSQL jsonb `comments` column the array is passed directly
 * (Drizzle serializes it). The `taskJson` text column stores the
 * `JSON.stringify(entry)` snapshot.
 *
 * @param handle The runtime db or a transaction handle.
 * @param entry The archived task snapshot to persist.
 */
export async function upsertArchivedTask(
  handle: QueryHandle,
  entry: ArchivedTaskEntry,
): Promise<void> {
  await handle
    .insert(schema.archive.archivedTasks)
    .values({
      id: entry.id,
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
      target: schema.archive.archivedTasks.id,
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
 * FNXC:ArchiveDatabase 2026-06-24-19:15:
 * List all archived task snapshots, newest-first by archivedAt. Mirrors sync
 * `ArchiveDatabase.list()`. Returns the deserialized ArchivedTaskEntry payloads
 * from the `task_json` column (the canonical restore shape).
 *
 * @param handle The runtime db or a transaction handle.
 */
export async function listArchivedTasks(
  handle: QueryHandle,
): Promise<ArchivedTaskEntry[]> {
  const rows = await handle
    .select({ taskJson: archivedTaskColumns.taskJson })
    .from(schema.archive.archivedTasks)
    .orderBy(desc(archivedTaskColumns.archivedAt));
  return rows.map((row) => JSON.parse((row as { taskJson: string }).taskJson) as ArchivedTaskEntry);
}

/**
 * FNXC:ArchivePagination 2026-07-08-00:00:
 * Bounded page of archived task snapshots for the Archived board column
 * (FN-7659), ordered `archivedAt DESC` with an `id DESC` tie-break (Postgres
 * has no rowid; id is the deterministic stand-in for same-timestamp rows).
 * Mirrors sync `ArchiveDatabase.listPage()`.
 */
export async function listArchivedTaskEntriesPage(
  handle: QueryHandle,
  limit: number,
  offset: number,
): Promise<ArchivedTaskEntry[]> {
  const rows = await handle
    .select({ taskJson: archivedTaskColumns.taskJson })
    .from(schema.archive.archivedTasks)
    .orderBy(desc(archivedTaskColumns.archivedAt), desc(archivedTaskColumns.id))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => JSON.parse((row as { taskJson: string }).taskJson) as ArchivedTaskEntry);
}

/**
 * FNXC:ArchiveDatabase 2026-06-24-19:20:
 * Read a single archived task by id. Returns undefined when absent. Mirrors
 * sync `ArchiveDatabase.get()`.
 *
 * @param handle The runtime db or a transaction handle.
 * @param id The archived task id.
 */
export async function getArchivedTask(
  handle: QueryHandle,
  id: string,
): Promise<ArchivedTaskEntry | undefined> {
  const rows = await handle
    .select({ taskJson: archivedTaskColumns.taskJson })
    .from(schema.archive.archivedTasks)
    .where(eq(archivedTaskColumns.id, id))
    .limit(1);
  const row = rows[0] as { taskJson: string } | undefined;
  return row ? (JSON.parse(row.taskJson) as ArchivedTaskEntry) : undefined;
}

/**
 * FNXC:ArchiveDatabase 2026-06-24-19:25:
 * Return the subset of `ids` that are present in archived_tasks. Used by the
 * task-store change-detection loop to distinguish a real deletion from an
 * archive (both look like "row gone from tasks table"). Mirrors sync
 * `ArchiveDatabase.filterArchived()`. Single-shot chunked query — cheaper than
 * N `getArchivedTask()` calls when many tasks are archived in a batch.
 *
 * @param handle The runtime db or a transaction handle.
 * @param ids The candidate task ids to test.
 */
export async function filterArchived(
  handle: QueryHandle,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const result = new Set<string>();
  // Chunk to stay well under any parameter limit; mirrors the SQLite CHUNK=500.
  // Uses Drizzle's inArray helper (the proven pattern from async-archive-lineage.ts)
  // so the IN-clause parenthesization is correct.
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await handle
      .select({ id: archivedTaskColumns.id })
      .from(schema.archive.archivedTasks)
      .where(inArray(archivedTaskColumns.id, chunk));
    for (const row of rows) result.add(String((row as { id: string }).id));
  }
  return result;
}

/**
 * FNXC:ArchiveDatabase 2026-06-24-19:30:
 * Delete an archived task snapshot by id. Mirrors sync
 * `ArchiveDatabase.delete()`.
 *
 * @param handle The runtime db or a transaction handle.
 * @param id The archived task id to delete.
 */
export async function deleteArchivedTask(
  handle: QueryHandle,
  id: string,
): Promise<void> {
  await handle.delete(schema.archive.archivedTasks).where(eq(archivedTaskColumns.id, id));
}

/**
 * FNXC:ArchiveDatabase 2026-06-24-19:35:
 * Count the archived rows. Mirrors sync `ArchiveDatabase.getArchivedRowCount()`.
 *
 * @param handle The runtime db or a transaction handle.
 */
export async function getArchivedRowCount(handle: QueryHandle): Promise<number> {
  const rows = await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.archive.archivedTasks);
  const count = (rows[0] as { count?: number } | undefined)?.count;
  return typeof count === "number" ? count : 0;
}

/**
 * FNXC:ArchiveDatabase 2026-06-24-19:40:
 * Full-text search over archived tasks. Mirrors sync
 * `ArchiveDatabase.search()` but uses an ILIKE-based scan (the sync LIKE
 * fallback). The tsvector/GIN path slots in here when U7 (fts-replacement)
 * lands; until then the ILIKE scan provides the same row-membership contract
 * the SQLite LIKE fallback did.
 *
 * Tokenization matches the sync path: the query is split on whitespace,
 * FTS-special characters are stripped, and every token must OR-match across
 * the id/title/description/comments columns. The result is the deserialized
 * ArchivedTaskEntry payloads, ordered by archivedAt DESC.
 *
 * @param handle The runtime db or a transaction handle.
 * @param query The raw user query.
 * @param limit Maximum number of results.
 */
export async function searchArchivedTasks(
  handle: QueryHandle,
  query: string,
  limit: number,
): Promise<ArchivedTaskEntry[]> {
  const trimmed = query?.trim();
  if (!trimmed) return [];

  const tokens = trimmed
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/["{}:*^+()]/g, ""))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return [];

  // Build an OR across tokens; within each token, OR across the searchable
  // columns. ILIKE is case-insensitive; the sync LIKE fallback used ESCAPE '\'
  // on a %pattern%. Each token is escaped for LIKE special chars.
  //
  // The columns: id, title, description (text), and comments (jsonb, cast to
  // text so token search covers the serialized comment payload — matching the
  // SQLite LIKE-over-text behavior).
  const tokenClauses: SQL[] = [];
  for (const token of tokens) {
    const pattern = `%${token.replace(/[\\%_]/g, "\\$&")}%`;
    const columnLikes = [
      ilike(archivedTaskColumns.id, pattern),
      ilike(archivedTaskColumns.title, pattern),
      ilike(archivedTaskColumns.description, pattern),
      ilike(sql<unknown>`${archivedTaskColumns.comments}::text`, pattern),
    ];
    tokenClauses.push(or(...columnLikes) ?? sql`false`);
  }
  const where = or(...tokenClauses);
  if (!where) return [];

  const rows = await handle
    .select({ taskJson: archivedTaskColumns.taskJson })
    .from(schema.archive.archivedTasks)
    .where(where)
    .orderBy(desc(archivedTaskColumns.archivedAt))
    .limit(limit);
  return rows.map((row) => JSON.parse((row as { taskJson: string }).taskJson) as ArchivedTaskEntry);
}
