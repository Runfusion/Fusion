#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

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

function hasDeletedAtColumn(db) {
  const columns = db.prepare("PRAGMA table_info('tasks')").all();
  return columns.some((column) => column?.name === "deletedAt");
}

export function recoverBlockedBy({ db, tasksDir, dryRun = true }) {
  const includeDeletedAt = hasDeletedAtColumn(db);
  const selectSql = includeDeletedAt
    ? "SELECT id, \"column\", blockedBy, worktree, paused, log, deletedAt FROM tasks WHERE deletedAt IS NULL"
    : "SELECT id, \"column\", blockedBy, worktree, paused, log FROM tasks";
  const rows = db.prepare(selectSql).all();
  const byId = new Map(rows.map((row) => [row.id, row]));

  const activeScopes = new Map();
  for (const row of rows) {
    const isActive = row.column === "in-progress" || (row.column === "in-review" && row.worktree && !row.paused);
    if (!isActive) continue;
    const scope = loadScope(tasksDir, row.id);
    if (scope.length > 0) activeScopes.set(row.id, scope);
  }

  const findings = [];
  const now = new Date().toISOString();

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

    if (!dryRun) {
      let log = [];
      try {
        log = row.log ? JSON.parse(row.log) : [];
        if (!Array.isArray(log)) log = [];
      } catch {
        log = [];
      }
      log.push({
        at: now,
        message: "Recovered: cleared stale blockedBy via FN-3899 recovery",
        outcome: `Recovered: cleared stale blockedBy via FN-3899 recovery (reason: ${reason})`,
      });

      db.prepare("UPDATE tasks SET blockedBy = NULL, log = ?, updatedAt = ? WHERE id = ?").run(JSON.stringify(log), now, row.id);
    }
  }

  return findings;
}

function resolveProjectRoot() {
  const commonDir = execSync("git rev-parse --git-common-dir", { encoding: "utf8" }).trim();
  return path.resolve(commonDir, "..");
}

function printFindings(findings, dryRun) {
  const changed = findings.filter((row) => row.oldBlocker !== row.newBlocker);
  console.log(dryRun ? "Mode: DRY RUN" : "Mode: APPLY");
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
  const dbPath = path.join(projectRoot, ".fusion", "fusion.db");
  const tasksDir = path.join(projectRoot, ".fusion", "tasks");

  const db = new DatabaseSync(dbPath);
  try {
    const findings = recoverBlockedBy({ db, tasksDir, dryRun });
    printFindings(findings, dryRun);
  } finally {
    db.close();
  }
}
