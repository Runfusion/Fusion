import type { TaskStore } from "./store.js";
import type { ColumnId, Task } from "./types.js";

export type TaskMoveSource = "user" | "engine" | "scheduler";
export type TaskMoveDisposer = (task: Task) => Promise<void>;

export interface TaskMoveDisposalInput {
  task: Task;
  from: ColumnId;
  to: ColumnId;
  source: TaskMoveSource;
}

/*
 * Core owns task-transition ordering but cannot import the engine. Keep the
 * cancellation seam store-scoped so one project's executor cannot stop work
 * owned by another store, and identity-guard unregisters across restarts.
 */
const disposers = new WeakMap<TaskStore, TaskMoveDisposer>();

export function registerTaskMoveDisposer(store: TaskStore, disposer: TaskMoveDisposer): () => void {
  disposers.set(store, disposer);
  return () => {
    if (disposers.get(store) === disposer) disposers.delete(store);
  };
}

export function getTaskMoveDisposer(store: TaskStore): TaskMoveDisposer | undefined {
  return disposers.get(store);
}

/**
 * A user move from active execution back to Todo is a hard cancel. Await every
 * registered execution surface before publishing the new column so persisted
 * board state can never claim the task is idle while its agent still runs.
 */
export async function disposeTaskBeforeMove(store: TaskStore, input: TaskMoveDisposalInput): Promise<void> {
  if (input.source !== "user" || input.from !== "in-progress" || input.to !== "todo") return;
  await disposers.get(store)?.(input.task);
}
