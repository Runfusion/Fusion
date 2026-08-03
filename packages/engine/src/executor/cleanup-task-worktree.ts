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
  activeWorktrees: Map<string, Set<string>>;
  getActiveWorktreePaths: (taskId: string) => string[];
  removeOwnWorktreeWithReconcile: AnyFn;
};

export async function cleanupTaskWorktree(
  deps: CleanupTaskWorktreeDeps,
  taskId: string,
): Promise<void> {
  const worktreePaths = deps.getActiveWorktreePaths(taskId);
  if (worktreePaths.length === 0) return;

  deps.activeWorktrees.delete(taskId);

  // FNXC:Workspace 2026-06-21-12:00: KTD1 — in workspace mode the tracked path is the non-git workspace root (browse-only), never a removable worktree. Drop the in-memory tracking above but never remove the root. Per-repo worktree teardown returns in Phase B.
  if (deps.workspaceConfig) {
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
