/**
 * FNXC:SqliteFinalRemoval 2026-06-26-09:30:
 * SQLite Database class body DELETED (VAL-REMOVAL-005).
 *
 * The full ~5900-line SQLite `Database` class (schema SQL, 130 migrations,
 * PRAGMA configuration, FTS5 virtual tables/triggers, VACUUM/WAL-checkpoint
 * maintenance, integrity-check offload, schema-compat fingerprinting) was the
 * legacy synchronous data layer. The runtime now uses PostgreSQL via the
 * async `AsyncDataLayer` (Drizzle) for ALL production data access. The SQLite
 * path was only reachable in non-backend mode (test fixtures / one-time
 * migrator), and the migrator uses the low-level `DatabaseSync` from
 * `sqlite-adapter.ts` directly — it never needed this class.
 *
 * This module now re-exports the pure JSON/schema utilities that ~55 production
 * files import (extracted to `db-helpers.ts`) and provides a stub `Database`
 * class whose methods throw. The stub preserves the public type shape so the
 * satellite stores' sync else-branches (dead in backend mode) and the
 * quarantined test files continue to type-check under `tsc --noEmit` while
 * their SQLite runtime code is removed in lockstep.
 *
 * What is KEPT for the one-time SQLite→PostgreSQL migration tool:
 *   - `sqlite-adapter.ts` (`DatabaseSync`)
 *   - `sqlite-validation.ts`
 *   - `sqlite-migrator.ts` (migration tool; lives in the migrator package)
 *
 * What is GONE: every PRAGMA, ATTACH DATABASE, FTS5 probe, VACUUM, WAL
 * checkpoint, integrity_check, and `sqlite3` CLI offload code path.
 */

// Re-export the pure utilities so existing `from "./db.js"` importers keep working.
export {
  toJson,
  toJsonNullable,
  fromJson,
  isSqliteLockError,
  sleepSync,
  normalizeTaskComments,
  SCHEMA_VERSION,
  ProjectIdentityConflictError,
} from "./db-helpers.js";
export type { Statement, VacuumResult, ProjectIdentity } from "./db-helpers.js";

import type { Statement, VacuumResult, ProjectIdentity } from "./db-helpers.js";
import type { PluginOnSchemaInit } from "./plugin-types.js";

/**
 * No-op stub for the legacy SQLite `probeFts5` runtime capability probe.
 *
 * FNXC:SqliteFinalRemoval 2026-06-26-09:30:
 * FTS5 is removed. Always returns false. Retained only because central-db.ts
 * and archive-db.ts historically imported it; their stubs no longer call it.
 */
export function probeFts5(): boolean {
  return false;
}

/**
 * No-op stub for the legacy `isFts5CorruptionError` classifier.
 * FTS5 is removed; there is no FTS5 corruption to classify.
 */
export function isFts5CorruptionError(_error: unknown): boolean {
  return false;
}

/**
 * No-op stub for the test-only in-memory DB snapshot hook.
 *
 * FNXC:SqliteFinalRemoval 2026-06-26-09:30:
 * The migrated-DB snapshot harness (store-test-helpers.ts /
 * db-snapshot-helper.ts) amortized `db.init()` cost across in-memory SQLite
 * DBs in tests. With the SQLite `Database` class body deleted, the snapshot
 * has no consumer; this stub accepts the call so quarantined test fixtures
 * that still reference it continue to type-check and run their setup without
 * throwing. The snapshot bytes are discarded.
 */
export function setInMemoryTemplateSnapshot(_snapshot: Uint8Array | null): void {
  // No-op: SQLite in-memory snapshot harness removed with the Database class.
}

/**
 * Stub for the legacy schema-compat table schema map.
 *
 * FNXC:SqliteFinalRemoval 2026-06-26-09:30:
 * The schema-compatibility fingerprint was a SQLite-only self-heal mechanism
 * (PRAGMA table_info reconciliation). PostgreSQL uses Drizzle's migration
 * history and `information_schema`-based validation instead. Returns an empty
 * map; no production code imports this (only comments reference it).
 */
export function getSchemaSqlTableSchemas(): Map<string, Map<string, string>> {
  return new Map();
}
export function getSchemaCompatibilityTableSchemas(): Map<string, Map<string, string>> {
  return new Map();
}
export const MIGRATION_ONLY_TABLE_SCHEMAS: Record<string, Record<string, string>> = {};
export const SCHEMA_COMPAT_FINGERPRINT = "";

/**
 * No-op stubs for the legacy SQLite file-integrity helpers.
 * PostgreSQL health checks live in `postgres/postgres-health.ts`.
 */
export function quickCheckSqliteFile(_dbPath: string): { ok: boolean; verified: boolean; errors?: string[] } {
  return { ok: true, verified: false };
}
export async function integrityCheckSqliteFileAsync(
  _dbPath: string,
): Promise<{ ok: boolean; errors?: string[] }> {
  return { ok: true };
}

// ── Stub Database class ──────────────────────────────────────────────

const SQLITE_REMOVED_MESSAGE =
  "SQLite Database class body has been removed (VAL-REMOVAL-005). " +
  "The runtime uses PostgreSQL via AsyncDataLayer. This sync SQLite path is " +
  "unreachable in backend mode; if you hit this, a non-backend-mode caller " +
    "was not migrated.";

function throwSqliteRemoved(): never {
  throw new Error(SQLITE_REMOVED_MESSAGE);
}

