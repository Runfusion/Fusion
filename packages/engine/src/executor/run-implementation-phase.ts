/**
 * FNXC:CodeOrganization 2026-08-03-15:40:
 * runImplementationPhase peeled from TaskExecutor (U4).
 *
 * Graph-owned implementation runner: one direct runImplementation pass with
 * completion/exit capture — no re-entry through execute() routing.
 *
 * FNXC:WorkflowExecution 2026-07-19-02:10:
 * U5e (R9) — calls runImplementation() DIRECTLY. It used to re-enter execute(),
 * which meant every graph-driven implementation pass made a second trip through
 * routing that had to be suppressed by a signal.
 */
import type { Task } from "@fusion/core";
import type { PreparedWorktree } from "../execution/runtime-primitives.js";
import type { ImplementationExit, ImplementationExitReporter } from "./implementation-exit.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror TaskExecutor method surface
type AnyFn = (...args: any[]) => any;

/** Mirrors TaskExecutor GraphCompletionCallback. */
export type GraphCompletionCallback = (info: { modifiedFiles: string[] }) => void;

export type RunImplementationPhaseDeps = {
  runImplementation: AnyFn;
};

export async function runImplementationPhase(
  deps: RunImplementationPhaseDeps,
  task: Task,
  prepared?: PreparedWorktree,
): Promise<{ taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit }> {
  let captured: { taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit } = { taskDone: false, modifiedFiles: [] };
  const graphCompletion: GraphCompletionCallback = (info) => {
    captured = { ...captured, taskDone: true, modifiedFiles: info.modifiedFiles };
  };
  /* Recorded independently of `graphCompletion`: the out-of-band exits never call it. */
  const reportExit: ImplementationExitReporter = (exit) => {
    captured = { ...captured, exit };
  };
  const executionTask = prepared
    ? {
        ...task,
        worktree: prepared.worktreePath || task.worktree,
        branch: prepared.branchName || task.branch,
      }
    : task;
  await deps.runImplementation(executionTask, graphCompletion, reportExit);
  return captured;
}
