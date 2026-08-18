/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * buildColumnBoundaryHooks peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowColumnBoundary 2026-07-27-16:40 (PR #2475 review, P2):
 * Wiring lives in createExecutorColumnBoundaryHooks; this only threads Executor
 * state (in-flight graph-move marker + logger).
 */
import type { Task, TaskStore } from "@fusion/core";
import { UNATTRIBUTED_MUTATION_CONTEXT } from "@fusion/core";
import type { WorkflowColumnBoundaryHooks } from "../workflows/workflow-graph-task-runner.js";
import { createExecutorColumnBoundaryHooks } from "../workflow-column-boundary-hooks.js";
import { executorLog } from "../logger.js";
import { toRunMutationContext, type EngineRunContext } from "../util/run-audit.js";

export type BuildColumnBoundaryHooksDeps = {
  store: TaskStore;
  workflowLifecycleMovesInFlight: Set<string>;
  getRunContextFor?: (taskId: string) => EngineRunContext | undefined;
  runContextFor: (taskId: string, fallbackAgentId?: string | null) => import("@fusion/core").RunMutationContext;
};

export function buildColumnBoundaryHooks(
  deps: BuildColumnBoundaryHooksDeps,
  task: Pick<Task, "id">,
  workflowRunId?: string,
): WorkflowColumnBoundaryHooks {
  const engineCtx = deps.getRunContextFor?.(task.id);
  return createExecutorColumnBoundaryHooks({
    store: deps.store,
    task,
    workflowRunId,
    /* FNXC:Identity 2026-08-15-22:52 (U18/KTD2): derived where the executor genuinely holds the
       run for this task; the marker fallback is real, not defensive — `currentRunContexts` is
       populated per active run, and a boundary built outside one has no actor to name. */
    runContext: engineCtx ? toRunMutationContext(engineCtx) : UNATTRIBUTED_MUTATION_CONTEXT,
    markMoveInFlight: (taskId) => deps.workflowLifecycleMovesInFlight.add(taskId),
    clearMoveInFlight: (taskId) => deps.workflowLifecycleMovesInFlight.delete(taskId),
    onWarn: (message, detail) => {
      executorLog.debug(`[workflow-column-boundary] ${task.id}: ${message} ${JSON.stringify(detail)}`);
    },
  });
}
