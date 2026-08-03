/**
 * FNXC:CodeOrganization 2026-08-03-14:50:
 * removeOwnWorktreeWithReconcile peeled from TaskExecutor (U4 Slice B).
 */
import type { Settings } from "@fusion/core";
import {
  activeSessionRegistry,
  executingTaskLock,
  reconcileSelfOwnedActiveSessionForRemoval,
} from "../agents/active-session-registry.js";
import {
  RemovalReason,
  removeWorktree,
} from "../worktree/worktree-pool.js";
import { ActiveSessionWorktreeRemovalError } from "../worktree/worktree-backend.js";
import { executorLog } from "../logger.js";

export type RemoveOwnWorktreeDeps = {
  rootDir: string;
  store: {
    logEntry: (taskId: string, action: string, outcome?: string) => Promise<unknown>;
  };
  reconcileSelfOwnedBeforeRemove: (worktreePath: string, taskId: string) => Promise<void>;
  hasActiveWorktreeBinding: (taskId: string, path: string) => boolean;
};

export async function removeOwnWorktreeWithReconcile(
  deps: RemoveOwnWorktreeDeps,
  input: {
    worktreePath: string;
    settings: Settings;
    taskId: string;
    reason: RemovalReason;
    audit?: Parameters<typeof removeWorktree>[0]["audit"];
  },
): Promise<void> {
  await deps.reconcileSelfOwnedBeforeRemove(input.worktreePath, input.taskId);
  const removeArgs = {
    worktreePath: input.worktreePath,
    rootDir: deps.rootDir,
    settings: input.settings,
    taskId: input.taskId,
    reason: input.reason,
    audit: input.audit,
    expectedOwnerTaskId: input.taskId,
    liveOwnerProbe: (path: string, ownerTaskId: string) => deps.hasActiveWorktreeBinding(ownerTaskId, path),
    // FN-5256: route the worktree-backend defensive reconcile through the
    // hardened gates (process-active + min-idle window).
    processActiveProbe: (probeTaskId: string) => executingTaskLock.has(probeTaskId),
  } as const;
  try {
    await removeWorktree(removeArgs);
  } catch (error: unknown) {
    if (
      error instanceof ActiveSessionWorktreeRemovalError
      && error.details.taskId === input.taskId
      && !deps.hasActiveWorktreeBinding(input.taskId, input.worktreePath)
    ) {
      // FN-5256: route the post-throw reconcile through the hardened path so
      // process-active and too-recent signals also gate this leg.
      const outcome = reconcileSelfOwnedActiveSessionForRemoval(
        activeSessionRegistry,
        input.worktreePath,
        input.taskId,
        (path, ownerTaskId) => deps.hasActiveWorktreeBinding(ownerTaskId, path),
        {
          processActiveProbe: (probeTaskId) => executingTaskLock.has(probeTaskId),
        },
      );
      if (outcome.action === "reconciled") {
        await deps.store.logEntry(
          input.taskId,
          "Reconciled stale self-owned active-session registration (post-throw)",
          input.worktreePath,
        );
        await removeWorktree(removeArgs);
        return;
      }
      if (outcome.action === "process-active-refuses" || outcome.action === "too-recent-refuses") {
        executorLog.warn(
          `[FN-5256] post-throw reconcile refused for ${input.taskId} at ${input.worktreePath}: action=${outcome.action}`,
        );
        // Refused — surface the original error so the caller can decide.
      }
    }
    throw error;
  }
}
