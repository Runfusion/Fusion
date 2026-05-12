import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  main,
  RECONCILIATION_ACTION,
} from "../reconcile-fn-3909-identity.mjs";

const STALE_TITLE = "Implement heartbeat scope discipline for default agent promp";
const STALE_DESCRIPTION = "Pick up FN-3884 (Heartbeat scope discipline for default agent prompts) — it's fully unblocked, spec-approved, size S. Update HEARTBEAT_PROCEDURE and HEARTBEAT_NO_TASK_PROCEDURE constants with scope-discipline guidance.";
const CANONICAL_HEADING = "# Task: FN-3909 - Restore icons + width-aware labels on agent card buttons\n";
const cloneValue = globalThis.structuredClone
  ? (value) => globalThis.structuredClone(value)
  : (value) => JSON.parse(JSON.stringify(value));

function createTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "fn-4194-"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function createTaskFixture() {
  return {
    id: "FN-3909",
    title: STALE_TITLE,
    description: STALE_DESCRIPTION,
    column: "done",
    log: [{ timestamp: "2026-05-10T05:40:52.625Z", action: "Task created" }],
    steps: [{ name: "Preflight", status: "done" }],
    mergeDetails: {
      commitSha: "3cdc2d5a5d7525a2e142f351dbdc6353892be2f4",
      mergeCommitMessage: "Added a details button icon to agent cards in the AgentsView with responsive container query styling for action labels, accompanied by regression tests.",
      mergeConfirmed: true,
    },
    modifiedFiles: ["packages/dashboard/app/components/AgentsView.tsx"],
    createdAt: "2026-05-10T05:40:52.625Z",
    updatedAt: "2026-05-12T02:28:16.959Z",
  };
}

