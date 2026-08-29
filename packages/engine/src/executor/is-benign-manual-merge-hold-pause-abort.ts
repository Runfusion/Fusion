/**
 * FNXC:CodeOrganization 2026-08-03-13:45:
 * isBenignManualMergeHoldPauseAbort peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowLifecycle 2026-07-09-14:54:
 * FN-7749: with auto-merge off, benign pause/resume abort at merge-region must preserve in-review.
 *
 * FNXC:AutoMergeHold 2026-07-09-17:07:
 * Exclude only live shared-group integrations; stale shared-group members are standalone holds.
 */
import type { Settings, TaskDetail, TaskStore } from "@fusion/core";
import { allowsAutoMergeProcessing, hasSharedBranchMemberAutoMergeHold, resolveEffectiveAutoMerge } from "@fusion/core";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";
import { isGenericAbortProvenance } from "./paused-abort-provenance.js";
import { graphFailureValue, isMergeGraphFailure, isStalePauseAbortParkFailure } from "./graph-failure-pure.js";
import { isTerminalMergeGraphFailureValue } from "./task-predicates.js";
import type { ResumeLanes } from "./resolve-resume-lanes.js";

export type IsBenignManualMergeHoldPauseAbortDeps = {
  store: TaskStore;
  resolveResumeLanes: (taskId: string, memo?: { lanes?: ResumeLanes }) => Promise<ResumeLanes>;
  isLiveSharedBranchGroupMember: (live: TaskDetail) => Promise<boolean>;
};

export async function isBenignManualMergeHoldPauseAbort(
  deps: IsBenignManualMergeHoldPauseAbortDeps,
  live: TaskDetail,
  result: WorkflowGraphTaskRunResult,
  abortProvenance: PausedAbortProvenance | undefined,
  pausedAborted: boolean,
  resumeLanesMemo?: { lanes?: ResumeLanes },
): Promise<boolean> {
    /*
    FNXC:WorkflowLifecycle 2026-07-09-14:54:
    FN-7749 / Runfusion#1979: with auto-merge off, a manual merge hold is the healthy `in-review` resting state for Merge & Close. A benign generic (`hard-cancel`/`engine-abort`, KB-PROV 2026-07-26) pause/resume abort at any merge-region node must not park the task failed; FN-5147 forbids moving, failing, or re-enqueueing the row, so this classifier only permits preserving `in-review` and clearing a stale pause-abort status/error.
    */
    if (!pausedAborted) return false;
    if (!isGenericAbortProvenance(abortProvenance)) return false;
    if (live.paused || live.userPaused === true) return false;
    if (live.column !== (await deps.resolveResumeLanes(live.id, resumeLanesMemo)).review) return false;
    if (live.mergeDetails?.mergeConfirmed === true) return false;
    if (isTerminalMergeGraphFailureValue(graphFailureValue(result))) return false;
    const failedNode = result.visitedNodeIds[result.visitedNodeIds.length - 1];
    if (!isMergeGraphFailure(failedNode)) return false;
    const cleanRow = live.status == null && live.error == null;
    const staleParkedFailure = isStalePauseAbortParkFailure(live, failedNode);
    if (!cleanRow && !staleParkedFailure) return false;
    let settings: Settings | undefined;
    try {
      settings = await deps.store.getSettings();
    } catch {
      return false;
    }
    /* FNXC:AutoMergeHold 2026-07-09-17:07 / FNXC:SharedBranchMemberHold 2026-08-08-01:58: exclude only live shared-group integrations from the benign manual-hold classifier; project Off holds non-opted-in members. */
    const sharedMemberHold = hasSharedBranchMemberAutoMergeHold(live, settings);
    if (await deps.isLiveSharedBranchGroupMember(live) && !sharedMemberHold) return false;
    return sharedMemberHold
      || !allowsAutoMergeProcessing(live, settings)
      || resolveEffectiveAutoMerge(live, settings) === false;
}
