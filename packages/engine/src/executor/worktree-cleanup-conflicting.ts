/**
 * FNXC:CodeOrganization 2026-08-03-15:10:
 * cleanupConflictingWorktree peeled from TaskExecutor (U4 Slice B).
 * Inject rootDir/store and ownership/remove callbacks.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Settings } from "@fusion/core";
import {
  isInsideWorktreesDir,
  isRegisteredGitWorktree,
  RemovalReason,
} from "../worktree/worktree-pool.js";
import { executorLog } from "../logger.js";

const execAsync = promisify(exec);

export type CleanupConflictingWorktreeDeps = {
  rootDir: string;
  store: {
    logEntry: (taskId: string, action: string, outcome?: string) => Promise<unknown>;
    getSettings: () => Promise<Settings>;
    clearStaleExecutionStartBranchReferences: (branches: string[], excludingTaskId?: string) => Promise<unknown>;
  };
  reconcileSelfOwnedBeforeRemove: (worktreePath: string, taskId: string) => Promise<void>;
  findActiveWorktreeOwner: (worktreePath: string, requestingTaskId: string) => Promise<string | null>;
  removeOwnWorktreeWithReconcile: (input: {
    worktreePath: string;
    settings: Settings;
    taskId: string;
    reason: RemovalReason;
  }) => Promise<void>;
};

export async function cleanupConflictingWorktree(
  deps: CleanupConflictingWorktreeDeps,
  worktreePath: string,
  branch: string,
  taskId: string,
): Promise<boolean> {
  await deps.reconcileSelfOwnedBeforeRemove(worktreePath, taskId);

  // FN-4811: Hard liveness gate — refuse to remove a worktree that is currently bound to
  // an active executor/merger session, regardless of git-level conflict classification.
  // This is the canonical guard against the FN-4781/FN-4804 race where a startup cleanup
  // pass or branch-conflict recovery yanked the worktree of a still-running session, causing
  // "assigned worktree path disappeared mid-task" + parallel-runs + cross-task contamination.
  const activeOwner = await deps.findActiveWorktreeOwner(worktreePath, taskId);
  if (activeOwner !== null) {
    const refusalMessage = `[FN-4811] Refused to remove worktree ${worktreePath}: actively owned by ${activeOwner} (requested by ${taskId})`;
    executorLog.warn(refusalMessage);
    await deps.store.logEntry(taskId, `Refused to remove conflicting worktree — actively owned by another task`, `${worktreePath} (owner: ${activeOwner})`);
    return false;
  }

  try {
    // Check if worktree is locked and unlock if needed
    try {
      await execAsync(`git worktree unlock "${worktreePath}"`, {
        cwd: deps.rootDir,
      });
      await deps.store.logEntry(taskId, `Unlocked worktree`, worktreePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${taskId}: failed to unlock conflicting worktree ${worktreePath} before cleanup: ${msg}`);
    }

    // Remove the worktree
    const settings = await deps.store.getSettings();
    await deps.removeOwnWorktreeWithReconcile({
      worktreePath,
      settings,
      taskId,
      reason: RemovalReason.ExecutorDispose,
    });
    await deps.store.logEntry(taskId, `Removed conflicting worktree`, worktreePath);

    // Delete the branch if it exists
    try {
      await execAsync(`git branch -D "${branch}"`, {
        cwd: deps.rootDir,
      });
      await deps.store.logEntry(taskId, `Deleted branch`, branch);
      // FN-2165 regression guard: null baseBranch on any task that stored this branch
      await deps.store.clearStaleExecutionStartBranchReferences([branch], taskId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${taskId}: failed to delete conflicting branch ${branch}: ${msg}`);
    }

    return true;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // FN-4811 follow-up (FN-4813): when `git worktree remove --force` fails because the
    // conflicting path isn't a recoverable git worktree, treat it as already-cleaned:
    // prune any stale admin entry, force-remove the leftover directory, best-effort delete
    // the branch, and return success so the caller can proceed with fresh worktree creation.
    // Without this recovery, every `tryCreateWorktree` retry on such a path fails with
    // "automatic cleanup failed".
    //
    // Three variants land here, all meaning "no live worktree to preserve at this path":
    //   1. `validation failed, cannot remove working tree` — stale admin entry, dir missing.
    //   2. `is not a working tree` — an orphan directory exists on disk but git never
    //      registered it (e.g. a leaked worktree dir that outlived its admin entry). This
    //      is the FN-6782 leak residue that collides with freshly generated worktree names.
    //   3. `No such file or directory` / ENOENT — the path is already gone.
    //
    // Exclude spawn failures (e.g. `spawn git ENOENT` when the git binary is missing or not
    // on PATH): those are environment errors, not "path is not a worktree" signals, and must
    // not be misread as a successful stale-path cleanup.
    const err = error as NodeJS.ErrnoException;
    const isSpawnFailure = typeof err?.syscall === "string" && err.syscall.startsWith("spawn");
    const staleConflictPath = !isSpawnFailure && (
      /validation failed, cannot remove working tree/i.test(errorMessage) ||
      /is not a working tree/i.test(errorMessage) ||
      /no such file or directory|ENOENT/i.test(errorMessage)
    );
    if (staleConflictPath) {
      // The error string alone is NOT authoritative — it can name an unrelated path, or fire
      // on a live worktree under a racing/transient failure. Re-verify on disk before any
      // destructive action and refuse to force-remove anything that is still a real worktree,
      // out of bounds, reached through a symlink, or actively owned by a live session. Only a
      // genuine orphan directory inside the configured worktrees tree is safe to delete.
      const settings = await deps.store.getSettings();
      const stillRegistered = await isRegisteredGitWorktree(deps.rootDir, worktreePath).catch(() => true);
      const activeOwner = await deps.findActiveWorktreeOwner(worktreePath, taskId).catch(() => "unknown");
      let safeToRemove = isInsideWorktreesDir(deps.rootDir, worktreePath, settings) && !stillRegistered && activeOwner === null;
      if (safeToRemove && existsSync(worktreePath)) {
        try {
          if (lstatSync(worktreePath).isSymbolicLink()) {
            safeToRemove = false;
          } else if (!isInsideWorktreesDir(deps.rootDir, realpathSync(worktreePath), settings)) {
            safeToRemove = false;
          }
        } catch {
          // Stat failed (path vanished mid-check) — nothing to remove; the prune/branch
          // cleanup below is still safe to run.
        }
      }
      if (!safeToRemove) {
        // A real/registered/out-of-bounds/owned/symlinked path we must not touch. Surface as a
        // cleanup failure so the operator-recovery path handles it instead of silently
        // claiming success (and never `rm -rf`-ing something we shouldn't).
        await deps.store.logEntry(
          taskId,
          `Refused stale-path cleanup — path is not a safe orphan (registered=${stillRegistered}, owner=${activeOwner ?? "none"})`,
          worktreePath,
        );
        return false;
      }
      try {
        await execAsync("git worktree prune", {
          cwd: deps.rootDir,
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (pruneErr: unknown) {
        const pruneMsg = pruneErr instanceof Error ? pruneErr.message : String(pruneErr);
        executorLog.warn(`${taskId}: git worktree prune failed during stale-path cleanup of ${worktreePath}: ${pruneMsg}`);
      }
      // An orphan directory ("is not a working tree") won't be removed by prune — git
      // doesn't track it. Force-remove the leftover dir so the colliding name is free.
      if (existsSync(worktreePath)) {
        try {
          await rm(worktreePath, { recursive: true, force: true });
        } catch (rmErr: unknown) {
          const rmMsg = rmErr instanceof Error ? rmErr.message : String(rmErr);
          executorLog.warn(`${taskId}: failed to remove orphan worktree directory ${worktreePath}: ${rmMsg}`);
        }
      }
      try {
        await execAsync(`git branch -D "${branch}"`, { cwd: deps.rootDir });
        await deps.store.clearStaleExecutionStartBranchReferences([branch], taskId);
      } catch {
        // best-effort — branch may not exist, which is fine for a stale-path cleanup
      }
      await deps.store.logEntry(
        taskId,
        `Cleaned up stale conflicting worktree (no live worktree at path — pruned admin entry and removed orphan directory)`,
        worktreePath,
      );
      return true;
    }
    await deps.store.logEntry(
      taskId,
      `Failed to clean up conflicting worktree`,
      `${worktreePath}: ${errorMessage}`,
    );
    return false;
  }
}