/**
 * Stub `Database` class.
 *
 * FNXC:SqliteFinalRemoval 2026-06-26-09:30:
 * The ~5900-line SQLite `Database` class body (constructor, schema SQL, 130
 * migrations, PRAGMA/FTS5/VACUUM/WAL/integrity-check code) is DELETED. This
 * stub preserves the public method signatures so the satellite stores' sync
 * else-branches and quarantined test files continue to type-check under
 * `tsc --noEmit`. Every method throws because the SQLite runtime is gone;
 * production runs in backend mode (PostgreSQL) and never reaches these.
 */
export class Database {
  corruptionDetected = false;
  integrityCheckErrors: string[] = [];
  integrityCheckPending = false;
  integrityCheckLastRunAt: string | null = null;

  /** Stub: preserves the constructor signature for type-compat only. */
  constructor(
    private readonly dbPath: string = ":memory:",
    _options?: { inMemory?: boolean; busyTimeoutMs?: number; lockRecoveryWindowMs?: number; lockRecoveryDelayMs?: number },
  ) {}

  get path(): string {
    return this.dbPath;
  }

  static recoverIfCorrupt(_fusionDir: string): {
    status: "absent" | "healthy" | "unverified" | "recovered" | "failed";
    corruptBackupPath?: string;
    recoveredPath?: string;
    errors?: string[];
  } {
    return { status: "absent" };
  }

  init(): void {
    throwSqliteRemoved();
  }

  /**
   * Stub for the legacy SQLite plugin onSchemaInit hook runner.
   *
   * FNXC:SqliteFinalRemoval 2026-06-26-09:30:
   * Plugin schema-init against the SQLite DB is removed. The PostgreSQL
   * backend runs plugin schema init via the async data layer. This stub is
   * reachable only through `taskStore.getDatabase()` which throws in backend
   * mode; it preserves the signature for the engine plugin-runner's type-check.
   */
  async runPluginSchemaInits(
    _hooks: Array<{ pluginId: string; hook: PluginOnSchemaInit }>,
  ): Promise<void> {
    throwSqliteRemoved();
  }

  prepare(_sql: string): Statement {
    throwSqliteRemoved();
  }
  exec(_sql: string): void {
    throwSqliteRemoved();
  }
  transaction<T>(_fn: () => T, _options?: { mode?: "deferred" | "immediate" }): T {
    throwSqliteRemoved();
  }
  transactionImmediate<T>(_fn: () => T): T {
    throwSqliteRemoved();
  }
  close(): void {
    // No-op: nothing to close (no SQLite handle was ever opened).
  }
  serializeSnapshot(): Uint8Array {
    throwSqliteRemoved();
  }
  get fts5Available(): boolean {
    return false;
  }
  rebuildFts5Index(): boolean {
    return false;
  }
  optimizeFts5(_mode?: "optimize" | "merge"): boolean {
    return false;
  }
  getFtsIndexBytes(): number | null {
    return null;
  }
  getTaskRowCount(): number {
    throwSqliteRemoved();
  }
  checkFts5Integrity(): boolean {
    return false;
  }
  integrityCheck(): { ok: true } | { ok: false; errors: string[] } {
    return { ok: true };
  }
  refreshIntegrityCheck(): { ok: true } | { ok: false; errors: string[] } {
    return { ok: true };
  }
  recoverDatabase(_outputPath: string): boolean {
    return false;
  }
  vacuum(): VacuumResult {
    throwSqliteRemoved();
  }
  dropOrphanRecoveryTables(): number {
    return 0;
  }
  pruneOperationalLogs(_retentionMs: number): { deletedByTable: Record<string, number>; deletedTotal: number } {
    return { deletedByTable: {}, deletedTotal: 0 };
  }
  walCheckpoint(_mode?: "PASSIVE" | "TRUNCATE"): { busy: number; log: number; checkpointed: number } {
    return { busy: 0, log: 0, checkpointed: 0 };
  }
  getProjectIdentity(): ProjectIdentity | undefined {
    throwSqliteRemoved();
  }
  setProjectIdentity(_identity: ProjectIdentity, _options?: { force?: boolean }): void {
    throwSqliteRemoved();
  }
  clearProjectIdentity(): void {
    throwSqliteRemoved();
  }
  getLastModified(): number {
    throwSqliteRemoved();
  }
  bumpLastModified(): void {
    throwSqliteRemoved();
  }
  getBootstrappedAt(): number | null {
    throwSqliteRemoved();
  }
  getSchemaVersion(): number {
    throwSqliteRemoved();
  }
  getPath(): string {
    return this.dbPath;
  }
}

/**
 * Stub factory matching the legacy `createDatabase` signature.
 * Returns a Database stub instance (never initialized).
 */
export function createDatabase(fusionDir: string, _options?: { inMemory?: boolean }): Database {
  return new Database(fusionDir);
}

/**
 * FNXC:SqliteFinalRemoval 2026-06-26-09:30:
 * Legacy sync project-identity readers. Production now uses the
 * `readProjectIdentity` / `writeProjectIdentity` in `project-identity.ts`
 * (which uses the low-level `DatabaseSync` for the local anchor file),
 * re-exported from index.ts. These db.ts versions are kept as stubs only
 * for backward-compat with any internal caller that imports from "./db.js"
 * directly; they delegate to the project-identity module.
 */
export { readProjectIdentity, writeProjectIdentity } from "./project-identity.js";
