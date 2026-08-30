import { exec } from "node:child_process";
import type { Task } from "@fusion/core";
import { isFusionDeletableBranch } from "@fusion/core";
import { promisify } from "node:util";

import { quoteShellArg } from "../executor/shell-quote.js";
import { canonicalFusionBranchName } from "./worktree-names.js";
import { canonicalizePath, getRegisteredWorktreeBranches } from "./worktree-pool.js";

const execAsync = promisify(exec);
const RESET_BRANCH_GIT_TIMEOUT_MS = 30_000;
const RESET_BRANCH_GIT_MAX_BUFFER = 10 * 1024 * 1024;

type GitRunOptions = {
  cwd: string;
  timeout: number;
  maxBuffer: number;
  encoding: "utf-8";
};

type GitRunner = (
  command: string,
  options: GitRunOptions,
) => Promise<string | { stdout?: string | Buffer }>;

export interface TaskResetBranchCleanupInput {
  task: Pick<Task, "id" | "branch" | "branchContext">;
  targets: Array<{ repoRootDir: string; recordedBranches: string[] }>;
  ownedWorktreePaths?: string[];
  runGit?: GitRunner;
  getRegisteredBranches?: typeof getRegisteredWorktreeBranches;
}

export interface TaskResetDeletedBranch {
  repoRootDir: string;
  branch: string;
}

export interface TaskResetRetainedBranch extends TaskResetDeletedBranch {
  reason: "operator-supplied" | "merge-target";
}

export interface TaskResetBlockedBranch extends TaskResetDeletedBranch {
  reason: "checked-out" | "delete-failed" | "still-present";
  holderWorktreePath?: string;
  detail?: string;
}

export interface TaskResetBranchCleanupOutcome {
  deleted: TaskResetDeletedBranch[];
  retained: TaskResetRetainedBranch[];
  blocked: TaskResetBlockedBranch[];
}

type ClassifiedBranches = TaskResetBranchCleanupOutcome & {
  deletable: TaskResetDeletedBranch[];
};

