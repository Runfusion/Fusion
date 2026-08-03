/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * sessionRegistryPath peeled from TaskExecutor (U4).
 *
 * FNXC:Workspace 2026-06-24-15:45 / FNXC:PlanReviewWorktree 2026-07-25-20:40:
 * Shared root-rooted sessions (workspace browse-root and single-repo Plan Review)
 * use a task-scoped synthetic registry key so concurrent tasks do not collide on
 * the bare rootDir path. Real worktree paths pass through unchanged.
 */
export function sessionRegistryPath(rootDir: string, taskId: string, worktreePath: string): string {
  if (worktreePath === rootDir) {
    return `${worktreePath}#session:${taskId}`;
  }
  return worktreePath;
}
