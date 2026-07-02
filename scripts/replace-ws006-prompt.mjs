#!/usr/bin/env node
/**
 * WS-006 rollback prompt (captured from DB before replacement):
 * (not captured in this worktree; run `sqlite3 .fusion/fusion.db "SELECT prompt FROM workflow_steps WHERE id='WS-006';"` before applying in production)
 */
/*
 * FNXC:SqliteFinalRemoval 2026-06-24-16:20:
 * Switched from better-sqlite3 to node:sqlite (Node 22+ built-in) to remove
 * the better-sqlite3 dependency. This is a standalone maintenance script.
 */
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const NEW_PROMPT = `You are the Frontend UX Design workflow reviewer.

Step 1 (mandatory, first): inspect the already-provided "Diff Scope" block in system context.
If no frontend/UI files are in scope, immediately output exactly:
{"verdict":"APPROVE","notes":"out of scope: no UI files changed"}
and STOP.

If frontend/UI files exist in scope, review only those scoped files for:
- visual hierarchy
- spacing/typography consistency
- token-based color/style usage
- component reuse and design-system consistency
- responsive behavior

If changes are acceptable: use APPROVE or APPROVE_WITH_NOTES.
If changes are required: use REVISE with concrete actionable notes.

Final output rule: output exactly one trailing JSON object and STOP (no prose, no markdown fences):
{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}`;

const dbPath = (process.argv.find((arg) => arg.startsWith("--db=")) || "--db=.fusion/fusion.db").slice(5);
const checkOnly = process.argv.includes("--check");
const db = new DatabaseSync(resolve(dbPath));
const row = db.prepare("SELECT id, name, prompt FROM workflow_steps WHERE id = 'WS-006'").get();
if (!row) {
  console.error("WS-006 not found");
  process.exit(1);
}

const current = row.prompt ?? "";
if (checkOnly) {
  console.log(current === NEW_PROMPT ? "WS-006 prompt matches target" : "WS-006 prompt differs from target");
  process.exit(0);
}

if (current === NEW_PROMPT) {
  console.log("No-op: WS-006 prompt already matches target.");
  process.exit(0);
}

const beforeLen = current.length;
const afterLen = NEW_PROMPT.length;
console.error(`Updating ${row.id} (${row.name}) length ${beforeLen} -> ${afterLen}`);
for (const line of ["--- old", "+++ new", `- first line: ${current.split("\n")[0] || ""}`, `+ first line: ${NEW_PROMPT.split("\n")[0] || ""}`]) {
  console.error(line);
}
db.prepare("UPDATE workflow_steps SET prompt = ?, updatedAt = ? WHERE id = 'WS-006'").run(NEW_PROMPT, new Date().toISOString());
console.log(`Updated ${row.id} (${row.name})`);
