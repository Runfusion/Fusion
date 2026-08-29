/**
 * FNXC:SqliteFinalRemoval 2026-06-26-09:45:
 * SQLite CentralDatabase class body DELETED (VAL-REMOVAL-005).
 *
 * The ~1090-line legacy sync `CentralDatabase` class (central schema SQL, 13
 * migrations, PRAGMA busy_timeout/journal_mode=DELETE/synchronous=foreign_keys,
 * BEGIN IMMEDIATE + SAVEPOINT nested transactions, task-claim mutex) was the
 * central-project-registry data layer. The runtime CentralCore now delegates
 * ALL central data access to PostgreSQL via the async `AsyncDataLayer`
 * (Drizzle, central schema) — see `async-central-core.ts`. The removed
 * `FUSION_NO_EMBEDDED_PG` runtime fallback is rejected by startup; only the
 * throwing compatibility type and explicit legacy migration readers remain.
 *
 * This module now re-exports the JSON utilities and `getDefaultCentralDbPath`
 * (still used by backup.ts and the onboard CLI), and provides a stub
 * `CentralDatabase` class whose methods throw. The stub preserves the public
 * type shape (including the `CentralClaimStore` interface) so consumers
 * continue to type-check under `tsc --noEmit` while the SQLite runtime is
 * removed.
 */

import { join } from "node:path";
import { resolveGlobalDir } from "../config/global-settings.js";
import type { CentralClaimStore, TaskClaimRow } from "../types.js";
import type { Statement } from "../db/db-helpers.js";

// Re-export the JSON utilities so existing `from "./central-db.js"` importers
// (secrets-store.ts, index.ts) keep working without touching them.
export { toJson, toJsonNullable, fromJson } from "../db/db-helpers.js";

/**
 * Resolve the default central DB file path.
 *
 * FNXC:SqliteFinalRemoval 2026-06-26-09:45:
 * The path is still used by backup.ts (to locate the legacy central DB for
 * one-time migration) and the onboard CLI (to print the path). It does NOT
 * imply the SQLite file is opened in production — the runtime uses PostgreSQL.
 */
export function getDefaultCentralDbPath(globalDir?: string): string {
  return join(resolveGlobalDir(globalDir), "fusion-central.db");
}

const SQLITE_REMOVED_MESSAGE =
  "SQLite CentralDatabase class body has been removed (VAL-REMOVAL-005). " +
  "CentralCore now uses PostgreSQL via AsyncDataLayer. This sync SQLite path " +
  "is unreachable in backend mode.";

function throwSqliteRemoved(): never {
  throw new Error(SQLITE_REMOVED_MESSAGE);
}

/**
 * Stub `CentralDatabase` class.
 *
 * FNXC:SqliteFinalRemoval 2026-06-26-09:45:
 * The ~1090-line SQLite CentralDatabase body is DELETED. This stub preserves
 * the public method signatures (and the CentralClaimStore interface contract)
 * so legacy API consumers and migration-oriented tests continue to type-check. Every method
 * throws because the SQLite runtime is gone; production CentralCore runs in
 * backend mode and never reaches these.
 */
export class CentralDatabase implements CentralClaimStore {
  constructor(
    _globalDir?: string,
    _options?: { busyTimeoutMs?: number; lockRecoveryWindowMs?: number; lockRecoveryDelayMs?: number },
  ) {}

  init(): void {
    throwSqliteRemoved();
  }

  prepare(_sql: string): Statement {
    throwSqliteRemoved();
  }

  exec(_sql: string): void {
    throwSqliteRemoved();
  }

  transaction<T>(_fn: () => T): T {
    throwSqliteRemoved();
  }

  transactionImmediate<T>(_fn: () => T): T {
    throwSqliteRemoved();
  }

  close(): void {
    // No-op: nothing to close (no SQLite handle was ever opened).
  }

  getLastModified(): number {
    throwSqliteRemoved();
  }

  bumpLastModified(): void {
    throwSqliteRemoved();
  }

  getSchemaVersion(): number {
    throwSqliteRemoved();
  }

  getPath(): string {
    throwSqliteRemoved();
  }

  getGlobalDir(): string {
    throwSqliteRemoved();
  }

  // ── CentralClaimStore contract ──────────────────────────────────────

  getTaskClaim(_projectId: string, _taskId: string): TaskClaimRow | null {
    throwSqliteRemoved();
  }

  tryClaimTask(_input: {
    projectId: string;
    taskId: string;
    nodeId: string;
    agentId: string;
    runId: string | null;
    renewedAt: string;
    expectedEpoch?: number | null;
  }): { ok: true; claim: TaskClaimRow } | { ok: false; reason: "conflict"; current: TaskClaimRow } {
    throwSqliteRemoved();
  }

  renewTaskClaim(_input: {
    projectId: string;
    taskId: string;
    nodeId: string;
    agentId: string;
    runId: string | null;
    renewedAt: string;
    expectedEpoch: number;
  }): { ok: true; claim: TaskClaimRow } | { ok: false; reason: "conflict" | "not_found"; current: TaskClaimRow | null } {
    throwSqliteRemoved();
  }

  releaseTaskClaim(_input: {
    projectId: string;
    taskId: string;
    nodeId: string;
    agentId: string;
  }): { ok: true } | { ok: false; reason: "not_owner" | "not_found"; current: TaskClaimRow | null } {
    throwSqliteRemoved();
  }
}

/**
 * Stub factory matching the legacy `createCentralDatabase` signature.
 */
export function createCentralDatabase(
  globalDir?: string,
  options?: { busyTimeoutMs?: number; lockRecoveryWindowMs?: number; lockRecoveryDelayMs?: number },
): CentralDatabase {
  return new CentralDatabase(globalDir, options);
}
