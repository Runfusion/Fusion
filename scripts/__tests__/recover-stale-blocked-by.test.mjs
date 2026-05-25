import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { recoverBlockedBy } from "../recover-stale-blocked-by.mjs";

function setupFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-3899-"));
  const tasksDir = path.join(dir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  const dbPath = path.join(dir, "fusion.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      "column" TEXT,
      blockedBy TEXT,
      worktree TEXT,
      paused INTEGER,
      log TEXT,
      updatedAt TEXT,
      deletedAt TEXT
    );
  `);

  return { dir, tasksDir, db };
}

function writePrompt(tasksDir, taskId, scopeLines) {
  const taskDir = path.join(tasksDir, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const bullets = scopeLines.map((line) => `- \`${line}\``).join("\n");
  fs.writeFileSync(path.join(taskDir, "PROMPT.md"), `# Task\n\n## File Scope\n${bullets}\n`);
}

function insertTask(db, row) {
  db.prepare(`INSERT INTO tasks (id, "column", blockedBy, worktree, paused, log, updatedAt, deletedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      row.id,
      row.column,
      row.blockedBy ?? null,
      row.worktree ?? null,
      row.paused ?? 0,
      row.log ?? "[]",
      row.updatedAt ?? new Date().toISOString(),
      row.deletedAt ?? null,
    );
}

test("clears stale blocker when blocker is terminal", () => {
  const { dir, tasksDir, db } = setupFixture();
  try {
    writePrompt(tasksDir, "FN-BLOCKED", ["packages/dashboard/app/App.tsx"]);
    writePrompt(tasksDir, "FN-DONE", ["packages/dashboard/app/App.tsx"]);

    insertTask(db, { id: "FN-DONE", column: "done" });
    insertTask(db, { id: "FN-BLOCKED", column: "todo", blockedBy: "FN-DONE" });

    const findings = recoverBlockedBy({ db, tasksDir, dryRun: false });
    const blocked = db.prepare("SELECT blockedBy, log FROM tasks WHERE id = ?").get("FN-BLOCKED");

    assert.equal(findings.find((f) => f.taskId === "FN-BLOCKED")?.reason, "blocker-terminal:done");
    assert.equal(blocked.blockedBy, null);
    assert.match(blocked.log, /FN-3899 recovery/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("preserves valid blocker when overlap remains active", () => {
  const { dir, tasksDir, db } = setupFixture();
  try {
    writePrompt(tasksDir, "FN-ACTIVE", ["packages/dashboard/app/App.tsx"]);
    writePrompt(tasksDir, "FN-BLOCKED", ["packages/dashboard/app/App.tsx"]);

    insertTask(db, { id: "FN-ACTIVE", column: "in-progress" });
    insertTask(db, { id: "FN-BLOCKED", column: "todo", blockedBy: "FN-ACTIVE" });

    recoverBlockedBy({ db, tasksDir, dryRun: false });
    const blocked = db.prepare("SELECT blockedBy FROM tasks WHERE id = ?").get("FN-BLOCKED");

    assert.equal(blocked.blockedBy, "FN-ACTIVE");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run reports repairs without writing", () => {
  const { dir, tasksDir, db } = setupFixture();
  try {
    writePrompt(tasksDir, "FN-BLOCKED", ["packages/dashboard/app/App.tsx"]);
    writePrompt(tasksDir, "FN-MISSING-SCOPE", ["packages/engine/src/scheduler.ts"]);

    insertTask(db, { id: "FN-MISSING-SCOPE", column: "in-review", worktree: null });
    insertTask(db, { id: "FN-BLOCKED", column: "todo", blockedBy: "FN-MISSING-SCOPE" });

    const findings = recoverBlockedBy({ db, tasksDir, dryRun: true });
    const blocked = db.prepare("SELECT blockedBy, log FROM tasks WHERE id = ?").get("FN-BLOCKED");

    assert.equal(findings.find((f) => f.taskId === "FN-BLOCKED")?.reason, "blocker-in-review-without-worktree");
    assert.equal(blocked.blockedBy, "FN-MISSING-SCOPE");
    assert.equal(blocked.log, "[]");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recoverBlockedBy ignores soft-deleted blockers and dependents (FN-5528)", () => {
  const { dir, tasksDir, db } = setupFixture();
  try {
    writePrompt(tasksDir, "FN-LIVE-DEPENDENT", ["packages/core/src/store.ts"]);
    writePrompt(tasksDir, "FN-DELETED-BLOCKER", ["packages/core/src/store.ts"]);
    writePrompt(tasksDir, "FN-DELETED-TODO", ["packages/dashboard/app/App.tsx"]);
    writePrompt(tasksDir, "FN-LIVE-TERMINAL", ["packages/engine/src/self-healing.ts"]);
    writePrompt(tasksDir, "FN-LIVE-TERMINAL-DEP", ["packages/engine/src/self-healing.ts"]);

    insertTask(db, {
      id: "FN-DELETED-BLOCKER",
      column: "in-review",
      deletedAt: "2026-05-20T05:50:51.015Z",
    });
    insertTask(db, { id: "FN-LIVE-DEPENDENT", column: "todo", blockedBy: "FN-DELETED-BLOCKER" });

    const deletedTodoUpdatedAt = "2026-05-22T01:00:00.000Z";
    insertTask(db, {
      id: "FN-DELETED-TODO",
      column: "todo",
      blockedBy: "FN-LIVE-TERMINAL",
      updatedAt: deletedTodoUpdatedAt,
      deletedAt: "2026-05-20T05:50:51.015Z",
    });

    insertTask(db, { id: "FN-LIVE-TERMINAL", column: "done" });
    insertTask(db, { id: "FN-LIVE-TERMINAL-DEP", column: "todo", blockedBy: "FN-LIVE-TERMINAL" });

    const findings = recoverBlockedBy({ db, tasksDir, dryRun: false });

    assert.equal(findings.find((f) => f.taskId === "FN-LIVE-DEPENDENT")?.reason, "blocker-missing");
    assert.equal(findings.find((f) => f.taskId === "FN-LIVE-TERMINAL-DEP")?.reason, "blocker-terminal:done");

    const deletedTodo = db.prepare("SELECT blockedBy, updatedAt FROM tasks WHERE id = ?").get("FN-DELETED-TODO");
    assert.equal(deletedTodo.blockedBy, "FN-LIVE-TERMINAL");
    assert.equal(deletedTodo.updatedAt, deletedTodoUpdatedAt);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
