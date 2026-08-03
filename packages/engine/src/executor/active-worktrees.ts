/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * activeWorktrees helpers peeled from TaskExecutor (U4).
 *
 * FNXC:Workspace 2026-06-21-12:00:
 * activeWorktrees tracks paths a task currently holds as a SET (N sub-repos in
 * workspace mode; one-element set for single-repo). Membership semantics keep
 * the single-repo path byte-for-byte unchanged (KTD2).
 */

export function addActiveWorktree(
  activeWorktrees: Map<string, Set<string>>,
  taskId: string,
  worktreePath: string,
): void {
  const set = activeWorktrees.get(taskId) ?? new Set<string>();
  set.add(worktreePath);
  activeWorktrees.set(taskId, set);
}

export function getActiveWorktreePaths(
  activeWorktrees: Map<string, Set<string>>,
  taskId: string,
): string[] {
  const set = activeWorktrees.get(taskId);
  return set ? Array.from(set) : [];
}
