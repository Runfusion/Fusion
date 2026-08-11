/**
 * FNXC:CodeOrganization 2026-08-03-12:10:
 * resetStepsIfWorkLost peeled from TaskExecutor (U4).
 *
 * FNXC:StuckRequeue 2026-06-27-23:55:
 * Stuck-requeue cleanup is about to delete the checkout. If git cannot prove the branch has durable commits, treat completed steps as lost uncommitted work and reset them.
 */
import type { Task } from "@fusion/core";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolveTaskWorkingBranch } from "../worktree/worktree-names.js";
import { executorLog } from "../logger.js";

const execAsync = promisify(exec);

export type ResetStepsIfWorkLostDeps = {
  rootDir: string;
  resetLostWorkStepProgress: (task: Task, completedCount: number, reason: string) => Promise<void>;
};

export async function resetStepsIfWorkLost(
  deps: ResetStepsIfWorkLostDeps,
  task: Task,
): Promise<void> {
  const completedSteps = task.steps.filter(
    (s) => s.status === "done" || s.status === "in-progress",
  );
  if (completedSteps.length === 0) return;

  const branchName = resolveTaskWorkingBranch(task);

  try {
    // Check if the branch has any unique commits vs main
    const { stdout: mergeBaseStdout } = await execAsync(
      `git merge-base "${branchName}" HEAD 2>/dev/null`,
      { cwd: deps.rootDir, encoding: "utf-8" },
    );
    const { stdout: branchHeadStdout } = await execAsync(
      `git rev-parse "${branchName}" 2>/dev/null`,
      { cwd: deps.rootDir, encoding: "utf-8" },
    );
    const mergeBase = mergeBaseStdout.trim();
    const branchHead = branchHeadStdout.trim();

    if (mergeBase === branchHead) {
      await deps.resetLostWorkStepProgress(task, completedSteps.length, "branch had no commits");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    executorLog.warn(
      `${task.id}: unable to prove surviving branch commits before worktree removal — resetting ${completedSteps.length} steps (${msg})`,
    );
    await deps.resetLostWorkStepProgress(task, completedSteps.length, `git proof failed: ${msg}`);
  }
}
