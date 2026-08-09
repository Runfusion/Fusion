/**
 * FNXC:CodeOrganization 2026-08-03-16:50:
 * captureModifiedFiles / captureWorkspaceModifiedFiles / captureUncommittedModifiedFiles
 * peeled from TaskExecutor (U4 Slice B). Attribution-aware + workspace multi-repo file capture.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Task } from "@fusion/core";
import { BranchAttributionError, filterFilesToOwnTaskCommits } from "../execution/branch-attribution.js";
import { executorLog } from "../logger.js";
import type { RunAuditor } from "../util/run-audit.js";
import { resolveDiffBaseRef } from "./worktree-git-refs.js";

const execAsync = promisify(exec);

export async function captureModifiedFiles(
  worktreePath: string,
  baseCommitSha: string | undefined,
  taskId: string,
  audit?: RunAuditor,
  source = "unspecified",
): Promise<string[]> {
  try {
    const baseRef = await resolveDiffBaseRef(worktreePath, baseCommitSha);
    if (!baseRef) {
      return [];
    }

    try {
      const attributed = await filterFilesToOwnTaskCommits({
        worktreePath,
        baseRef,
        taskId,
      });
      const divergence = attributed.rawDiffFileCount - attributed.files.length;
      if (divergence > 0) {
        await audit?.database({
          type: "task:worktree-contamination-detected",
          target: taskId,
          metadata: {
            rawDiffFileCount: attributed.rawDiffFileCount,
            attributedFileCount: attributed.files.length,
            foreignCommitCount: attributed.foreignCommits.length,
            foreignCommitShas: attributed.foreignCommits.slice(0, 5).map((commit) => commit.sha),
            source,
          },
        });
        executorLog.warn(
          `${taskId}: contamination detected — raw diff ${attributed.rawDiffFileCount} files, attributed ${attributed.files.length} (foreign commits: ${attributed.foreignCommits.length})`,
        );
      }
      return attributed.files;
    } catch (error) {
      if (error instanceof BranchAttributionError) {
        executorLog.warn(`${taskId}: branch-attribution failed (${error.message}); falling back to raw diff`);
        const { stdout } = await execAsync(`git diff --name-only ${baseRef}..HEAD`, {
          cwd: worktreePath,
          encoding: "utf-8",
        });
        const output = stdout.trim();
        return output ? output.split("\n").filter(Boolean) : [];
      }
      throw error;
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.debug(`Failed to capture modified files: ${errorMessage}`);
    return [];
  }
}

/**
 * FNXC:Workspace 2026-06-21-23:30: KTD1 — per-repo modified-file capture for workspace tasks.
 * Loops `task.workspaceWorktrees` and REUSES `captureModifiedFiles` per sub-repo (NOT a hand-built `git diff`), so each repo gets: (a) resolveDiffBaseRef's merge-base fallback when repo.baseCommitSha is undefined, and (b) the filterFilesToOwnTaskCommits raw-vs-attributed divergence/contamination audit for free. Returned files are repo-prefixed (`<repoRel>/<file>`) and aggregated, so a downstream File-Scope check / merge can attribute each change to its sub-repo. Returns [] for a zero-acquire workspace task.
 */
export async function captureWorkspaceModifiedFiles(
  task: Task,
  audit?: RunAuditor,
  source = "post-session",
): Promise<string[]> {
  const workspaceWorktrees = task.workspaceWorktrees ?? {};
  // FNXC:Workspace 2026-06-21-15:00: F4/F6 — per-repo error isolation + deterministic ordering.
  // F4: an unexpected throw from one repo's `captureModifiedFiles` must NOT escape and skip the
  // downstream `updateTask({modifiedFiles})` write — that would leave `task.modifiedFiles` empty and
  // blind the merge file audit. Wrap each per-repo call (log + continue), mirroring the post-session
  // branch-attribution loop. F6: iterate sorted repo keys so aggregation order is stable across runs.
  const aggregated: string[] = [];
  for (const repoRel of Object.keys(workspaceWorktrees).sort()) {
    const repo = workspaceWorktrees[repoRel];
    try {
      const repoFiles = await captureModifiedFiles(repo.worktreePath, repo.baseCommitSha ?? undefined, task.id, audit, source);
      for (const file of repoFiles) {
        aggregated.push(`${repoRel}/${file}`);
      }
    } catch (repoErr: unknown) {
      executorLog.warn(`${task.id}: per-repo modified-file capture failed for ${repoRel}: ${repoErr instanceof Error ? repoErr.message : String(repoErr)}`);
    }
  }
  return aggregated;
}

export async function captureUncommittedModifiedFiles(worktreePath: string): Promise<string[]> {
  try {
    const [unstaged, staged] = await Promise.all([
      execAsync("git diff --name-only", { cwd: worktreePath, encoding: "utf-8" }),
      execAsync("git diff --name-only --cached", { cwd: worktreePath, encoding: "utf-8" }),
    ]);
    const files = [...unstaged.stdout.split("\n"), ...staged.stdout.split("\n")]
      .map((entry) => entry.trim())
      .filter(Boolean);
    return [...new Set(files)];
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.warn(`Failed to capture uncommitted modified files: ${errorMessage}`);
    return [];
  }
}

