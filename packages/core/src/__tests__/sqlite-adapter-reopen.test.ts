/*
FNXC:SqliteConnectionReopen 2026-07-10-22:50:
Regression tests for in-place healing of a wedged SQLite connection.
Incident 2026-07-10: the live dashboard's fusion.db connection went SQLITE_NOTADB
("file is not a database" on every query) while the on-disk file stayed intact,
and the only recovery was restarting the whole process. The adapter must reopen
the connection in place, replay connection-scoped PRAGMAs, re-prepare cached
statements, retry the failed operation once outside transactions, and absorb the
unwind of a transaction that died with the old connection.

The wedge is simulated by swapping the adapter's private `impl` for a stub whose
every call throws the corruption error — exactly the observable behavior of the
real wedged handle (the real trigger, an inconsistent pager/WAL-index view, is
not reproducible deterministically in-process).
*/
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "../sqlite-adapter.js";

const NOTADB = () => new Error("file is not a database");

/**
 * Replace the adapter's live connection with one that throws NOTADB on every
 * query. close() delegates to the real underlying handle — in production the
 * reopen path closes the actual wedged connection, releasing any locks it held
 * (e.g. a write transaction's RESERVED lock).
 */
function wedge(db: DatabaseSync): void {
  const holder = db as unknown as {
    impl: { exec(sql: string): void; prepare(sql: string): unknown; close(): void };
  };
  const real = holder.impl;
  holder.impl = {
    exec: () => {
      throw NOTADB();
    },
    prepare: () => {
      throw NOTADB();
    },
    close: () => real.close(),
  };
}

describe("sqlite-adapter corruption reopen", () => {
  let dir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sqlite-adapter-reopen-test-"));
    db = new DatabaseSync(join(dir, "test.db"), { reopenCooldownMs: 0 });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO t (v) VALUES (?)").run("alpha");
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by a test
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("heals a wedged connection and retries the query once", () => {
    wedge(db);
    const row = db.prepare("SELECT v FROM t WHERE id = 1").get() as { v: string };
    expect(row.v).toBe("alpha");
  });

  it("re-prepares statements created before the reopen", () => {
    const stmt = db.prepare("SELECT COUNT(*) AS c FROM t");
    wedge(db);
    // Heal via an unrelated query first, then the pre-wedge statement must
    // transparently re-prepare on the new connection.
    db.exec("SELECT 1");
    const row = stmt.get() as { c: number };
    expect(row.c).toBe(1);
  });

  it("replays recorded assignment-style PRAGMAs onto the reopened connection", () => {
    wedge(db);
    db.exec("SELECT 1");
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  });

  it("retries writes outside a transaction", () => {
    wedge(db);
    db.prepare("INSERT INTO t (v) VALUES (?)").run("beta");
    const row = db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number };
    expect(row.c).toBe(2);
  });

  it("does NOT retry inside an explicit transaction, absorbs the unwind, and stays usable", () => {
    db.exec("BEGIN");
    db.prepare("INSERT INTO t (v) VALUES (?)").run("in-tx");
    wedge(db);
    // The statement inside the broken transaction must fail (no orphan
    // autocommit retry), even though the connection heals.
    expect(() => db.prepare("INSERT INTO t (v) VALUES (?)").run("in-tx-2")).toThrow(
      /file is not a database/,
    );
    // The caller's ROLLBACK unwind must be a no-op, not a masking throw.
    expect(() => db.exec("ROLLBACK")).not.toThrow();
    // Neither in-tx write survived: the transaction died with the connection.
    const row = db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number };
    expect(row.c).toBe(1);
    // Fresh transactions work normally after the unwind.
    db.exec("BEGIN");
    db.prepare("INSERT INTO t (v) VALUES (?)").run("post-heal");
    db.exec("COMMIT");
    const after = db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number };
    expect(after.c).toBe(2);
  });

  it("absorbs savepoint unwind (ROLLBACK TO + RELEASE) after a mid-transaction reopen", () => {
    db.exec("BEGIN");
    db.exec("SAVEPOINT sp_1");
    wedge(db);
    expect(() => db.prepare("SELECT 1").get()).toThrow(/file is not a database/);
    expect(() => db.exec("ROLLBACK TO sp_1")).not.toThrow();
    expect(() => db.exec("RELEASE sp_1")).not.toThrow();
    expect(() => db.exec("ROLLBACK")).not.toThrow();
    // Connection is healthy afterwards.
    const row = db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number };
    expect(row.c).toBe(1);
  });

  it("rethrows the original error while the reopen cooldown is active", () => {
    const cooled = new DatabaseSync(join(dir, "cooldown.db"), { reopenCooldownMs: 60_000 });
    try {
      cooled.exec("CREATE TABLE c (id INTEGER)");
      wedge(cooled);
      // First wedge heals (no prior attempt inside the cooldown window)...
      cooled.exec("SELECT 1");
      // ...but a second wedge within the window must not reopen again.
      wedge(cooled);
      expect(() => cooled.exec("SELECT 1")).toThrow(/file is not a database/);
    } finally {
      try {
        cooled.close();
      } catch {
        // wedged stub close may throw
      }
    }
  });

  it("does not reopen after the user closed the database", () => {
    db.close();
    expect(() => db.prepare("SELECT 1")).toThrow();
  });

  it("passes unrelated errors through without reopening", () => {
    expect(() => db.exec("NOT VALID SQL")).toThrow(/syntax error|near/i);
    // Connection untouched: still generation 0, still works.
    const row = db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number };
    expect(row.c).toBe(1);
  });
});
