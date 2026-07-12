/**
 * Async data-layer foundation (U4) — replaces the synchronous DatabaseSync adapter.
 *
 * FNXC:AsyncDataLayer 2026-06-24-09:00:
 * The synchronous `DatabaseSync` surface (`db.prepare(sql).get/run/all`,
 * `db.transaction(fn)`, `db.transactionImmediate(fn)`) is replaced by an async
 * Drizzle-backed connection. This module defines the stable data-layer
 * interface (the "AsyncDataLayer") that plugin stores and the decomposed
 * task-store modules consume, and provides the core CRUD/transaction
 * primitives they depend on.
 *
 * Why this module exists:
 *   R6 — the sync DatabaseSync data-access surface is replaced with an async
 *   data layer; no blocking/synchronous bridge to PostgreSQL remains
 *   (VAL-DATA-001). Every PostgreSQL client is async, so every data call site
 *   must be awaited. Store methods are already `async`, so the boundary exists;
 *   this module is the inner layer they call into.
 *
 * What this module provides (the foundation; U12-U15 migrate the actual stores):
 *   1. `AsyncDataLayer` — the stable interface plugin stores consume. It exposes
 *      the runtime Drizzle instance, a `transaction()` primitive, and
 *      `transactionImmediate()` for write-heavy paths.
 *   2. `transactionImmediate(async (tx) => ...)` — the async equivalent of the
 *      SQLite `BEGIN IMMEDIATE` path. In SQLite this acquired the RESERVED lock
 *      before user code ran so writers fail/retry before the callback executes.
 *      PostgreSQL uses MVCC (no BEGIN IMMEDIATE), so the closest equivalent for
 *      write-heavy paths is a transaction with READ WRITE access mode. All
 *      writes inside the callback commit atomically; a thrown error rolls back
 *      every write including audit rows (VAL-DATA-002, VAL-DATA-003).
 *   3. `recordRunAuditEventWithinTransaction(tx, input)` — the run-audit-event
 *      insertion that runs *inside* a shared transaction so the audit row
 *      commits or rolls back atomically with the mutation it accompanies
 *      (the run-audit-event-within-transaction behavior).
 *   4. The `getDatabase()` accessor contract changes to return this async-capable
 *      connection rather than the synchronous `Database` (U15 converts the
 *      direct-`prepare()` consumers that relied on the sync shape).
 *
 * Transaction isolation (VAL-DATA-004):
 *   Concurrent transactions do not observe each other's uncommitted writes.
 *   PostgreSQL's default `READ COMMITTED` isolation already guarantees this —
 *   a transaction never sees another transaction's uncommitted rows.
 *   `transactionImmediate()` defaults to `READ COMMITTED` (matching the SQLite
 *   behavioral contract: SQLite's default is also a read-committed-equivalent
 *   under WAL). Callers needing stricter guarantees can pass an isolation level.
 *
 * Concurrency model change:
 *   SQLite used WAL multi-process-over-one-file with BEGIN IMMEDIATE for
 *   write serialization. PostgreSQL uses a server process with MVCC, which
 *   structurally removes single-writer contention. The atomicity contract
 *   (multi-statement mutations commit/rollback together) is preserved by the
 *   Drizzle transaction callback wrapper.
 */

import { sql, eq, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase, PostgresJsTransaction } from "drizzle-orm/postgres-js";
import { randomUUID } from "node:crypto";
import type { PostgresConnections } from "./connection.js";
import * as schema from "./schema/index.js";
import { PROJECT_SCHEMA } from "./schema/_shared.js";

/**
 * FNXC:AsyncDataLayer 2026-06-24-09:00:
 * The schema-aware Drizzle instance type. U3 defined the schema-as-code
 * table objects; the runtime Drizzle instance is constructed schema-less at
 * the connection layer (connection.ts wraps postgres.js without a schema
 * binding so the same connection serves the schema-applier and the data
 * layer). The `DrizzleDb` type therefore mirrors that schema-less shape.
 *
 * Callers reference tables via the `schema.project.<table>` namespace
 * (imported from `./schema/index.js`) and pass them to the query builders.
 * This keeps the data-layer foundation decoupled from the full schema type
 * (which would require `ExtractTablesWithRelations` plumbing) while still
 * giving compile-time table references.
 */
export type DrizzleDb = PostgresJsDatabase<Record<string, never>>;

/**
 * A Drizzle transaction handle passed to a `transaction()` / `transactionImmediate()`
 * callback. It supports the same query builders as the top-level `DrizzleDb`
 * (select/insert/update/delete/execute) so code inside a transaction is written
 * identically to code outside one.
 *
 * Schema-less (matching `DrizzleDb`) so the foundation does not force every
 * caller through `ExtractTablesWithRelations` plumbing. Callers reference
 * tables via the `schema.project.<table>` namespace.
 */
