import type { TaskStore } from "./store.js";
import type { ColumnId, Task } from "./types.js";
import { columnsWithFlag, declaresAnyLifecycleTrait } from "./workflow-lifecycle-traits.js";
import { resolveWorkflowIrForTask } from "./workflow-ir-resolver.js";

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
 * FNXC:WorkflowLifecycle 2026-07-18-14:32:
 * A user move from active execution back to Todo is a hard cancel. Await every
 * registered execution surface before publishing the new column so persisted
 * board state can never claim the task is idle while its agent still runs.
 */
export async function disposeTaskBeforeMove(store: TaskStore, input: TaskMoveDisposalInput): Promise<void> {
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-15:20 (batch-core):
  THE HARD CANCEL MUST FIRE ON A RENAMED BOARD.

  Keyed on the literals, this returned early for every board that renamed either lane — so the
  disposer never ran, and a user pulling a card out of active execution got a task that LOOKS parked
  while its agent is still running. A cancellation contract failing OPEN, which is the worst
  direction: the operator believes the work stopped.

  Same defect and same direction as the `moveTaskInternal` hard-cancel guards, which resolved their
  target as `hold ?? intake` for exactly this reason. Both halves are membership questions here — the
  card LEFT a wip lane and ENTERED a pre-wip one — so both take the full sets rather than one id.

  A workflow expressing no trait at all is a v1 upgrade, not a board without these roles, so it keeps
  the legacy pair; likewise an unresolvable workflow. Failing to dispose is the harm, so the fallback
  stays exactly as permissive as before.
  */
  if (input.source !== "user") return;
  /*
  RESOLVED ONLY WHEN THE LITERALS DO NOT ALREADY MATCH.

  Two reasons, and the second was found by this module's own test rather than reasoned out. First,
  the legacy pair is what a default board uses, so short-circuiting keeps that path free of a
  workflow read on every user move. Second, and load-bearing: `disposeTaskBeforeMove` is awaited by
  the caller BEFORE the new column is published, and the existing test pins that the disposer starts
  within one microtask. Adding an unconditional `await` ahead of it pushed the disposer past that
  point — a real change to when cancellation begins on the ordinary path, for no benefit there.

  So the default board behaves exactly as before, and only a board whose lanes do NOT match the
  legacy pair pays a resolution — which is precisely the case the literals got wrong.
  */
  /* FNXC:WorkflowResolvedColumns 2026-07-30-15:50 DELIBERATE-LITERAL: a fast path, not the guard.
     The legacy pair is what a default board uses, so matching it short-circuits the workflow read.
     The actual lane decision is the RESOLVED membership test inside this block; these two ids only
     decide whether resolution is needed, and answering "no" for them is always correct because they
     are exactly the pair the resolved test would have matched anyway. */
  if (input.from !== "in-progress" || input.to !== "todo") {
    let wipLanes: ReadonlySet<string> = new Set<string>();
    let preWipLanes: ReadonlySet<string> = new Set<string>();
    try {
      const ir = await resolveWorkflowIrForTask(store, input.task.id);
      if (ir && declaresAnyLifecycleTrait(ir)) {
        wipLanes = new Set(columnsWithFlag(ir, "countsTowardWip"));
        preWipLanes = new Set([...columnsWithFlag(ir, "intake"), ...columnsWithFlag(ir, "hold")]);
      }
    } catch { /* degraded: no resolved lanes, so the legacy pair above is the only match */ }
    /*
    A user move out of a WIP lane into a pre-WIP one is the hard cancel. Keyed on the literals this
    returned early for every renamed board, so the disposer never ran and the operator got a card that
    LOOKS parked while its agent is still running — a cancellation contract failing OPEN, the same
    direction and the same defect as the `moveTaskInternal` hard-cancel guards.
    */
    if (!wipLanes.has(input.from) || !preWipLanes.has(input.to)) return;
  }
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
