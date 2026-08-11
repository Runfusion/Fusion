/**
 * FNXC:CodeOrganization 2026-08-03-18:20:
 * handleDepAbortCleanup peeled from TaskExecutor (U4).
 * After mid-execution fn_task_add_dep: remove worktree, delete branch, rebound for replan.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Settings, TaskStore } from "@fusion/core";
import { resolveTaskWorkingBranch } from "../worktree/worktree-names.js";
import { RemovalReason } from "../worktree/worktree-pool.js";
import { executorLog } from "../logger.js";
import { resolveExternalExecutionCheckoutRoute } from "../execution/external-execution-checkout.js";
import { resolveReboundColumnFor } from "./lifecycle-columns.js";

const execAsync = promisify(exec);

export type DepAbortCleanupDeps = {
  rootDir: string;
  store: TaskStore;
  activeWorktrees: Map<string, unknown>;
  removeOwnWorktreeWithReconcile: (input: {
    worktreePath: string;
    settings: Settings;
    taskId: string;
    reason: RemovalReason;
  }) => Promise<void>;
};

export async function handleDepAbortCleanup(
  deps: DepAbortCleanupDeps,
  taskId: string,
  worktreePath: string,
): Promise<void> {
  executorLog.log(`${taskId} dependency added — work discarded, moved to triage for re-planning`);

  const task = await deps.store.getTask(taskId);
  const externalExecutionRoute = await resolveExternalExecutionCheckoutRoute(task);

  /*
  FNXC:ExternalExecutionCheckout 2026-08-09-22:43:
  Persisted external execution routes are operator-owned checkouts. Executor cleanup may clear Fusion's managed task pointers, but it must never remove the routed directory or delete its branch during dependency abort, retry, pause, stuck-kill, or remediation recovery.
  */
  if (!externalExecutionRoute.configured) {
    try {
      const settings = await deps.store.getSettings() as Settings;
      await deps.removeOwnWorktreeWithReconcile({
        worktreePath,
        settings,
        taskId,
        reason: RemovalReason.ExecutorDispose,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${taskId}: failed to remove worktree during dep-abort cleanup (${worktreePath}): ${msg}`);
    }
  }

  // Delete only a Fusion-managed branch. External routes remain operator-owned.
  const branch = resolveTaskWorkingBranch(task);
  let branchDeleted = false;
  if (!externalExecutionRoute.configured) {
    try {
      await execAsync(`git branch -D "${branch}"`, { cwd: deps.rootDir });
      branchDeleted = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`${taskId}: failed to delete branch during dep-abort cleanup (${branch}): ${msg}`);
    }
  }
  if (branchDeleted) {
    // FN-2165 regression guard: null baseBranch on any task that stored this branch
    try { await deps.store.clearStaleExecutionStartBranchReferences([branch], taskId); } catch { /* best-effort */ }
  }

  // Clear worktree tracking
  deps.activeWorktrees.delete(taskId);

  // Update task: clear worktree and status, move to triage
  await deps.store.updateTask(taskId, { worktree: null, status: null });
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-29-15:10 (P0 audit after the Planning-column merge):
  This wrote the LITERAL `triage`. The default coding lineage no longer declares that column —
  it has one pre-implementation column, id `todo` — so a card that gained a dependency
  mid-execution had its work discarded and was then parked in a column its own workflow does
  not define. Nothing in the graph routes a card out of an undeclared column, and the only
  rescue is `reconcileUndeclaredTaskColumns` on the NEXT ENGINE START, so between the abort and
  a restart the card is stalled with no automatic recovery. It does not throw, which is why it
  would have surfaced as a user report rather than a red test.

  Resolve the rebound target from the task's own workflow (hold -> intake -> first declared
  column), the same helper the other ~16 executor rebounds already use.
  */
  await deps.store.moveTask(taskId, await resolveReboundColumnFor(deps.store, taskId));
  await deps.store.logEntry(taskId, "Execution stopped — work discarded, requeued for re-planning");
}
