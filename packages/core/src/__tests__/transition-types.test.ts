import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database, SCHEMA_VERSION } from "../db.js";
import {
  TRANSITION_REJECTION_CODES,
  type TransitionRejectionCode,
  deserializeTransitionPending,
  deserializeTransitionRejection,
  makeTransitionPending,
  makeTransitionRejection,
  serializeTransitionPending,
  serializeTransitionRejection,
  transitionOk,
  transitionRejected,
} from "../transition-types.js";
import {
  clearTransitionPending,
  reconcileHooksRemaining,
  readTransitionPending,
  writeTransitionPending,
} from "../transition-pending.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-transition-types-"));
}

describe("TransitionRejection (de)serialization across the API boundary", () => {
  it("round-trips every rejection code", () => {
    for (const code of TRANSITION_REJECTION_CODES) {
      const rejection = makeTransitionRejection(code, `transition.reject.${code}`, code === "capacity-exhausted");
      const wire = serializeTransitionRejection(rejection);
      // Wire form is plain JSON — no class instances survive the boundary.
      expect(typeof wire).toBe("string");
      const parsedRaw = JSON.parse(wire) as Record<string, unknown>;
      expect(parsedRaw.code).toBe(code);
      const back = deserializeTransitionRejection(wire);
      expect(back).toEqual(rejection);
    }
  });

  it("round-trips the optional detail field and omits it when absent", () => {
    const withDetail = makeTransitionRejection("guard-rejected", "k", false, "guard X said no");
    expect(deserializeTransitionRejection(serializeTransitionRejection(withDetail))).toEqual(withDetail);

    const withoutDetail = makeTransitionRejection("unknown-column", "k", false);
    expect("detail" in withoutDetail).toBe(false);
    const wire = serializeTransitionRejection(withoutDetail);
    expect(JSON.parse(wire)).not.toHaveProperty("detail");
    expect(deserializeTransitionRejection(wire)).toEqual(withoutDetail);
  });

  it("rejects malformed / structurally invalid payloads with null (never throws)", () => {
    expect(deserializeTransitionRejection("not json{{")).toBeNull();
    expect(deserializeTransitionRejection("null")).toBeNull();
    expect(deserializeTransitionRejection("42")).toBeNull();
    expect(deserializeTransitionRejection(JSON.stringify({ code: "not-a-code", messageKey: "k", retryable: true }))).toBeNull();
    expect(deserializeTransitionRejection(JSON.stringify({ code: "guard-rejected", retryable: true }))).toBeNull();
    expect(deserializeTransitionRejection(JSON.stringify({ code: "guard-rejected", messageKey: "k", retryable: "yes" }))).toBeNull();
    expect(deserializeTransitionRejection(JSON.stringify({ code: "guard-rejected", messageKey: "k", retryable: true, detail: 7 }))).toBeNull();
  });

  it("builds discriminated TransitionResult values", () => {
    const ok = transitionOk("in-review");
    expect(ok).toEqual({ ok: true, toColumn: "in-review" });

    const rejection = makeTransitionRejection("merge-blocked", "transition.merge-blocked", true);
    const rejected = transitionRejected(rejection);
    expect(rejected).toEqual({ ok: false, rejection });
  });

  it("exposes the full, exhaustive code set", () => {
    const expected: TransitionRejectionCode[] = [
      "guard-rejected",
      "capacity-exhausted",
      "unknown-column",
      "workflow-mismatch",
      "merge-blocked",
    ];
    expect([...TRANSITION_REJECTION_CODES].sort()).toEqual([...expected].sort());
  });
});

describe("TransitionPending (de)serialization", () => {
  it("round-trips a marker including hooksRemaining order and startedAt", () => {
    const marker = makeTransitionPending("in-progress", ["timing:onEnter", "abort-on-exit:onExit"], 1_700_000_000_000);
    const wire = serializeTransitionPending(marker);
    expect(deserializeTransitionPending(wire)).toEqual(marker);
  });

  it("copies hooksRemaining so the marker does not alias caller state", () => {
    const hooks = ["a", "b"];
    const marker = makeTransitionPending("todo", hooks);
    hooks.push("c");
    expect(marker.hooksRemaining).toEqual(["a", "b"]);
  });

  it("drops non-string hook entries defensively and rejects malformed markers", () => {
    expect(deserializeTransitionPending("garbage")).toBeNull();
    expect(deserializeTransitionPending(JSON.stringify({ toColumn: "x", startedAt: 1 }))).toBeNull();
    expect(deserializeTransitionPending(JSON.stringify({ toColumn: "x", hooksRemaining: [], startedAt: "soon" }))).toBeNull();
    const recovered = deserializeTransitionPending(
      JSON.stringify({ toColumn: "x", hooksRemaining: ["keep", 5, null, "also"], startedAt: 10 }),
    );
    expect(recovered).toEqual({ toColumn: "x", hooksRemaining: ["keep", "also"], startedAt: 10 });
  });
});

