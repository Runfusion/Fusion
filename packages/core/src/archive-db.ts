/**
 * FNXC:SqliteFinalRemoval 2026-06-26-09:50:
 * SQLite ArchiveDatabase class body DELETED (VAL-REMOVAL-005).
 *
 * The legacy sync `ArchiveDatabase` class (archive schema SQL, FTS5 virtual
 * table + triggers — already no-op'd in session 6, LIKE-based search, PRAGMA
 * busy_timeout/journal_mode/synchronous/wal_autocheckpoint) was the archived-
 * task data layer. The runtime TaskStore now delegates ALL archive data
 * access to PostgreSQL via the async `AsyncDataLayer` (Drizzle, archive
 * schema) — see `async-archive-lineage.ts`. The SQLite path is only reachable
 * in the sync else-branch of `TaskStore.archiveDb` (task-id-integrity.ts),
 * which throws in backend mode and is never constructed in production.
 *
 * This module provides a stub `ArchiveDatabase` class whose methods throw.
 * The stub preserves the public type shape so the sync else-branches and
 * quarantined test files continue to type-check under `tsc --noEmit`.
 */

import type { ArchivedTaskEntry } from "./types.js";

const SQLITE_REMOVED_MESSAGE =
  "SQLite ArchiveDatabase class body has been removed (VAL-REMOVAL-005). " +
  "TaskStore now uses PostgreSQL via AsyncDataLayer for archive access. " +
  "This sync SQLite path is unreachable in backend mode.";

function throwSqliteRemoved(): never {
  throw new Error(SQLITE_REMOVED_MESSAGE);
}

/**
 * Stub `ArchiveDatabase` class.
 *
 * FNXC:SqliteFinalRemoval 2026-06-26-09:50:
 * The SQLite ArchiveDatabase body is DELETED. This stub preserves the public
 * method signatures so consumers (task-id-integrity.ts sync else-branch,
 * self-healing archive FTS calls — all gated behind backend-mode early
 * returns, and quarantined tests) continue to type-check. Every data method
 * throws because the SQLite runtime is gone.
 */
export class ArchiveDatabase {
  constructor(_fusionDir: string, _options?: { inMemory?: boolean }) {}

  init(): void {
    throwSqliteRemoved();
  }

  upsert(_entry: ArchivedTaskEntry): void {
    throwSqliteRemoved();
  }

  list(): ArchivedTaskEntry[] {
    throwSqliteRemoved();
  }

  /**
   * FNXC:ArchivePagination 2026-07-08-00:00:
   * Sqlite stub for FN-7659's paginated archive read; the live implementation
   * is the async Drizzle path (listArchivedTaskEntriesPage in async-archive
   * helpers) ordered archivedAt DESC with an id DESC tie-break.
   */
  listPage(_limit: number, _offset: number): ArchivedTaskEntry[] {
    throwSqliteRemoved();
  }

  get(_id: string): ArchivedTaskEntry | undefined {
    throwSqliteRemoved();
  }

  filterArchived(_ids: readonly string[]): Set<string> {
    throwSqliteRemoved();
  }

  delete(_id: string): void {
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

  getArchivedRowCount(): number {
    throwSqliteRemoved();
  }

  search(_query: string, _limit: number): ArchivedTaskEntry[] {
    throwSqliteRemoved();
  }

  close(): void {
    // No-op: nothing to close (no SQLite handle was ever opened).
  }
}
