/**
 * Async Drizzle task-search query-structure helpers (U14).
 *
 * FNXC:TaskStoreSearch 2026-06-24-10:30:
 * Async query-structure helpers for task full-text search. This module captures
 * the query predicates and token-sanitization logic that the FTS5 path in
 * store.ts used, expressed against the PostgreSQL `project.tasks` table via
 * Drizzle. The actual tsvector/GIN full-text search implementation is delivered
 * by the `fts-replacement` feature (separate milestone); this module provides
 * the LIKE-based fallback query structure and the shared predicate builders
 * (soft-delete filtering, archived filtering, token sanitization) that
 * fts-replacement builds on top of.
 *
 * The search query structure preserves these invariants:
 *   - Soft-delete visibility: live search filters `deleted_at IS NULL`
 *     (VAL-DATA-005). Soft-deleted tasks never appear in search results.
 *   - Archived filtering: when `includeArchived` is false, archived tasks
 *     (`column = 'archived'`) are excluded.
 *   - Token sanitization: FTS5 operators are stripped so both code paths see
 *     the same token set. Empty/whitespace queries fall back to listTasks.
 *
 * Transition context (see library/taskstore-persistence-notes.md):
 *   `getDatabase()` still returns the sync `Database` until U15 flips it. The
 *   TaskStore facade keeps its sync search path (the gate depends on it).
 *   These helpers are the async target the fts-replacement feature and the
 *   PostgreSQL integration tests consume.
 */
import { and, asc, eq, ne, or, sql, type SQL } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import { ACTIVE_TASK_FILTER } from "./async-persistence.js";

/**
 * The columns searched by the LIKE fallback. These are the same columns the
 * FTS5 external-content table indexed (`id`, `title`, `description`, `comments`).
 * The fts-replacement feature's tsvector generated column will index a
 * superset of these.
 */
const SEARCHABLE_TEXT_COLUMNS = ["id", "title", "description", "comments"] as const;

/**
 * FNXC:TaskStoreSearch 2026-06-24-10:35:
 * Sanitize a raw user query into search tokens. Strips FTS5 operators
 * (`"{}:*^+()`) so both the FTS and LIKE code paths see the same token set.
 * Returns an empty array for empty/whitespace queries (the caller falls back
 * to listTasks in that case). Mirrors the sync `sanitizedTokens` logic.
 *
 * @param query The raw user query.
 * @returns The sanitized, non-empty tokens.
 */
