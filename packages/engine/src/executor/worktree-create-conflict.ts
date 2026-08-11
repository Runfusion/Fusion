/**
 * FNXC:CodeOrganization 2026-08-03-15:10:
 * tryCreateWorktree + handleWorktreeConflict peeled from TaskExecutor (U4 Slice B).
 * Circular call graph is expressed via deps callbacks (thin class facades wire them).
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Settings } from "@fusion/core";
import { installTaskWorktreeIdentityGuard } from "../worktree/worktree-hooks.js";
import { isInsideWorktreesDir } from "../worktree/worktree-pool.js";
import { inspectBranchConflict } from "../execution/branch-conflicts.js";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { executorLog } from "../logger.js";
import { extractWorktreeConflictInfo } from "./worktree-conflict-info.js";
import { assertWorktreePathNotNested, isRegisteredWorktree, NonRetryableWorktreeError } from "./worktree-registry-helpers.js";

const execAsync = promisify(exec);

export type WorktreeCreateConflictDeps = {
  rootDir: string;
  store: {
    logEntry: (taskId: string, action: string, outcome?: string) => Promise<unknown>;
  };
  maxWorktreeRetries: number;
  recoverIndexLockIfStale: (taskId: string, path: string, conflictInfo: { lockPath?: string; message?: string }) => Promise<boolean>;
  recoverStaleRegistration: (taskId: string, path: string, conflictInfo: { path?: string; message?: string }) => Promise<boolean>;
  cleanupStaleBranch: (branch: string, taskId: string) => Promise<boolean>;
  handleWorktreeConflict: (
    conflictPath: string,
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    attemptNumber?: number,
    allowSiblingBranchRename?: boolean,
    settings?: Partial<Settings>,
  ) => Promise<{ path: string; branch: string } | null>;
  tryCreateWorktree: (
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    attemptNumber?: number,
    recoveryDepth?: number,
    allowSiblingBranchRename?: boolean,
    settings?: Partial<Settings>,
  ) => Promise<{ path: string; branch: string }>;
  tryFreshWorktreeAfterLiveConflict: (input: {
    conflictPath: string;
    branch: string;
    taskId: string;
    startPoint?: string;
    attemptNumber?: number;
    allowSiblingBranchRename: boolean;
    settings: Partial<Settings>;
  }) => Promise<{ path: string; branch: string }>;
  shouldGenerateNewWorktreeName: (conflictPath: string, currentTaskId: string) => Promise<boolean>;
  cleanupConflictingWorktree: (worktreePath: string, branch: string, taskId: string) => Promise<boolean>;
  normalizeReclaimableWorktreePath: (
    sourcePath: string,
    targetPath: string,
    taskId: string,
    settings: Partial<Settings>,
  ) => Promise<string>;
  isLiveCleanupRefusal: (worktreePath: string, taskId: string) => Promise<boolean>;
};

export async function tryCreateWorktree(
  deps: WorktreeCreateConflictDeps,
  branch: string,
  path: string,
  taskId: string,
  startPoint?: string,
  attemptNumber = 0,
  recoveryDepth = 0,
  allowSiblingBranchRename = false,
  settings: Partial<Settings> = {},
): Promise<{ path: string; branch: string }> {
  // Guard: refuse to create a worktree nested inside another worktree.
  // Nested worktrees happen when the executor is launched with rootDir pointed
  // at a worktree directory instead of the main repo — produces paths like
  // `.worktrees/green-finch/.worktrees/amber-panda` that bloat the filesystem
  // and confuse every tool that walks git state.
  await assertWorktreePathNotNested(deps.rootDir, deps.store, path, taskId);

  const installGuardOrCleanup = async () => {
    try {
      await installTaskWorktreeIdentityGuard({
        worktreePath: path,
        taskId,
        commitMsgHookEnabled: settings.commitMsgHookEnabled,
        taskPrefix: settings.taskPrefix,
        taskAttributionTrailerName: settings.taskAttributionTrailerNames?.[0],
        commitAuthorEnabled: settings.commitAuthorEnabled,
        commitAuthorName: settings.commitAuthorName,
        commitAuthorEmail: settings.commitAuthorEmail,
      });
    } catch (error) {
      try {
        await rm(path, { recursive: true, force: true });
      } catch {
        executorLog.log(`Warning: failed to remove worktree after identity-guard install failure: ${path}`);
      }
      throw error;
    }
  };

  // If directory exists but is not a registered worktree, remove it first
  if (existsSync(path)) {
    const isRegistered = await isRegisteredWorktree(deps.rootDir, path);
    if (!isRegistered) {
      await deps.store.logEntry(
        taskId,
        `Removing existing directory (not a registered worktree): ${path}`,
      );
      try {
        await rm(path, { recursive: true, force: true });
      } catch (e: unknown) {
        const eMessage = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to remove existing directory ${path}: ${eMessage}`);
      }
    } else {
      executorLog.debug(`Worktree already exists: ${path}`);
      await installGuardOrCleanup();
      return { path, branch };
    }
  }

  const createWithBranch = async (branchToCreate: string) => {
    const cmd = startPoint
      ? `git worktree add -b "${branchToCreate}" "${path}" "${startPoint}"`
      : `git worktree add -b "${branchToCreate}" "${path}"`;
    try {
      await execAsync(cmd, { cwd: deps.rootDir });
    } catch (err) {
      // Remove any partial directory left behind so the invariant holds:
      // "if .worktrees/<slug> exists on disk, it is a fully registered git worktree."
      try {
        await rm(path, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; log but don't mask the original error
        executorLog.log(`Warning: failed to remove partial worktree directory after creation failure: ${path}`);
      }
      throw err;
    }
  };

  const createFromExistingBranch = async () => {
    try {
      await execAsync(`git worktree add "${path}" "${branch}"`, { cwd: deps.rootDir });
    } catch (err) {
      // Remove any partial directory left behind so the invariant holds:
      // "if .worktrees/<slug> exists on disk, it is a fully registered git worktree."
      try {
        await rm(path, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; log but don't mask the original error
        executorLog.log(`Warning: failed to remove partial worktree directory after creation failure: ${path}`);
      }
      throw err;
    }
  };

  let staleLockRecoveryAttempted = false;
  let staleRegistrationRecoveryAttempted = false;
  try {
    await createWithBranch(branch);
    executorLog.log(`Worktree created: ${path}${startPoint ? ` (from ${startPoint})` : ""}`);
    if (attemptNumber > 0) {
      await deps.store.logEntry(taskId, `Worktree created on attempt ${attemptNumber + 1}`, path);
    }
    await installGuardOrCleanup();
    return { path, branch };
  } catch (initialError: unknown) {
    const conflictInfo = extractWorktreeConflictInfo(initialError);

    if (conflictInfo.type === "index-lock-contention" && !staleLockRecoveryAttempted) {
      staleLockRecoveryAttempted = true;
      const recovered = await deps.recoverIndexLockIfStale(taskId, path, conflictInfo);
      if (recovered) {
        await createWithBranch(branch);
        executorLog.log(`Worktree created after stale lock recovery: ${path}`);
        await installGuardOrCleanup();
        return { path, branch };
      }
    }

    if (conflictInfo.type === "stale-registration" && !staleRegistrationRecoveryAttempted) {
      staleRegistrationRecoveryAttempted = true;
      const recovered = await deps.recoverStaleRegistration(taskId, path, conflictInfo);
      if (recovered) {
        await createWithBranch(branch);
        executorLog.log(`Worktree created after stale registration recovery: ${path}`);
        await installGuardOrCleanup();
        return { path, branch };
      }
    }

    if (conflictInfo.type === "not-git-repo") {
      throw new NonRetryableWorktreeError(
        "Project directory is not a Git repository. Fusion requires a Git repository for worktree creation. Initialize with 'git init' or run from a Git project directory.",
      );
    }

    // Handle "already used by worktree" conflict
    if (conflictInfo.type === "already-used" && conflictInfo.path) {
      const result = await deps.handleWorktreeConflict(
        conflictInfo.path,
        branch,
        path,
        taskId,
        startPoint,
        attemptNumber,
        allowSiblingBranchRename,
        settings,
      );
      if (result) {
        return result;
      }
      throw new Error(
        `Worktree conflict at ${conflictInfo.path}: automatic cleanup failed`,
      );
    }

    // Handle "invalid reference" - stale branch that doesn't exist
    if (conflictInfo.type === "invalid-reference") {
      if (recoveryDepth >= deps.maxWorktreeRetries - 1) {
        throw new NonRetryableWorktreeError(
          `Stale branch reference for ${branch} remained invalid after ${deps.maxWorktreeRetries} cleanup attempts`,
        );
      }
      const branchCleaned = await deps.cleanupStaleBranch(branch, taskId);
      if (branchCleaned) {
        await deps.store.logEntry(taskId, `Removed stale branch reference, retrying`);
        return deps.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber, recoveryDepth + 1, allowSiblingBranchRename, settings);
      }
      throw new Error(
        `Invalid reference for branch ${branch}: unable to clean up stale reference`,
      );
    }

    // Handle "could not create leading directories" - permission/path issues
    if (conflictInfo.type === "leading-directories") {
      throw new Error(
        `Cannot create worktree at ${path}: permission or path issue. ` +
        `Check that parent directories are writable.`,
      );
    }

    // Try creating from existing branch (branch might already exist)
    try {
      await createFromExistingBranch();
      executorLog.log(`Worktree created from existing branch: ${path}`);
      await installGuardOrCleanup();
      return { path, branch };
    } catch (fallbackError: unknown) {
      const fallbackErrorMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      // Check if the fallback also hit an "already used" conflict
      const fallbackConflictInfo = extractWorktreeConflictInfo(fallbackError);
      if (fallbackConflictInfo.type === "index-lock-contention" && !staleLockRecoveryAttempted) {
        staleLockRecoveryAttempted = true;
        const recovered = await deps.recoverIndexLockIfStale(taskId, path, fallbackConflictInfo);
        if (recovered) {
          await createFromExistingBranch();
          executorLog.log(`Worktree created from existing branch after stale lock recovery: ${path}`);
          await installGuardOrCleanup();
          return { path, branch };
        }
      }

      if (fallbackConflictInfo.type === "stale-registration" && !staleRegistrationRecoveryAttempted) {
        staleRegistrationRecoveryAttempted = true;
        const recovered = await deps.recoverStaleRegistration(taskId, path, fallbackConflictInfo);
        if (recovered) {
          await createFromExistingBranch();
          executorLog.log(`Worktree created from existing branch after stale registration recovery: ${path}`);
          await installGuardOrCleanup();
          return { path, branch };
        }
      }

      if (fallbackConflictInfo.type === "not-git-repo") {
        throw new NonRetryableWorktreeError(
          "Project directory is not a Git repository. Fusion requires a Git repository for worktree creation. Initialize with 'git init' or run from a Git project directory.",
        );
      }

      if (fallbackConflictInfo.type === "already-used" && fallbackConflictInfo.path) {
        const result = await deps.handleWorktreeConflict(
          fallbackConflictInfo.path,
          branch,
          path,
          taskId,
          startPoint,
          attemptNumber,
          allowSiblingBranchRename,
          settings,
        );
        if (result) {
          return result;
        }
        throw new Error(
          `Worktree conflict at ${fallbackConflictInfo.path}: automatic cleanup failed`,
        );
      }

      // Handle stale reference in fallback path too
      if (fallbackConflictInfo.type === "invalid-reference") {
        if (recoveryDepth >= deps.maxWorktreeRetries - 1) {
          throw new NonRetryableWorktreeError(
            `Stale branch reference for ${branch} remained invalid after ${deps.maxWorktreeRetries} cleanup attempts`,
          );
        }
        const branchCleaned = await deps.cleanupStaleBranch(branch, taskId);
        if (branchCleaned) {
          await deps.store.logEntry(taskId, `Cleaned up stale reference in fallback, retrying`);
          return deps.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber, recoveryDepth + 1, allowSiblingBranchRename, settings);
        }
      }

      throw new Error(`Failed to create worktree: ${fallbackErrorMessage}`);
    }
  }
}

/**
 * Handle "already used by worktree" conflict.
 * Either generates a new worktree name (if conflicting worktree is in use by active task)
 * or cleans up the conflicting worktree and retries.
 *
 * @returns The worktree path if recovery succeeded, null if recovery failed
 */
