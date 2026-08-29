import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const architecturePath = path.resolve(__dirname, "../../docs/architecture.md");
const taskManagementPath = path.resolve(__dirname, "../../docs/task-management.md");
const architectureDoc = readFileSync(architecturePath, "utf8");
const taskManagementDoc = readFileSync(taskManagementPath, "utf8");

test("architecture self-healing section documents already-merged review recovery layer", () => {
  assert.ok(
    architectureDoc.includes("recoverAlreadyMergedReviewTasks()"),
    "Expected docs/architecture.md to mention recoverAlreadyMergedReviewTasks()",
  );

  assert.ok(
    architectureDoc.includes("Together, `recoverAlreadyMergedReviewTasks()`, `clearStaleBlockedBy()`, and paused-aware in-review scheduling"),
    "Expected architecture docs to describe the layered merge-deadlock self-healing defenses",
  );
});

test("task lifecycle docs describe preserved failed review state plus already-landed auto-finalization", () => {
  assert.ok(
    taskManagementDoc.includes("This state is intentionally preserved by recovery (not auto-bounced to `todo`)."),
    "Expected task-management docs to preserve failed in-review tasks",
  );

  assert.match(
    taskManagementDoc,
    /Self-healing can still auto-finalize retry-exhausted failed review tasks[\s\S]*already landed on the merge target/,
    "Expected task-management docs to explain already-landed failed-review auto-finalization",
  );
});
