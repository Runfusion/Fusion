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
import * as childProcess from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
// `execFile` is resolved lazily through the namespace import so test mocks that
// only stub `exec`/`execSync` (the repo's established node:child_process mock
// convention) can still load this module; `execFile` is only required when a
// code path actually shells out.
const execFileAsync: (file: string, args: string[], opts?: import("node:child_process").ExecFileOptions) => Promise<{ stdout: string; stderr: string }> = (file, args, opts) =>
  (promisify(childProcess.execFile) as (f: string, a: string[], o?: object) => Promise<{ stdout: string; stderr: string }>)(file, args, opts);
import type { TaskStore } from "@fusion/core";
import { resolveTaskMergeTarget, getCurrentRepo, isBranchGroupMemberLanded } from "@fusion/core";
import type { Settings, TaskDetail, PrInfo, MergeResult, BranchGroup, BranchGroupPrState, Task } from "@fusion/core";
import { activeSessionRegistry, resolveIntegrationBranch } from "@fusion/engine";
import type { CreateGroupPrFn, SyncGroupPrFn, WorktreePool } from "@fusion/engine";

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
  getPrStatus(owner: string, repo: string, number: number): Promise<PrInfo>;
  updatePr(params: { owner?: string; repo?: string; number: number; title?: string; body?: string }): Promise<PrInfo>;
  closePr(params: { number: number }): Promise<PrInfo>;
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

