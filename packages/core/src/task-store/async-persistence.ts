/**
 * Async Drizzle task-persistence helpers (U12).
 *
 * FNXC:TaskStorePersistence 2026-06-24-13:00:
 * Async equivalents of the sync SQLite persistence call sites in store.ts.
 * These helpers target the PostgreSQL `project.tasks` table via Drizzle and
 * preserve the three load-bearing persistence invariants the migration must
 * not regress:
 *
 *   VAL-DATA-005 — Soft-delete visibility: every live reader filters
 *     `deleted_at IS NULL`. Soft-deleted tasks do not appear in active lists,
 *     kanban, or counts. Forensic reads (includeDeleted) still surface them.
 *   VAL-DATA-006 — Forensic reads surface soft-deleted rows when explicitly
 *     requested (includeDeleted: true).
 *   VAL-DATA-009 — Create-class inserts are non-destructive: create paths use
 *     a plain INSERT so PostgreSQL raises a primary-key violation on duplicate
 *     IDs instead of silently rewriting the existing row (the upsert path is
 *     update-only and must never be used for create).
 *
 * SQLite → PostgreSQL JSON note (VAL-SCHEMA-004):
 *   In SQLite the JSON columns were TEXT with `toJson()`/`fromJson()`. In
 *   PostgreSQL they are `jsonb`, so Drizzle returns them already-parsed as JS
 *   values. On write, pass the JS value directly (Drizzle serializes it).
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until U15 flips it. The
 *   TaskStore facade keeps its sync persistence path (the gate depends on it).
 *   These helpers are the async target the migrating stores (U13/U14) and the
 *   PostgreSQL integration tests consume. They program against the stable
 *   `AsyncDataLayer` interface (U4), not the underlying driver.
 */
import { and, Column, eq, is, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import { taskProjectScope } from "../postgres/data-layer.js";
import {
  TASK_COLUMN_DESCRIPTORS,
  type TaskPersistSerializationContext,
} from "./persistence.js";

/**
 *FNXC:TaskStorePersistence 2026-06-24-13:05:
 * The async-persistence live-reader filter. Every live reader applies this so
 * soft-deleted rows (deleted_at IS NOT NULL) are hidden (VAL-DATA-005).
 * Forensic readers omit this filter (VAL-DATA-006).
 */
export const ACTIVE_TASK_FILTER: SQL = isNull(schema.project.tasks.deletedAt);

/**
 * FNXC:TaskStoreReads 2026-06-26-11:45:
 * Projection of every task-table column EXCEPT `log`, built from Drizzle
 * Column objects. This is the slim-read column set for `readLiveTaskRows`
 * (excludeLog mode), which drops the heavy `log` jsonb payload (~99% of row
 * bytes on busy boards) so board-list hydration stays bounded.
 *
 * WHY Column objects, not Object.keys(): a Drizzle table object's enumerable
 * own-keys are the camelCase TypeScript property names (e.g. `lineageId`), but
 * the underlying PostgreSQL columns are snake_case (e.g. `lineage_id`). Earlier
 * code built a raw `SELECT` via `sql.identifier(Object.keys(...))`, which
 * quotes the camelCase key verbatim and produces invalid SQL like
 * `SELECT "lineageId"` against a `lineage_id` column. Iterating the Column
 * objects and passing them to Drizzle's `.select({...})` lets Drizzle emit the
 * correct quoted snake_case identifiers (and skip non-column own-properties
 * such as `enableRLS`). The returned rows are keyed by the TS property name, so
 * `pgRowToTaskRow` / `rowToTask` continue to read `row.column`,
 * `row.deletedAt`, etc. unchanged.
 *
 * Computed once at module load (the schema is static); `log` is restored to
 * `[]` by `pgRowToTaskRow` / `rowToTask` when a single task is fetched in full.
 */
const TASK_SLIM_PROJECTION: Record<string, PgColumn> = Object.fromEntries(
  Object.entries(schema.project.tasks)
    .filter(([, value]) => is(value, Column))
    .filter(([key]) => key !== "log")
    .map(([key, value]) => [key, value as PgColumn]),
);

/**
 * FNXC:TaskStorePersistence 2026-06-24-13:07:
 * The task-table columns that are `jsonb` in PostgreSQL (VAL-SCHEMA-004). In
 * SQLite these were TEXT with `toJson()`/`toJsonNullable()`. The shared column
 * descriptors serialize these to JSON *strings* (the SQLite binding shape), but
 * a PostgreSQL jsonb column expects a JS value so Drizzle can bind it as jsonb.
 * `buildTaskInsertValues` parses the descriptor-produced JSON strings for these
 * columns back into JS values so the round-trip through jsonb preserves shape.
 */
const TASK_JSONB_COLUMNS: ReadonlySet<string> = new Set([
  "dependencies",
  "steps",
  "customFields",
  "log",
  "attachments",
  "steeringComments",
  "comments",
  "review",
  "reviewState",
  "workflowStepResults",
  "prInfo",
  "prInfos",
  "issueInfo",
  "githubTracking",
  "mergeDetails",
  "workspaceWorktrees",
  "enabledWorkflowSteps",
  "modifiedFiles",
  "scopeAutoWiden",
  "sourceMetadata",
  "tokenUsagePerModel",
  "tokenBudgetOverride",
]);

/**
 * Build a Drizzle `values` object for a task from the shared column
 * descriptors. This is the async equivalent of `getTaskPersistValues()` —
 * instead of producing positional SQL placeholders, it produces a column-keyed
 * object suitable for `db.insert(tasks).values(...)`.
 *
 * The descriptor serialization functions are reused verbatim from the sync
 * path so the persisted shape is identical across backends. For jsonb columns,
 * the descriptor-produced JSON string is parsed back into a JS value so Drizzle
 * binds it as jsonb (not a double-encoded text string).
 */
export function buildTaskInsertValues(
  taskRecord: Record<string, unknown>,
  context: TaskPersistSerializationContext,
  projectId?: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const descriptor of TASK_COLUMN_DESCRIPTORS) {
    // The descriptors are written against the Task type; they only read fields,
    // so a loose record is safe here.
    let value = descriptor.serialize(taskRecord as never, context);
    if (TASK_JSONB_COLUMNS.has(descriptor.column) && typeof value === "string") {
      // PostgreSQL jsonb: parse the descriptor's JSON string back to a JS value
      // so Drizzle binds it as jsonb (round-trip shape parity, VAL-SCHEMA-004).
      // "[]" (the toJson empty-array sentinel) maps to an empty array; "" maps
      // to null (absent optional column).
      value = value === "" ? null : JSON.parse(value);
    }
    values[descriptor.column] = value;
  }
  // FNXC:MultiProjectIsolation 2026-07-10:
  // Stamp the per-project partition key so every task row is attributed to the
  // project whose store wrote it. The task-store descriptors don't include
  // project_id (it isn't a Task field), so it is set here from the bound layer
  // projectId. When undefined (single-project store / SQLite path), the column
  // stays NULL and the scope filter is a no-op — behavior-preserving.
  if (projectId !== undefined) {
    values.projectId = projectId;
  }
  return values;
}

