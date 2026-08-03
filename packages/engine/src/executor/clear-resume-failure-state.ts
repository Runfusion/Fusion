/**
 * FNXC:CodeOrganization 2026-08-03-09:25:
 * clearResumeFailureState peeled from TaskExecutor (U4).
 *
 * Pre-dispatch gating state must not survive into a resumed in-progress run.
 * The scheduler sets status="queued" + blockedBy on dep/file-scope conflicts
 * (scheduler.ts) and clears them on the todo→in-progress transition.
 * Resume paths (unpause, drift recovery, engine restart) bypass that clear,
 * so a task can end up actively executing while still labeled "queued" in the UI.
 */
import type { Task, TaskStore } from "@fusion/core";

export type ClearResumeFailureStateDeps = {
  store: TaskStore;
};

export async function clearResumeFailureState(
  deps: ClearResumeFailureStateDeps,
  task: Task,
): Promise<void> {
  const updates: { status?: null; error?: null; blockedBy?: null } = {};
  if (task.status === "failed" || task.error) {
    updates.status = null;
    updates.error = null;
  }
  if (task.status === "queued") {
    updates.status = null;
  }
  if (task.blockedBy) {
    updates.blockedBy = null;
  }
  if (Object.keys(updates).length > 0) {
    await deps.store.updateTask(task.id, updates);
  }
}
