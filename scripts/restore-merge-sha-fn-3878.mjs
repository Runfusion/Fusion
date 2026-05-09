#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

export const RESTORATIONS = [
  { id: "FN-3794", canonicalSha: "7d20a348d82320bc57310169aaa2d3b3f0d5a946" },
  { id: "FN-3814", canonicalSha: "8a7038c9e8c692b0cce89f26260604c6672283bd" },
  { id: "FN-3829", canonicalSha: "1abbb106073df866147e24b48ac05deeaf7224a6" },
];

function parseShortstat(output) {
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
    isAncestorOfMain(sha) {
      return run(["merge-base", "--is-ancestor", sha, "main"]).ok;
    },
    getCommitSubject(sha) {
      const res = run(["log", "-1", "--format=%s", sha]);
      return res.ok ? res.stdout.trim() : null;
    },
    getCommitBody(sha) {
      const res = run(["log", "-1", "--format=%B", sha]);
      return res.ok ? res.stdout : null;
    },
    getCommitAuthorDateIso(sha) {
      const res = run(["log", "-1", "--format=%aI", sha]);
      return res.ok ? res.stdout.trim() : null;
    },
    getShortstat(sha) {
      const res = run(["show", "--shortstat", "--format=", sha]);
      return res.ok ? parseShortstat(res.stdout) : null;
    },
  };
}

function commitOwnedByTask(taskId, subject, body) {
  if (String(body ?? "").includes(`Fusion-Task-Id: ${taskId}`)) return true;
  return new RegExp(`\\(${taskId}\\)`).test(String(subject ?? ""));
}

export async function runRestoration({ store, git, restorations = RESTORATIONS, dryRun = true }) {
  const results = [];
  let hadValidationErrors = false;

  for (const { id, canonicalSha } of restorations) {
    const task = await store.getTask(id);
    const mergeDetails = task.mergeDetails ?? {};

    if (task.column !== "done") {
      results.push({ taskId: id, action: "skipped", reason: "task-not-done" });
      continue;
    }
    if (mergeDetails.mergeConfirmed !== true) {
      results.push({ taskId: id, action: "skipped", reason: "merge-not-confirmed" });
      continue;
    }

    if (mergeDetails.commitSha === canonicalSha) {
      results.push({ taskId: id, action: "already-canonical", reason: "commit-matches" });
      continue;
    }

    if (!git.isAncestorOfMain(canonicalSha)) {
      hadValidationErrors = true;
      results.push({ taskId: id, action: "skipped", reason: "canonical-sha-not-on-main" });
      continue;
    }

    const subject = git.getCommitSubject(canonicalSha);
    const body = git.getCommitBody(canonicalSha);
    if (!subject || !body || !commitOwnedByTask(id, subject, body)) {
      hadValidationErrors = true;
      results.push({ taskId: id, action: "skipped", reason: "canonical-sha-not-owned-by-task" });
      continue;
    }

    const mergedAt = git.getCommitAuthorDateIso(canonicalSha);
    const shortstat = git.getShortstat(canonicalSha);
    if (!mergedAt || !shortstat) {
      hadValidationErrors = true;
      results.push({ taskId: id, action: "skipped", reason: "failed-to-derive-commit-metadata" });
      continue;
    }

    const nextMergeDetails = {
      ...mergeDetails,
      commitSha: canonicalSha,
      mergeCommitMessage: subject,
      filesChanged: shortstat.filesChanged,
      insertions: shortstat.insertions,
      deletions: shortstat.deletions,
      mergedAt,
      mergeConfirmed: true,
    };

    if (!dryRun) {
      await store.updateTask(id, { mergeDetails: nextMergeDetails });
      await store.logEntry(
        id,
        "FN-3878 restore commitSha",
        `${String(mergeDetails.commitSha ?? "unknown").slice(0, 8)} → ${canonicalSha.slice(0, 8)}`,
      );
      results.push({ taskId: id, action: "updated", reason: "restored-canonical-sha" });
    } else {
      results.push({ taskId: id, action: "updated", reason: "dry-run" });
    }
  }

  return { results, hadValidationErrors };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const dryRun = !argv.includes("--apply");
  const git = deps.git ?? createGitHelpers(process.cwd());
  let store = deps.store;
  if (!store) {
    const { TaskStore } = await import("../packages/core/dist/index.js");
    store = new TaskStore(process.cwd());
    await store.init();
  }

  const output = await runRestoration({ store, git, dryRun });
  console.log(JSON.stringify(output.results, null, 2));
  return output.hadValidationErrors ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
