/**
 * FNXC:CodeOrganization 2026-08-03-14:20:
 * Stale branch cleanup peeled from TaskExecutor (U4 Slice B).
 * Inject rootDir + store so the helper is free of class state.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type StaleBranchCleanupStore = {
  logEntry: (taskId: string, action: string, outcome?: string) => Promise<unknown>;
  clearStaleExecutionStartBranchReferences: (branches: string[], excludingTaskId?: string) => Promise<unknown>;
};

/**
 * Clean up a stale git branch that is blocking worktree creation.
 *
 * Recovery ladder:
 * 1. `git worktree prune` — drop stale worktree metadata that may
 *    hold a lock on the branch reference
 * 2. `git branch -D` — delete the branch normally
 * 3. `git update-ref -d refs/heads/<branch>` — force-remove a corrupted
 *    or dangling reference when `git branch -D` fails
 *
 * Each step is logged so operators can trace the recovery path.
 * Returns true if the branch reference was successfully removed.
 */
export async function cleanupStaleBranch(
  rootDir: string,
  store: StaleBranchCleanupStore,
  branch: string,
  taskId: string,
): Promise<boolean> {
  // Step 1: Prune stale worktree metadata that may hold a lock on the branch
  try {
    await execAsync("git worktree prune", { cwd: rootDir });
    await store.logEntry(taskId, `Pruned stale worktree metadata`, branch);
  } catch {
    // Prune is best-effort — continue even if it fails
  }

  // Step 2: Try normal branch deletion
  try {
    await execAsync(`git branch -D "${branch}"`, {
      cwd: rootDir,
    });
    await store.logEntry(taskId, `Removed stale branch`, branch);
    // FN-2165 regression guard: null baseBranch on any task that stored this branch
    try { await store.clearStaleExecutionStartBranchReferences([branch], taskId); } catch { /* best-effort */ }
    return true;
  } catch (branchDeleteError: unknown) {
    const branchDeleteErrorMessage = branchDeleteError instanceof Error ? branchDeleteError.message : String(branchDeleteError);
    await store.logEntry(
      taskId,
      `git branch -D failed for stale branch, trying update-ref`,
      `${branch}: ${branchDeleteErrorMessage}`,
    );
  }

  // Step 3: Force-remove the reference directly
  try {
    const refPath = `refs/heads/${branch}`;
    await execAsync(`git update-ref -d "${refPath}"`, {
      cwd: rootDir,
    });
    await store.logEntry(taskId, `Force-removed stale branch reference via update-ref`, refPath);
    // FN-2165 regression guard: null baseBranch on any task that stored this branch
    try { await store.clearStaleExecutionStartBranchReferences([branch], taskId); } catch { /* best-effort */ }
    return true;
  } catch (updateRefError: unknown) {
    const updateRefErrorMessage = updateRefError instanceof Error ? updateRefError.message : String(updateRefError);
    await store.logEntry(
      taskId,
      `Failed to remove stale branch reference`,
      `${branch}: ${updateRefErrorMessage}`,
    );
    return false;
  }
}