function stdoutOf(result: string | { stdout?: string | Buffer }): string {
  if (typeof result === "string") return result;
  return typeof result.stdout === "string" ? result.stdout : result.stdout?.toString("utf8") ?? "";
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultGitRunner(command: string, options: GitRunOptions) {
  return execAsync(command, options);
}

async function runGit(input: TaskResetBranchCleanupInput, command: string, repoRootDir: string) {
  return (input.runGit ?? defaultGitRunner)(command, {
    cwd: repoRootDir,
    timeout: RESET_BRANCH_GIT_TIMEOUT_MS,
    maxBuffer: RESET_BRANCH_GIT_MAX_BUFFER,
    encoding: "utf-8",
  });
}

type BranchProbe =
  | { kind: "present" }
  | { kind: "missing" }
  | { kind: "error"; detail: string };

function gitExitCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

async function probeBranch(
  input: TaskResetBranchCleanupInput,
  repoRootDir: string,
  branch: string,
): Promise<BranchProbe> {
  try {
    await runGit(input, `git rev-parse --verify --quiet ${quoteShellArg(`refs/heads/${branch}`)}`, repoRootDir);
    return { kind: "present" };
  } catch (error) {
    if (gitExitCode(error) === 1) return { kind: "missing" };
    return { kind: "error", detail: errorDetail(error) };
  }
}

/*
FNXC:TaskReset 2026-08-28-14:45:
FN-232 reverses local task-branch retention. Ownership comes from isFusionDeletableBranch rather
than branch spelling, shared merge targets and operator branches remain intact, and remote refs are
outside Reset's local-cleanup contract. A checked-out Fusion-owned branch is blocking, not retained:
inspectBareBranchCollision would reclaim any survivor on the next acquisition and falsely resume the
work Reset promised to discard. This refusal is safe only because the route permits retrying after
its own worktree targets become absent.

FNXC:TaskReset 2026-08-28-15:16:
Reset may treat only git rev-parse's dedicated exit code 1 as proof that a local branch is absent.
Timeouts, repository failures, and permission errors leave absence unproven and must block publication,
or Reset could report a clean restart while the old branch remains reclaimable.
*/
async function classifyTaskResetBranches(input: TaskResetBranchCleanupInput): Promise<ClassifiedBranches> {
  const retained: TaskResetRetainedBranch[] = [];
  const blocked: TaskResetBlockedBranch[] = [];
  const deletable: TaskResetDeletedBranch[] = [];
  const ownedPaths = new Set((input.ownedWorktreePaths ?? []).map(canonicalizePath));
  const mergeTarget = input.task.branchContext?.mergeTargetBranch?.trim();

  for (const target of input.targets) {
    const canonical = canonicalFusionBranchName(input.task.id);
    const enumerated = stdoutOf(await runGit(
      input,
      `git for-each-ref --format='%(refname:short)' ${quoteShellArg(`refs/heads/${canonical}`)} ${quoteShellArg(`refs/heads/${canonical}-*`)}`,
      target.repoRootDir,
    )).split(/\r?\n/u).map((branch) => branch.trim()).filter(Boolean);
    const candidates = [...new Set([
      ...target.recordedBranches.map((branch) => branch.trim()).filter(Boolean),
      ...enumerated,
    ])];
    const registered = await (input.getRegisteredBranches ?? getRegisteredWorktreeBranches)(target.repoRootDir);

    for (const branch of candidates) {
      const probe = await probeBranch(input, target.repoRootDir, branch);
      if (probe.kind === "missing") continue;
      if (probe.kind === "error") {
        blocked.push({
          repoRootDir: target.repoRootDir,
          branch,
          reason: "still-present",
          detail: `Unable to verify branch absence: ${probe.detail}`,
        });
        continue;
      }
      if (mergeTarget && branch === mergeTarget) {
        retained.push({ repoRootDir: target.repoRootDir, branch, reason: "merge-target" });
        continue;
      }
      if (!isFusionDeletableBranch(input.task, branch)) {
        retained.push({ repoRootDir: target.repoRootDir, branch, reason: "operator-supplied" });
        continue;
      }
      const holder = registered.find((entry) => entry.branch === branch && !ownedPaths.has(canonicalizePath(entry.worktreePath)));
      if (holder) {
        blocked.push({
          repoRootDir: target.repoRootDir,
          branch,
          reason: "checked-out",
          holderWorktreePath: holder.worktreePath,
        });
        continue;
      }
      deletable.push({ repoRootDir: target.repoRootDir, branch });
    }
  }

  return { deleted: [], retained, blocked, deletable };
}

export async function planTaskResetBranchCleanup(
  input: TaskResetBranchCleanupInput,
): Promise<TaskResetBranchCleanupOutcome> {
  const { deletable: _deletable, ...outcome } = await classifyTaskResetBranches(input);
  return outcome;
}

export async function deleteTaskResetBranches(
  input: TaskResetBranchCleanupInput,
): Promise<TaskResetBranchCleanupOutcome> {
  const { deletable, ...outcome } = await classifyTaskResetBranches(input);
  for (const candidate of deletable) {
    try {
      await runGit(input, `git branch -D ${quoteShellArg(candidate.branch)}`, candidate.repoRootDir);
    } catch (error) {
      outcome.blocked.push({ ...candidate, reason: "delete-failed", detail: errorDetail(error) });
      continue;
    }
    const verification = await probeBranch(input, candidate.repoRootDir, candidate.branch);
    if (verification.kind === "present") {
      outcome.blocked.push({ ...candidate, reason: "still-present", detail: "Branch still resolves after deletion" });
      continue;
    }
    if (verification.kind === "error") {
      outcome.blocked.push({
        ...candidate,
        reason: "still-present",
        detail: `Unable to verify branch absence after deletion: ${verification.detail}`,
      });
      continue;
    }
    outcome.deleted.push(candidate);
  }
  return outcome;
}
