import type {Task} from "./types.js";
import type {TaskStore} from "./store.js";
import type {WorktreePathReservation} from "./worktree-path-reservation.js";

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
