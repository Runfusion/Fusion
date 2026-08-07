/**
 * FNXC:CodeOrganization 2026-08-03-13:45:
 * routeGraphMergeFailureToRetry peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowMerge 2026-07-12-17:38:
 * FN-1165: never route implementation-incomplete merge failures to the merge requester.
 */
import type { TaskDetail, TaskStore } from "@fusion/core";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";
import { isGenericAbortProvenance } from "./paused-abort-provenance.js";
import { graphFailureValue } from "./graph-failure-pure.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { executorLog } from "../logger.js";

export type RouteGraphMergeFailureToRetryDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  mergeRequester?: ((taskId: string) => Promise<unknown>) | null;
  ensureWorkflowMergeBoundaryTask: (
    live: TaskDetail,
    opts: { reason: string; nodeId: string; workflowId: string; runId: string },
  ) => Promise<TaskDetail>;
  persistTokenUsage: (taskId: string) => Promise<void>;
};

export async function routeGraphMergeFailureToRetry(
  deps: RouteGraphMergeFailureToRetryDeps,
  live: TaskDetail,
  result: WorkflowGraphTaskRunResult,
  abortProvenance: PausedAbortProvenance | undefined,
): Promise<boolean> {
    if (!deps.mergeRequester) return false;
    /* FNXC:WorkflowMerge 2026-07-12-17:38: FN-1165 defense in depth — implementation-incomplete merge graph failures must never reach the merge requester, because a no-branch task can otherwise be finalized as an intentional no-op. */
    if (graphFailureValue(result) === "implementation-incomplete") return false;
    const failedNode = result.visitedNodeIds[result.visitedNodeIds.length - 1] ?? "unknown";
    const message = `Workflow graph merge failure at node '${failedNode}' routed to bounded auto-merge retry${abortProvenance === "merge-seam" ? " after merge-seam abort" : isGenericAbortProvenance(abortProvenance) || abortProvenance === undefined ? " after benign pause/resume abort" : ""}`;
    executorLog.warn(`${live.id}: ${message}`);
    await deps.store.logEntry(live.id, message, undefined, deps.getRunContextFor(live.id));
    try {
      const mergeTask = await deps.ensureWorkflowMergeBoundaryTask(live, {
        reason: "workflow-merge-retry-boundary",
        nodeId: failedNode,
        workflowId: result.context?.["workflow:id"] as string | undefined ?? "workflow-graph",
        runId: deps.getRunContextFor(live.id)?.runId ?? "graph-merge-retry",
      });
      await deps.mergeRequester(mergeTask.id);
    } catch (error) {
      executorLog.warn(`${live.id}: bounded auto-merge retry request failed after graph merge failure: ${error instanceof Error ? error.message : String(error)}`);
    }
    await deps.persistTokenUsage(live.id);
    return true;
}
