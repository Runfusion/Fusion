/**
 * FNXC:CodeOrganization 2026-08-10-04:05:
 * Workspace liveness predicates peeled from SelfHealingManager (U5 / wave19 Slice B).
 */
import type { Task } from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";

/**
 * FNXC:Workspace 2026-06-22-09:30 (Phase D U1, KTD2 — workspace-aware liveness predicate):
 * A workspace task is LIVE iff ANY of its sub-repo paths is still registered as active
 * (`pathsForTask` ∩ `isPathActive`) OR a process-wide executing/active signal is held.
 */
export function isWorkspaceTaskLive(
  task: Task,
  isTaskActive?: (taskId: string) => boolean,
): { live: boolean; livePaths: string[] } {
  const livePaths = activeSessionRegistry.pathsForTask(task.id).filter((path) => activeSessionRegistry.isPathActive(path));
  const live = livePaths.length > 0
    || executingTaskLock.has(task.id)
    || isTaskActive?.(task.id) === true;
  return { live, livePaths };
}

/*
FNXC:Workspace 2026-06-22-14:10 / FNXC:WorkflowResolvedColumns 2026-07-31-23:40:
Owner is LIVE unless it is provably terminal — missing, complete-column, or failed.

FNXC:Workspace 2026-08-15-04:11:
Archive is cold storage, but `getTask` serves its snapshot as an archived-column task. An archived
or soft-deleted owner cannot be running, while this in-memory registry retains a leaked land lease
until process exit. Resolve archive columns with the workflow vocabulary and treat them as terminal;
the unchanged age, merge-pending, and executing guards still prevent reclaiming a live land.

Non-terminal states must continue to read LIVE. The column sets are resolved once by the async
caller because this predicate remains synchronous.

FNXC:CodeOrganization 2026-08-15-22:49:
Archived/deleted terminal reasons landed on main after the U5 peel. Keep them on this extracted
helper so reclaimPhantomWorkspaceLandLeases cannot drift from the class wrapper.
*/
export function workspaceOwnerTerminalReason(
  owner: Task | null | undefined,
  completeColumns: ReadonlySet<string>,
  archivedColumns: ReadonlySet<string>,
): "missing" | "complete" | "archived" | "deleted" | "failed" | null {
  if (!owner) return "missing";
  if (completeColumns.has(owner.column)) return "complete";
  if (archivedColumns.has(owner.column)) return "archived";
  if (typeof owner.deletedAt === "string" && owner.deletedAt.length > 0) return "deleted";
  if (owner.status === "failed") return "failed";
  return null;
}

export function isWorkspaceOwnerLive(
  owner: Task | null | undefined,
  completeColumns: ReadonlySet<string>,
  archivedColumns: ReadonlySet<string>,
): boolean {
  return workspaceOwnerTerminalReason(owner, completeColumns, archivedColumns) === null;
}
