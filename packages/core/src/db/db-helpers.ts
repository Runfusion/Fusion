/**
 * FNXC:SqliteFinalRemoval 2026-06-26-09:00:
 * Standalone module for the JSON/schema utilities that ~55 production files
 * import. These were previously exported from db.ts alongside the SQLite
 * `Database` class. When the Database class body was deleted (VAL-REMOVAL-005),
 * the utilities were extracted here so importers no longer depend on the
 * SQLite module. db.ts re-exports them for backward compatibility.
 *
 * These helpers are pure (no SQLite, no I/O) and are safe for both the
 * PostgreSQL backend mode and the legacy SQLite test paths.
 */

import type { SteeringComment, TaskComment } from "../types.js";

// ── Types ────────────────────────────────────────────────────────────

/**
 * A prepared SQL statement shape.
 *
 * FNXC:SqliteFinalRemoval 2026-06-26-09:00:
 * Previously `ReturnType<DatabaseSync["prepare"]>`. The SQLite DatabaseSync
 * type now lives only in sqlite-adapter.ts (kept for the one-time migration
 * tool). This alias preserves the structural type so the stub Database class
 * and its consumers continue to type-check without importing the SQLite
 * adapter into production data paths.
 */
export interface Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

/** Result payload for explicit database compaction. */
export interface VacuumResult {
  beforeBytes: number;
  afterBytes: number;
  durationMs: number;
}

export interface ProjectIdentity {
  id: string;
  createdAt: string;
  firstSeenPath: string;
}

export class ProjectIdentityConflictError extends Error {
  readonly storedId: string;
  readonly storedPath: string;
  readonly incomingId: string;
  readonly incomingPath: string;

  constructor(input: {
    storedId: string;
    storedPath: string;
    incomingId: string;
    incomingPath: string;
  }) {
    super(
      `Project identity conflict: stored id ${input.storedId} (${input.storedPath}) does not match incoming id ${input.incomingId} (${input.incomingPath})`,
    );
    this.name = "ProjectIdentityConflictError";
    this.storedId = input.storedId;
    this.storedPath = input.storedPath;
    this.incomingId = input.incomingId;
    this.incomingPath = input.incomingPath;
  }
}

// ── JSON Helpers ─────────────────────────────────────────────────────

/**
 * Stringify a value for storage in a JSON column.
 * Stringifies arrays/objects. Returns '[]' for empty arrays.
 * For undefined/null, returns '[]' (safe default for array-backed columns).
 *
 * For nullable object columns (prInfo, issueInfo, etc.), use toJsonNullable() instead.
 */
export function toJson(value: unknown): string {
  if (value === undefined || value === null) return "[]";
  if (Array.isArray(value) && value.length === 0) return "[]";
  return JSON.stringify(value);
}

/**
 * Stringify a value for a nullable JSON column (non-array).
 * Returns null (SQL NULL) for undefined/null.
 * For use with optional object columns like prInfo, issueInfo, lastRunResult.
 */
export function toJsonNullable(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** Parse a JSON column value. Returns undefined for null/empty/invalid. */
export function fromJson<T>(json: string | null | undefined): T | undefined {
  if (json === null || json === undefined || json === "") return undefined;
  try {
    const parsed = JSON.parse(json);
    // Treat JSON null as undefined for consistency
    if (parsed === null) return undefined;
    return parsed as T;
  } catch {
    return undefined;
  }
}

export function isSqliteLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_(?:BUSY|LOCKED)|database is locked|database table is locked/i.test(message);
}

export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

// ── Schema version ───────────────────────────────────────────────────

/**
 * The historical SQLite schema version constant.
 *
 * FNXC:SqliteFinalRemoval 2026-06-26-09:00:
 * This was the highest migration number applied by the legacy SQLite
 * `Database.applyMigration` loop. It is retained for compatibility with
 * code that references it (e.g. workflow schema-version checks) and as
 * documentation of the snapshot the PostgreSQL Drizzle migration was
 * generated from. It is NOT used by the PostgreSQL data path, which uses
 * Drizzle's own migration history.
 */
export const SCHEMA_VERSION = 130;

// ── Comment normalization ────────────────────────────────────────────

/**
 * Merge steering comments into the unified task comment list, deduplicating
 * by id (or text+author+createdAt fallback). Returns the deduped comments
 * plus the original steering comments list.
 */
export function normalizeTaskComments(
  steeringComments: SteeringComment[] | undefined,
  comments: TaskComment[] | undefined,
): { steeringComments: SteeringComment[]; comments: TaskComment[] } {
  const normalizedComments: TaskComment[] = [];
  const seenKeys = new Set<string>();

  const pushComment = (comment: TaskComment) => {
    const key = comment.id || `${comment.text}\u0000${comment.author}\u0000${comment.createdAt}`;
    const existingIndex = normalizedComments.findIndex((entry) => {
      if (comment.id && entry.id) {
        return entry.id === comment.id;
      }
      return (
        entry.text === comment.text &&
        entry.author === comment.author &&
        entry.createdAt === comment.createdAt
      );
    });

    if (existingIndex !== -1) {
      const existing = normalizedComments[existingIndex];
      normalizedComments[existingIndex] = {
        ...existing,
        ...comment,
        updatedAt: comment.updatedAt ?? existing.updatedAt,
      };
      seenKeys.add(key);
      return;
    }

    if (!seenKeys.has(key)) {
      normalizedComments.push(comment);
      seenKeys.add(key);
    }
  };

  for (const comment of comments || []) {
    if (!comment || !comment.id || !comment.createdAt) continue;
    pushComment(comment);
  }

  for (const comment of steeringComments || []) {
    if (!comment || !comment.id || !comment.createdAt) continue;
    pushComment({
      id: comment.id,
      text: comment.text,
      author: comment.author,
      createdAt: comment.createdAt,
    });
  }

  return {
    steeringComments: steeringComments || [],
    comments: normalizedComments,
  };
}
