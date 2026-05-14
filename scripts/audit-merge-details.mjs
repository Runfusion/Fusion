#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";

/**
 * FN-4529 mergeDetails auditor/backfill.
 *
 * Usage:
 *   node scripts/audit-merge-details.mjs [--apply] [--ids=FN-1,FN-2] [--report=path.json]
 *
 * Defaults to dry-run mode and prints a JSON report to stdout.
 * Use --apply to persist corrected filesChanged/insertions/deletions on done tasks
 * with mergeConfirmed=true and a backfillable classification.
 *
 * Safety rules:
 * - Never writes in dry-run mode.
 * - Refuses to backfill legacy rows without commitSha, unreachable commits,
 *   non-confirmed merges, and ambiguous/other classifications.
 * - FN-4518 note: rebase-range-vs-single-commit detection is heuristic until
 *   MergeDetails gains a persisted rebaseBaseSha field.
 */

export function parseShortstat(output) {
  const normalized = String(output ?? "").trim().replace(/\n/g, " ");
  const filesMatch = normalized.match(/(\d+) files? changed/);
  const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
  const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);
  return {
    filesChanged: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
    insertions: insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0,
  };
}

function commitOwnedByTask(taskId, subject, body) {
  if (String(body ?? "").includes(`Fusion-Task-Id: ${taskId}`)) return true;
  return new RegExp(`\\(${taskId}\\)`).test(String(subject ?? ""));
}

function parseIdsFlag(argv) {
  const arg = argv.find((entry) => entry.startsWith("--ids="));
  if (!arg) return null;
  return arg
    .slice("--ids=".length)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function parseReportPath(argv) {
  const arg = argv.find((entry) => entry.startsWith("--report="));
  if (!arg) return null;
  return arg.slice("--report=".length).trim() || null;
}

function sameCounts(left, right) {
  return left.filesChanged === right.filesChanged
    && left.insertions === right.insertions
    && left.deletions === right.deletions;
}

export function createGitHelpers(cwd = process.cwd()) {
  function run(args) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status ?? 1,
    };
  }

  return {
    commitExists(sha) {
      return run(["cat-file", "-e", `${sha}^{commit}`]).ok;
    },
    isAncestorOfMain(sha) {
      return run(["merge-base", "--is-ancestor", sha, "main"]).ok;
    },
    getShortstat(sha) {
      const res = run(["show", "--shortstat", "--format=", sha]);
      return res.ok ? parseShortstat(res.stdout) : null;
    },
    getCommitSubject(sha) {
      const res = run(["log", "-1", "--format=%s", sha]);
      return res.ok ? res.stdout.trim() : null;
    },
    getCommitBody(sha) {
      const res = run(["log", "-1", "--format=%B", sha]);
      return res.ok ? res.stdout : null;
    },
    getCommitRangeCount(base, head) {
      const res = run(["rev-list", "--count", `${base}..${head}`]);
      if (!res.ok) return null;
      const parsed = Number.parseInt(res.stdout.trim(), 10);
      return Number.isFinite(parsed) ? parsed : null;
    },
  };
}

export function classifyMismatch({ task, expected, actual, gitContext }) {
  const details = task.mergeDetails ?? {};
  const commitSha = String(details.commitSha ?? "").trim();
  if (!commitSha) return "legacy-no-commit-sha";
  if (!gitContext.commitExists || !gitContext.isAncestor) return "commit-unreachable";
  if (gitContext.rangeCommitCount && gitContext.rangeCommitCount > 1) return "rebase-range-vs-single-commit";
  if (gitContext.ownedByTask) return "post-push-sha-refresh";
  if (!sameCounts(actual, expected)) return "other";
  return "other";
}

