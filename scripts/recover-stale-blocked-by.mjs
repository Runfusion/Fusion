#!/usr/bin/env node
/*
FNXC:PostgresCutover 2026-07-05-13:00:
Ported from direct node:sqlite access on .fusion/fusion.db to the PostgreSQL
backend (scripts/lib/backend-db.mjs). The FN-3899 recovery logic
(planRecoverBlockedBy) is pure and operates on plain row arrays so tests need
no database; only the thin apply step touches PostgreSQL. In PG the `log`
column is jsonb (already an array), unlike the SQLite JSON-string column.
*/
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import { openBackend, rowsOf } from "./lib/backend-db.mjs";

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  return {
    dryRun: !flags.has("--apply"),
    apply: flags.has("--apply"),
  };
}

export function parseFileScopeFromPromptText(promptText) {
  const headerMatch = promptText.match(/^##\s+File Scope\s*$/m);
  if (!headerMatch || headerMatch.index === undefined) return [];
  const start = headerMatch.index + headerMatch[0].length;
  const rest = promptText.slice(start);
  const nextHeader = rest.search(/^##\s+/m);
  const section = nextHeader >= 0 ? rest.slice(0, nextHeader) : rest;
  const paths = [];
  const regex = /`([^`]+)`/g;
  let match;
  while ((match = regex.exec(section)) !== null) {
    const value = match[1].trim();
    if (value) paths.push(value);
  }
  return [...new Set(paths)];
}

export function pathsOverlap(a, b) {
  for (const pa of a) {
    const prefixA = pa.endsWith("/*") ? pa.slice(0, -1) : null;
    for (const pb of b) {
      const prefixB = pb.endsWith("/*") ? pb.slice(0, -1) : null;
      const cleanA = prefixA ? pa.slice(0, -2) : pa;
      const cleanB = prefixB ? pb.slice(0, -2) : pb;
      if (cleanA === cleanB) return true;
      if (prefixA && pb.startsWith(prefixA)) return true;
      if (prefixB && pa.startsWith(prefixB)) return true;
      if (prefixA && prefixB && (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA))) return true;
      if (pa === pb) return true;
    }
  }
  return false;
}

function loadScope(tasksDir, taskId) {
  const promptPath = path.join(tasksDir, taskId, "PROMPT.md");
  if (!fs.existsSync(promptPath)) return [];
  return parseFileScopeFromPromptText(fs.readFileSync(promptPath, "utf8"));
}

function isTerminalColumn(column) {
  return column === "done" || column === "archived";
}

/*
FNXC:OperatorScriptLaneAssumptions 2026-07-30-23:30:
Refuse to look healthy on a board this script cannot reason about.

Every lane test here is a legacy id: `isTerminalColumn` is done/archived, "active" is
in-progress/in-review, and the candidate gate is `row.column !== "todo"`. On a board whose lanes are
named anything else that gate matches NOTHING, so the planner returns no findings and the script
prints "Repairs: 0" — an operator running a recovery reads that as "the board is fine" when in fact
the tool never examined a single card. A silently empty answer from a RECOVERY tool is the worst
shape available: it is indistinguishable from success and it is consulted precisely during incidents.

Detection only, deliberately. Correct classification needs the board's resolved trait vocabulary, and
this script holds a raw backend (`openBackend` -> asyncLayer + sql), not a TaskStore — resolving lanes
here would mean reimplementing IR trait resolution in a .mjs script, which is a worse bug than the one
it fixes. So the assumptions are not repaired; they are made LOUD, which is the same principle the
lane-wiring gate applies to itself ("a gate whose errors land on nothing to report is the one failure
mode a ratchet must not have").

Pure and exported so the warning is testable without a database, matching how `planRecoverBlockedBy`
is already structured.
*/
const LEGACY_LANES_THIS_SCRIPT_UNDERSTANDS = new Set([
  "triage",
  "todo",
  "in-progress",
  "in-review",
  "done",
  "archived",
]);

export function unrecognisedLanes(rows) {
  return [...new Set(
    rows
      .map((row) => row.column)
      .filter((column) => typeof column === "string" && column.length > 0 && !LEGACY_LANES_THIS_SCRIPT_UNDERSTANDS.has(column)),
  )].sort();
}

/**
 * Pure FN-3899 planning: rows are { id, column, blockedBy, worktree, paused }.
 * Returns findings; entries with newBlocker === null are the repairs.
 */
export function planRecoverBlockedBy({ rows, tasksDir }) {
  const byId = new Map(rows.map((row) => [row.id, row]));

  const activeScopes = new Map();
  for (const row of rows) {
    const isActive = row.column === "in-progress" || (row.column === "in-review" && row.worktree && !row.paused);
    if (!isActive) continue;
    const scope = loadScope(tasksDir, row.id);
    if (scope.length > 0) activeScopes.set(row.id, scope);
  }

  const findings = [];
  for (const row of rows) {
    if (row.column !== "todo" || !row.blockedBy) continue;

    const blocker = byId.get(row.blockedBy);
    const taskScope = loadScope(tasksDir, row.id);
    let reason = null;

    if (!blocker) {
      reason = "blocker-missing";
    } else if (isTerminalColumn(blocker.column)) {
      reason = `blocker-terminal:${blocker.column}`;
    } else if (blocker.column === "in-review" && !blocker.worktree) {
      reason = "blocker-in-review-without-worktree";
    } else {
      const blockerScope = activeScopes.get(blocker.id) ?? [];
      if (taskScope.length === 0 || blockerScope.length === 0 || !pathsOverlap(taskScope, blockerScope)) {
        reason = "scope-no-overlap";
      }
    }

    if (!reason) {
      findings.push({ taskId: row.id, oldBlocker: row.blockedBy, newBlocker: row.blockedBy, reason: "unchanged" });
      continue;
    }

    findings.push({ taskId: row.id, oldBlocker: row.blockedBy, newBlocker: null, reason });
  }

  return findings;
}

export async function recoverBlockedBy({ backend, tasksDir, dryRun = true }) {
  const { asyncLayer, sql } = backend;
  const rows = rowsOf(
    await asyncLayer.db.execute(sql`
      SELECT id, "column", blocked_by AS "blockedBy", worktree, paused, log
      FROM project."tasks"
      WHERE deleted_at IS NULL
    `),
  );

  const findings = planRecoverBlockedBy({ rows, tasksDir });
  /* Attached to the returned array rather than changing the return type: `recoverBlockedBy` is
     consumed as findings[] by the entry point below and by tests, and widening it to an object would
     be a breaking change to a script an operator may already be scripting around. */
  Object.defineProperty(findings, "unrecognisedLanes", { value: unrecognisedLanes(rows), enumerable: false });
  if (dryRun) return findings;

  const byId = new Map(rows.map((row) => [row.id, row]));
  const now = new Date().toISOString();
  for (const finding of findings) {
    if (finding.newBlocker === finding.oldBlocker) continue;
    const row = byId.get(finding.taskId);
    const log = Array.isArray(row?.log) ? [...row.log] : [];
    log.push({
      at: now,
      message: "Recovered: cleared stale blockedBy via FN-3899 recovery",
      outcome: `Recovered: cleared stale blockedBy via FN-3899 recovery (reason: ${finding.reason})`,
    });
    await asyncLayer.db.execute(sql`
      UPDATE project."tasks"
      SET blocked_by = NULL, log = ${JSON.stringify(log)}::jsonb, updated_at = ${now}
      WHERE id = ${finding.taskId}
    `);
  }

  return findings;
}

function resolveProjectRoot() {
  const commonDir = execSync("git rev-parse --git-common-dir", { encoding: "utf8" }).trim();
  return path.resolve(commonDir, "..");
}

function printFindings(findings, dryRun, unknownLanes = []) {
  const changed = findings.filter((row) => row.oldBlocker !== row.newBlocker);
  console.log(dryRun ? "Mode: DRY RUN" : "Mode: APPLY");
  /* Printed BEFORE the results, because the results are the thing it qualifies — "Repairs: 0" under
     unrecognised lanes means "not examined", not "nothing to fix". See `unrecognisedLanes`. */
  if (unknownLanes.length > 0) {
    console.warn(
      `WARNING: this board uses lanes this script does not understand: ${unknownLanes.join(", ")}.\n`
      + "         Its blocked/active/terminal tests are hardcoded to the legacy column ids, so cards in\n"
      + "         those lanes were NOT examined. Treat the result below as incomplete, not as a clean bill\n"
      + "         of health, and recover those cards by another route.",
    );
  }
  console.log("taskId\toldBlocker\tnewBlocker\treason");
  for (const row of findings) {
    if (row.oldBlocker === row.newBlocker) continue;
    console.log(`${row.taskId}\t${row.oldBlocker}\t${row.newBlocker ?? "NULL"}\t${row.reason}`);
  }
  console.log(`Repairs: ${changed.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { dryRun } = parseArgs(process.argv);
  const projectRoot = resolveProjectRoot();
  const tasksDir = path.join(projectRoot, ".fusion", "tasks");

  const backend = await openBackend(projectRoot);
  try {
    const findings = await recoverBlockedBy({ backend, tasksDir, dryRun });
    printFindings(findings, dryRun, findings.unrecognisedLanes ?? []);
  } finally {
    await backend.shutdown().catch(() => {});
  }
}
