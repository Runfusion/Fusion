import type {Task} from "../types.js";
import type {TaskStore} from "../store.js";
import type {WorktreePathReservation} from "../tasks/worktree-path-reservation.js";

/**
 * FNXC:WorkflowLifecycle 2026-07-16-10:00:
 * Core owns archive ordering but cannot import engine. Disposers are keyed by
 * store, rather than process-global, so one project's executor never removes
 * a worktree for another store. Identity-guarded teardown cannot erase a newer
 * executor registration.
 */
export type ArchiveWorktreeDisposer = (task: Task, reservation: WorktreePathReservation) => Promise<void>;
const disposers = new WeakMap<TaskStore, ArchiveWorktreeDisposer>();

export function registerArchiveWorktreeDisposer(store: TaskStore, disposer: ArchiveWorktreeDisposer): () => void {
  disposers.set(store, disposer);
  return () => { if (disposers.get(store) === disposer) disposers.delete(store); };
}
export function getArchiveWorktreeDisposer(store: TaskStore): ArchiveWorktreeDisposer | undefined {
  return disposers.get(store);
}

/** A canonical-path-deduplicated workspace disposal unit owned by `repoRel`. */
export type WorkspaceDisposalPlanEntry = {
  repoRel: string;
  worktreePath: string;
  branch: string;
  repoRootDir: string;
  aliasRepoRels: string[];
};
export type ArchiveWorkspaceDisposalResult = {
  removed: string[];
  failed: {repoRel: string; error: unknown}[];
};
export type ArchiveWorkspaceWorktreeDisposer = (
  task: Task,
  plan: WorkspaceDisposalPlanEntry[],
  reservations: Record<string, WorktreePathReservation>,
) => Promise<ArchiveWorkspaceDisposalResult>;

export class ArchiveWorkspaceDisposalError extends Error {
  constructor(message: string, readonly removed: string[], readonly failed: {repoRel: string; error: unknown}[]) {
    super(message);
    this.name = "ArchiveWorkspaceDisposalError";
  }
}
export class ArchiveWorkspaceDisposalIncompleteError extends Error {
  constructor(repoRel: string) {
    super(`Workspace archive disposer did not report one unambiguous successful removal for ${repoRel}`);
    this.name = "ArchiveWorkspaceDisposalIncompleteError";
  }
}
export class ArchiveWorkspaceWorktreeDisposerMissingError extends Error {
  constructor(repoRel: string) {
    super(`No archive workspace worktree disposer is registered for ${repoRel}`);
    this.name = "ArchiveWorkspaceWorktreeDisposerMissingError";
  }
}

/*
FNXC:WorkflowLifecycle 2026-07-16-14:00:
Workspace archives have one destructive operation per sub-repository. Keep this
DI seam store-scoped so executor-less archive surfaces use the baseline backend
remover while an executor can replace only its own store with session-aware work.
*/
const workspaceDisposers = new WeakMap<TaskStore, ArchiveWorkspaceWorktreeDisposer>();
export function registerArchiveWorkspaceWorktreeDisposer(store: TaskStore, disposer: ArchiveWorkspaceWorktreeDisposer): () => void {
  workspaceDisposers.set(store, disposer);
  return () => { if (workspaceDisposers.get(store) === disposer) workspaceDisposers.delete(store); };
}
export function getArchiveWorkspaceWorktreeDisposer(store: TaskStore): ArchiveWorkspaceWorktreeDisposer | undefined {
  return workspaceDisposers.get(store);
}
