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
 * owned by another store. A set preserves every live owner during overlap.
 */
const disposers = new WeakMap<TaskStore, Set<TaskMoveDisposer>>();
const TASK_MOVE_DISPOSAL_TIMEOUT_MS = 30_000;
let taskMoveDisposalTimeoutMs = TASK_MOVE_DISPOSAL_TIMEOUT_MS;

export function __setTaskMoveDisposalTimeoutForTesting(
  timeoutMs = TASK_MOVE_DISPOSAL_TIMEOUT_MS,
): void {
  taskMoveDisposalTimeoutMs = timeoutMs;
}

export function registerTaskMoveDisposer(store: TaskStore, disposer: TaskMoveDisposer): () => void {
  const registered = disposers.get(store) ?? new Set<TaskMoveDisposer>();
  registered.add(disposer);
  disposers.set(store, registered);
  return () => {
    const current = disposers.get(store);
    current?.delete(disposer);
    if (current?.size === 0) disposers.delete(store);
  };
}

export function getTaskMoveDisposer(store: TaskStore): TaskMoveDisposer | undefined {
  const registered = disposers.get(store);
  if (!registered?.size) return undefined;
  return async (task) => {
    await Promise.all([...registered].map((disposer) => disposer(task)));
  };
}

/**
 * A user move from active execution back to Todo is a hard cancel. Await every
 * registered execution surface before publishing the new column so persisted
 * board state can never claim the task is idle while its agent still runs.
 */
export async function disposeTaskBeforeMove(store: TaskStore, input: TaskMoveDisposalInput): Promise<void> {
  if (input.source !== "user" || input.from !== "in-progress" || input.to !== "todo") return;
  const disposer = getTaskMoveDisposer(store);
  if (!disposer) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      disposer(input.task),
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out stopping active work for ${input.task.id} before moving to Todo`));
        }, taskMoveDisposalTimeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
