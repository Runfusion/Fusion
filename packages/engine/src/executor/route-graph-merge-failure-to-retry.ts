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
import { MERGE_BOUNDARY_UNPROVEN_VALUE } from "../workflows/workflow-merge-nodes.js";
import { emitMergeBoundaryUnprovenParked } from "./emit-merge-boundary-unproven-audit.js";
import type { MergeBoundaryUnprovenReasonCode } from "./workflow-merge-boundary.js";

export type RouteGraphMergeFailureToRetryDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  runContextFor: (taskId: string, fallbackAgentId?: string | null) => import("@fusion/core").RunMutationContext;
  mergeRequester?: ((taskId: string) => Promise<unknown>) | null;
  ensureWorkflowMergeBoundaryTask: (
    live: TaskDetail,
    opts: { reason: string; nodeId: string; workflowId: string; runId: string },
  ) => Promise<{
    task: TaskDetail;
    blocked?: {
      reason: string;
      code: MergeBoundaryUnprovenReasonCode;
      missingInstanceCount: number;
    };
  }>;
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
    await deps.store.logEntry(live.id, message, undefined, deps.runContextFor(live.id));
    try {
      const mergeBoundary = await deps.ensureWorkflowMergeBoundaryTask(live, {
        reason: "workflow-merge-retry-boundary",
        nodeId: failedNode,
        workflowId: result.context?.["workflow:id"] as string | undefined ?? "workflow-graph",
        runId: deps.getRunContextFor(live.id)?.runId ?? "graph-merge-retry",
      });
      /*
      FNXC:WorkflowMerge 2026-08-20-00:50:
      FN-9157 forbids a bounded retry from repeating an unprovable boundary check.
      Park visibly so the existing failed-status lease rule releases overlapping
      work, rather than silently retaining an in-review blocker.
      */
      if (mergeBoundary.blocked) {
        const { reason, code, missingInstanceCount } = mergeBoundary.blocked;
        await deps.store.logEntry(live.id, `Workflow merge boundary retry parked task: ${reason}`, undefined, deps.runContextFor(live.id));
        const outcome = mergeBoundary.task.status !== "failed" || !mergeBoundary.task.error
          ? "parked" as const
          : "already-terminal" as const;
        if (outcome === "parked") {
          await deps.store.updateTask(
            live.id,
            { status: "failed", error: `${MERGE_BOUNDARY_UNPROVEN_VALUE.toUpperCase().replaceAll("-", "_")}: ${reason}` },
            deps.runContextFor(live.id),
          );
        }
        /*
        FNXC:RunAudit 2026-08-20-02:00:
        FN-9168 records exactly one terminal merge-boundary-unproven park here. The boundary
        helper's blocked return is not a park and remains silent; its bounded audit seam contains
        failure and hangs, so telemetry cannot delay or alter this terminal write or return path.
        */
        await emitMergeBoundaryUnprovenParked(deps.store, {
          taskId: live.id,
          nodeId: failedNode,
          failureValue: MERGE_BOUNDARY_UNPROVEN_VALUE,
          source: "retry-boundary",
          reasonCode: code,
          missingInstanceCount,
          priorColumn: live.column,
          priorStatus: live.status,
          outcome,
          runId: deps.getRunContextFor(live.id)?.runId,
        });
        await deps.persistTokenUsage(live.id);
        return true;
      }
      await deps.mergeRequester(mergeBoundary.task.id);
    } catch (error) {
      executorLog.warn(`${live.id}: bounded auto-merge retry request failed after graph merge failure: ${error instanceof Error ? error.message : String(error)}`);
    }
    await deps.persistTokenUsage(live.id);
    return true;
}