export async function computeBackfillPlan({ tasks, git }) {
  const matches = [];
  const mismatches = [];
  const unbackfillable = [];
  const plan = [];

  for (const task of tasks) {
    if (task.column !== "done") continue;

    const mergeDetails = task.mergeDetails ?? {};
    const actual = {
      filesChanged: mergeDetails.filesChanged ?? 0,
      insertions: mergeDetails.insertions ?? 0,
      deletions: mergeDetails.deletions ?? 0,
    };

    if (mergeDetails.mergeConfirmed !== true) {
      unbackfillable.push({ taskId: task.id, classification: "merge-not-confirmed", before: actual, after: null });
      continue;
    }

    const commitSha = String(mergeDetails.commitSha ?? "").trim();
    if (!commitSha) {
      const row = { taskId: task.id, classification: "legacy-no-commit-sha", before: actual, after: null };
      mismatches.push(row);
      unbackfillable.push(row);
      continue;
    }

    const commitExists = git.commitExists(commitSha);
    const isAncestor = commitExists ? git.isAncestorOfMain(commitSha) : false;
    const expected = commitExists && isAncestor ? git.getShortstat(commitSha) : null;

    if (!expected) {
      const row = { taskId: task.id, classification: "commit-unreachable", before: actual, after: null };
      mismatches.push(row);
      unbackfillable.push(row);
      continue;
    }

    if (sameCounts(actual, expected)) {
      matches.push({ taskId: task.id, before: actual, after: expected, classification: "match" });
      continue;
    }

    const subject = git.getCommitSubject(commitSha);
    const body = git.getCommitBody(commitSha);
    const mergeTarget = String(mergeDetails.mergeTargetBranch ?? "main").trim() || "main";
    const rangeCommitCount = git.getCommitRangeCount?.(mergeTarget, commitSha) ?? null;

    const classification = classifyMismatch({
      task,
      expected,
      actual,
      gitContext: {
        commitExists,
        isAncestor,
        ownedByTask: commitOwnedByTask(task.id, subject, body),
        rangeCommitCount,
      },
    });

    const row = {
      taskId: task.id,
      classification,
      before: actual,
      after: expected,
      commitSha,
    };
    mismatches.push(row);

    if (classification === "post-push-sha-refresh" || classification === "rebase-range-vs-single-commit") {
      plan.push(row);
    } else {
      unbackfillable.push(row);
    }
  }

  return { matches, mismatches, unbackfillable, plan };
}

export async function runAudit({ store, git, dryRun = true, ids = null }) {
  const tasks = await store.listTasks({ includeArchived: false, includeDone: true, includeMissionContext: false });
  const selected = ids && ids.length > 0 ? tasks.filter((task) => ids.includes(task.id)) : tasks;
  const computed = await computeBackfillPlan({ tasks: selected, git });

  const applied = [];
  if (!dryRun) {
    for (const entry of computed.plan) {
      const task = await store.getTask(entry.taskId);
      const mergeDetails = task.mergeDetails ?? {};
      const before = {
        filesChanged: mergeDetails.filesChanged ?? 0,
        insertions: mergeDetails.insertions ?? 0,
        deletions: mergeDetails.deletions ?? 0,
      };
      const after = entry.after;

      if (!after || sameCounts(before, after)) {
        continue;
      }

      const nextMergeDetails = {
        ...mergeDetails,
        filesChanged: after.filesChanged,
        insertions: after.insertions,
        deletions: after.deletions,
      };

      await store.updateTask(entry.taskId, { mergeDetails: nextMergeDetails });
      await store.logEntry(
        entry.taskId,
        "FN-4529 backfill mergeDetails",
        `${before.filesChanged}/${before.insertions}/${before.deletions} → ${after.filesChanged}/${after.insertions}/${after.deletions}`,
      );
      applied.push({ taskId: entry.taskId, before, after, classification: entry.classification });
    }
  }

  return {
    dryRun,
    selectedTaskCount: selected.length,
    ...computed,
    applied,
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const dryRun = !argv.includes("--apply");
  const reportPath = parseReportPath(argv);
  const ids = parseIdsFlag(argv);
  const git = deps.git ?? createGitHelpers(process.cwd());

  let store = deps.store;
  if (!store) {
    const { TaskStore } = await import("../packages/core/dist/index.js");
    store = new TaskStore(process.cwd());
    await store.init();
  }

  const report = await runAudit({ store, git, dryRun, ids });
  const reportJson = JSON.stringify(report, null, 2);
  console.log(reportJson);

  if (reportPath) {
    writeFileSync(reportPath, `${reportJson}\n`, "utf8");
  }

  const hasUnbackfillableMismatches = report.unbackfillable.some((entry) => entry.classification !== "merge-not-confirmed");
  if (dryRun && hasUnbackfillableMismatches) return 1;
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