/**
 * FNXC:TaskStorePersistence 2026-06-24-13:10:
 * Non-destructive task insert (VAL-DATA-009). Create-class operations MUST use
 * this, not the upsert. A plain `INSERT` against a primary-key column raises a
 * `unique_violation` (PostgreSQL error code 23505) on a duplicate id instead of
 * silently overwriting the existing row. Callers catch that error and surface
 * "Task ID already exists".
 *
 * @param layer The async data layer.
 * @param taskRecord A record carrying the Task fields to persist.
 * @param context Serialization context (lineageId).
 */
export async function insertTaskRow(
  layer: AsyncDataLayer,
  taskRecord: Record<string, unknown>,
  context: TaskPersistSerializationContext,
): Promise<void> {
  const values = buildTaskInsertValues(taskRecord, context, layer.projectId);
  await layer.db.insert(schema.project.tasks).values(values as never);
}

/**
 * Non-destructive task insert inside a shared transaction handle. Use this when
 * the create must commit/rollback atomically with sibling writes (e.g. an audit
 * row or a mergeQueue insert in the same transaction).
 */
export async function insertTaskRowInTransaction(
  tx: DbTransaction,
  taskRecord: Record<string, unknown>,
  context: TaskPersistSerializationContext,
  projectId?: string,
): Promise<void> {
  const values = buildTaskInsertValues(taskRecord, context, projectId);
  await tx.insert(schema.project.tasks).values(values as never);
}

/**
 * FNXC:TaskStorePersistence 2026-06-24-13:15:
 * Soft-delete a task (the deleteTask path). Sets `deleted_at`, moves the column
 * to 'archived', and stamps `updated_at`. This is non-destructive: the row is
 * retained for forensic reads and the task ID stays reserved (VAL-DATA-008 —
 * soft-deleted IDs are never reassigned because the allocator reconciliation
 * scans soft-deleted rows when bumping sequences).
 *
 * @param layer The async data layer.
 * @param id The task id to soft-delete.
 * @param deletedAt The deletion timestamp (ISO-8601).
 * @param allowResurrection Whether the task may be resurrected (1/0).
 */