describe("reconcileHooksRemaining (missing-plugin-hook, U3-level)", () => {
  it("keeps known hooks and drops unknown ones with one audit warning each", () => {
    const known = new Set(["builtin:timing", "builtin:abort"]);
    const result = reconcileHooksRemaining(["builtin:timing", "plugin:gone", "builtin:abort", "plugin:also-gone"], known);
    expect(result.hooksRemaining).toEqual(["builtin:timing", "builtin:abort"]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("plugin:gone");
    expect(result.warnings[1]).toContain("plugin:also-gone");
  });

  it("returns no warnings when every hook is known", () => {
    const result = reconcileHooksRemaining(["a"], new Set(["a", "b"]));
    expect(result).toEqual({ hooksRemaining: ["a"], warnings: [] });
  });
});

describe("transitionPending marker lifecycle (helper-level, U3)", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir);
    db.init();
    db.exec(
      `INSERT INTO tasks (id, description, "column", createdAt, updatedAt) VALUES ('FN-1', 'task', 'todo', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    );
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("set with a move, then cleared after hooks complete", () => {
    expect(readTransitionPending(db, "FN-1")).toBeNull();

    // Simulate the in-txn write that accompanies a column change (U4 wires this):
    // the column change and the marker write land in one transaction.
    db.exec("BEGIN");
    db.prepare(`UPDATE tasks SET "column" = ? WHERE id = ?`).run("in-progress", "FN-1");
    writeTransitionPending(db, "FN-1", makeTransitionPending("in-progress", ["timing:onEnter"], 1234));
    db.exec("COMMIT");

    const after = readTransitionPending(db, "FN-1");
    expect(after).toEqual({ toColumn: "in-progress", hooksRemaining: ["timing:onEnter"], startedAt: 1234 });
    const movedRow = db.prepare(`SELECT "column" AS col FROM tasks WHERE id = ?`).get("FN-1") as { col: string };
    expect(movedRow.col).toBe("in-progress");

    // Post-commit hooks ran -> clear.
    clearTransitionPending(db, "FN-1");
    expect(readTransitionPending(db, "FN-1")).toBeNull();
  });

  it("survives a simulated crash: marker recoverable with hooksRemaining intact", () => {
    writeTransitionPending(db, "FN-1", makeTransitionPending("in-review", ["merge:onEnter", "stall:onEnter"], 999));
    db.close();

    // Re-open as a fresh handle (the post-commit hook runner never ran -> crash).
    const reopened = new Database(fusionDir);
    reopened.init();
    const recovered = readTransitionPending(reopened, "FN-1");
    expect(recovered).toEqual({ toColumn: "in-review", hooksRemaining: ["merge:onEnter", "stall:onEnter"], startedAt: 999 });
    reopened.close();
    db = new Database(fusionDir);
    db.init();
  });

  it("reads back exclusively from the SQLite row (authoritative store, ADR-0001)", () => {
    // The helper only ever consults the SQLite tasks row; there is no task.json
    // read path. Writing the marker and reading it through a brand-new handle
    // proves SQLite is the single source of truth.
    writeTransitionPending(db, "FN-1", makeTransitionPending("done", ["complete:onEnter"], 5));
    db.close();
    const fresh = new Database(fusionDir);
    fresh.init();
    expect(readTransitionPending(fresh, "FN-1")).toEqual({
      toColumn: "done",
      hooksRemaining: ["complete:onEnter"],
      startedAt: 5,
    });
    fresh.close();
    db = new Database(fusionDir);
    db.init();
  });

  it("returns undefined for a missing task and null for a corrupt marker", () => {
    expect(readTransitionPending(db, "FN-nonexistent")).toBeUndefined();
    db.prepare(`UPDATE tasks SET transitionPending = ? WHERE id = ?`).run("not json{{", "FN-1");
    expect(readTransitionPending(db, "FN-1")).toBeNull();
  });
});

describe("tasks.transitionPending migration (106)", () => {
  let tmpDir: string;
  let fusionDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("adds the column when migrating a pre-106 tasks table, leaving existing rows NULL", () => {
    const db = new Database(fusionDir);
    db.exec("CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        "column" TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);
    db.exec("INSERT INTO __meta (key, value) VALUES ('schemaVersion', '105')");
    db.exec("INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')");
    db.exec(
      `INSERT INTO tasks (id, description, "column", createdAt, updatedAt) VALUES ('FN-legacy', 'legacy', 'todo', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
    );

    db.init();

    const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain("transitionPending");

    const row = db.prepare("SELECT transitionPending FROM tasks WHERE id = 'FN-legacy'").get() as {
      transitionPending: string | null;
    };
    expect(row.transitionPending).toBeNull();
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);

    db.close();
  });

  it("is idempotent: running init twice does not error and stays at the current version", () => {
    const db = new Database(fusionDir);
    db.init();
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
    // Second init on the same DB is a no-op (version already current).
    expect(() => db.init()).not.toThrow();
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
    const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(columns.filter((c) => c.name === "transitionPending")).toHaveLength(1);
    db.close();

    // Re-open + init a third time on the persisted DB.
    const reopened = new Database(fusionDir);
    expect(() => reopened.init()).not.toThrow();
    expect(reopened.getSchemaVersion()).toBe(SCHEMA_VERSION);
    reopened.close();
  });

  it("is a no-op on a fresh DB: column present from the base CREATE TABLE", () => {
    const db = new Database(fusionDir);
    db.init();
    const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain("transitionPending");
    expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION);
    db.close();
  });
});
