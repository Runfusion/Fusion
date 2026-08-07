/**
 * FNXC:CodeOrganization 2026-08-03-11:20:
 * executeCore peeled from TaskExecutor (U4).
 * Routing-only entry: soft-delete refuse, graph claim, gates, then executeWorkflowGraph.
 *
 * FNXC:GlobalConcurrencyControls 2026-07-15-03:50:
 * Structural cleanup for scheduler pre-held global slots lives on the execute() wrapper:
 * every exit path must leave no unclaimed registration (dropPreHeldExecutorSlot + release).
 *
 * FNXC:WorkflowExecution 2026-07-19-02:10:
 * U5e (R9) — `executeCore` is ROUTING ONLY. It decides who owns the task (duplicate-dispatch
 * drop, dependency/ephemeral gates, the workflow graph, authoritative dispatch) and, when no
 * one else claims it, drives the implementation phase itself.
 *
 * The routing block used to be wrapped in `if (!graphCompletion)` because the graph re-ENTERED
 * `execute()` to run the implementation phase, and that inner call had to skip routing or it
 * would recurse. The graph now calls `runImplementation()` directly, so there is no inner
 * invocation to exclude and the gates are unconditional.
 *
 * FNXC:ExecutorSoftDelete 2026-07-20-23:30:
 * Soft-delete refuse in routing so deleted cards never start a workflow run.
 *
 * FNXC:WorkflowExecution 2026-07-21-22:56:
 * Claim graphRouting BEFORE any await (FN-8471 multi-entry race).
 *
 * FNXC:WorkflowExecution 2026-07-19-10:40 / 17:45 (U10/U10b):
 * Authoritative driver and bare runImplementation fallback deleted; graph is sole orchestrator.
 */
import type { Task } from "@fusion/core";
import { executorLog } from "../logger.js";
import { dropPreHeldExecutorSlot } from "../concurrency/concurrency.js";

export type ExecuteCoreDeps = {
  completionFinalizedTaskIds: Set<string>;
  graphRouting: Set<string>;
  releaseSemaphore: () => void;
  clearStalePauseAbortBeforeDispatch: (task: Task) => Promise<void>;
  blockOuterDispatchWhenDependenciesUnmet: (task: Task) => Promise<boolean>;
  executeWorkflowGraph: (task: Task, options: { alreadyClaimed: true }) => Promise<void>;
};

export async function executeCore(deps: ExecuteCoreDeps, task: Task): Promise<void> {
  deps.completionFinalizedTaskIds.delete(task.id);
  /*
  FNXC:ExecutorSoftDelete 2026-07-20-23:30:
  Soft-delete refuse belongs in routing, not only inside runImplementation. After U10b the
  graph owns every execute() call, so a deletedAt check that lives only under the
  implementation seam never fires for graph entry (cursor capture / selection / fail-closed
  parks run first). Refuse here before graph ownership so soft-deleted cards never start a
  workflow run; runImplementation keeps the same check as defense-in-depth for graph-owned
  re-entry that already holds the process lock.
  */
  if (task.deletedAt) {
    executorLog.warn(`${task.id}: refusing execute — task is soft-deleted`);
    if (dropPreHeldExecutorSlot(task.id)) deps.releaseSemaphore();
    return;
  }
  /*
  FNXC:WorkflowExecution 2026-07-21-22:56:
  Claim graphRouting BEFORE any await. The previous check-then-await-then-claim
  window let concurrent execute() calls (task:moved + unpause resume after plan-review)
  both pass the graphRouting.has gate, both enter executeWorkflowGraph, and one park
  status=failed while the other still owned work (FN-8471 overseer thrash).
  */
  if (deps.graphRouting.has(task.id)) {
    // Duplicate dispatch while the graph runner owns this task — drop it,
    // mirroring the executingTaskLock duplicate-invocation behavior.
    executorLog.debug(`execute() called for ${task.id} while graph routing is active — skipping duplicate`);
    return;
  }
  deps.graphRouting.add(task.id);
  let graphRunnerOwnsClaim = false;
  try {
    await deps.clearStalePauseAbortBeforeDispatch(task);
    if (await deps.blockOuterDispatchWhenDependenciesUnmet(task)) {
      // FNXC:GlobalConcurrencyControls 2026-07-14-18:30: release any scheduler pre-held slot when outer dispatch aborts before agent work starts.
      if (dropPreHeldExecutorSlot(task.id)) deps.releaseSemaphore();
      return;
    }
    /*
    FNXC:WorkflowAgentRouting 2026-08-07-09:11:
    FN-8821: ephemeralAgentsEnabled is a routing-inert compatibility setting. Do not
    rebound or queue at outer dispatch based on it; graph principal admission owns
    durable identity/capacity. The old blockOuterDispatchWhenEphemeralDisabled gate is
    retired from this path.
    */
    /*
    FNXC:WorkflowExecution 2026-07-19-10:40:
    U10 (R9) — the `workflowAuthoritativeDispatch` branch is DELETED along with
    WorkflowAuthoritativeDriver. It was the pre-graph "authoritative" runtime: a second
    in-process execution path that could claim a task between the graph and the legacy
    implementation. The graph is now the sole orchestrator, so a second claimant is not a
    fallback, it is a race.

    FNXC:WorkflowExecution 2026-07-19-17:45 (U10b / R9):
    The trailing `await this.runImplementation(task)` is DELETED too, and
    `maybeExecuteWorkflowGraph` is now `executeWorkflowGraph` returning void. The old boolean
    meant "did the graph claim this task"; with the legacy fallback gone the answer is always
    yes, so a bare `runImplementation` call with NO `graphCompletion` — an implementation pass
    that nothing owns the completion of — is unreachable by construction rather than by
    convention. That is what makes `graphCompletion` a required parameter below.
    */
    graphRunnerOwnsClaim = true;
    await deps.executeWorkflowGraph(task, { alreadyClaimed: true });
  } finally {
    // executeWorkflowGraph's finally releases the claim when it owns the run.
    if (!graphRunnerOwnsClaim) {
      deps.graphRouting.delete(task.id);
    }
  }
}