export function sanitizeSearchTokens(query: string): string[] {
  const trimmed = query?.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => token.replace(/["{}:*^+()]/g, ""))
    .filter((token) => token.length > 0);
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-10:40:
 * Build the "live task" search predicate: `deleted_at IS NULL` (soft-delete
 * visibility, VAL-DATA-005) AND, when `includeArchived` is false,
 * `column != 'archived'`. This is the shared predicate every search path
 * applies so soft-deleted tasks never appear in results and archived tasks
 * can be optionally excluded.
 *
 * @param includeArchived Whether to include archived tasks in the results.
 * @returns The composed SQL predicate.
 */
export function liveSearchPredicate(includeArchived: boolean, projectId?: string): SQL {
  // FNXC:MultiProjectIsolation 2026-07-10:
  // Fold the per-project partition key into the shared search predicate so BOTH
  // full-text (tsvector) and LIKE search paths are scoped to the bound project.
  // This is load-bearing for the CREATE-time near-duplicate check, which calls
  // scopedStore.searchTasks(): without it a task in project B is rejected as a
  // duplicate of a same-titled task in project A on the shared embedded-PG table.
  const projectScope = projectId ? eq(schema.project.tasks.projectId, projectId) : undefined;
  const base = includeArchived
    ? ACTIVE_TASK_FILTER
    : and(ACTIVE_TASK_FILTER, ne(schema.project.tasks.column, "archived"));
  return (projectScope ? and(base, projectScope) : base) as SQL;
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-10:45:
 * Build a LIKE-based search predicate for a set of sanitized tokens. Each token
 * is matched (case-insensitive LIKE) against every searchable text column
 * (`id`, `title`, `description`, `comments`). Tokens are OR'd: a task matches
 * if ANY token matches ANY column. This mirrors the sync LIKE fallback.
 *
 * PostgreSQL note: the `comments` column is jsonb, so ILIKE does not work on it
 * directly. We cast it to text (`comments::text`) before the ILIKE so the
 * search covers the serialized comment content. The fts-replacement feature's
 * tsvector path will index a dedicated text-generated column instead.
 *
 * This is the query structure the fts-replacement feature's tsvector path will
 * REPLACE with a `tsvector @@ plainto_tsquery(...)` predicate. The predicate
 * builder is kept separate from the query execution so the fts-replacement
 * feature can swap just the text-matching predicate while reusing the
 * soft-delete/archived filtering.
 *
 * @param tokens The sanitized search tokens.
 * @returns The composed LIKE predicate, or `undefined` if tokens is empty.
 */
export function buildLikeSearchPredicate(tokens: readonly string[]): SQL | undefined {
  if (tokens.length === 0) return undefined;

  // The comments column is jsonb in PostgreSQL; cast to text for ILIKE.
  // The other columns (id, title, description) are already text.
  const columnRefs: SQL[] = [
    sql`${schema.project.tasks.id}`,
    sql`${schema.project.tasks.title}`,
    sql`${schema.project.tasks.description}`,
    sql`${schema.project.tasks.comments}::text`,
  ];

  const perTokenClauses: SQL[] = tokens.map((token) => {
    const pattern = `%${token.replace(/[\\%_]/g, "\\$&")}%`;
    const columnLikes = columnRefs.map(
      (col) => sql`${col} ILIKE ${pattern} ESCAPE '\\'`,
    );
    return or(...columnLikes) as SQL;
  });

  return or(...perTokenClauses) as SQL;
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-10:50:
 * Search tasks via a LIKE-based fallback query. This is the async equivalent
 * of the sync LIKE-fallback search path (used when FTS5 is unavailable). The
 * fts-replacement feature will add a tsvector-based variant that produces the
 * same row membership but ranked by relevance.
 *
 * Soft-deleted tasks are always excluded (VAL-DATA-005). Archived tasks are
 * excluded unless `includeArchived` is true.
 *
 * @param db The Drizzle instance.
 * @param query The raw user query.
 * @param options Search options (limit, offset, includeArchived).
 * @returns The matching task ids (the caller hydrates them into full Task
 *   objects). Returns the raw rows for the caller to deserialize.
 */
export async function searchTasksLike(
  db: AsyncDataLayer["db"] | DbTransaction,
  query: string,
  options?: { limit?: number; offset?: number; includeArchived?: boolean; projectId?: string },
): Promise<Record<string, unknown>[]> {
  const tokens = sanitizeSearchTokens(query);
  if (tokens.length === 0) return [];

  const includeArchived = options?.includeArchived ?? true;
  const textPredicate = buildLikeSearchPredicate(tokens);
  if (!textPredicate) return [];

  const conditions = [textPredicate, liveSearchPredicate(includeArchived, options?.projectId)];

  const baseQuery = db
    .select()
    .from(schema.project.tasks)
    .where(and(...conditions))
    .orderBy(asc(schema.project.tasks.createdAt));

  const rows = options?.limit && options.limit > 0
    ? await baseQuery.limit(options.limit).offset(options.offset ?? 0)
    : await baseQuery;
  return rows as unknown as Record<string, unknown>[];
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-10:55:
 * Count tasks matching a LIKE-based search query. Companion to
 * `searchTasksLike` for pagination. Returns 0 for empty queries.
 */
export async function countSearchTasksLike(
  db: AsyncDataLayer["db"] | DbTransaction,
  query: string,
  options?: { includeArchived?: boolean; projectId?: string },
): Promise<number> {
  const tokens = sanitizeSearchTokens(query);
  if (tokens.length === 0) return 0;

  const includeArchived = options?.includeArchived ?? true;
  const textPredicate = buildLikeSearchPredicate(tokens);
  if (!textPredicate) return 0;

  const conditions = [textPredicate, liveSearchPredicate(includeArchived, options?.projectId)];
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.project.tasks)
    .where(and(...conditions));
  return rows[0]?.count ?? 0;
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-11:00:
 * Archive search query structure. The archive database (`archive.archived_tasks`)
 * stores append-only snapshots of archived tasks. This helper provides the
 * LIKE-based search predicate over the archive's denormalized text columns
 * (`title`, `description`). The fts-replacement feature will add a tsvector
 * variant for archive search parity (VAL-SEARCH-005).
 *
 * @param db The Drizzle instance.
 * @param query The raw user query.
 * @param limit The maximum number of results.
 * @returns The matching archived-task entries (parsed from task_json).
 */
export async function searchArchivedTasksLike(
  db: AsyncDataLayer["db"] | DbTransaction,
  query: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const tokens = sanitizeSearchTokens(query);
  if (tokens.length === 0) return [];

  const columnRefs: SQL[] = [
    sql`${schema.archive.archivedTasks.title}`,
    sql`${schema.archive.archivedTasks.description}`,
  ];

  const perTokenClauses: SQL[] = tokens.map((token) => {
    const pattern = `%${token.replace(/[\\%_]/g, "\\$&")}%`;
    const columnLikes = columnRefs.map(
      (col) => sql`${col} ILIKE ${pattern} ESCAPE '\\'`,
    );
    return or(...columnLikes) as SQL;
  });

  const textPredicate = or(...perTokenClauses) as SQL;

  const rows = await db
    .select()
    .from(schema.archive.archivedTasks)
    .where(textPredicate)
    .orderBy(asc(schema.archive.archivedTasks.archivedAt))
    .limit(limit);
  return rows as unknown as Record<string, unknown>[];
}

/**
 * The searchable text columns (re-exported for the fts-replacement feature to
 * reference when building the tsvector generated column).
 */
export { SEARCHABLE_TEXT_COLUMNS };

// ════════════════════════════════════════════════════════════════════
// tsvector / GIN full-text search (fts-replacement, U7)
// ════════════════════════════════════════════════════════════════════

/**
 * FNXC:TaskStoreSearch 2026-06-24-13:00:
 * The text-search configuration used by the tsvector generated columns and the
 * plainto_tsquery search predicates. 'simple' is used (not a language-specific
 * config like 'english') because task text is code-like (task IDs, technical
 * terms, file paths) and FTS5 used simple tokenization. 'simple' performs no
 * stemming and applies no stopword list, preserving the same token boundary
 * behavior as FTS5 so search-result membership parity holds (VAL-SEARCH-001).
 *
 * This constant MUST match the configuration embedded in the search_vector
 * generated-column expressions in schema/project.ts and schema/archive.ts and
 * the migration baseline (0000_initial.sql). Changing it without updating all
 * four sites breaks search parity.
 */
export const FTS_TS_CONFIG = "simple";

/**
 * FNXC:TaskStoreSearch 2026-06-24-15:45:
 * Build a tsquery SQL fragment from the raw query using the 'simple' config.
 * Uses `to_tsquery` (NOT plainto_tsquery) with each sanitized token suffixed
 * `:*` for prefix matching and joined by ` | ` (OR), reproducing the FTS5
 * baseline semantics in store.ts (sanitizedTokens.map(t => `${t}*`).join(" OR ")).
 *
 * `plainto_tsquery` was INCORRECT: it ANDs tokens and does no prefix matching,
 * so "frob" failed to match "frobnicator" and multi-term queries lost OR
 * recall. The earlier comment claiming FTS5 used "space-joined tokens (implicit
 * AND)" was factually wrong -- FTS5 joined with " OR " (see store.ts MATCH).
 *
 * `websearch_to_tsquery` is also unsuitable: it lacks prefix matching.
 * `to_tsquery` with manually sanitized tokens + `:*` is the only function
 * that gives OR + prefix.
 *
 * @param query The raw user query (will be sanitized and tokenized).
 * @returns A `SQL` fragment binding the to_tsquery, or `undefined` if the
 *   query produces no valid tokens.
 */
function buildTsqueryFragment(query: string): SQL | undefined {
  const tokens = sanitizeSearchTokens(query);
  if (tokens.length === 0) return undefined;

  // Strip to_tsquery metacharacters that survive sanitizeSearchTokens
  // (&|!:<>()'\) so user input cannot inject tsquery operators.
  const safeTokens = tokens
    .map((t) => t.replace(/[&|!:<>()'\\]/g, ""))
    .filter((t) => t.length > 0);
  if (safeTokens.length === 0) return undefined;

  // `simple` config, OR join, prefix match per token -- matches FTS5 baseline.
  const tsqueryExpr = safeTokens.map((t) => `${t}:*`).join(" | ");
  return sql`to_tsquery(${FTS_TS_CONFIG}, ${tsqueryExpr})`;
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-13:10:
 * Search tasks via the tsvector/GIN full-text index. This is the PostgreSQL
 * replacement for the SQLite FTS5 search path (VAL-SEARCH-001 search parity,
 * VAL-SEARCH-002/003/004 sync-on-write). The `search_vector @@ tsquery`
 * predicate uses the GIN index (idxTasksSearchVector) for fast ranked lookup.
 *
 * Soft-deleted tasks are always excluded (VAL-DATA-005) because the live-search
 * predicate filters `deleted_at IS NULL`. Archived tasks (`column = 'archived'`)
 * are excluded unless `includeArchived` is true.
 *
 * Results are ordered by `ts_rank` (relevance) descending, then by `created_at`
 * ascending for a stable tiebreak. This mirrors the FTS5 `ORDER BY rank` path.
 * Row membership (which tasks match) is what VAL-SEARCH-001 asserts; ordering
 * is explicitly excluded from the parity contract (see validation-contract.md
 * VAL-CUTOVER-003 "excluding search-result ordering").
 *
 * @param db The Drizzle instance or transaction handle.
 * @param query The raw user query.
 * @param options Search options (limit, offset, includeArchived).
 * @returns The matching task rows. Empty for empty/whitespace queries.
 */
export async function searchTasksTsvector(
  db: AsyncDataLayer["db"] | DbTransaction,
  query: string,
  options?: { limit?: number; offset?: number; includeArchived?: boolean; projectId?: string },
): Promise<Record<string, unknown>[]> {
  const tokens = sanitizeSearchTokens(query);
  if (tokens.length === 0) return [];

  // Re-join sanitized tokens for plainto_tsquery. Sanitization strips FTS5
  // operators so the tsquery sees clean tokens, matching the membership
  // semantics of the LIKE fallback (both paths see the same token set).
  const cleanQuery = tokens.join(" ");
  const tsquery = buildTsqueryFragment(cleanQuery);
  if (!tsquery) return [];

  const includeArchived = options?.includeArchived ?? true;
  const conditions = [
    sql`${schema.project.tasks.searchVector} @@ ${tsquery}`,
    liveSearchPredicate(includeArchived, options?.projectId),
  ];

  const baseQuery = db
    .select()
    .from(schema.project.tasks)
    .where(and(...conditions))
    .orderBy(
      sql`ts_rank(${schema.project.tasks.searchVector}, ${tsquery}) DESC`,
      asc(schema.project.tasks.createdAt),
    );

  const rows = options?.limit && options.limit > 0
    ? await baseQuery.limit(options.limit).offset(options.offset ?? 0)
    : await baseQuery;
  return rows as unknown as Record<string, unknown>[];
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-13:15:
 * Count tasks matching a tsvector full-text search query. Companion to
 * `searchTasksTsvector` for pagination. Returns 0 for empty queries.
 */
export async function countSearchTasksTsvector(
  db: AsyncDataLayer["db"] | DbTransaction,
  query: string,
  options?: { includeArchived?: boolean; projectId?: string },
): Promise<number> {
  const tokens = sanitizeSearchTokens(query);
  if (tokens.length === 0) return 0;

  const cleanQuery = tokens.join(" ");
  const tsquery = buildTsqueryFragment(cleanQuery);
  if (!tsquery) return 0;

  const includeArchived = options?.includeArchived ?? true;
  const conditions = [
    sql`${schema.project.tasks.searchVector} @@ ${tsquery}`,
    liveSearchPredicate(includeArchived, options?.projectId),
  ];
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.project.tasks)
    .where(and(...conditions));
  return rows[0]?.count ?? 0;
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-13:20:
 * Search archived tasks via the tsvector/GIN full-text index on the archive
 * database (VAL-SEARCH-005 archive search parity). This is the PostgreSQL
 * replacement for the SQLite FTS5 archive search path. The
 * `search_vector @@ tsquery` predicate uses the GIN index
 * (idxArchivedTasksSearchVector).
 *
 * Results are ordered by `ts_rank` descending then `archived_at` ascending.
 * Row membership is what VAL-SEARCH-005 asserts.
 *
 * @param db The Drizzle instance or transaction handle.
 * @param query The raw user query.
 * @param limit The maximum number of results.
 * @returns The matching archived-task rows. Empty for empty/whitespace queries.
 */
export async function searchArchivedTasksTsvector(
  db: AsyncDataLayer["db"] | DbTransaction,
  query: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const tokens = sanitizeSearchTokens(query);
  if (tokens.length === 0) return [];

  const cleanQuery = tokens.join(" ");
  const tsquery = buildTsqueryFragment(cleanQuery);
  if (!tsquery) return [];

  const rows = await db
    .select()
    .from(schema.archive.archivedTasks)
    .where(sql`${schema.archive.archivedTasks.searchVector} @@ ${tsquery}`)
    .orderBy(
      sql`ts_rank(${schema.archive.archivedTasks.searchVector}, ${tsquery}) DESC`,
      asc(schema.archive.archivedTasks.archivedAt),
    )
    .limit(limit);
  return rows as unknown as Record<string, unknown>[];
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-13:25:
 * Read the raw search_vector tsvector value for a task. Used by tests to
 * verify the value-aware partial-update optimization (VAL-SEARCH-006): a
 * mutation touching only non-text columns leaves search_vector unchanged.
 * Returns null if the task does not exist.
 *
 * This is a debug/assertion helper, not a hot-path query.
 *
 * @param db The Drizzle instance.
 * @param taskId The task id.
 * @returns The tsvector value as a string (PostgreSQL cast), or null.
 */
export async function readTaskSearchVector(
  db: AsyncDataLayer["db"] | DbTransaction,
  taskId: string,
): Promise<string | null> {
  const rows = await db
    .select({ sv: sql<string | null>`${schema.project.tasks.searchVector}::text` })
    .from(schema.project.tasks)
    .where(eq(schema.project.tasks.id, taskId));
  return rows[0]?.sv ?? null;
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-13:30:
 * REINDEX the tasks search_vector GIN index. Operators call this to rebuild
 * the full-text index after bloat, restoring correct search without data loss
 * (VAL-SEARCH-007). The generated column values are NOT affected — only the
 * index is rebuilt from the existing tsvector data. This replaces the FTS5
 * `rebuildFts5Index()` / `optimizeFts5()` self-healing paths.
 *
 * REINDEX is a DDL operation that takes an exclusive lock on the index; in
 * production it should run via `REINDEX INDEX CONCURRENTLY` to avoid blocking
 * writes. This helper uses the blocking form because it targets the
 * operator/maintenance path, not the hot path.
 *
 * @param db The Drizzle instance.
 * @param concurrently If true, use REINDEX INDEX CONCURRENTLY (non-blocking).
 */
export async function reindexTasksSearchVector(
  db: AsyncDataLayer["db"],
  concurrently = false,
): Promise<void> {
  // Schema-qualify the index name because the connection's search_path may not
  // include the project schema (the runtime connection is schema-less).
  const clause = concurrently
    ? sql`REINDEX INDEX CONCURRENTLY project."idxTasksSearchVector"`
    : sql`REINDEX INDEX project."idxTasksSearchVector"`;
  await db.execute(clause);
}

/**
 * FNXC:TaskStoreSearch 2026-06-24-13:35:
 * REINDEX the archived_tasks search_vector GIN index. Companion to
 * `reindexTasksSearchVector` for the archive database.
 */
export async function reindexArchivedTasksSearchVector(
  db: AsyncDataLayer["db"],
  concurrently = false,
): Promise<void> {
  const clause = concurrently
    ? sql`REINDEX INDEX CONCURRENTLY archive."idxArchivedTasksSearchVector"`
    : sql`REINDEX INDEX archive."idxArchivedTasksSearchVector"`;
  await db.execute(clause);
}
