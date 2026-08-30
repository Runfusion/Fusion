import type { Settings, WorkspaceWorktreeContext } from "@fusion/core";
import { resolveTaskWorktreePath } from "./worktree-paths.js";

/*
FNXC:TaskPinnedWorktrees 2026-08-29-08:51:
FN-258 makes every task worktree task-ID-derived. There is no naming mode or
recycled directory exception: the task ID is permanently unique, and deriving
this path repairs stale task metadata without allocating another directory.
*/

/** Task IDs are always pinned to one derivable worktree directory. */
export function isTaskPinnedWorktreeNaming(_settings?: unknown): true {
  return true;
}

/** Directory slug for a task-pinned worktree: the lowercased task ID. */
export function pinnedWorktreeSlug(taskId: string): string {
  return taskId.toLowerCase();
}

/** Derive the absolute task worktree path from its ID. */
export function pinnedWorktreePathForTask(
  taskId: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  rootDir: string,
  workspaceContext?: WorkspaceWorktreeContext,
): string {
  return resolveTaskWorktreePath(rootDir, settings, pinnedWorktreeSlug(taskId), workspaceContext);
}

/** Preserve the task-ID path regardless of stale source metadata. */
export function preservedWorktreeTargetPathForTask(
  taskId: string,
  _sourcePath: string,
  settings: Pick<Settings, "worktreesDir"> | undefined,
  rootDir: string,
  workspaceContext?: WorkspaceWorktreeContext,
): string {
  return pinnedWorktreePathForTask(taskId, settings, rootDir, workspaceContext);
}