export async function softDeleteTaskRow(
  layer: AsyncDataLayer,
  id: string,
  deletedAt: string,
  allowResurrection = false,
): Promise<void> {
  await layer.db
    .update(schema.project.tasks)
    .set({
      column: "archived",
      deletedAt,
      allowResurrection: allowResurrection ? 1 : 0,
      updatedAt: deletedAt,
    })
    .where(eq(schema.project.tasks.id, id));
}

/**
 * FNXC:TaskStoreArchiveLineage 2026-06-24-15:00:
 * Soft-delete a task INSIDE a shared transaction handle. This is the
 * transaction-aware variant of {@link softDeleteTaskRow} for composite
 * operations (archiveParentTaskWithLineageGate, restoreTaskFromArchive)
 * that must commit the soft-delete atomically with sibling writes.
 *
 * HAZARD FIX (runtime-workflow-async): the previous composite functions
 * called `softDeleteTaskRow(layer, ...)` inside a `layer.transactionImmediate`
 * block, but that helper used `layer.db` (the runtime connection) — the
 * UPDATE ran OUTSIDE the transaction, so a later rollback left the
 * soft-delete persisted while reverting its siblings. This variant takes
 * the `tx` handle so the UPDATE participates in the surrounding transaction
 * (VAL-DATA-002/003 — atomic commit/rollback).
 *
 * @param tx The transaction handle (from layer.transactionImmediate).
 * @param id The task id to soft-delete.
 * @param deletedAt The deletion timestamp (ISO-8601).
 * @param allowResurrection Whether the task may be resurrected (1/0).
 */
export async function softDeleteTaskRowInTransaction(
  tx: DbTransaction,
  id: string,
  deletedAt: string,
  allowResurrection = false,
): Promise<void> {
  await tx
    .update(schema.project.tasks)
    .set({
      column: "archived",
      deletedAt,
      allowResurrection: allowResurrection ? 1 : 0,
      updatedAt: deletedAt,
    })
    .where(eq(schema.project.tasks.id, id));
}

/**
 * Read a single task row by id. By default applies the soft-delete visibility
 * filter (VAL-DATA-005 — live readers hide deletedAt rows). Pass
 * `includeDeleted: true` for a forensic read that surfaces soft-deleted rows
 * (VAL-DATA-006).
 *
 * Returns the raw Drizzle row. JSON columns come back already-parsed (jsonb).
 */
export async function readTaskRow(
  layer: AsyncDataLayer,
  id: string,
  options?: { includeDeleted?: boolean },
): Promise<Record<string, unknown> | undefined> {
  const conditions = [eq(schema.project.tasks.id, id)];
  if (!options?.includeDeleted) {
    conditions.push(ACTIVE_TASK_FILTER);
  }
  // FNXC:MultiProjectIsolation 2026-07-10: scope the by-id read to the bound
  // project so one project's store can never resolve another project's task
  // (defence-in-depth; also protects the merger, which loads each merge-queue
  // entry's task via getTask -> readTaskRow and skips when not found).
  const projectScope = taskProjectScope(layer);
  if (projectScope) conditions.push(projectScope);
  const rows = await layer.db
    .select()
    .from(schema.project.tasks)
    .where(and(...conditions));
  return rows[0];
}

/**
 * FNXC:TaskStoreArchiveLineage 2026-06-24-15:05:
 * Read a single task row by id INSIDE a shared transaction handle. This is
 * the transaction-aware variant of {@link readTaskRow} for composite
 * operations (restoreTaskFromArchive) that must read within the same
 * transaction as their sibling writes for a consistent snapshot.
 *
 * HAZARD FIX (runtime-workflow-async): the previous restoreTaskFromArchive
 * called `readTaskRow(layer, ...)` inside its transactionImmediate block, but
 * that helper used `layer.db` — the read ran outside the transaction,
 * returning a non-transactional snapshot that could observe concurrent
 * writes. This variant takes the `tx` handle so the read participates in the
 * surrounding transaction (read-committed snapshot inside the txn).
 *
 * @param tx The transaction handle (from layer.transactionImmediate).
 * @param id The task id to read.
 * @param options Optional: includeDeleted surfaces soft-deleted rows.
 */
export async function readTaskRowInTransaction(
  tx: DbTransaction,
  id: string,
  options?: { includeDeleted?: boolean },
): Promise<Record<string, unknown> | undefined> {
  const conditions = [eq(schema.project.tasks.id, id)];
  if (!options?.includeDeleted) {
    conditions.push(ACTIVE_TASK_FILTER);
  }
  const rows = await tx
    .select()
    .from(schema.project.tasks)
    .where(and(...conditions));
  return rows[0];
}

