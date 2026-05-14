#!/usr/bin/env node
/**
 * Rollback prompts captured before replacement (from local worktree DB):
 * WS-004: not present in .fusion/fusion.db at capture time.
 * WS-006: not present in .fusion/fusion.db at capture time.
 *
 * To capture production rollback text before applying:
 * sqlite3 <db> "SELECT id, prompt FROM workflow_steps WHERE id IN ('WS-004','WS-006') ORDER BY id;"
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const dbPath = (process.argv.find((arg) => arg.startsWith("--db=")) || "--db=.fusion/fusion.db").slice(5);
const checkOnly = process.argv.includes("--check");

let WORKFLOW_STEP_TEMPLATES;
try {
  ({ WORKFLOW_STEP_TEMPLATES } = await import("../packages/core/dist/types.js"));
} catch {
  console.error("Unable to import packages/core/dist/types.js. Run: pnpm --filter @fusion/core build");
  process.exit(1);
}

const templateMap = new Map(WORKFLOW_STEP_TEMPLATES.map((entry) => [entry.id, entry.prompt]));
const seededMappings = [
  { workflowStepId: "WS-004", templateId: "browser-verification" },
  { workflowStepId: "WS-006", templateId: "frontend-ux-design" },
];

function createCliDatabase(dbFile) {
  const runSql = (sql) => execFileSync("sqlite3", [dbFile, sql], { encoding: "utf8" });
  const runSqlJson = (sql) => execFileSync("sqlite3", ["-json", dbFile, sql], { encoding: "utf8" });
  return {
    getRow(id) {
      const escapedId = String(id).replace(/'/g, "''");
      const output = runSqlJson(`SELECT id, name, prompt FROM workflow_steps WHERE id = '${escapedId}';`).trim();
      if (!output) return null;
      const rows = JSON.parse(output);
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const row = rows[0];
      return { id: row.id, name: row.name, prompt: row.prompt ?? "" };
    },
    updateRow(id, prompt, updatedAt) {
      const escapedId = String(id).replace(/'/g, "''");
      const escapedPrompt = String(prompt).replace(/'/g, "''");
      const escapedUpdatedAt = String(updatedAt).replace(/'/g, "''");
      runSql(`UPDATE workflow_steps SET prompt = '${escapedPrompt}', updatedAt = '${escapedUpdatedAt}' WHERE id = '${escapedId}';`);
    },
  };
}

const db = createCliDatabase(resolve(dbPath));

let updated = 0;
let skipped = 0;
let noOp = 0;
let differs = 0;

for (const { workflowStepId, templateId } of seededMappings) {
  const nextPrompt = templateMap.get(templateId);
  if (!nextPrompt) {
    console.error(`Template ${templateId} not found in WORKFLOW_STEP_TEMPLATES`);
    process.exit(1);
  }

  const row = db.getRow(workflowStepId);
  if (!row) {
    skipped += 1;
    console.log(`${workflowStepId}: not present, skipping`);
    continue;
  }

  const current = row.prompt ?? "";
  if (current === nextPrompt) {
    noOp += 1;
    console.log(`${workflowStepId}: no-op, already up to date`);
    continue;
  }

  if (checkOnly) {
    differs += 1;
    console.log(`${workflowStepId}: differs (check-only)`);
    continue;
  }

  db.updateRow(workflowStepId, nextPrompt, new Date().toISOString());
  updated += 1;
  console.log(`${workflowStepId}: updated (${row.name})`);
}

console.log(
  checkOnly
    ? `Updated ${updated} row(s), skipped ${skipped}, no-op ${noOp}, differs ${differs}`
    : `Updated ${updated} row(s), skipped ${skipped}, no-op ${noOp}`,
);
