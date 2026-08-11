/**
 * FNXC:CodeOrganization 2026-08-03-18:00:
 * buildColumnBoundaryHooks peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowColumnBoundary 2026-07-27-16:40 (PR #2475 review, P2):
 * Wiring lives in createExecutorColumnBoundaryHooks; this only threads Executor
 * state (in-flight graph-move marker + logger).
 */
import type { Task, TaskStore } from "@fusion/core";
import type { WorkflowColumnBoundaryHooks } from "../workflows/workflow-graph-task-runner.js";
import { createExecutorColumnBoundaryHooks } from "../workflow-column-boundary-hooks.js";
import { executorLog } from "../logger.js";

export type BuildColumnBoundaryHooksDeps = {
  store: TaskStore;
  workflowLifecycleMovesInFlight: Set<string>;
};

export function buildColumnBoundaryHooks(
  deps: BuildColumnBoundaryHooksDeps,
  task: Pick<Task, "id">,
  workflowRunId?: string,
): WorkflowColumnBoundaryHooks {
  return createExecutorColumnBoundaryHooks({
    store: deps.store,
    task,
    workflowRunId,
    markMoveInFlight: (taskId) => deps.workflowLifecycleMovesInFlight.add(taskId),
    clearMoveInFlight: (taskId) => deps.workflowLifecycleMovesInFlight.delete(taskId),
    onWarn: (message, detail) => {
      executorLog.debug(`[workflow-column-boundary] ${task.id}: ${message} ${JSON.stringify(detail)}`);
    },
  });
}