/**
 * Read all live (non-soft-deleted) task rows. This is the live-reader scan that
 * backs active task lists, kanban, and counts. The soft-delete visibility
 * filter (deleted_at IS NULL) is always applied (VAL-DATA-005).
 *
 * FNXC:TaskStoreReads 2026-06-26-10:20:
 * The `excludeLog` option omits the heavy `log` jsonb column (~99% of row
 * payload on busy boards per the slim-read analysis) from the SELECT so the
 * wire transfer is bounded. Callers that need the activity log fetch the
 * individual task via `readTaskRow` (full row). This mirrors the SQLite path's
 * `getTaskSelectClause(slim)` projection.
 *
 * @param layer The async data layer.
 * @param options Optional: excludeLog drops the `log` jsonb column;
 *   includeDeleted surfaces soft-deleted rows for forensic reads (VAL-DATA-006);
 *   column/excludeColumn filter by board column in SQL; limit/offset paginate
 *   in SQL (ordered by createdAt then numeric id suffix).
 */
export async function readLiveTaskRows(
  layer: AsyncDataLayer,
  options?: { excludeLog?: boolean; includeDeleted?: boolean; column?: string; excludeColumn?: string; limit?: number; offset?: number },
): Promise<Record<string, unknown>[]> {
  // FNXC:TaskStoreForensicRead 2026-06-26-15:20:
  // VAL-DATA-006 — Forensic reads surface soft-deleted rows when explicitly
  // requested. By default the live-reader filter (deletedAt IS NULL) is
  // applied so soft-deleted tasks never appear on the board (VAL-DATA-005).
  // When includeDeleted is true the filter is dropped entirely, exposing
  // tombstoned rows for admin/forensic surfaces (e.g. GET /api/tasks?includeDeleted=true).
  // FNXC:MultiProjectIsolation 2026-07-10:
  // THE load-bearing isolation filter. readLiveTaskRows backs store.listTasks(),
  // which the engine scheduler/executor uses to decide what to run, plus the
  // board/kanban/count reads and the /api/tasks list. Scoping it to the bound
  // project is what stops a per-project engine from ever seeing — and therefore
  // claiming/executing in the wrong repo — another project's tasks on the shared
  // embedded-PG cluster. `and(...)` drops undefined operands, so the scope
  // collapses to just the live filter when the layer is project-agnostic.
  const projectScope = taskProjectScope(layer);
  /*
  FNXC:TaskStoreReadsPerf 2026-07-11 (PR #1793 review):
  Push the board filters and pagination into SQL. The previous shape read the
  ENTIRE live task table on every listTasks call and filtered/sorted/sliced in
  JS — every out-of-page row still paid wire transfer plus per-task hydration.
  `column`/`excludeColumn` become WHERE operands, and when the caller paginates
  (limit/offset) the query orders by (created_at, numeric id suffix) — the same
  comparator the JS sort uses — so the SQL page is exactly the JS page.
  */
  const columnScope = options?.column !== undefined
    ? eq(schema.project.tasks.column, options.column)
    : options?.excludeColumn !== undefined
      ? sql`${schema.project.tasks.column} IS DISTINCT FROM ${options.excludeColumn}`
      : undefined;
  const liveFilter = options?.includeDeleted
    ? and(projectScope, columnScope)
    : and(ACTIVE_TASK_FILTER, projectScope, columnScope);
  const paginate = options?.limit !== undefined || (options?.offset ?? 0) > 0;
  // Mirrors the JS comparator: createdAt ASC, then the numeric suffix of the
  // task id ("FN-12" → 12; no trailing digits → 0). substring() returns NULL
  // (→ 0) instead of throwing on ids without a numeric suffix.
  const createdAtIdOrder = [
    sql`${schema.project.tasks.createdAt} ASC`,
    sql`COALESCE(substring(${schema.project.tasks.id} from '-([0-9]+)$')::int, 0) ASC`,
  ];
  const applyPagination = <Q extends { orderBy: (...o: SQL[]) => Q; limit: (n: number) => Q; offset: (n: number) => Q }>(query: Q): Q => {
    if (!paginate) return query;
    let q = query.orderBy(...createdAtIdOrder);
    if (options?.limit !== undefined) q = q.limit(Math.max(0, options.limit));
    const offset = options?.offset ?? 0;
    if (offset > 0) q = q.offset(offset);
    return q;
  };
  if (options?.excludeLog) {
    // FNXC:TaskStoreReads 2026-06-26-11:45:
    // Select every column except `log` via a Drizzle `.select({...projection})`
    // query. Drizzle emits correct snake_case SQL identifiers for each Column
    // chunk (avoiding the earlier camelCase-vs-snake_case bug) and returns rows
    // keyed by the TS property name so the downstream `pgRowToTaskRow` /
    // `rowToTask` deserializers work unchanged. `log` is restored to `[]` when
    // a single task is fetched in full via `readTaskRow`.
    let query = layer.db.select(TASK_SLIM_PROJECTION).from(schema.project.tasks).$dynamic();
    if (liveFilter) query = query.where(liveFilter);
    const rows = await applyPagination(query);
    return rows as unknown as Record<string, unknown>[];
  }
  let query = layer.db.select().from(schema.project.tasks).$dynamic();
  if (liveFilter) query = query.where(liveFilter);
  return applyPagination(query);
}