async function gitCommandSucceeds(
  cwd: string,
  file: string,
  args: string[],
  missingExitCode: number,
): Promise<boolean> {
  try {
    // No-shell invocation (Fix #11): pass git args as discrete argv entries so a
    // crafted branch name (e.g. `$(...)`) can never trigger shell interpretation.
    await execFileAsync(file, args, { cwd, timeout: 30_000 });
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
    "git",
    ["show-ref", "--verify", "--quiet", localRef],
    1,
  );

  if (!localBranchExists) {
    const remoteBranchExists = await gitCommandSucceeds(
      cwd,
      "git",
      ["ls-remote", "--exit-code", "--heads", "origin", branch],
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
    // No-shell invocation (Fix #11): pass the branch as a discrete argv entry so a
    // crafted branch name (e.g. `$(...)`) cannot be interpreted by a shell.
    await execFileAsync("git", ["push", "-u", "origin", branch], {
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

function buildGroupPullRequestTitle(group: Pick<BranchGroup, "id" | "sourceType" | "sourceId">, members: Task[]): string {
  return `${group.id}: ${group.sourceType}/${group.sourceId} (${members.length} tasks)`;
}

/**
 * Build the body for a single managed group PR. With `checklist: true` (sync
 * path, U6/R6) each member line gets an [x]/[ ] landed marker and an x/N
 * "Completion" summary line is added; without it (initial create path) members
 * are listed as plain bullets. Both variants share the same header/skeleton.
 */
function buildGroupPullRequestBody(
  group: Pick<BranchGroup, "id" | "branchName" | "sourceType" | "sourceId">,
  members: Array<Pick<Task, "id" | "title"> & { branchName: string }>,
  options?: { checklist?: boolean; landed?: (member: Pick<Task, "id" | "title"> & { branchName: string }) => boolean },
): string {
  const checklist = options?.checklist ?? false;
  const isLanded = options?.landed ?? (() => false);
  const lines = members.map((member) => {
    const title = member.title || "(untitled)";
    if (checklist) {
      return `- [${isLanded(member) ? "x" : " "}] ${member.id}: ${title} — \`${member.branchName}\``;
    }
    return `- ${member.id}: ${title} — \`${member.branchName}\``;
  });
  const header = [
    `Automated group PR for ${group.id}.`,
    `Source: ${group.sourceType}/${group.sourceId}`,
    `Integration branch: \`${group.branchName}\``,
  ];
  if (checklist) {
    const landedCount = members.filter((member) => isLanded(member)).length;
    header.push(`Completion: ${landedCount}/${members.length} landed`);
  }
  return [
    ...header,
    "",
    "Included tasks:",
    ...(lines.length > 0 ? lines : ["- (none)"]),
  ].join("\n");
}

function toBranchGroupPrState(prInfo: PrInfo | null): BranchGroupPrState {
  if (!prInfo) return "none";
  if (prInfo.status === "merged") return "merged";
  if (prInfo.status === "closed") return "closed";
  return "open";
}

/**
 * Build the `createGroupPr` engine callback (KTD7) used by the branch-group
 * promotion coordinator. Closes over a GitHub client so the engine never imports
 * the dashboard client directly. Pushes the group integration branch to origin
 * (so `gh pr create --head` / the REST API can find it), then creates or reuses
 * the single managed PR for the group.
 *
 * Idempotency: reuses an existing PR for the group head branch on GitHub. The
 * coordinator additionally skips this call when a `prNumber` is already persisted,
 * so a re-promotion never opens a second PR.
 */
export function createGroupPrCallback(
  github: Pick<GitHubOperations, "findPrForBranch" | "createPr">,
): CreateGroupPrFn {
  return async ({ cwd, group, members, headBranch, baseBranch }) => {
    const existing = await github.findPrForBranch({ head: headBranch, state: "open" });
    if (existing) {
      return { prNumber: existing.number, prUrl: existing.url, prState: toBranchGroupPrState(existing) };
    }

    await pushTaskBranchToOrigin(cwd, headBranch);
    const membersWithBranch = members.map((member) => ({
      id: member.id,
      title: member.title,
      branchName: getTaskBranchName(member.id),
    }));
    const created = await github.createPr({
      title: buildGroupPullRequestTitle(group, members),
      body: buildGroupPullRequestBody(group, membersWithBranch),
      head: headBranch,
      base: baseBranch,
    });
    return { prNumber: created.number, prUrl: created.url, prState: toBranchGroupPrState(created) };
  };
}

/**
 * Build a completion-aware group PR body: a member checklist marking each task
 * landed/unlanded, plus an x/N completion summary (U6, R6). Rewritten in full on
 * every sync, so repeated pushes are idempotent and coalesce naturally.
 */
function buildGroupPrSyncBody(group: BranchGroup, members: Task[]): string {
  const membersWithBranch = members.map((member) => ({
    id: member.id,
    title: member.title,
    branchName: getTaskBranchName(member.id),
  }));
  const landedById = new Map(members.map((member) => [member.id, isBranchGroupMemberLanded(member, group)]));
  return buildGroupPullRequestBody(group, membersWithBranch, {
    checklist: true,
    landed: (member) => landedById.get(member.id) ?? false,
  });
}

/**
 * Build the `syncGroupPr` engine callback (KTD7, U6). Pushes an updated body
 * (member checklist + x/N completion) onto the single managed group PR as
 * members land. Closes over a GitHub client so the engine never imports the
 * dashboard client.
 *
 * Out-of-band reconciliation: reads the PR's current state first; if it is no
 * longer open (closed/merged on GitHub), returns the reconciled prState rather
 * than editing or re-opening it, so the caller can persist the corrected state.
 *
 * Repo identity is resolved from the per-project `cwd` passed in the callback
 * input (not the process cwd), so multi-project daemons target the right repo.
 */
export function syncGroupPrCallback(
  github: Pick<GitHubOperations, "getPrStatus" | "updatePr">,
): SyncGroupPrFn {
  return async ({ cwd, group, members }) => {
    if (group.prNumber == null) {
      throw new Error(`syncGroupPr: group ${group.id} has no persisted prNumber`);
    }
    // T4: resolve the repo from the PROJECT cwd, not the process cwd. In a
    // multi-project daemon the process cwd is not the project dir, so
    // `getCurrentRepo()` (no arg) would resolve the wrong repository.
    const repo = getCurrentRepo(cwd);
    if (!repo) {
      throw new Error("syncGroupPr: could not determine repository");
    }
    const current = await github.getPrStatus(repo.owner, repo.repo, group.prNumber);
    const currentState = toBranchGroupPrState(current);
    if (currentState !== "open") {
      return { prNumber: current.number, prUrl: current.url, prState: currentState };
    }
    const updated = await github.updatePr({
      owner: repo.owner,
      repo: repo.repo,
      number: group.prNumber,
      title: buildGroupPullRequestTitle(group, members),
      body: buildGroupPrSyncBody(group, members),
    });
    return { prNumber: updated.number, prUrl: updated.url, prState: toBranchGroupPrState(updated) };
  };
}

async function hasCommitsRelativeToBranch(cwd: string, branch: string, baseBranch: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`git rev-list --count "${baseBranch}..${branch}"`, { cwd, timeout: 30_000 });
    return Number.parseInt(stdout.trim(), 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Clean up worktree and branch artifacts after a successful merge.
 * Both operations are best-effort; errors are logged but don't propagate.
 */
/**
 * @param options.pool Optional runtime worktree pool; FN-5455/FN-4954 require best-effort
 * release before force-removing merged PR worktrees.
 */
export async function cleanupMergedTaskArtifacts(
  cwd: string,
  task: Pick<TaskDetail, "id" | "worktree">,
  options?: { pool?: WorktreePool },
): Promise<void> {
  const branch = getTaskBranchName(task.id);

  if (task.worktree) {
    if (options?.pool) {
      try {
        options.pool.release(task.worktree, task.id);
      } catch {
        // Best-effort cleanup — release may fail if pool state is already divergent.
      }
    }

    try {
      activeSessionRegistry.unregisterPath(task.worktree);
    } catch {
      // Best-effort cleanup — registry entry may already be absent or registry state divergent.
    }

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
  pool?: WorktreePool,
): Promise<void> {
  await cleanupMergedTaskArtifacts(cwd, task, { pool });
  await store.updateTask(task.id, { status: null, mergeRetries: 0 });
  const movedTask = await store.moveTask(task.id, "done");
  const mergedTask = movedTask ?? (await store.getTask(task.id));
  await store.logEntry(task.id, message, `PR #${prInfo.number}: ${prInfo.url}`);
  const settings = await store.getSettings();
  const resolvedIntegrationBranch = await resolveIntegrationBranch(cwd, settings);
  const mergeTargetBranch = resolveTaskMergeTarget(mergedTask, {
    projectDefaultBranch: resolvedIntegrationBranch,
  });
  store.emit("task:merged", {
    task: mergedTask,
    branch: mergedTask.branch ?? getTaskBranchName(task.id),
    merged: true,
    worktreeRemoved: false,
    branchDeleted: false,
    mergeConfirmed: mergedTask.mergeDetails?.mergeConfirmed ?? true,
    mergedAt: mergedTask.mergeDetails?.mergedAt,
    mergeTargetBranch: mergeTargetBranch.branch,
  } as MergeResult);
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
  pool?: WorktreePool,
): Promise<ProcessPullRequestResult> {
  const task = await store.getTask(taskId);
  if (getTaskMergeBlocker(task)) {
    return "skipped";
  }

  const branch = getTaskBranchName(task.id);
  const settings = await store.getSettings();
  const resolvedIntegrationBranch = await resolveIntegrationBranch(cwd, settings);
  const projectDefaultBranch = resolvedIntegrationBranch;

  // FN-5782 contract: shared group members promote via branch_groups.branchName
  // integration branch, while non-shared tasks keep per-task PR behavior.
  const isSharedBranchGroupMember = task.branchContext?.assignmentMode === "shared";
  const sharedGroupId = task.branchContext?.groupId;
  const branchGroup =
    isSharedBranchGroupMember && sharedGroupId
      ? store.getBranchGroup(sharedGroupId)
      : null;

  if (isSharedBranchGroupMember && branchGroup) {
    const members = await store.listTasksByBranchGroup(branchGroup.id);
    const membersWithCommits: Array<Pick<Task, "id" | "title"> & { branchName: string }> = [];
    for (const member of members) {
      const memberBranch = getTaskBranchName(member.id);
      const hasCommits = await hasCommitsRelativeToBranch(cwd, memberBranch, branchGroup.branchName);
      if (hasCommits || member.id === task.id) {
        membersWithCommits.push({ id: member.id, title: member.title, branchName: memberBranch });
      }
    }

    await store.updateTask(task.id, { status: "creating-pr" });
    let groupPrInfo: PrInfo | null = null;
    if (branchGroup.prNumber) {
      groupPrInfo = {
        number: branchGroup.prNumber,
        url: branchGroup.prUrl ?? "",
        status: branchGroup.prState === "merged" ? "merged" : branchGroup.prState === "closed" ? "closed" : "open",
        title: buildGroupPullRequestTitle(branchGroup, members),
        headBranch: branchGroup.branchName,
        baseBranch: projectDefaultBranch,
        commentCount: 0,
      };
    } else {
      // RB#2: only relink an OPEN PR as the live group PR. A closed/merged
      // terminal PR for this head branch must NOT be reattached (that reintroduces
      // the terminal-PR reuse bug createGroupPrCallback fixed); treat it as
      // not-found and fall through to push + createPr for a fresh open PR.
      groupPrInfo = await github.findPrForBranch({ head: branchGroup.branchName, state: "open" });
      if (!groupPrInfo) {
        await pushTaskBranchToOrigin(cwd, branchGroup.branchName);
        try {
          groupPrInfo = await github.createPr({
            title: buildGroupPullRequestTitle(branchGroup, members),
            body: buildGroupPullRequestBody(branchGroup, membersWithCommits),
            head: branchGroup.branchName,
            base: projectDefaultBranch,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("No commits between")) {
            await store.updateBranchGroup(branchGroup.id, { prState: "none", prNumber: null, prUrl: null });
            await store.updateTask(task.id, { status: "failed", error: `No pull request created for ${branchGroup.branchName}: no commits relative to ${projectDefaultBranch}.` });
            await store.logEntry(task.id, "No group pull request created", message);
            return "skipped";
          }
          throw err;
        }
        await store.logEntry(task.id, "Created group PR", `PR #${groupPrInfo.number}: ${groupPrInfo.url}`);
      } else {
        await store.logEntry(task.id, "Linked existing group PR", `PR #${groupPrInfo.number}: ${groupPrInfo.url}`);
      }
    }

    if (!groupPrInfo) {
      throw new Error(`Failed to create or resolve pull request for branch group ${branchGroup.id}`);
    }

    await store.updateBranchGroup(branchGroup.id, {
      prNumber: groupPrInfo.number,
      prUrl: groupPrInfo.url,
      prState: toBranchGroupPrState(groupPrInfo),
    });

    const mergeStatus = await github.getPrMergeStatus(projectDefaultBranch, branchGroup.branchName, groupPrInfo.number);
    const refreshedPrInfo: PrInfo = {
      ...groupPrInfo,
      ...mergeStatus.prInfo,
      lastCheckedAt: new Date().toISOString(),
    };
    await store.updateBranchGroup(branchGroup.id, {
      prNumber: refreshedPrInfo.number,
      prUrl: refreshedPrInfo.url,
      prState: toBranchGroupPrState(refreshedPrInfo),
    });

    if (mergeStatus.prInfo.status === "merged") {
      for (const member of members) {
        const memberDetail = await store.getTask(member.id);
        await finalizePullRequestMerge(store, cwd, memberDetail, refreshedPrInfo, "Group pull request merged", pool);
      }
      await store.updateBranchGroup(branchGroup.id, { status: "finalized", prState: "merged" });
      return "merged";
    }

    if (settings.requirePrApproval && mergeStatus.reviewDecision !== "APPROVED") {
      await store.updateTask(task.id, { status: "awaiting-pr-checks" });
      return "waiting";
    }

    if (!mergeStatus.mergeReady) {
      await store.updateTask(task.id, { status: mergeStatus.prInfo.status === "open" ? "awaiting-pr-checks" : null });
      return "waiting";
    }

    const activeMerge = store.getActiveMergingTask(task.id);
    if (activeMerge) {
      await store.updateTask(task.id, { status: "awaiting-pr-checks" });
      return "waiting";
    }

    await store.updateTask(task.id, { status: "merging-pr" });
    const mergedPr = await github.mergePr({ number: refreshedPrInfo.number, method: "squash" });
    await store.updateBranchGroup(branchGroup.id, {
      prNumber: mergedPr.number,
      prUrl: mergedPr.url,
      prState: toBranchGroupPrState(mergedPr),
    });
    for (const member of members) {
      const memberDetail = await store.getTask(member.id);
      await finalizePullRequestMerge(store, cwd, memberDetail, mergedPr, "Group pull request merged", pool);
    }
    await store.updateBranchGroup(branchGroup.id, { status: "finalized", prState: "merged" });
    return "merged";
  }

  if (isSharedBranchGroupMember && !branchGroup) {
    await store.logEntry(task.id, "Branch group missing; falling back to per-task PR path", task.branchContext?.groupId);
  }

  const mergeTarget = resolveTaskMergeTarget(task, {
    projectDefaultBranch,
    branchGroup,
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
    await finalizePullRequestMerge(store, cwd, task, prInfo, "Pull request merged", pool);
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
        pool,
      );
      return "merged";
    }

    throw err;
  }
  await store.updatePrInfo(task.id, { ...mergedPr, lastCheckedAt: new Date().toISOString() });
  await finalizePullRequestMerge(store, cwd, task, mergedPr, "Pull request merged", pool);
  return "merged";
}
