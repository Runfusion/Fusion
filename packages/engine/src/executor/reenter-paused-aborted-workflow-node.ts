/**
 * FNXC:CodeOrganization 2026-08-03-13:30:
 * reenterPausedAbortedWorkflowNode peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-16:05:
 * Re-entry uses one resume-lane snapshot so renamed boards preserve in-review re-entry.
 */
import type { TaskDetail, TaskStore } from "@fusion/core";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";
import { generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";
import { executorLog } from "../logger.js";
import type { ResumeLanes } from "./resolve-resume-lanes.js";

const MAX_TRANSIENT_GRAPH_RESUME_RETRIES = 2;
const TRANSIENT_GRAPH_RESUME_RETRY_BACKOFF_MS = process.env.VITEST || process.env.NODE_ENV === "test" ? 0 : 1_000;

export type ReenterPausedAbortedWorkflowNodeDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  resolveResumeLanes: (taskId: string, memo?: { lanes?: ResumeLanes }) => Promise<ResumeLanes>;
  clearPausedAborted: (taskId: string) => void;
  activeWorktrees: Map<string, Set<string>>;
  activeSessions: Map<string, unknown>;
  activeStepExecutors: Map<string, unknown>;
  activeWorkflowStepSessions: Map<string, unknown>;
  activeWorkflowGraphAbortControllers: Map<string, unknown>;
  processWideGraphRouting: Set<string>;
  persistTokenUsage: (taskId: string) => Promise<void>;
  executeWorkflowGraph: (task: TaskDetail) => Promise<void>;
  execute: (task: TaskDetail) => Promise<void>;
};

export async function reenterPausedAbortedWorkflowNode(
  deps: ReenterPausedAbortedWorkflowNodeDeps,
  live: TaskDetail,
  result: WorkflowGraphTaskRunResult,
  abortProvenance: PausedAbortProvenance | undefined,
  resumeLanesMemo?: { lanes?: ResumeLanes },
): Promise<boolean> {
    const nodeId = result.interruptedNodeId ?? result.visitedNodeIds[result.visitedNodeIds.length - 1] ?? "unknown";
    const priorRetries = live.graphResumeRetryCount ?? 0;
    if (priorRetries >= MAX_TRANSIENT_GRAPH_RESUME_RETRIES) return false;
    const nextRetries = priorRetries + 1;
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-16:05: resolved ONCE for the whole re-entry —
    `preservedInReview`, the audit `mode` label, the resume-safety recheck, and the branch that
    picks execute() vs executeWorkflowGraph() must all agree on which column is which. They were
    four independent literal comparisons, so on a renamed board `preservedInReview` was false for
    a card in review AND the recheck rejected it, and the re-entry silently never happened.
    */
    const reentryLanes = await deps.resolveResumeLanes(live.id, resumeLanesMemo);
    const preservedInReview = live.column === reentryLanes.review;
    deps.clearPausedAborted(live.id);
    deps.activeWorktrees.delete(live.id);
    const message = `Workflow graph node '${nodeId}' was interrupted by engine pause/resume — re-entering workflow graph (${nextRetries}/${MAX_TRANSIENT_GRAPH_RESUME_RETRIES})`;
    executorLog.log(`${live.id}: ${message}`);
    await deps.store.logEntry(live.id, message, undefined, deps.getRunContextFor(live.id));
    await deps.store.logEntry(live.id, `Auto-recovered: re-entering paused-aborted workflow graph node '${nodeId}' — failure notification suppressed`, undefined, deps.getRunContextFor(live.id));
    await deps.store.updateTask(live.id, { graphResumeRetryCount: nextRetries, status: null, error: null }, deps.getRunContextFor(live.id));
    try {
      await deps.store.recordRunAuditEvent?.({
        taskId: live.id,
        agentId: "executor",
        runId: generateSyntheticRunId("workflow-node-reentry", live.id),
        domain: "database",
        mutationType: "task:reenter-paused-aborted-workflow-node",
        target: live.id,
        metadata: {
          nodeId,
          fromColumn: live.column,
          attempt: nextRetries,
          maxAttempts: MAX_TRANSIENT_GRAPH_RESUME_RETRIES,
          abortProvenance: abortProvenance ?? "unknown",
          preservedInReview,
          mode: preservedInReview ? "preserved-in-review" : live.column === reentryLanes.hold ? "reexecuted-from-todo" : "reentered-graph",
        },
      });
    } catch (error) {
      executorLog.warn(`${live.id}: failed to record paused-node graph re-entry audit: ${error instanceof Error ? error.message : String(error)}`);
    }
    await deps.persistTokenUsage(live.id);

    const scheduleRetry = () => {
      void (async () => {
        try {
          const resumeTask = await deps.store.getTask(live.id);
          if (
            resumeTask.deletedAt
            || resumeTask.paused
            || resumeTask.userPaused
            || resumeTask.status != null
            || resumeTask.error != null
            || (preservedInReview
              ? resumeTask.column !== reentryLanes.review
              : resumeTask.column !== reentryLanes.hold && resumeTask.column !== reentryLanes.wip)
            || deps.activeSessions.has(live.id)
            || deps.activeStepExecutors.has(live.id)
            || deps.activeWorkflowStepSessions.has(live.id)
            || deps.activeWorkflowGraphAbortControllers.has(live.id)
            || deps.processWideGraphRouting.has(live.id)
          ) {
            executorLog.debug(`${live.id}: skipping paused-node graph re-entry — task is no longer in a safe resume state`);
            return;
          }
          if (preservedInReview) {
            await deps.executeWorkflowGraph(resumeTask);
          } else if (resumeTask.column === reentryLanes.hold) {
            await deps.execute(resumeTask);
          } else {
            await deps.executeWorkflowGraph(resumeTask);
          }
        } catch (err) {
          executorLog.error(`Failed paused-node graph re-entry for ${live.id}:`, err);
        }
      })();
    };
    if (TRANSIENT_GRAPH_RESUME_RETRY_BACKOFF_MS > 0) {
      const handle = setTimeout(scheduleRetry, TRANSIENT_GRAPH_RESUME_RETRY_BACKOFF_MS);
      handle.unref?.();
    } else {
      setTimeout(scheduleRetry, 0).unref?.();
    }
    return true;
}
