/**
 * SQLite adapter that picks the runtime's native SQLite at construction time:
 *   - Bun runtime  → `bun:sqlite` (built-in, no native module dance)
 *   - Node runtime → `node:sqlite` (Node 22+ built-in)
 *
 * Exports a `DatabaseSync` class with the subset of node:sqlite's API that the
 * fn codebase actually uses: `prepare`, `exec`, `close`, and prepared
 * statement methods `all`, `get`, `run`.
 *
 * The adapter exists because Bun's --compile bundler does not implement
 * `node:sqlite` (require returns undefined silently; import throws), so a
 * standalone Bun binary cannot use the same module that plain `node` uses.
 */

import { createRequire } from "node:module";
import { assertOutsideRealFusionPath } from "../process/test-safety.js";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

// Use createRequire so the bundler does not statically trace these specifiers.
// Bun's bundler will skip require() calls whose argument it cannot resolve at
// build time, which keeps `node:sqlite` from being eagerly pulled into the
// compiled binary (where it would fail to resolve at runtime).
const requireFromHere = createRequire(import.meta.url);

export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): SqliteRunResult;
}

interface RawStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): RawStatement;
  close(): void;
  // Optional snapshot API (node:sqlite ≥ 22.x, bun:sqlite). Both runtimes
  // expose `serialize()` → Uint8Array and `deserialize(buf)` that replaces the
  // open database's contents in place. Used only by the test snapshot harness.
  serialize?: () => Uint8Array;
  deserialize?: (data: Uint8Array) => void;
}

type DatabaseCtor = new (path: string, options?: Record<string, unknown>) => RawDatabase;

let cachedCtor: DatabaseCtor | null = null;

function loadDatabaseCtor(): DatabaseCtor {
  if (cachedCtor) return cachedCtor;

  if (isBun) {
    const mod = requireFromHere("bun:sqlite") as { Database: DatabaseCtor };
    cachedCtor = mod.Database;
  } else {
    const mod = requireFromHere("node:sqlite") as { DatabaseSync: DatabaseCtor };
    cachedCtor = mod.DatabaseSync;
  }
  return cachedCtor;
}

/**
 * Drop-in replacement for `node:sqlite`'s `DatabaseSync`. Backed by
 * `bun:sqlite` under Bun and `node:sqlite` under Node.
 */
export class DatabaseSync {
  private impl: RawDatabase;

  constructor(path: string, options?: { readOnly?: boolean }) {
    assertOutsideRealFusionPath(path, "SQLite database open");
    const Ctor = loadDatabaseCtor();
    /* FNXC:LegacySqliteBoundary 2026-07-14-18:42:
     * Remaining SQLite access is migration/import/validation only. Open those
     * sources read-only so discovery cannot create files, recover WALs, or
     * checkpoint legacy databases during normal PostgreSQL startup.
     */
    const runtimeOptions = options?.readOnly
      ? (isBun ? { readonly: true } : { readOnly: true })
      : undefined;
    this.impl = runtimeOptions ? new Ctor(path, runtimeOptions) : new Ctor(path);
  }

  exec(sql: string): void {
    this.impl.exec(sql);
  }

  close(): void {
    this.impl.close();
  }

  /**
   * FNXC:CoreTests 2026-06-25-16:30:
   * Snapshot the entire database into a byte buffer. Backs the test-only
   * migrated-DB snapshot harness so the 129-migration init() runs once per
   * test file instead of once per test. Throws if the runtime lacks the API.
   */
  serialize(): Uint8Array {
    if (typeof this.impl.serialize !== "function") {
      throw new Error("SQLite runtime does not support serialize()");
    }
    return this.impl.serialize();
  }

  /**
   * FNXC:CoreTests 2026-06-25-16:30:
   * Replace this (in-memory) database's contents with a previously serialized
   * snapshot. Restores a fully-migrated schema without replaying migrations.
   */
  deserialize(data: Uint8Array): void {
    if (typeof this.impl.deserialize !== "function") {
      throw new Error("SQLite runtime does not support deserialize()");
    }
    this.impl.deserialize(data);
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this.impl.prepare(sql);
    /*
    FNXC:Storage 2026-06-25-00:00:
    Node v26's node:sqlite rejects `undefined` bound parameters with
    ERR_INVALID_ARG_TYPE ("Provided value cannot be bound to SQLite parameter").
    Bun's bun:sqlite and the legacy better-sqlite3 treat `undefined` as NULL.
    To preserve the historical contract that callers may pass `undefined` for
    an optional/absent column value, coerce each param: undefined → null before
    handing it to the underlying statement. This is the production-safe fix
    (no caller depends on `undefined` being a distinct value from NULL — NULL
    is the SQL-correct representation of "no value"). The coercion is applied
    uniformly across all/get/run so behavior is identical regardless of which
    execute path a caller takes.
    */
    const coerceParams = (params: unknown[]): unknown[] =>
      params.map((p) => (p === undefined ? null : p));
    // Both node:sqlite and bun:sqlite expose the same .all/.get/.run shape.
    // Normalize `get` to return undefined (not null) when no row matches, and
    // pass run() through unchanged — both runtimes already produce the same
    // { changes, lastInsertRowid } shape.
    return {
      all: (...params: unknown[]) => stmt.all(...coerceParams(params)),
      get: (...params: unknown[]) => {
        const row = stmt.get(...coerceParams(params));
        return row ?? undefined;
      },
      run: (...params: unknown[]) => stmt.run(...coerceParams(params)),
    };
  }
}
