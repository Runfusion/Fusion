import type { TaskStore, WorkspaceLandFailure } from "@fusion/core";

/**
 * FNXC:Workspace 2026-08-15-07:05:
 * Persist a display-only per-repository landing failure without altering merge control flow.
 *
 * FNXC:Workspace 2026-08-15-08:00:
 * This is a per-key mutation, so it must use the advisory-locked store merge rather than
 * reconstructing workspaceWorktrees from a stale read. `requireExistingEntry` retains the
 * absent-entry no-op while concurrent acquisition and landing keep every sibling entry.
 */
export async function persistWorkspaceRepoLandFailure(
  store: TaskStore,
  taskId: string,
  repoRel: string,
  failure: Omit<WorkspaceLandFailure, "category"> & { category?: WorkspaceLandFailure["category"] },
): Promise<void> {
  await store.mergeWorkspaceWorktreeEntry(
    taskId,
    repoRel,
    { landFailure: { ...failure, category: failure.category ?? "internal-technical" } },
    { requireExistingEntry: true },
  );
}
