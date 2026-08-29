/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * sessionRegistryPath peeled from TaskExecutor (U4).
 *
 * FNXC:Workspace 2026-06-24-15:45 (concurrent workspace tasks — shared browse-root collision):
 * In workspace mode rootDir is the SHARED browse-only (non-git) workspace root, and EVERY
 * workspace task runs its agent session rooted there (per-sub-repo worktrees are acquired on demand).
 * The session registrations are keyed in the GLOBAL path-keyed activeSessionRegistry, whose
 * foreign-task guard rejects a second task registering a path already held by a different task. With
 * the bare root as the key, the second concurrent workspace task fails with "active-session path
 * <root> is held by task <other>; task <self> may not overwrite it" — so only ONE task per workspace
 * could ever run. Per-task session liveness does NOT require path-exclusivity on the shared root
 * (real per-sub-repo exclusivity is enforced separately by the workspace-repo-acquire lease in
 * worktree-acquisition.ts, keyed by sub-repo path). Give each task a task-scoped synthetic session
 * key so the registry stays per-task. The in-memory activeWorktrees Set still holds the REAL root, so
 * getActiveWorktreePaths() consumers that cd into a path are unaffected; only the registry key changes.
 * Non-workspace tasks (unique worktree path != rootDir) are returned unchanged.
 *
 * FNXC:PlanReviewWorktree 2026-07-25-20:40 (concurrent root-rooted step sessions — single-repo collision):
 * The task-scoped key must apply to the shared repo root in EVERY project mode, not only workspace mode.
 * Read-only graph nodes that need no worktree (Plan Review is the canonical one — it reviews the
 * store-injected PROMPT.md, see FNXC:PlanReviewSpecInjection) run rooted at rootDir, and a todo
 * task has no worktree of its own. With the bare root as the registry key, two tasks reaching Plan Review
 * at the same time collided: the second failed with "active-session path <root> is held by task <other>;
 * task <self> may not overwrite it", which surfaced as a Plan Review provider failure, burned the
 * in-place retry budget against a hold that retrying can never clear, and left the task parked
 * (reported: FN-1398 holding /home/ubuntu/dev/freemap-svelte while FN-1403 planned).
 * Path-exclusivity on the shared root is not what keeps these sessions correct: write-capable nodes are
 * refused at the root outright (no-worktree-for-write-node), real per-sub-repo exclusivity is the
 * workspace-repo-acquire lease, and every isPathActive consumer guards removable WORKTREE paths — the
 * root is never one. Liveness still works because the synthetic key stays in the registry under the task.
 */
export function sessionRegistryPath(rootDir: string, taskId: string, worktreePath: string): string {
  if (worktreePath === rootDir) {
    return `${worktreePath}#session:${taskId}`;
  }
  return worktreePath;
}
