/*
FNXC:PostgresCutover 2026-07-05-13:00:
The script now targets the PostgreSQL backend; the FN-3899 recovery logic is
pure (planRecoverBlockedBy over plain rows), so this test injects rows instead
of seeding a SQLite fixture. Soft-deleted rows never reach the planner — the
backend query filters `deleted_at IS NULL` — so the FN-5528 case is modeled by
omitting deleted rows from the injected set.
*/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { planRecoverBlockedBy, unrecognisedLanes } from "../recover-stale-blocked-by.mjs";

function setupTasksDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-3899-"));
  const tasksDir = path.join(dir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  return { dir, tasksDir };
}

function writePrompt(tasksDir, taskId, scopeLines) {
  const taskDir = path.join(tasksDir, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const bullets = scopeLines.map((line) => `- \`${line}\``).join("\n");
  fs.writeFileSync(path.join(taskDir, "PROMPT.md"), `# Task\n\n## File Scope\n${bullets}\n`);
}

test("clears stale blocker when blocker is terminal", () => {
  const { dir, tasksDir } = setupTasksDir();
  try {
    writePrompt(tasksDir, "FN-BLOCKED", ["packages/dashboard/app/App.tsx"]);
    writePrompt(tasksDir, "FN-DONE", ["packages/dashboard/app/App.tsx"]);

    const findings = planRecoverBlockedBy({
      rows: [
        { id: "FN-DONE", column: "done", blockedBy: null, worktree: null, paused: 0 },
        { id: "FN-BLOCKED", column: "todo", blockedBy: "FN-DONE", worktree: null, paused: 0 },
      ],
      tasksDir,
    });

    const finding = findings.find((f) => f.taskId === "FN-BLOCKED");
    assert.equal(finding?.reason, "blocker-terminal:done");
    assert.equal(finding?.newBlocker, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("preserves valid blocker when overlap remains active", () => {
  const { dir, tasksDir } = setupTasksDir();
  try {
    writePrompt(tasksDir, "FN-ACTIVE", ["packages/dashboard/app/App.tsx"]);
    writePrompt(tasksDir, "FN-BLOCKED", ["packages/dashboard/app/App.tsx"]);

    const findings = planRecoverBlockedBy({
      rows: [
        { id: "FN-ACTIVE", column: "in-progress", blockedBy: null, worktree: null, paused: 0 },
        { id: "FN-BLOCKED", column: "todo", blockedBy: "FN-ACTIVE", worktree: null, paused: 0 },
      ],
      tasksDir,
    });

    const finding = findings.find((f) => f.taskId === "FN-BLOCKED");
    assert.equal(finding?.reason, "unchanged");
    assert.equal(finding?.newBlocker, "FN-ACTIVE");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("flags in-review blocker without worktree", () => {
  const { dir, tasksDir } = setupTasksDir();
  try {
    writePrompt(tasksDir, "FN-BLOCKED", ["packages/dashboard/app/App.tsx"]);
    writePrompt(tasksDir, "FN-MISSING-SCOPE", ["packages/engine/src/scheduler.ts"]);

    const findings = planRecoverBlockedBy({
      rows: [
        { id: "FN-MISSING-SCOPE", column: "in-review", blockedBy: null, worktree: null, paused: 0 },
        { id: "FN-BLOCKED", column: "todo", blockedBy: "FN-MISSING-SCOPE", worktree: null, paused: 0 },
      ],
      tasksDir,
    });

    assert.equal(findings.find((f) => f.taskId === "FN-BLOCKED")?.reason, "blocker-in-review-without-worktree");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("treats soft-deleted blockers as missing and never plans for deleted dependents (FN-5528)", () => {
  const { dir, tasksDir } = setupTasksDir();
  try {
    writePrompt(tasksDir, "FN-LIVE-DEPENDENT", ["packages/core/src/store.ts"]);
    writePrompt(tasksDir, "FN-LIVE-TERMINAL", ["packages/engine/src/self-healing.ts"]);
    writePrompt(tasksDir, "FN-LIVE-TERMINAL-DEP", ["packages/engine/src/self-healing.ts"]);

    // FN-DELETED-BLOCKER and FN-DELETED-TODO are soft-deleted: the backend
    // query filters them out with `deleted_at IS NULL`, so they are absent.
    const findings = planRecoverBlockedBy({
      rows: [
        { id: "FN-LIVE-DEPENDENT", column: "todo", blockedBy: "FN-DELETED-BLOCKER", worktree: null, paused: 0 },
        { id: "FN-LIVE-TERMINAL", column: "done", blockedBy: null, worktree: null, paused: 0 },
        { id: "FN-LIVE-TERMINAL-DEP", column: "todo", blockedBy: "FN-LIVE-TERMINAL", worktree: null, paused: 0 },
      ],
      tasksDir,
    });

    assert.equal(findings.find((f) => f.taskId === "FN-LIVE-DEPENDENT")?.reason, "blocker-missing");
    assert.equal(findings.find((f) => f.taskId === "FN-LIVE-TERMINAL-DEP")?.reason, "blocker-terminal:done");
    assert.equal(findings.some((f) => f.taskId === "FN-DELETED-TODO"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/*
FNXC:OperatorScriptLaneAssumptions 2026-07-30-23:30:
THE INVARIANT: a board this script cannot reason about is REPORTED, never silently skipped.

Every lane test in the planner is a legacy id, and the candidate gate is `row.column !== "todo"`, so a
renamed board matches nothing and the planner returns []. That is indistinguishable from "no repairs
needed" — the worst possible answer from a recovery tool, which an operator consults during an
incident and reads as a clean bill of health.

The first case below documents that gap directly: the planner still finds nothing, and that is NOT
fixed here (correct classification needs the board's trait vocabulary, which this script has no store
to resolve). What is fixed is that the condition is now detectable and printed.

Reverted (`unrecognisedLanes` removed), these fail to import.
*/
test("names lanes the planner does not understand, so an empty result cannot read as healthy", () => {
  const rows = [
    { id: "FN-1", column: "backlog", blockedBy: "FN-2" },
    { id: "FN-2", column: "checking", blockedBy: null },
  ];

  assert.deepEqual(unrecognisedLanes(rows), ["backlog", "checking"]);
  // The gap this warns about, pinned rather than claimed fixed: the planner still sees nothing.
  const { tasksDir } = setupTasksDir();
  assert.deepEqual(planRecoverBlockedBy({ rows, tasksDir }), []);
});

test("stays quiet on a legacy board, so the warning means something when it appears", () => {
  const rows = [
    { id: "FN-1", column: "todo", blockedBy: "FN-2" },
    { id: "FN-2", column: "in-review", blockedBy: null },
    { id: "FN-3", column: "done", blockedBy: null },
  ];

  assert.deepEqual(unrecognisedLanes(rows), []);
});

test("reports each unknown lane once, ignoring rows with no column at all", () => {
  const rows = [
    { id: "FN-1", column: "building" },
    { id: "FN-2", column: "building" },
    { id: "FN-3", column: null },
    { id: "FN-4", column: "" },
  ];

  assert.deepEqual(unrecognisedLanes(rows), ["building"]);
});
