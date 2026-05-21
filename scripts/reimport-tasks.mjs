// One-off: re-import specific FN-* tasks from .fusion/tasks/<id>/task.json into
// the live SQLite DB. Uses INSERT OR IGNORE — never overwrites existing rows.
// Mirrors the column list used by packages/core/src/db-migrate.ts:migrateTasks.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const FUSION_DIR = join(process.cwd(), ".fusion");
const DB_PATH = join(FUSION_DIR, "fusion.db");
const TASKS_DIR = join(FUSION_DIR, "tasks");

const TARGET_IDS = process.argv.slice(2);
if (TARGET_IDS.length === 0) {
  console.error("usage: node scripts/reimport-tasks.mjs FN-5414 FN-5415 ...");
  process.exit(2);
}

const toJson = (v) => JSON.stringify(v ?? []);
const toJsonNullable = (v) => (v == null ? null : JSON.stringify(v));

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO tasks (
    id, title, description, priority, "column", status, size, reviewLevel, currentStep,
    worktree, blockedBy, paused, baseBranch, branch, executionStartBranch, baseCommitSha, modelPresetId,
    modelProvider, modelId, validatorModelProvider, validatorModelId,
    mergeRetries, recoveryRetryCount, nextRecoveryAt,
    error, summary, thinkingLevel, createdAt, updatedAt,
    columnMovedAt, dependencies, steps, log, attachments, steeringComments,
    comments, workflowStepResults, prInfo, issueInfo,
    sourceIssueProvider, sourceIssueRepository, sourceIssueExternalIssueId, sourceIssueNumber, sourceIssueUrl,
    mergeDetails, breakIntoSubtasks, noCommitsExpected, enabledWorkflowSteps, modifiedFiles, sliceId
  ) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
`);

const existsStmt = db.prepare(`SELECT 1 AS hit FROM tasks WHERE id = ?`);

let imported = 0;
let skipped = 0;
let missing = 0;

for (const id of TARGET_IDS) {
  const path = join(TASKS_DIR, id, "task.json");
  if (!existsSync(path)) {
    console.log(`[skip] ${id}: no task.json on disk`);
    missing++;
    continue;
  }

  if (existsStmt.get(id)) {
    console.log(`[skip] ${id}: already exists in DB`);
    skipped++;
    continue;
  }

  let task;
  try {
    task = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.warn(`[fail] ${id}: invalid JSON — ${err.message}`);
    skipped++;
    continue;
  }

  const priority =
    task.priority === "critical" || task.priority === "high" || task.priority === "low"
      ? task.priority
      : "normal";

  // Migration normalizes steeringComments + comments together; for fresh
  // imports it's safe to just trust the persisted JSON.
  const steeringComments = task.steeringComments ?? [];
  const comments = task.comments ?? [];

  insertStmt.run(
    task.id,
    task.title ?? null,
    task.description ?? "",
    priority,
    task.column,
    task.status ?? null,
    task.size ?? null,
    task.reviewLevel ?? null,
    task.currentStep || 0,
    task.worktree ?? null,
    task.blockedBy ?? null,
    task.paused ? 1 : 0,
    task.baseBranch ?? null,
    task.branch ?? null,
    task.executionStartBranch ?? null,
    task.baseCommitSha ?? null,
    task.modelPresetId ?? null,
    task.modelProvider ?? null,
    task.modelId ?? null,
    task.validatorModelProvider ?? null,
    task.validatorModelId ?? null,
    task.mergeRetries ?? null,
    task.recoveryRetryCount ?? null,
    task.nextRecoveryAt ?? null,
    task.error ?? null,
    task.summary ?? null,
    task.thinkingLevel ?? null,
    task.createdAt,
    task.updatedAt,
    task.columnMovedAt ?? null,
    toJson(task.dependencies),
    toJson(task.steps),
    toJson(task.log),
    toJson(task.attachments),
    toJson(steeringComments),
    toJson(comments),
    toJson(task.workflowStepResults),
    toJsonNullable(task.prInfo),
    toJsonNullable(task.issueInfo),
    task.sourceIssue?.provider ?? null,
    task.sourceIssue?.repository ?? null,
    task.sourceIssue?.externalIssueId ?? null,
    task.sourceIssue?.issueNumber ?? null,
    task.sourceIssue?.url ?? null,
    toJsonNullable(task.mergeDetails),
    task.breakIntoSubtasks ? 1 : 0,
    task.noCommitsExpected ? 1 : 0,
    toJson(task.enabledWorkflowSteps),
    toJson(task.modifiedFiles),
    task.sliceId ?? null,
  );

  console.log(`[ok]   ${id}: imported (col=${task.column} status=${task.status ?? "-"})`);
  imported++;
}

db.close();
console.log(`\ndone: imported=${imported} skipped=${skipped} missing=${missing}`);
