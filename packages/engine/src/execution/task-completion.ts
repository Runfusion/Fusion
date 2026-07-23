import { getTaskCompletionBlocker, type Task, type TaskStore } from "@fusion/core";

export async function getTaskCompletionBlockerForStore(
  store: Pick<TaskStore, "getTask">,
  task: Task,
): Promise<string | undefined> {
  return getTaskCompletionBlocker(task, {
    // FN-4091: return full task state from the store so completion gating can
    // ignore stale blockedBy markers when the blocker is missing or terminal.
    resolveTask: async (dependencyId) => {
      try {
        return await store.getTask(dependencyId);
      } catch {
        return null;
      }
    },
  });
}