export type DbTransaction = PostgresJsTransaction<Record<string, never>, Record<string, never>>;

/**
 * Transaction configuration. Maps the SQLite transaction modes onto PostgreSQL.
 *
 * FNXC:AsyncDataLayer 2026-06-24-09:05:
 * - `immediate` (the default for `transactionImmediate()`) maps to a PostgreSQL
 *   transaction with `READ WRITE` access mode. There is no direct BEGIN
 *   IMMEDIATE in PostgreSQL; MVCC provides atomicity and the access mode
 *   signals write intent.
 * - `isolationLevel` overrides the default (`READ COMMITTED`). Use
 *   `SERIALIZABLE` only when the write path genuinely requires it — most
 *   paths do not, and SERIALIZABLE introduces retryable serialization
 *   failures that callers must handle.
 */
export interface TransactionOptions {
  readonly isolationLevel?: "read uncommitted" | "read committed" | "repeatable read" | "serializable";
  readonly accessMode?: "read only" | "read write";
  readonly deferrable?: boolean;
}

/**
 * FNXC:AsyncDataLayer 2026-06-24-09:10:
 * The stable data-layer interface plugin stores and the decomposed task-store
 * modules consume. This is the contract that survives the SQLite→PostgreSQL
 * backend swap: plugins like `fusion-plugin-roadmap` keep working because they
 * program against this interface, not the underlying driver (VAL-DATA-016).
 *
 * Members:
 *   - `db` — the runtime Drizzle instance for queries outside explicit
 *     transactions. Schema-typed for compile-time safety.
 *   - `transaction(fn, options?)` — run `fn` inside a PostgreSQL transaction.
 *     All writes inside `fn` commit atomically on success; a thrown error
 *     rolls back every write (VAL-DATA-002, VAL-DATA-003). The callback
 *     receives a transaction handle with the same query surface as `db`.
 *   - `transactionImmediate(fn, options?)` — the write-heavy-path variant,
 *     equivalent to SQLite's `BEGIN IMMEDIATE`. Defaults to READ WRITE access
 *     mode. Use for multi-statement mutations and the
 *     run-audit-event-within-transaction pattern.
 *   - `ping()` — connectivity probe.
 *   - `close()` — release the connection pool.
 *
 * Stability contract:
 *   - Adding methods is backwards-compatible.
 *   - The signature of `transaction` / `transactionImmediate` is stable; do
 *     not change the callback shape or the return type without a major-version
 *     plugin contract bump.
 *   - The `db` member may gain schema (new tables) but its query-builder
 *     surface is stable.
 */
