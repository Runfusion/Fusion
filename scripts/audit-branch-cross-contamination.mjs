#!/usr/bin/env node

/*
FNXC:PostgresCutover 2026-07-05-13:00:
Ported from the sqlite3 CLI on .fusion/fusion.db to the PostgreSQL backend
(scripts/lib/backend-db.mjs). The git contamination analysis
(analyzeBranchCrossContamination) is pure given task rows, so tests inject
rows directly; only row loading touches PostgreSQL.
*/
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openBackend, rowsOf } from "./lib/backend-db.mjs";

function runGit(projectRoot, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function parseArgs(argv) {
  const options = {
    projectRoot: process.cwd(),
    outPath: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-root") {
      options.projectRoot = path.resolve(argv[i + 1] ?? process.cwd());
      i += 1;
    } else if (arg.startsWith("--out=")) {
      options.outPath = path.resolve(arg.slice("--out=".length));
    } else if (arg === "--out") {
      options.outPath = path.resolve(argv[i + 1] ?? "audit-branch-cross-contamination.json");
      i += 1;
    }
  }
  return options;
}

function parseTaskIdFromSubject(subject) {
  const match = String(subject).match(/^[a-z]+\((FN-\d+)\):/i);
  return match ? match[1].toUpperCase() : null;
}

function parseTaskIdFromBody(body) {
  const match = String(body).match(/(?:^|\n)Fusion-Task-Id:\s*(FN-\d+)\s*(?:\n|$)/i);
  return match ? match[1].toUpperCase() : null;
}

function expectedBranch(taskId, branch) {
  if (branch && String(branch).trim()) return String(branch).trim();
  return `fusion/${String(taskId).toLowerCase()}`;
}

function branchExists(projectRoot, branchName) {
  return runGit(projectRoot, ["rev-parse", "--verify", `refs/heads/${branchName}`], { allowFailure: true }) !== null;
}

function resolveMainRef(projectRoot) {
  if (runGit(projectRoot, ["rev-parse", "--verify", "origin/main"], { allowFailure: true })) {
    return "origin/main";
  }
  return "main";
}

function resolveBaseCommit(projectRoot, branchName, taskBaseCommitSha) {
  if (taskBaseCommitSha && String(taskBaseCommitSha).trim()) {
    return { baseCommitSha: String(taskBaseCommitSha).trim(), source: "task.baseCommitSha" };
  }
  const mainRef = resolveMainRef(projectRoot);
  const fallback = runGit(projectRoot, ["merge-base", mainRef, branchName], { allowFailure: true });
  if (fallback) {
    return { baseCommitSha: fallback.trim(), source: `merge-base(${mainRef},${branchName})` };
  }
  return { baseCommitSha: null, source: "unresolved" };
}

function parseCommits(raw) {
  if (!raw) return [];
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const [sha, subject, body] = line.split("\u001f");
    const trailerTaskId = parseTaskIdFromBody(body ?? "");
    const subjectTaskId = parseTaskIdFromSubject(subject ?? "");
    return {
      sha,
      subject,
      trailerTaskId,
      subjectTaskId,
      attributedTaskId: trailerTaskId ?? subjectTaskId,
    };
  });
}

/** Pure analysis over injected task rows ({ id, title, branch, baseCommitSha, columnName }). */
/*
FNXC:OperatorScriptLaneAssumptions 2026-07-31-10:15:
`scannedColumns` reports what was ACTUALLY scanned, instead of asserting a fixed list.

This field was the literal array `["triage","todo","in-progress","in-review"]` — a claim, not an
observation. It was printed in the report regardless of what the query returned, so on a renamed
board it stated coverage the audit did not have. That is the one thing keeping a silent audit
honest, so it must be derived rather than declared.

Derived from the rows themselves: whatever lanes came back are the lanes examined, whether or not
this script has heard of them.
*/
export function analyzeBranchCrossContamination({ projectRoot = process.cwd(), taskRows }) {
  const report = {
    generatedAt: new Date().toISOString(),
    projectRoot,
    scannedTaskCount: taskRows.length,
    scannedColumns: [...new Set(taskRows.map((row) => row.columnName).filter(Boolean))].sort(),
    taintedTaskCount: 0,
    missingBranchCount: 0,
    tasks: [],
  };

  for (const task of taskRows) {
    const taskId = String(task.id).toUpperCase();
    const branchName = expectedBranch(taskId, task.branch);
    const baseResolution = resolveBaseCommit(projectRoot, branchName, task.baseCommitSha);
    const baseCommitSha = baseResolution.baseCommitSha;

    if (!branchExists(projectRoot, branchName)) {
      report.missingBranchCount += 1;
      process.stderr.write(`[skip] ${taskId}: branch not found locally (${branchName})\n`);
      report.tasks.push({
        taskId,
        title: task.title,
        branchName,
        baseCommitSha,
        column: task.columnName,
        skipped: true,
        reason: "branch-missing-local",
      });
      continue;
    }

    if (!baseCommitSha) {
      report.tasks.push({
        taskId,
        title: task.title,
        branchName,
        baseCommitSha: null,
        baseResolutionSource: baseResolution.source,
        column: task.columnName,
        skipped: true,
        reason: "missing-baseCommitSha",
      });
      continue;
    }

    const rawLog = runGit(projectRoot, ["log", `${baseCommitSha}..${branchName}`, "--format=%H%x1f%s%x1f%b"]);
    const commits = parseCommits(rawLog);
    const taintedCommits = commits.filter((commit) => commit.attributedTaskId && commit.attributedTaskId !== taskId);
    const ownCommits = commits.filter((commit) => commit.attributedTaskId === taskId);
    const isTainted = taintedCommits.length > 0;

    if (isTainted) report.taintedTaskCount += 1;

    report.tasks.push({
      taskId,
      title: task.title,
      branchName,
      baseCommitSha,
      baseResolutionSource: baseResolution.source,
      column: task.columnName,
      totalCommits: commits.length,
      taskAttributedCommitCount: ownCommits.length,
      tainted: isTainted,
      taintedCommits: taintedCommits.map((commit) => ({
        sha: commit.sha,
        subject: commit.subject,
        foreignTaskId: commit.attributedTaskId,
      })),
      recommendation: !isTainted ? "clean" : ownCommits.length > 0 ? "refile" : "force-reset",
      commits,
    });
  }

  return report;
}

