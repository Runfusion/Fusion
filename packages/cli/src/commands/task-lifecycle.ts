/**
 * Shared task lifecycle helpers for PR merge workflows.
 *
 * This module contains non-UI task lifecycle utilities that can be used by both
 * `runDashboard()` and `runServe()`. It has NO dependency on `@fusion/dashboard`
 * or any dashboard-specific imports.
 *
 * The lifecycle helpers handle:
 * - PR merge strategy resolution
 * - Branch naming conventions
 * - PR title/body construction
 * - Worktree/branch cleanup after merge
 * - Full PR lifecycle orchestration (create → status check → merge)
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
import type { TaskStore } from "@fusion/core";
import { resolveTaskMergeTarget } from "@fusion/core";
import type { Settings, TaskDetail, PrInfo } from "@fusion/core";

/**
 * Minimal interface for GitHub operations needed by the PR merge workflow.
 * Defined locally to avoid importing from @fusion/dashboard.
 */
interface GitHubOperations {
  findPrForBranch(params: { head: string; state?: "open" | "closed" | "all" }): Promise<PrInfo | null>;
  createPr(params: { title: string; body: string; head: string; base?: string }): Promise<PrInfo>;
  getPrMergeStatus(base?: string, head?: string, number?: number): Promise<{
    prInfo: PrInfo;
    reviewDecision: string | null;
    checks: Array<{ name: string; required: boolean; state: string }>;
    mergeReady: boolean;
    blockingReasons: string[];
  }>;
  mergePr(params: { number: number; method?: "merge" | "squash" | "rebase" }): Promise<PrInfo>;
}

/**
 * Resolve the merge strategy from settings.
 * Returns the configured merge strategy or "direct" as default.
 */
export function getMergeStrategy(settings: Pick<Settings, "mergeStrategy">): NonNullable<Settings["mergeStrategy"]> {
  return settings.mergeStrategy ?? "direct";
}

/**
 * Generate the git branch name for a task.
 * Format: fusion/{task-id-lowercase}
 */
export function getTaskBranchName(taskId: string): string {
  return `fusion/${taskId.toLowerCase()}`;
}

/**
 * Push the per-task branch to origin so `gh pr create --head <branch>`
 * can find it. Idempotent: creates the remote branch on first push and
 * fast-forwards thereafter. Required because the GitHub PR-create flow
 * does not implicitly publish the local branch.
 */
function commandExitCode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "number" ? code : undefined;
  }
  return undefined;
}

async function gitCommandSucceeds(cwd: string, command: string, missingExitCode: number): Promise<boolean> {
  try {
    await execAsync(command, { cwd, timeout: 30_000 });
    return true;
  } catch (err: unknown) {
    if (commandExitCode(err) === missingExitCode) return false;
    throw err;
  }
}

