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
}

type DatabaseCtor = new (path: string) => RawDatabase;

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

  constructor(path: string) {
    const Ctor = loadDatabaseCtor();
    this.impl = new Ctor(path);
  }

  exec(sql: string): void {
    this.impl.exec(sql);
  }

  close(): void {
    this.impl.close();
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this.impl.prepare(sql);
    // Both node:sqlite and bun:sqlite expose the same .all/.get/.run shape.
    // Normalize `get` to return undefined (not null) when no row matches, and
    // pass run() through unchanged — both runtimes already produce the same
    // { changes, lastInsertRowid } shape.
    return {
      all: (...params: unknown[]) => stmt.all(...params),
      get: (...params: unknown[]) => {
        const row = stmt.get(...params);
        return row ?? undefined;
      },
      run: (...params: unknown[]) => stmt.run(...params),
    };
  }
}
