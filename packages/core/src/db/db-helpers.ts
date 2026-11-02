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
 * Raised when a value cannot be written to an array-backed jsonb column without changing its shape.
 */
export class TaskLogShapeError extends Error {
  readonly receivedType: string;
  constructor(input: { receivedType: string; preview: string }) {
    super(
      `Expected an array for an array-backed jsonb column, received ${input.receivedType}: ${input.preview}`,
    );
    this.name = "TaskLogShapeError";
    this.receivedType = input.receivedType;
  }
}

/*
FNXC:TaskLogShape 2026-11-02-18:20 (RUFU-858):
`project.tasks.log` is jsonb whose contract is an ARRAY of entries, and two distinct corruptions of that one
column were measured on 2026-11-02:

1. Double-encoding. `toJson()` stringifies anything that is not null/empty-array, so a value that was
   ALREADY JSON text was written as a jsonb *scalar* (`jsonb_typeof(log) = 'string'`). Two rows reached that
   shape. Because store queries select `id, log` across a whole `project_id`, ONE scalar row makes every
   project-wide read throw - so `fn task delete` reported failure after its own write committed, and
   `fn task create` failed having created nothing. Both rows healed cleanly by re-parsing the inner text.
2. Character-spread. The append path built `[...(current.log ?? []), entry]`; spreading a string yields single
   characters, which would have written an array of 1-char strings instead.

So the seam heals exactly one shape - JSON text that parses to an array - and refuses everything else. It
must not silently fall back to `[]`: that would delete the operator's task history to keep a write green.
Refusing loudly is affordable because after the 2026-11-02 data repair the count of non-array rows is zero,
so this guard is a tripwire, not a hot path.
*/

/**
 * Normalize a value for an array-backed jsonb column (e.g. `tasks.log`).
 *
 * - array / undefined / null  -> used as-is (`[]` for absent)
 * - JSON text that parses to an array -> healed to that array
 * - anything else -> {@link TaskLogShapeError}, never a silent `[]`
 */
export function coerceTaskLogArray<T = unknown>(value: unknown): T[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    const preview = value.slice(0, 80);
    // The measured corruption is TWO layers deep: the column holds a jsonb scalar whose text is itself the
    // JSON of the entry array. One parse yields a string; the array only appears after the second. Bounded
    // deliberately - an unbounded unwrap loop would accept any depth of self-nesting.
    let current: unknown = value;
    for (let unwrap = 0; unwrap < 2; unwrap++) {
      if (Array.isArray(current)) return current as T[];
      if (typeof current !== "string") break;
      try {
        current = JSON.parse(current);
      } catch {
        break;
      }
    }
    if (Array.isArray(current)) return current as T[];
    throw new TaskLogShapeError({
      receivedType: typeof current === "object" && current !== null ? "object" : String(typeof current),
      preview,
    });
  }
  throw new TaskLogShapeError({ receivedType: typeof value, preview: String(value).slice(0, 80) });
}

/**
 * Stringify a value for an ARRAY-backed jsonb column. Use this instead of `toJson()` wherever the column
 * contract is an array; `toJson()` will happily write a jsonb scalar and poison every project-wide read.
 */
export function toJsonArray(value: unknown): string {
  const arr = coerceTaskLogArray(value);
  return arr.length === 0 ? "[]" : JSON.stringify(arr);
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