export interface AsyncDataLayer {
  /** Schema-typed runtime Drizzle instance for non-transactional queries. */
  readonly db: DrizzleDb;
  /**
   * FNXC:MultiProjectIsolation 2026-07-10:
   * The central-registry project ID this data layer is bound to, or undefined
   * for a project-agnostic layer (single-project / global / analytics reads).
   *
   * In embedded-PG mode every per-project TaskStore gets its OWN AsyncDataLayer
   * instance (constructed by the startup factory per projectId) but they all
   * connect to the SAME shared `fusion` database + `project` schema. This field
   * lets the task-store helpers scope every read/claim/insert on the flat
   * `project.tasks` / `project.archived_tasks` tables to a single project so
   * per-project engines cannot poll/claim/execute each other's tasks. When
   * undefined the scope filter is a no-op (back-compat: single-project stores,
   * cross-project analytics, and the SQLite path — which isolates by file — are
   * unaffected).
   */
  readonly projectId?: string;
  /**
   * Run an async callback inside a PostgreSQL transaction. All writes inside
   * the callback commit atomically; a thrown error rolls back every write
   * including audit rows. Concurrent transactions do not observe each other's
   * uncommitted writes (READ COMMITTED default isolation, VAL-DATA-004).
   */
  transaction<T>(fn: (tx: DbTransaction) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /**
   * Write-heavy-path transaction, equivalent to SQLite's `transactionImmediate()`.
   * Defaults to READ WRITE access mode. Use for multi-statement mutations where
   * the audit row must commit/rollback with the mutation (the
   * run-audit-event-within-transaction behavior).
   */
  transactionImmediate<T>(fn: (tx: DbTransaction) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** Connectivity probe; rejects if the backend is unreachable. */
  ping(): Promise<void>;
  /** Release the underlying connection pool. */
  close(): Promise<void>;
}

/**
 * Input for a run-audit event insertion. Mirrors the sync
 * `RunAuditEventInput` but lives here so the data-layer foundation owns the
 * transaction-scoped insertion helper.
 *
 * FNXC:AsyncDataLayer 2026-06-24-09:15:
 * The `id` column is the PRIMARY KEY. Inserting a duplicate id fails the
 * transaction with a primary-key constraint violation, which is one way to
 * trigger the rollback behavior for VAL-DATA-003 (a failing mutation inside
 * a transaction rolls back all writes including the audit row). The `domain`
 * column is free-text (no CHECK constraint) in both the SQLite and PostgreSQL
 * schemas.
 */
export interface RunAuditEventInput {
  readonly timestamp?: string;
  readonly taskId?: string;
  readonly agentId: string;
  readonly runId: string;
  readonly domain: string;
  readonly mutationType: string;
  readonly target: string;
  readonly metadata?: Record<string, unknown> | null;
}

/** A persisted run-audit event row. */
export interface RunAuditEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly taskId: string | null;
  readonly agentId: string;
  readonly runId: string;
  readonly domain: string;
  readonly mutationType: string;
  readonly target: string;
  readonly metadata: Record<string, unknown> | null;
}

/**
 * Construct the stable `AsyncDataLayer` from a `PostgresConnections` set.
 *
 * The data layer wraps the runtime Drizzle instance and exposes the
 * transaction primitives. The migration Drizzle instance is held by the
 * connections object for schema work (the applier) but is not part of the
 * data-layer contract plugin stores consume.
 *
 * @param connections The resolved PostgreSQL connection set (runtime + migration).
 * @param options Optional binding: `projectId` scopes task-table reads/writes
 *   to a single project (embedded-PG multi-project isolation, FNXC:MultiProjectIsolation).
 */
export function createAsyncDataLayer(
  connections: PostgresConnections,
  options?: { projectId?: string },
): AsyncDataLayer {
  // The runtime Drizzle instance is schema-less at the connection layer
  // (connection.ts constructs it without a schema binding so it works for
  // any caller). We cast to the schema-typed view so callers get
  // compile-time table references via `layer.db`.
  const db = connections.runtime as unknown as DrizzleDb;

  return {
    db,
    projectId: options?.projectId,
    async transaction<T>(fn: (tx: DbTransaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
      return runInTransaction(db, fn, options);
    },
    async transactionImmediate<T>(fn: (tx: DbTransaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
      return runInTransaction(db, fn, {
        accessMode: "read write",
        ...options,
      });
    },
    async ping(): Promise<void> {
      await connections.ping();
    },
    async close(): Promise<void> {
      await connections.close();
    },
  };
}

/**
 * Internal: run `fn` inside a Drizzle transaction with the given options.
 *
 * Drizzle's `db.transaction(callback, config)` issues `BEGIN` (with the
 * configured isolation/access mode), runs the callback, and commits on normal
 * return or rolls back on a thrown error. This is the atomicity primitive
 * that preserves the SQLite `transactionImmediate()` contract (VAL-DATA-002,
 * VAL-DATA-003).
 *
 * The config object maps directly onto PostgreSQL's SET TRANSACTION
 * TRANSACTION ISOLATION LEVEL / ACCESS MODE / DEFERRABLE clauses. When no
 * options are set, `undefined` is passed so Drizzle uses a plain `BEGIN`
 * (passing an empty object makes Drizzle emit a malformed `SET TRANSACTION `
 * with no clauses, so we omit the config entirely in the no-options case).
 */
async function runInTransaction<T>(
  db: DrizzleDb,
  fn: (tx: DbTransaction) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  const config: {
    isolationLevel?: TransactionOptions["isolationLevel"];
    accessMode?: TransactionOptions["accessMode"];
    deferrable?: boolean;
  } = {};
  if (options?.isolationLevel) config.isolationLevel = options.isolationLevel;
  if (options?.accessMode) config.accessMode = options.accessMode;
  if (typeof options?.deferrable === "boolean") config.deferrable = options.deferrable;

  // Drizzle's transaction callback receives a typed transaction handle.
  // The cast bridges the schema-less runtime instance to the schema-typed
  // transaction surface callers program against.
  const hasConfig =
    config.isolationLevel !== undefined ||
    config.accessMode !== undefined ||
    config.deferrable !== undefined;
  return db.transaction(
    async (tx) => fn(tx as unknown as DbTransaction),
    hasConfig ? config : undefined,
  );
}

/**
 * FNXC:AsyncDataLayer 2026-06-24-09:20:
 * Insert a run-audit event row *inside* the given transaction handle.
 *
 * This is the run-audit-event-within-transaction behavior: the audit row is
 * written using the same transaction handle as the mutation it accompanies,
 * so it commits or rolls back atomically. Callers pass the `tx` they received
 * from `transactionImmediate(async (tx) => ...)`.
 *
 * If the insert fails (e.g. a CHECK-constraint violation on `domain`), the
 * error propagates and Drizzle rolls back the entire transaction — including
 * any prior writes in the same callback. This is the rollback coverage that
 * VAL-DATA-003 requires.
 *
 * @param tx The transaction handle from `transaction()` / `transactionImmediate()`.
 * @param input The audit event input.
 * @returns The persisted event (with generated id/timestamp if not provided).
 */
export async function recordRunAuditEventWithinTransaction(
  tx: DbTransaction,
  input: RunAuditEventInput,
): Promise<RunAuditEvent> {
  const id = randomUUID();
  const timestamp = input.timestamp ?? new Date().toISOString();
  const event: RunAuditEvent = {
    id,
    timestamp,
    taskId: input.taskId ?? null,
    agentId: input.agentId,
    runId: input.runId,
    domain: input.domain,
    mutationType: input.mutationType,
    target: input.target,
    metadata: input.metadata ?? null,
  };

  await tx.insert(schema.project.runAuditEvents).values({
    id: event.id,
    timestamp: event.timestamp,
    taskId: event.taskId,
    agentId: event.agentId,
    runId: event.runId,
    domain: event.domain,
    mutationType: event.mutationType,
    target: event.target,
    metadata: event.metadata,
  });

  return event;
}

/**
 * FNXC:AsyncDataLayer 2026-06-24-09:25:
 * Convenience: insert a run-audit event in its own transaction. This mirrors
 * the standalone `recordRunAuditEvent` path used when the audit row is not
 * paired with a task mutation (e.g. a system bookkeeping event). Most callers
 * should use `recordRunAuditEventWithinTransaction(tx, ...)` to pair the
 * audit row with the mutation it describes.
 */
export async function recordRunAuditEvent(
  layer: AsyncDataLayer,
  input: RunAuditEventInput,
): Promise<RunAuditEvent> {
  return layer.transactionImmediate(async (tx) =>
    recordRunAuditEventWithinTransaction(tx, input),
  );
}

/**
 * FNXC:AsyncDataLayer 2026-06-24-09:30:
 * Helper to build a qualified SQL fragment referencing a project-schema table.
 * The project schema is namespaced (`project.<table>`), so raw-SQL call sites
 * inside transactions need the schema qualifier. Exposed so the migrating
 * stores (U12-U14) can reference tables by their PostgreSQL-qualified name
 * without re-deriving the schema constant.
 *
 * `sql.identifier` takes a single name; a schema-qualified reference needs two
 * identifiers joined as raw SQL (`schema"."table`) to avoid search_path
 * ambiguity. The tableName is interpolated as a raw identifier (not a
 * parameter) so it is treated as a column/table name, not a value.
 */
export function projectTable(tableName: string): SQL {
  return sql.raw(`${PROJECT_SCHEMA}."${tableName}"`);
}

/**
 * FNXC:MultiProjectIsolation 2026-07-10:
 * The per-project scope predicate for the flat `project.tasks` table. Returns
 * `project_id = <layer.projectId>` when the data layer is bound to a project,
 * or `undefined` (a no-op inside Drizzle's `and(...)`) when it is not.
 *
 * Every backend-mode task READ / CLAIM / LIST / COUNT path folds this into its
 * WHERE clause so a per-project engine only ever sees its own project's rows on
 * the shared embedded-PG cluster. `undefined` preserves the pre-isolation
 * behavior for project-agnostic layers (single-project stores, cross-project
 * analytics) and is safe to pass through `and()` (Drizzle drops undefined
 * operands).
 *
 * NOTE: this operand is passed to `and(...)` so it is only enforced where a
 * caller actually threads it in. The load-bearing sites are the row-scan
 * readers (readLiveTaskRows, readTaskRow, countLiveTasks), the merge-lease
 * candidate scan, and the search scans — see the FNXC:MultiProjectIsolation
 * markers in the task-store helpers.
 */
export function taskProjectScope(layer: Pick<AsyncDataLayer, "projectId">): SQL | undefined {
  return layer.projectId ? eq(schema.project.tasks.projectId, layer.projectId) : undefined;
}

/** As {@link taskProjectScope} but for the `project.archived_tasks` table. */
export function archivedTaskProjectScope(
  layer: Pick<AsyncDataLayer, "projectId">,
): SQL | undefined {
  return layer.projectId
    ? eq(schema.project.archivedTasks.projectId, layer.projectId)
    : undefined;
}
