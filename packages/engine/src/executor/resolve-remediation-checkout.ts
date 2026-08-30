import { isWorkspaceTask, type Task, type WorkflowStepResult } from "@fusion/core";
import { deriveWorkspaceReviewRemediation } from "./workspace-review-remediation.js";

export type ResolvedRemediationCheckout = {
  path: string;
  repository?: string;
  persist: boolean;
};

/*
FNXC:WorkspaceReviewRemediation 2026-08-28-12:16:
`clearSingularWorktree: true` intentionally nulls the singular worktree for every workspace task. Remediation must therefore resolve the failed repository's acquired checkout; singular guards excluded workspace recovery entirely, while stage-2 arbitration additionally read the engine directory and judged the wrong tree before attempting an empty-path bounce.
*/
export function resolveRemediationCheckout(
  task: Pick<Task, "worktree" | "workspaceWorktrees" | "repositoryScope">,
  target?: WorkflowStepResult,
): ResolvedRemediationCheckout | undefined {
  if (!isWorkspaceTask(task)) {
    const singularPath = task.worktree?.trim();
    return singularPath ? { path: singularPath, persist: true } : undefined;
  }

  const derivedRepository = target ? deriveWorkspaceReviewRemediation(target)?.repository : undefined;
  const persistedRepository = task.repositoryScope?.reviewRemediation?.repository;
  const repository = derivedRepository
    ?? persistedRepository
    ?? Object.keys(task.workspaceWorktrees ?? {})
      .filter((key) => Boolean(task.workspaceWorktrees?.[key]?.worktreePath?.trim()))
      .sort((left, right) => left.localeCompare(right))[0];
  if (!repository) return undefined;
  const path = task.workspaceWorktrees?.[repository]?.worktreePath?.trim();
  return path ? { path, repository, persist: false } : undefined;
}