/**
 * FNXC:TaskStorePersistence 2026-06-24-13:20:
 * Count live (non-soft-deleted) tasks. Soft-deleted rows are excluded so the
 * board count never includes tombstoned tasks (VAL-DATA-005).
 */
export async function countLiveTasks(layer: AsyncDataLayer): Promise<number> {
  // FNXC:MultiProjectIsolation 2026-07-10: scope live counts to the bound project.
  const rows = await layer.db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.project.tasks)
    .where(and(ACTIVE_TASK_FILTER, taskProjectScope(layer)));
  return rows[0]?.count ?? 0;
}

/**
 * FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-13:00:
 * Upsert a task row inside a transaction (the updateTask backend-mode path).
 * This is the async equivalent of the sync `upsertTask` — it performs an
 * INSERT ... ON CONFLICT (id) DO UPDATE so an existing task row is updated in
 * place and a new row is inserted if it does not exist.
 *
 * The upsert is used by `updateTask` (which always reads the task first and
 * then writes the updated fields). Create-class operations MUST use
 * `insertTaskRow` (non-destructive plain insert) instead, never this upsert.
 *
 * @param tx The transaction handle from layer.transactionImmediate.
 * @param taskRecord A record carrying the Task fields to persist.
 * @param context Serialization context (lineageId).
 */
export async function upsertTaskRowInTransaction(
  tx: DbTransaction,
  taskRecord: Record<string, unknown>,
  context: TaskPersistSerializationContext,
  projectId?: string,
): Promise<void> {
  const values = buildTaskInsertValues(taskRecord, context, projectId);
  const updateValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    // Never rewrite the primary key or the per-project partition key on update
    // (FNXC:MultiProjectIsolation — project_id is stable for a task's lifetime).
    if (key === "id" || key === "projectId") continue;
    updateValues[key] = value;
  }
  await tx
    .insert(schema.project.tasks)
    .values(values as never)
    .onConflictDoUpdate({
      target: schema.project.tasks.id,
      set: updateValues as never,
    });
}

/**
 * FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-13:05:
 * Update a subset of task columns by id (the updateTask backend-mode path
 * alternative when only specific columns changed). This builds a targeted
 * UPDATE statement rather than a full row upsert.
 *
 * @param layer The async data layer.
 * @param id The task id to update.
 * @param updates A record of column → value to SET.
 */
export async function updateTaskColumns(
  layer: AsyncDataLayer,
  id: string,
  updates: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(updates).length === 0) return;
  await layer.db
    .update(schema.project.tasks)
    .set(updates as never)
    .where(eq(schema.project.tasks.id, id));
}

/**
 * FNXC:TaskStorePersistence 2026-06-24-13:25:
 * Detect whether a primary-key violation is a PostgreSQL unique_violation
 * (error code 23505). The sync path used a regex against the SQLite message
 * (`SQLITE_CONSTRAINT|UNIQUE constraint failed: tasks.id`); PostgreSQL reports
 * a structured `code` field. Drizzle wraps postgres.js errors in a
 * "Failed query: ..." Error whose `cause` is the original `PostgresError`
 * carrying the `code`, so we inspect both the error and its `cause`. Both
 * SQLite and PostgreSQL checks are kept so the helper is robust across backends
 * during the transition.
 */
export function isTaskIdConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/SQLITE_CONSTRAINT|UNIQUE constraint failed: tasks\.id|PRIMARY KEY constraint failed: tasks\.id/i.test(message)) {
    return true;
  }
  // PostgreSQL unique_violation (23505). The code may be on the error directly
  // (raw postgres.js) or on the `cause` (Drizzle wraps postgres errors).
  const directCode = (error as { code?: string } | null)?.code;
  const causeCode = (error as { cause?: { code?: string } } | null)?.cause?.code;
  return directCode === "23505" || causeCode === "23505";
}
