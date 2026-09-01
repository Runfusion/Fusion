import type { Task } from "../types.js";
import { compareTasksByPriorityThenAgeAndId } from "./task-priority.js";

export type FileScopeLeaseKind = "none" | "active" | "dormant";

export interface FileScopeLeaseClassification {
  kind: FileScopeLeaseKind;
  waivedForTaskIds: readonly string[];
}

/*
FNXC:WorkspaceFileOverlap 2026-08-30-19:14:
Workspace tasks deliberately clear the singular `task.worktree` through
`normalizeWorkspaceTaskWorktreeMetadata({ clearSingularWorktree: true })`, so overlap lifetime must also
recognize their per-repository checkouts. A retained entry is the unfinished-work proof; executor and archive
cleanup delete those entries when the checkout is removed, preserving checkout clearing as the early-release hatch.
*/
export function taskHoldsUnmergedCheckout(
  task: Pick<Task, "worktree" | "workspaceWorktrees">,
): boolean {
  if (typeof task.worktree === "string" && task.worktree.trim()) return true;
  return Object.values(task.workspaceWorktrees ?? {}).some(
    (entry) => typeof entry?.worktreePath === "string" && entry.worktreePath.trim().length > 0,
  );
}

function normalizeWorkspaceScopePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

/*
FNXC:WorkspaceFileOverlap 2026-08-30-19:14:
Workspace repository scope treats an unprefixed declaration as applying inside every configured repository,
matching `resolveRepoDeclaredScope`'s `unprefixed-fallback` behavior. Expand overlap scope in the safe direction:
more serialization is acceptable, while missing a qualified peer would admit conflicting edits. Explicit repository
paths remain untouched, and tasks without repository checkouts retain the exact single-repository scope behavior.
*/
export function normalizeOverlapScopeForTask(
  task: Pick<Task, "workspaceWorktrees">,
  scope: readonly string[],
): string[] {
  const repoKeys = [...new Set(
    Object.keys(task.workspaceWorktrees ?? {})
      .map(normalizeWorkspaceScopePath)
      .filter(Boolean),
  )].sort();
  if (repoKeys.length === 0) return [...scope];

  const normalizedScope = new Set<string>();
  for (const rawEntry of scope) {
    const entry = normalizeWorkspaceScopePath(rawEntry);
    if (!entry) continue;
    normalizedScope.add(entry);
    if (repoKeys.some((repoKey) => entry === repoKey || entry.startsWith(`${repoKey}/`))) continue;
    for (const repoKey of repoKeys) normalizedScope.add(`${repoKey}/${entry}`);
  }
  return [...normalizedScope].sort();
}

/*
FNXC:OverlapScheduling 2026-08-29-05:47:
A file-scope claim lasts until the blocking task's work has landed rather than only while it occupies a
particular board column. Active claims always serialize overlapping work; dormant claims use priority,
age, then task id so two waiting holders choose one deterministic winner instead of freezing each other.
*/
export function fileScopeLeaseBlocksCandidate(
  blocker: Pick<Task, "id" | "priority" | "createdAt">,
  candidate: Pick<Task, "id" | "priority" | "createdAt">,
  classification: FileScopeLeaseClassification,
): boolean {
  if (blocker.id === candidate.id) return false;
  if (classification.waivedForTaskIds.includes(candidate.id)) return false;
  if (classification.kind === "active") return true;
  if (classification.kind === "dormant") {
    return compareTasksByPriorityThenAgeAndId(blocker, candidate) < 0;
  }
  return false;
}
