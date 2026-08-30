import { classifyTaskBranchOrigin } from "@fusion/core";
import type { Settings, Task, WorkspaceWorktreeContext } from "@fusion/core";
import { resolveTaskWorktreePath } from "./worktree-paths.js";

export function canonicalFusionBranchName(taskId: string): string {
  return `fusion/${taskId.toLowerCase()}`;
}

/**
 * Canonical per-instance branch name for a worktree-isolated foreach step.
 * The branch is deterministic from the task id and step index so a resumed
 * workflow can reconstruct it without allocating a name.
 */
export function canonicalStepInstanceBranchName(taskId: string, stepIndex: number): string {
  return `${canonicalFusionBranchName(taskId)}-step-${stepIndex}`;
}

export function resolveTaskWorkingBranch(task: Pick<Task, "id" | "branch" | "branchContext">): string {
  if (task.branchContext?.assignmentMode === "shared") {
    return canonicalFusionBranchName(task.id);
  }
  return task.branch || canonicalFusionBranchName(task.id);
}

/**
 * FNXC:WorkspaceBranches 2026-08-20-03:38:
 * FN-9161 requires recorded provenance rather than name shape: an operator
 * branch may intentionally use Fusion's namespace.
 */
export function resolveTaskWorkingBranchWithOrigin(
  task: Pick<Task, "id" | "branch" | "branchContext">,
): { branch: string; origin: ReturnType<typeof classifyTaskBranchOrigin> } {
  const branch = resolveTaskWorkingBranch(task);
  return { branch, origin: classifyTaskBranchOrigin(task, branch) };
}

/**
 * Return the single deterministic directory reserved for a task.
 *
 * FNXC:TaskWorktreeNames 2026-08-29-08:51:
 * FN-258 removes selectable and random worktree names. A committed task ID is
 * unique forever, so its lower-cased ID is the only safe worktree directory
 * identity and stale metadata can always be derived again on acquisition.
 * Legacy naming/reservation arguments remain accepted temporarily for callers
 * outside this package, but intentionally have no effect.
 */
export function planTaskWorktreePath(
  task: { id: string; worktree?: string | null },
  rootDir: string,
  _reservedNames?: Set<string>,
  settings?: Pick<Settings, "worktreesDir">,
  workspaceContext?: WorkspaceWorktreeContext,
): string {
  if (task.worktree) return task.worktree;
  return resolveTaskWorktreePath(rootDir, settings, task.id.toLowerCase(), workspaceContext);
}
