/**
 * FNXC:CodeOrganization 2026-08-03-20:15:
 * getWorktreePath peeled from TaskExecutor (U4).
 *
 * FNXC:Workspace 2026-06-21-12:00: KTD2 single-path-getter contract.
 * Returns the sole worktree path for single-repo tasks; undefined in workspace mode
 * (callers must use per-repo workspaceWorktrees).
 */
export function getWorktreePath(
  workspaceConfig: unknown | null | undefined,
  getActiveWorktreePaths: (taskId: string) => string[],
  taskId: string,
): string | undefined {
  if (workspaceConfig) {
    return undefined;
  }
  return getActiveWorktreePaths(taskId)[0];
}
