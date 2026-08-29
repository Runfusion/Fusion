import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Settings, Task } from "@fusion/core";
import { resolveWorkspaceRepoBaseBranch } from "./workspace-base-branch.js";
import { computeReviewDiffFingerprint } from "./review-diff-fingerprint.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceRepositoryReviewEvidence {
  repository: string;
  baseCommitSha: string;
  branch: string;
  files: string[];
  qualifiedFiles: string[];
  fingerprint?: string;
  ahead: boolean;
  netZero: boolean;
}

export interface WorkspaceReviewEvidenceCapture {
  repositories: WorkspaceRepositoryReviewEvidence[];
  modifiedFiles: string[];
  modifiedRepositories: Set<string>;
  outOfScopeRepositories: Set<string>;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

/**
 * Capture the immutable branch payload shared by workspace Code Review and landing.
 *
 * FNXC:WorkspaceReviewEvidence 2026-08-21-19:25:
 * FN-120 requires the review producer and landing consumer to measure the identical
 * base-to-task-branch binary diff. A linked worktree has HEAD at the task branch, so
 * ambient HEAD is never a valid comparison endpoint. Acquiring a clean repository is
 * reported as no obligation while any modified repository outside confirmed intent is
 * retained as a fail-closed observation.
 */
export async function captureWorkspaceReviewEvidence(options: {
  task: Task;
  workspaceRootDir: string;
  settings: Partial<Settings>;
}): Promise<WorkspaceReviewEvidenceCapture> {
  const { task, workspaceRootDir, settings } = options;
  const confirmedScope = task.repositoryScope?.state === "confirmed"
    ? new Set(task.repositoryScope.repositories)
    : new Set<string>();
  const repositories: WorkspaceRepositoryReviewEvidence[] = [];
  const modifiedFiles = new Set<string>();
  const modifiedRepositories = new Set<string>();
  const outOfScopeRepositories = new Set<string>();

  for (const [repository, entry] of Object.entries(task.workspaceWorktrees ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    if (!entry.branch) throw new Error(`Workspace repository ${repository} has no task branch for review evidence`);
    /* FNXC:WorkspaceReviewEvidence 2026-08-21-19:25: Legacy rows can name a branch which no longer resolves while the linked checkout remains readable. Production acquisition records a resolvable branch; landing remains fail-closed through its later branch checks. */
    let branch = entry.branch;
    try {
      branch = await git(["rev-parse", "--verify", `${entry.branch}^{commit}`], entry.worktreePath);
    } catch {
      branch = await git(["rev-parse", "--verify", "HEAD"], entry.worktreePath);
    }
    const baseCommitSha = entry.baseCommitSha
      ? await git(["rev-parse", "--verify", `${entry.baseCommitSha}^{commit}`], entry.worktreePath)
      : await (async () => {
        const base = await resolveWorkspaceRepoBaseBranch({
          mode: "recorded",
          repoRootDir: join(workspaceRootDir, repository),
          repoRelPath: repository,
          task,
          settings,
          recordedBaseBranch: entry.baseBranch,
        });
        return git(["merge-base", base.branch, branch], entry.worktreePath);
      })();
    const range = `${baseCommitSha}..${branch}`;
    const names = await git(["diff", "--name-only", range], entry.worktreePath);
    const files = [...new Set(names.split("\n").map((file) => file.trim()).filter(Boolean))].sort();
    const ahead = Number(await git(["rev-list", "--count", range], entry.worktreePath)) > 0;
    const qualifiedFiles = files.map((file) => `${repository}/${file}`);
    const fingerprint = files.length > 0
      ? await computeReviewDiffFingerprint(entry.worktreePath, baseCommitSha, branch)
      : undefined;
    const netZero = ahead && files.length === 0;
    repositories.push({ repository, baseCommitSha, branch, files, qualifiedFiles, fingerprint, ahead, netZero });
    if (files.length > 0) {
      if (confirmedScope.has(repository)) {
        modifiedRepositories.add(repository);
        for (const file of qualifiedFiles) modifiedFiles.add(file);
      } else {
        outOfScopeRepositories.add(repository);
      }
    }
  }

  return {
    repositories,
    modifiedFiles: [...modifiedFiles].sort(),
    modifiedRepositories,
    outOfScopeRepositories,
  };
}
