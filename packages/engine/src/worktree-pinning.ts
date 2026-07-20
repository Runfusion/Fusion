import type { Settings } from "@fusion/core";
import { basename } from "node:path";
import { resolveTaskWorktreePath } from "./worktree-paths.js";

/*
FNXC:TaskPinnedWorktrees 2026-07-16-00:00:
Task-pinned worktrees invariant. When `worktreeNaming === "task-id"`, a task lives in exactly one
derivable worktree directory — `<resolvedWorktreesDir>/<lowercased-task-id>` (e.g. `.worktrees/fn-7996`) —
for its entire lifecycle. No other task may ever occupy it and no code path may hand this task any other
directory. The path is DERIVED from the task id (unique forever via committed reservations, so no
dedup-suffixing is possible), which makes the FN-7996 stale/foreign `task.worktree` pointer structurally
impossible: `task.worktree` becomes a cache that is re-derived and corrected on acquisition.

This is intentionally separate from `recycleWorktrees`: pinning takes PRECEDENCE. Under `"random"` /
`"task-title"` naming the pool acquire/release path is untouched and byte-inert; only `"task-id"` naming
bypasses the pool (a pooled dir has the wrong name by definition) and removes-on-release instead of pooling.
Worktrunk-managed layouts own their own path derivation, so pinning is bypassed when that backend is active.
*/

/** True iff the resolved worktree naming mode pins each task to a derivable per-task directory. */
export function isTaskPinnedWorktreeNaming(settings: Pick<Settings, "worktreeNaming"> | undefined): boolean {
  return settings?.worktreeNaming === "task-id";
}

/** Directory slug for a task-pinned worktree: the lowercased task id (IDs are unique forever). */
export function pinnedWorktreeSlug(taskId: string): string {
  return taskId.toLowerCase();
}

/**
 * Derive the absolute task-pinned worktree path for a task under `"task-id"` naming.
 * Respects the configured `worktreesDir` resolution (`~` expansion + `{repo}` token).
 */
export function pinnedWorktreePathForTask(
  taskId: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  rootDir: string,
): string {
  return resolveTaskWorktreePath(rootDir, settings, pinnedWorktreeSlug(taskId));
}

/** Preserve the task-pinned naming invariant while normalizing legacy paths. */
export function preservedWorktreeTargetPathForTask(
  taskId: string,
  sourcePath: string,
  settings: Pick<Settings, "worktreeNaming" | "worktreesDir"> | undefined,
  rootDir: string,
): string {
  return isTaskPinnedWorktreeNaming(settings)
    ? pinnedWorktreePathForTask(taskId, settings, rootDir)
    : resolveTaskWorktreePath(rootDir, settings, basename(sourcePath));
}