export async function auditBranchCrossContamination({ projectRoot = process.cwd() } = {}) {
  const backend = await openBackend(projectRoot);
  let taskRows;
  try {
    const { core, store, asyncLayer, sql } = backend;
    /*
    FNXC:OperatorScriptLaneAssumptions 2026-07-31-10:15:
    Exclude the board's FINISHED lanes rather than allowlisting four legacy active ones.

    The query said `"column" IN ('triage','todo','in-progress','in-review')`. On a board whose lanes
    are named anything else that matches NOTHING, so the audit scans zero rows and reports zero
    contamination — a clean bill of health from a scan that never happened. `triage` is in that list
    too, a lane U11 (#2515) deleted.

    Inverted so the default is the safe one: an unrecognised lane is active work by assumption and IS
    audited; only lanes that genuinely mean finished drop out. An allowlist fails closed (skip
    everything unknown), a denylist fails open (look at it), and for an audit looking at one extra
    finished branch is a far smaller error than auditing nothing.

    Filtered in JS rather than by building a dynamic SQL exclusion: it keeps ONE place deciding what
    "finished" means, and it removes the last raw-SQL lane literal from this file — the shape the
    sibling gate could not see until #3000 widened it to `scripts/`.
    */
    const terminalLanes = store && core.resolveProjectColumnsForRoles
      ? await core.resolveProjectColumnsForRoles(store, core.TERMINAL_ROLES).catch(() => undefined)
      : undefined;
    /* DELIBERATE-LITERAL — the degraded default when the lanes could not be resolved. */
    const isFinished = (column) => (terminalLanes ? terminalLanes.has(column) : column === "done" || column === "archived");
    const allRows = rowsOf(await asyncLayer.db.execute(sql`
      SELECT id, title, branch, base_commit_sha AS "baseCommitSha", "column" AS "columnName"
      FROM project."tasks"
      WHERE deleted_at IS NULL
      ORDER BY id
    `));
    taskRows = allRows.filter((row) => !isFinished(row.columnName));
  } finally {
    await backend.shutdown().catch(() => {});
  }
  return analyzeBranchCrossContamination({ projectRoot, taskRows });
}

function renderSummary(report) {
  const lines = [
    `Branch cross-contamination audit`,
    `Scanned tasks: ${report.scannedTaskCount}`,
    `Tainted branches: ${report.taintedTaskCount}`,
    `Missing local branches: ${report.missingBranchCount}`,
    "",
  ];
  for (const task of report.tasks) {
    if (task.skipped) continue;
    if (!task.tainted) continue;
    lines.push(`${task.taskId} | branch=${task.branchName} | base=${task.baseCommitSha} | commits=${task.totalCommits} | recommendation=${task.recommendation}`);
    for (const commit of task.taintedCommits) {
      lines.push(`  - ${commit.sha.slice(0, 12)} ${commit.subject} [foreign=${commit.foreignTaskId ?? "unknown"}]`);
    }
  }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  const report = await auditBranchCrossContamination({ projectRoot: options.projectRoot });
  const json = JSON.stringify(report, null, 2);
  process.stdout.write(`${json}\n`);
  process.stderr.write(`${renderSummary(report)}\n`);
  if (options.outPath) {
    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    fs.writeFileSync(options.outPath, json);
    process.stderr.write(`\nWrote report: ${options.outPath}\n`);
  }
}
