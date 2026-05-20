import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { reconcileLeakedSoftDeletes } from "../reconcile-leaked-soft-deletes.mjs";

function setupFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-5175-"));
  const dbPath = path.join(dir, "fusion.db");
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      "column" TEXT NOT NULL,
      status TEXT,
      deletedAt TEXT,
      updatedAt TEXT
    );

    CREATE TABLE runAuditEvents (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      taskId TEXT,
      agentId TEXT NOT NULL,
      runId TEXT NOT NULL,
      domain TEXT NOT NULL,
      mutationType TEXT NOT NULL,
      target TEXT NOT NULL,
      metadata TEXT
    );
  `);

  return { dir, db };
}

function insertTask(db, row) {
  db.prepare(`INSERT INTO tasks (id, "column", status, deletedAt, updatedAt) VALUES (?, ?, ?, ?, ?)`)
    .run(row.id, row.column, row.status ?? null, row.deletedAt ?? null, row.updatedAt ?? null);
}

test("reconciles leaked soft-deletes and is idempotent on re-run", () => {
  const { dir, db } = setupFixture();
  try {
    insertTask(db, {
      id: "FN-5130",
      column: "in-review",
      status: "failed",
      deletedAt: "2026-05-19T00:00:00.000Z",
      updatedAt: "2026-05-19T00:00:00.000Z",
    });
    insertTask(db, {
      id: "FN-5133",
      column: "todo",
      status: null,
      deletedAt: "2026-05-19T01:00:00.000Z",
      updatedAt: "2026-05-19T01:00:00.000Z",
    });
    insertTask(db, {
      id: "FN-5167",
      column: "archived",
      status: null,
      deletedAt: "2026-05-19T02:00:00.000Z",
      updatedAt: "2026-05-19T02:00:00.000Z",
    });

    const result = reconcileLeakedSoftDeletes({
      db,
      dryRun: false,
      runId: "synthetic-reconcile-fn-5175-test",
    });

    assert.equal(result.rowsScanned, 2);
    assert.equal(result.rowsUpdated, 2);
    assert.equal(result.auditRowsInserted, 2);

    const columns = db.prepare(`SELECT id, "column" FROM tasks ORDER BY id`).all().map((row) => ({ ...row }));
    assert.deepEqual(columns, [
      { id: "FN-5130", column: "archived" },
      { id: "FN-5133", column: "archived" },
      { id: "FN-5167", column: "archived" },
    ]);

    const audits = db.prepare(`SELECT taskId, agentId, runId, mutationType, target, metadata FROM runAuditEvents ORDER BY taskId`).all().map((row) => ({ ...row }));
    assert.equal(audits.length, 2);
    assert.deepEqual(audits.map((row) => row.taskId), ["FN-5130", "FN-5133"]);
    assert.ok(audits.every((row) => row.agentId === "system"));
    assert.ok(audits.every((row) => row.runId === "synthetic-reconcile-fn-5175-test"));
    assert.ok(audits.every((row) => row.mutationType === "task:soft-delete-column-reconcile"));
    assert.deepEqual(audits.map((row) => JSON.parse(row.metadata)), [
      {
        previousColumn: "in-review",
        previousStatus: "failed",
        source: "FN-5175 reconcile",
      },
      {
        previousColumn: "todo",
        previousStatus: null,
        source: "FN-5175 reconcile",
      },
    ]);

    const second = reconcileLeakedSoftDeletes({
      db,
      dryRun: false,
      runId: "synthetic-reconcile-fn-5175-test-2",
    });
    assert.equal(second.rowsScanned, 0);
    assert.equal(second.rowsUpdated, 0);
    assert.equal(second.auditRowsInserted, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runAuditEvents").get().count, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
