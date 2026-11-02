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

/*
FNXC:ZeroCommitWorkspaceDelivery 2026-11-02-22:25 (RUFU-451):
Clear one repository's display-only landing-failure breadcrumb. RUFU-451's source-free card is the shape this
exists for: attempts made before the zero-commit contract was honoured wrote per-repository "land failed" chips
(merger-ai's three failure sites plus the partial-land sweep), and once the card closed on an ABSENCE proof
those chips kept reporting a broken repository that never owed a land — a closed card still looking red in the
per-repository status surface.

Two properties are deliberate:
  • `requireExistingEntry: true` keeps a repository the card never acquired a no-op — there is no entry to
    clear, and inventing one to hold a deletion would fabricate acquisition evidence on the row.
  • The patch sets the key to `undefined`, which the store's jsonb write drops, so the breadcrumb is gone
    rather than present-and-empty. A reader must never have to distinguish "cleared" from "failed with no
    details".
*/
export async function clearWorkspaceRepoLandFailure(
  store: TaskStore,
  taskId: string,
  repoRel: string,
): Promise<void> {
  await store.mergeWorkspaceWorktreeEntry(
    taskId,
    repoRel,
    { landFailure: undefined },
    { requireExistingEntry: true },
  );
}
