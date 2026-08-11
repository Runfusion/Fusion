/**
 * FNXC:CodeOrganization 2026-08-03-20:15:
 * listWorktreeHolders peeled from TaskExecutor (U4).
 *
 * FNXC:Workspace 2026-06-21-12:00: KTD2 — flat-map each task's Set into one holder row per worktree path.
 * A workspace task emits N rows; self-healing reaper keys off taskId and is idempotent across duplicate-task rows.
 */
export function listWorktreeHolders(
  activeWorktrees: Map<string, Set<string>>,
): Array<{ taskId: string; worktreePath: string }> {
  const holders: Array<{ taskId: string; worktreePath: string }> = [];
  for (const [taskId, worktreePaths] of activeWorktrees) {
    for (const worktreePath of worktreePaths) {
      holders.push({ taskId, worktreePath });
    }
  }
  return holders;
}