function createFixture({ promptHeading = CANONICAL_HEADING, rawPrompt, task = createTaskFixture() } = {}) {
  const root = createTempDir();
  const fusionDir = path.join(root, ".fusion");
  const taskDir = path.join(fusionDir, "tasks", "FN-3909");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    path.join(taskDir, "PROMPT.md"),
    rawPrompt ?? `${promptHeading}\n## Mission\n\nFix two related defects in AgentsView.\n`,
  );
  writeJson(path.join(taskDir, "task.json"), task);

  const unrelatedTask = {
    id: "FN-9999",
    title: "Unrelated task",
    description: "Should stay untouched",
    column: "done",
    log: [{ timestamp: "2026-05-12T00:00:00.000Z", action: "Task created" }],
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
  const tasks = new Map([
    [task.id, cloneValue(task)],
    [unrelatedTask.id, cloneValue(unrelatedTask)],
  ]);

  const calls = { updateTask: 0, logEntry: 0 };
  const store = {
    calls,
    async getTask(id) {
      const taskState = tasks.get(id);
      return taskState ? cloneValue(taskState) : null;
    },
    async updateTask(id, updates) {
      calls.updateTask += 1;
      const taskState = tasks.get(id);
      assert.ok(taskState, `missing task ${id}`);
      Object.assign(taskState, updates, { updatedAt: "2026-05-12T12:00:00.000Z" });
      if (id === "FN-3909") {
        writeJson(path.join(taskDir, "task.json"), taskState);
      }
      return cloneValue(taskState);
    },
    async logEntry(id, action, outcome) {
      calls.logEntry += 1;
      const taskState = tasks.get(id);
      assert.ok(taskState, `missing task ${id}`);
      taskState.log.push({ timestamp: "2026-05-12T12:00:01.000Z", action, outcome });
      taskState.updatedAt = "2026-05-12T12:00:01.000Z";
      if (id === "FN-3909") {
        writeJson(path.join(taskDir, "task.json"), taskState);
      }
      return cloneValue(taskState);
    },
  };

  return {
    root,
    taskDir,
    taskPath: path.join(taskDir, "task.json"),
    promptPath: path.join(taskDir, "PROMPT.md"),
    store,
    calls,
    tasks,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function comparableTask(task) {
  const clone = cloneValue(task);
  delete clone.updatedAt;
  return clone;
}

test("dry-run reports the diff without mutating the task", async () => {
  const fixture = createFixture();
  try {
    const beforeTaskJson = readFileSync(fixture.taskPath, "utf8");
    const unrelatedBefore = comparableTask(fixture.tasks.get("FN-9999"));

    const result = await main(["--project-root", fixture.root], { store: fixture.store });

    assert.equal(result.status, "would-apply");
    assert.equal(result.dryRun, true);
    assert.equal(result.diff.before.title, STALE_TITLE);
    assert.match(result.diff.after.title, /Restore icons/);
    assert.equal(fixture.calls.updateTask, 0);
    assert.equal(fixture.calls.logEntry, 0);
    assert.equal(readFileSync(fixture.taskPath, "utf8"), beforeTaskJson);
    assert.deepEqual(comparableTask(fixture.tasks.get("FN-9999")), unrelatedBefore);
  } finally {
    fixture.cleanup();
  }
});

test("apply updates only title, description, and log on FN-3909", async () => {
  const fixture = createFixture();
  try {
    const before = readJson(fixture.taskPath);
    const unrelatedBefore = comparableTask(fixture.tasks.get("FN-9999"));

    const result = await main(["--project-root", fixture.root, "--apply"], { store: fixture.store });
    const after = readJson(fixture.taskPath);

    assert.equal(result.status, "applied");
    assert.equal(fixture.calls.updateTask, 1);
    assert.equal(fixture.calls.logEntry, 1);
    assert.equal(after.title, "Restore icons + width-aware labels on agent card buttons");
    assert.match(after.description, /AgentsView card action buttons/);
    assert.equal(after.log.at(-1).action, RECONCILIATION_ACTION);
    assert.match(after.log.at(-1).outcome, /FN-4194/);

    const beforeComparable = comparableTask(before);
    const afterComparable = comparableTask(after);
    beforeComparable.title = afterComparable.title;
    beforeComparable.description = afterComparable.description;
    beforeComparable.log = afterComparable.log;
    assert.deepEqual(afterComparable, beforeComparable);

    assert.deepEqual(comparableTask(fixture.tasks.get("FN-9999")), unrelatedBefore);
  } finally {
    fixture.cleanup();
  }
});

test("second apply is a no-op once reconciliation marker exists", async () => {
  const fixture = createFixture();
  try {
    await main(["--project-root", fixture.root, "--apply"], { store: fixture.store });
    const afterFirstApply = readFileSync(fixture.taskPath, "utf8");

    const result = await main(["--project-root", fixture.root, "--apply"], { store: fixture.store });

    assert.equal(result.status, "noop");
    assert.equal(fixture.calls.updateTask, 1);
    assert.equal(fixture.calls.logEntry, 1);
    assert.equal(readFileSync(fixture.taskPath, "utf8"), afterFirstApply);
  } finally {
    fixture.cleanup();
  }
});

test("refuses when the row already matches the prompt heading without reconciliation marker", async () => {
  const task = createTaskFixture();
  task.title = "Restore icons + width-aware labels on agent card buttons";
  task.description = "Already canonical but not reconciled.";
  const fixture = createFixture({ task });
  try {
    await assert.rejects(
      main(["--project-root", fixture.root, "--apply"], { store: fixture.store }),
      /already matches PROMPT heading but no FN-4194 reconciliation marker is present/,
    );
    assert.equal(fixture.calls.updateTask, 0);
    assert.equal(fixture.calls.logEntry, 0);
  } finally {
    fixture.cleanup();
  }
});

test("refuses when PROMPT heading is missing or unexpected", async (t) => {
  await t.test("missing heading", async () => {
    const fixture = createFixture({ rawPrompt: "No markdown heading here.\n\nJust body text.\n" });
    try {
      await assert.rejects(
        main(["--project-root", fixture.root, "--apply"], { store: fixture.store }),
        /PROMPT.md is missing a first heading/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test("unexpected heading", async () => {
    const fixture = createFixture({ promptHeading: "# Task: FN-3909 - Unexpected heading\n" });
    try {
      await assert.rejects(
        main(["--project-root", fixture.root, "--apply"], { store: fixture.store }),
        /unexpected PROMPT heading/,
      );
    } finally {
      fixture.cleanup();
    }
  });
});