async function pushTaskBranchToOrigin(cwd: string, branch: string): Promise<void> {
  const localRef = `refs/heads/${branch}`;
  const localBranchExists = await gitCommandSucceeds(
    cwd,
    `git show-ref --verify --quiet "${localRef}"`,
    1,
  );

  if (!localBranchExists) {
    const remoteBranchExists = await gitCommandSucceeds(
      cwd,
      `git ls-remote --exit-code --heads origin "${branch}"`,
      2,
    );

    if (remoteBranchExists) {
      return;
    }

    throw new Error(
      `Cannot create PR for missing task branch "${branch}": no local ref "${localRef}" and no origin branch "${branch}". Re-run the task or recreate the branch before retrying PR creation.`,
    );
  }

  try {
    await execAsync(`git push -u origin "${branch}"`, {
      cwd,
      timeout: 60_000,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to push branch "${branch}" to origin before PR creation: ${message}`,
    );
  }
}

/**
 * Build the PR title for a task.
 * Format: "{taskId}: {title}" or just "{taskId}" if no title.
 */
function buildPullRequestTitle(task: Pick<TaskDetail, "id" | "title">): string {
  return task.title ? `${task.id}: ${task.title}` : task.id;
}

/**
 * Build the PR body/description for a task.
 * Format:
 * ```
 * Automated PR for {taskId}.
 *
 * {description}
 * ```
 */
function buildPullRequestBody(task: Pick<TaskDetail, "id" | "description">): string {
  return [`Automated PR for ${task.id}.`, "", task.description].join("\n");
}

/**
 * Clean up worktree and branch artifacts after a successful merge.
 * Both operations are best-effort; errors are logged but don't propagate.
 */
export async function cleanupMergedTaskArtifacts(cwd: string, task: Pick<TaskDetail, "id" | "worktree">): Promise<void> {
  const branch = getTaskBranchName(task.id);

  if (task.worktree) {
    try {
      await execAsync(`git worktree remove "${task.worktree}" --force`, {
        cwd,
        timeout: 30_000,
      });
    } catch {
      // Best-effort cleanup — worktree may already be gone.
    }
  }

  try {
    await execAsync(`git branch -d "${branch}"`, {
      cwd,
      timeout: 30_000,
    });
  } catch {
    try {
      await execAsync(`git branch -D "${branch}"`, {
        cwd,
        timeout: 30_000,
      });
    } catch {
      // Best-effort cleanup — branch may already be gone.
    }
  }
}

async function finalizePullRequestMerge(
  store: TaskStore,
  cwd: string,
  task: TaskDetail,
  prInfo: PrInfo,
  message = "Pull request merged",
): Promise<void> {
  await cleanupMergedTaskArtifacts(cwd, task);
  await store.updateTask(task.id, { status: null, mergeRetries: 0 });
  await store.moveTask(task.id, "done");
  await store.logEntry(task.id, message, `PR #${prInfo.number}: ${prInfo.url}`);
}

/**
 * Result of processing a PR merge task.
 * - "waiting": PR exists but not ready to merge (checks pending, reviews needed)
 * - "merged": Successfully merged and cleaned up
 * - "skipped": Task is blocked and cannot be merged
 */
export type ProcessPullRequestResult = "waiting" | "merged" | "skipped";

/**
 * Type for the task merge blocker function from @fusion/core.
 * Accepts a task object and returns a reason string if blocked, or undefined if not blocked.
 */
type TaskMergeBlockerFn = (task: TaskDetail) => string | undefined;

/**
 * Process a single task through the PR merge workflow.
 *
 * Flow:
 * 1. Check if task can be merged (via getTaskMergeBlocker from @fusion/core)
 * 2. Create or link existing PR if none exists
 * 3. Check PR merge readiness (checks, reviews)
 * 4. Merge if ready, otherwise wait
 * 5. Clean up worktree/branch artifacts on success
 *
 * Status transitions during processing:
 * - "creating-pr" → when creating a new PR
 * - "awaiting-pr-checks" → when checks/reviews are blocking
 * - "merging-pr" → when initiating the merge
 *
 * On success:
 * - Moves task to "done"
 * - Clears status and mergeRetries
 * - Logs merge completion
 */
export async function processPullRequestMergeTask(
  store: TaskStore,
  cwd: string,
  taskId: string,
  github: GitHubOperations,
  getTaskMergeBlocker: TaskMergeBlockerFn,
): Promise<ProcessPullRequestResult> {
  const task = await store.getTask(taskId);
  if (getTaskMergeBlocker(task)) {
    return "skipped";
  }

  const branch = getTaskBranchName(task.id);
  const settings = await store.getSettings();
  const projectDefaultBranch = typeof settings.baseBranch === "string" ? settings.baseBranch : undefined;
  const mergeTarget = resolveTaskMergeTarget(task, {
    projectDefaultBranch,
  });
  let prInfo: PrInfo | undefined = task.prInfo;

  if (!prInfo) {
    await store.updateTask(task.id, { status: "creating-pr" });

    const existingPr = await github.findPrForBranch({ head: branch, state: "all" });
    if (!existingPr) {
      // gh pr create / GitHub REST require the head branch to exist on
      // origin. Nothing else in the merge path publishes the per-task
      // branch, so we push it here right before creating the PR.
      await pushTaskBranchToOrigin(cwd, branch);
    }
    try {
      prInfo = existingPr ?? await github.createPr({
        title: buildPullRequestTitle(task),
        body: buildPullRequestBody(task),
        head: branch,
        base: mergeTarget.branch,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("No commits between")) {
        const error = `No pull request created for ${branch}: the branch has no commits relative to the base branch.`;
        await store.updateTask(task.id, { status: "failed", error });
        await store.logEntry(task.id, error, message);
        return "skipped";
      }
      throw err;
    }

    await store.updatePrInfo(task.id, prInfo);
    await store.logEntry(
      task.id,
      existingPr ? "Linked existing PR" : "Created PR",
      `PR #${prInfo.number}: ${prInfo.url}`,
    );
  }

  if (!prInfo) {
    throw new Error(`Failed to create or resolve pull request for ${task.id}`);
  }

  const mergeStatus = await github.getPrMergeStatus(mergeTarget.branch, branch, prInfo.number);
  const refreshedPrInfo: PrInfo = {
    ...prInfo,
    ...mergeStatus.prInfo,
    lastCheckedAt: new Date().toISOString(),
  };
  await store.updatePrInfo(task.id, refreshedPrInfo);

  if (mergeStatus.prInfo.status === "merged") {
    await finalizePullRequestMerge(store, cwd, task, prInfo);
    return "merged";
  }

  // Optional approval gate. GitHub's `required: true` flag for checks only
  // flows from branch protection (Pro feature on private repos), so on free
  // private repos every fresh PR is "merge ready" and would auto-squash
  // immediately. `requirePrApproval` lets users keep PR mode as "open the
  // PR, wait for me to approve and merge it" by holding the merge until
  // reviewDecision === "APPROVED".
  if (settings.requirePrApproval && mergeStatus.reviewDecision !== "APPROVED") {
    await store.updateTask(task.id, { status: "awaiting-pr-checks" });
    return "waiting";
  }

  if (!mergeStatus.mergeReady) {
    if (mergeStatus.prInfo.status === "open") {
      await store.updateTask(task.id, { status: "awaiting-pr-checks" });
    } else {
      await store.updateTask(task.id, { status: null });
    }
    return "waiting";
  }

  // Cross-process safety net: abort if another task is already mid-merge.
  const activeMerge = store.getActiveMergingTask(task.id);
  if (activeMerge) {
    await store.updateTask(task.id, { status: "awaiting-pr-checks" });
    return "waiting";
  }
  await store.updateTask(task.id, { status: "merging-pr" });
  let mergedPr: PrInfo;
  try {
    mergedPr = await github.mergePr({ number: prInfo.number, method: "squash" });
  } catch (err: unknown) {
    let refreshedStatus: Awaited<ReturnType<GitHubOperations["getPrMergeStatus"]>>;
    try {
      refreshedStatus = await github.getPrMergeStatus(mergeTarget.branch, branch, prInfo.number);
    } catch {
      throw err;
    }
    const refreshedAfterFailure: PrInfo = {
      ...prInfo,
      ...refreshedStatus.prInfo,
      lastCheckedAt: new Date().toISOString(),
    };
    await store.updatePrInfo(task.id, refreshedAfterFailure);

    if (refreshedAfterFailure.status === "merged") {
      await finalizePullRequestMerge(
        store,
        cwd,
        task,
        refreshedAfterFailure,
        "Pull request already merged after merge command failed; reconciled task state from GitHub",
      );
      return "merged";
    }

    throw err;
  }
  await store.updatePrInfo(task.id, { ...mergedPr, lastCheckedAt: new Date().toISOString() });
  await finalizePullRequestMerge(store, cwd, task, mergedPr);
  return "merged";
}