export async function handleWorktreeConflict(
  deps: WorktreeCreateConflictDeps,
  conflictPath: string,
  branch: string,
  path: string,
  taskId: string,
  startPoint?: string,
  attemptNumber?: number,
  allowSiblingBranchRename = false,
  settings: Partial<Settings> = {},
): Promise<{ path: string; branch: string } | null> {
  const tryFreshFallback = () => deps.tryFreshWorktreeAfterLiveConflict({
    conflictPath,
    branch,
    taskId,
    startPoint,
    attemptNumber,
    allowSiblingBranchRename,
    settings,
  });
  const shouldGenerateNewName = await deps.shouldGenerateNewWorktreeName(
    conflictPath,
    taskId,
  );

  /*
   * FNXC:ExecutorWorktree 2026-07-18-17:20:
   * Inspect every branch/worktree collision before cleanup, including inactive
   * same-task bindings. The old inactive path skipped inspection and called
   * cleanupConflictingWorktree directly, which force-deleted a branch carrying
   * completed task commits during workflow-node recovery. Liveness determines
   * whether a sibling checkout is needed; it must never determine whether task
   * history is disposable.
   */
  const inspection = await inspectBranchConflict({
    repoDir: deps.rootDir,
    branchName: branch,
    conflictingWorktreePath: conflictPath,
    requestingTaskId: taskId,
    ownerTaskId: taskId,
    startPoint,
    integrationRef: await resolveIntegrationBranch(deps.rootDir, settings),
  });

  if (inspection.kind === "reclaimable") {
    const livePath = isInsideWorktreesDir(deps.rootDir, inspection.livePath, settings)
      ? inspection.livePath
      : await deps.normalizeReclaimableWorktreePath(inspection.livePath, path, taskId, settings);
    await deps.store.logEntry(
      taskId,
      `[recovery] reclaimed existing worktree for ${taskId} at ${livePath} (${inspection.taskAttributedCommitCount} commits preserved)`,
      inspection.tipSha,
    );
    return { path: livePath, branch };
  }

  if (inspection.kind === "fully-subsumed") {
    const livePath = isInsideWorktreesDir(deps.rootDir, inspection.livePath, settings)
      ? inspection.livePath
      : await deps.normalizeReclaimableWorktreePath(inspection.livePath, path, taskId, settings);
    await deps.store.logEntry(
      taskId,
      `[recovery] reclaimed existing worktree for ${taskId} at ${livePath} (0 commits preserved)`,
      inspection.tipSha,
    );
    return { path: livePath, branch };
  }

  if (shouldGenerateNewName) {
    if (inspection.kind === "stale" || inspection.kind === "stale-resolved" || inspection.kind === "tip-already-merged") {
      const cleanupSuccess = await deps.cleanupConflictingWorktree(conflictPath, branch, taskId);
      if (cleanupSuccess) {
        await deps.store.logEntry(taskId, `Cleaned up conflicting worktree, retrying`, path);
        return deps.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber, 0, allowSiblingBranchRename, settings);
      }
      // FN-4811: When git classifies a worktree as stale but the DB liveness gate refuses
      // removal (an active task still has this worktree bound), fall through to the
      // sibling-rename path rather than failing the whole conflict-recovery attempt. This
      // preserves the live task while letting the requesting task proceed with a fresh
      // worktree name.
    }

    if (inspection.kind === "live-foreign") {
      const cleanupSuccess = await deps.cleanupConflictingWorktree(inspection.livePath, branch, taskId);
      if (cleanupSuccess) {
        await deps.store.logEntry(taskId, `Removed foreign conflicting worktree and retrying`, inspection.livePath);
        return deps.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber, 0, allowSiblingBranchRename, settings);
      }
      // FN-4811: Cleanup was refused because the foreign worktree is actively bound to a
      // live session. Force-removing would yank an active task's filesystem. Fall through
      // to the sibling-rename path (suffix-2 through suffix-6) so the requesting task can
      // proceed without disturbing the live owner. If sibling-rename is disabled, the
      // generic conflict error below will trigger the caller's auto-recovery dispatcher.
    }

    if (!allowSiblingBranchRename) {
      throw new Error(`Branch ${branch} conflict could not be auto-resolved`);
    }

    return tryFreshFallback();
  }

  const cleanupSuccess = await deps.cleanupConflictingWorktree(conflictPath, branch, taskId);
  if (cleanupSuccess) {
    await deps.store.logEntry(taskId, `Cleaned up conflicting worktree, retrying`, path);
    return deps.tryCreateWorktree(branch, path, taskId, startPoint, attemptNumber, 0, allowSiblingBranchRename, settings);
  }

  if (await deps.isLiveCleanupRefusal(conflictPath, taskId)) {
    return tryFreshFallback();
  }

  return null;
}

