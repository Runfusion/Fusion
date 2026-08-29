/**
 * FNXC:CodeOrganization 2026-08-03-15:40:
 * TaskExecutor.cleanup peeled from TaskExecutor (U4).
 *
 * Drops in-memory active-worktree tracking and removes the single-repo worktree
 * when no other task still needs it. Workspace roots are tracking-only (never removed).
 */
import type { TaskStore, WorkspaceConfig } from "@fusion/core";
import { findWorktreeUser } from "../merger.js";
import { RemovalReason } from "../worktree/worktree-pool.js";
import { executorLog } from "../logger.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror TaskExecutor method surface
type AnyFn = (...args: any[]) => any;

export type CleanupTaskWorktreeDeps = {
  store: TaskStore;
  workspaceConfig: WorkspaceConfig | null | undefined;
  ensureWorkspaceConfig?: () => Promise<WorkspaceConfig | null>;
  activeWorktrees: Map<string, Set<string>>;
  getActiveWorktreePaths: (taskId: string) => string[];
  removeOwnWorktreeWithReconcile: AnyFn;
};

export async function cleanupTaskWorktree(
  deps: CleanupTaskWorktreeDeps,
  taskId: string,
): Promise<void> {
  const workspaceConfig = deps.ensureWorkspaceConfig
    ? await deps.ensureWorkspaceConfig()
    : deps.workspaceConfig;
  const worktreePaths = deps.getActiveWorktreePaths(taskId);
  if (worktreePaths.length === 0) return;

  deps.activeWorktrees.delete(taskId);

  /*
  FNXC:Workspace 2026-08-15-05:13:
  In workspace mode the tracked path is the browse-only non-git root, never a removable worktree.
  Per-repo teardown belongs to SelfHealingManager.reconcileOrphanedWorkspaceWorktrees for complete
  and terminal lanes, while archive-lifecycle owns archived rows. A failed task may be retried, so
  executor cleanup only drops in-memory tracking and must not discard sub-repo work at this boundary.
  */
  if (workspaceConfig) {
    return;
  }
  // Non-workspace tasks hold a one-element set — preserve the original single-path removal semantics.
  const worktreePath = worktreePaths[0];

  // Check if another task still needs this worktree
  const otherUser = await findWorktreeUser(deps.store, worktreePath, taskId);
  if (otherUser) {
    executorLog.log(`Worktree retained for ${taskId} — still needed by ${otherUser}`);
    return;
  }

  try {
    const settings = await deps.store.getSettings();
    await deps.removeOwnWorktreeWithReconcile({
      worktreePath,
      settings,
      taskId,
      reason: RemovalReason.ExecutorDispose,
    });
    executorLog.log(`Cleaned up worktree for ${taskId}`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.error(`Failed to clean up worktree for ${taskId}:`, errorMessage);
  }
}
