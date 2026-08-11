/**
 * FNXC:CodeOrganization 2026-08-03-13:45:
 * handleStaleInReviewParsePauseAbortReplay peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowLifecycle 2026-06-29-01:18:
 * Stale parse-node pause/resume replay after in-review auto-retries the graph (safe re-entry).
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-21:40:
 * One resume-lane snapshot for entry gate and deferred scheduleRetry recheck.
 */
import type { Settings, TaskDetail, TaskStore } from "@fusion/core";
import { allowsAutoMergeProcessing } from "@fusion/core";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";
import { isGenericAbortProvenance } from "./paused-abort-provenance.js";
import { graphFailureValue, isStalePauseAbortParkFailure } from "./graph-failure-pure.js";
import { isTerminalMergeGraphFailureValue } from "./task-predicates.js";
import type { ResumeLanes } from "./resolve-resume-lanes.js";
import { generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";
import { executorLog } from "../logger.js";
import { WORKFLOW_NODE_ENGINE_PAUSE_ABORT_KIND } from "../workflows/workflow-graph-executor.js";

const MAX_TRANSIENT_GRAPH_RESUME_RETRIES = 2;
const TRANSIENT_GRAPH_RESUME_RETRY_BACKOFF_MS = process.env.VITEST || process.env.NODE_ENV === "test" ? 0 : 1_000;

export type HandleStaleInReviewParsePauseAbortReplayDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  resolveResumeLanes: (taskId: string, memo?: { lanes?: ResumeLanes }) => Promise<ResumeLanes>;
  isLiveSharedBranchGroupMember: (live: TaskDetail) => Promise<boolean>;
  clearPausedAborted: (taskId: string) => void;
  activeWorktrees: Map<string, Set<string>>;
  activeSessions: Map<string, unknown>;
  activeStepExecutors: Map<string, unknown>;
  activeWorkflowStepSessions: Map<string, unknown>;
  activeWorkflowGraphAbortControllers: Map<string, unknown>;
  processWideGraphRouting: Set<string>;
  persistTokenUsage: (taskId: string) => Promise<void>;
  executeWorkflowGraph: (task: TaskDetail) => Promise<void>;
};

export async function handleStaleInReviewParsePauseAbortReplay(
  deps: HandleStaleInReviewParsePauseAbortReplayDeps,
  live: TaskDetail,
  result: WorkflowGraphTaskRunResult,
  abortProvenance: PausedAbortProvenance | undefined,
  pausedAborted: boolean,
  userCanceled: boolean,
  resumeLanesMemo?: { lanes?: ResumeLanes },
): Promise<boolean> {
    /*
    FNXC:WorkflowLifecycle 2026-06-29-01:18:
    A stale in-review pause/resume replay at `parse` is not an operator action. Unlike `plan`, parse is a safe workflow re-entry point for review rows, so auto-retry the graph with the shared transient resume budget and suppress the parked failure notification.
    */
    if (!pausedAborted) return false;
    if (!isGenericAbortProvenance(abortProvenance) && abortProvenance !== "global-pause") return false;
    if (userCanceled) return false;
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): ONE SNAPSHOT for the entry gate AND the deferred
    recheck inside `scheduleRetry` below — the recheck is the second half of THIS decision ("is the card
    still where it was when we admitted it?"), so resolving the board again inside the timeout callback
    would let a workflow edit make the two halves disagree.
    */
    const replayLanes = await deps.resolveResumeLanes(live.id, resumeLanesMemo);
    if (live.column !== replayLanes.review) return false;
    if (live.paused || live.userPaused === true) return false;
    if (live.autoMerge === false) return false;
    if (live.mergeDetails?.mergeConfirmed === true) return false;
    if (result.interruptedAbortKind && result.interruptedAbortKind !== WORKFLOW_NODE_ENGINE_PAUSE_ABORT_KIND) return false;
    const failedNode = result.interruptedNodeId ?? result.visitedNodeIds[result.visitedNodeIds.length - 1];
    if (failedNode !== "parse") return false;
    const failureValue = typeof result.context?.[`node:${failedNode}:value`] === "string"
      ? result.context[`node:${failedNode}:value`] as string
      : graphFailureValue(result);
    if (failureValue !== "aborted") return false;
    if (isTerminalMergeGraphFailureValue(failureValue)) return false;
    const cleanRow = live.status == null && live.error == null;
    const staleParkedFailure = isStalePauseAbortParkFailure(live, "parse");
    if (!cleanRow && !staleParkedFailure) return false;
    const priorRetries = live.graphResumeRetryCount ?? 0;
    if (priorRetries >= MAX_TRANSIENT_GRAPH_RESUME_RETRIES) return false;
    let settings: Settings;
    try {
      settings = await deps.store.getSettings();
    } catch {
      return false;
    }
    if (settings.globalPause === true || settings.enginePaused === true) return false;
    if (!allowsAutoMergeProcessing(live, settings) && !(await deps.isLiveSharedBranchGroupMember(live))) return false;

    const nextRetries = priorRetries + 1;
    deps.clearPausedAborted(live.id);
    deps.activeWorktrees.delete(live.id);
    const message = `Workflow graph parse node pause/resume replay surfaced after task was already in-review — auto-retrying workflow graph (${nextRetries}/${MAX_TRANSIENT_GRAPH_RESUME_RETRIES})`;
    executorLog.log(`${live.id}: ${message}`);
    await deps.store.logEntry(live.id, message, undefined, deps.getRunContextFor(live.id));
    await deps.store.logEntry(live.id, "Auto-recovered: retrying stale in-review parse pause/resume replay — failure notification suppressed", undefined, deps.getRunContextFor(live.id));
    await deps.store.updateTask(live.id, { graphResumeRetryCount: nextRetries, status: null, error: null }, deps.getRunContextFor(live.id));
    try {
      await deps.store.recordRunAuditEvent?.({
        taskId: live.id,
        agentId: "executor",
        runId: generateSyntheticRunId("workflow-stale-parse-retry", live.id),
        domain: "database",
        mutationType: "task:retry-stale-in-review-parse-pause-abort-replay",
        target: live.id,
        metadata: {
          nodeId: failedNode,
          fromColumn: live.column,
          attempt: nextRetries,
          maxAttempts: MAX_TRANSIENT_GRAPH_RESUME_RETRIES,
          abortProvenance: abortProvenance ?? "unknown",
          clearedStaleFailure: staleParkedFailure,
          mode: "preserved-in-review-retry-graph",
        },
      });
    } catch (error) {
      executorLog.warn(`${live.id}: failed to record stale parse replay retry audit: ${error instanceof Error ? error.message : String(error)}`);
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
            || resumeTask.column !== replayLanes.review
            || deps.activeSessions.has(live.id)
            || deps.activeStepExecutors.has(live.id)
            || deps.activeWorkflowStepSessions.has(live.id)
            || deps.activeWorkflowGraphAbortControllers.has(live.id)
            || deps.processWideGraphRouting.has(live.id)
          ) {
            executorLog.debug(`${live.id}: skipping stale parse graph retry — task is no longer in a safe in-review resume state`);
            return;
          }
          await deps.executeWorkflowGraph(resumeTask);
        } catch (err) {
          executorLog.error(`Failed stale parse graph retry for ${live.id}:`, err);
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
