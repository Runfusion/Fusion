/**
 * FNXC:CodeOrganization 2026-08-03-13:45:
 * handleStaleInReviewPlanPauseAbortReplay peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowLifecycle 2026-06-28-21:05:
 * FN-7143: stale plan-node pause/resume replay after in-review is clear/log-only (not a re-entry).
 */
import type { Settings, TaskDetail, TaskStore } from "@fusion/core";
import { allowsAutoMergeProcessing } from "@fusion/core";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";
import { isGenericAbortProvenance } from "./paused-abort-provenance.js";
import { graphFailureValue, isMergeGraphFailure, isStalePauseAbortParkFailure } from "./graph-failure-pure.js";
import { isTerminalMergeGraphFailureValue } from "./task-predicates.js";
import type { ResumeLanes } from "./resolve-resume-lanes.js";
import { generateSyntheticRunId, type EngineRunContext } from "../util/run-audit.js";
import { executorLog } from "../logger.js";
import { WORKFLOW_NODE_ENGINE_PAUSE_ABORT_KIND } from "../workflows/workflow-graph-executor.js";

export type HandleStaleInReviewPlanPauseAbortReplayDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  resolveResumeLanes: (taskId: string, memo?: { lanes?: ResumeLanes }) => Promise<ResumeLanes>;
  isLiveSharedBranchGroupMember: (live: TaskDetail) => Promise<boolean>;
  clearPausedAborted: (taskId: string) => void;
  activeWorktrees: Map<string, Set<string>>;
  persistTokenUsage: (taskId: string) => Promise<void>;
};

export async function handleStaleInReviewPlanPauseAbortReplay(
  deps: HandleStaleInReviewPlanPauseAbortReplayDeps,
  live: TaskDetail,
  result: WorkflowGraphTaskRunResult,
  abortProvenance: PausedAbortProvenance | undefined,
  pausedAborted: boolean,
  userCanceled: boolean,
  resumeLanesMemo?: { lanes?: ResumeLanes },
): Promise<boolean> {
    /*
    FNXC:WorkflowLifecycle 2026-06-28-21:05:
    FN-7143 showed that a stale graph lifecycle replay can surface at `plan` after an in-review pause/resume even though planning is not actually running anymore. Plan is not a safe re-entry point for review rows, typed or generic, so this classifier is clear/log-only: preserve in-review, never route to triage/todo, and keep genuine user/global pauses plus real plan failures on the operator-action path.
    */
    if (!pausedAborted) return false;
    if (!isGenericAbortProvenance(abortProvenance) && abortProvenance !== "global-pause") return false;
    if (userCanceled) return false;
    if (live.column !== (await deps.resolveResumeLanes(live.id, resumeLanesMemo)).review) return false;
    if (live.paused || live.userPaused === true) return false;
    if (live.autoMerge === false) return false;
    if (live.mergeDetails?.mergeConfirmed === true) return false;
    if (result.interruptedAbortKind && result.interruptedAbortKind !== WORKFLOW_NODE_ENGINE_PAUSE_ABORT_KIND) return false;
    const failedNode = result.interruptedNodeId ?? result.visitedNodeIds[result.visitedNodeIds.length - 1];
    if (failedNode !== "plan") return false;
    if (isMergeGraphFailure(failedNode)) return false;
    const failureValue = typeof result.context?.[`node:${failedNode}:value`] === "string"
      ? result.context[`node:${failedNode}:value`] as string
      : graphFailureValue(result);
    if (failureValue !== "aborted") return false;
    if (isTerminalMergeGraphFailureValue(failureValue)) return false;
    const cleanRow = live.status == null && live.error == null;
    const staleParkedFailure = isStalePauseAbortParkFailure(live, "plan");
    if (!cleanRow && !staleParkedFailure) return false;
    let settings: Settings;
    try {
      settings = await deps.store.getSettings();
    } catch {
      return false;
    }
    if (settings.globalPause === true || settings.enginePaused === true) return false;
    if (!allowsAutoMergeProcessing(live, settings) && !(await deps.isLiveSharedBranchGroupMember(live))) return false;

    deps.clearPausedAborted(live.id);
    deps.activeWorktrees.delete(live.id);
    const message = "Workflow graph plan node pause/resume replay surfaced after task was already in-review — stale replay ignored, in-review state preserved";
    executorLog.log(`${live.id}: ${message}`);
    await deps.store.logEntry(live.id, message, undefined, deps.getRunContextFor(live.id));
    if (staleParkedFailure) {
      await deps.store.updateTask(live.id, { status: null, error: null }, deps.getRunContextFor(live.id));
      await deps.store.logEntry(live.id, "Auto-recovered: cleared stale in-review plan pause/resume replay failure — failure notification suppressed", undefined, deps.getRunContextFor(live.id));
    }
    try {
      await deps.store.recordRunAuditEvent?.({
        taskId: live.id,
        agentId: "executor",
        runId: generateSyntheticRunId("workflow-stale-plan-replay", live.id),
        domain: "database",
        mutationType: "task:classify-stale-in-review-plan-pause-abort-replay",
        target: live.id,
        metadata: {
          nodeId: failedNode,
          fromColumn: live.column,
          abortProvenance,
          clearedStaleFailure: staleParkedFailure,
          graphResumeRetryCount: live.graphResumeRetryCount ?? 0,
          mode: "preserved-in-review",
        },
      });
    } catch (error) {
      executorLog.warn(`${live.id}: failed to record stale plan replay audit: ${error instanceof Error ? error.message : String(error)}`);
    }
    await deps.persistTokenUsage(live.id);
    return true;
}
