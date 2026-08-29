/**
 * FNXC:CodeOrganization 2026-08-03-13:45:
 * isRetryableBenignMergePauseAbort peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowLifecycle 2026-06-19-00:05:
 * FN-6735: generic engine pause/resume abort at merge seam is transient only for clean in-review auto-merge candidates.
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-21:40:
 * Review-lane gate uses resolved resume lanes, not default-lineage literals.
 */
import type { Settings, TaskDetail, TaskStore } from "@fusion/core";
import {
  allowsAutoMergeProcessing,
  hasSharedBranchMemberAutoMergeHold,
  resolveEffectiveAutoMerge,
  resolveMaxAutoMergeRetries,
} from "@fusion/core";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";
import { graphFailureValue, isMergeGraphFailure } from "./graph-failure-pure.js";
import { isRetryableMergePauseAbortStatus, isTerminalMergeGraphFailureValue } from "./task-predicates.js";
import type { ResumeLanes } from "./resolve-resume-lanes.js";

export type IsRetryableBenignMergePauseAbortDeps = {
  store: TaskStore;
  resolveResumeLanes: (taskId: string, memo?: { lanes?: ResumeLanes }) => Promise<ResumeLanes>;
  isLiveSharedBranchGroupMember: (live: TaskDetail) => Promise<boolean>;
};

export async function isRetryableBenignMergePauseAbort(
  deps: IsRetryableBenignMergePauseAbortDeps,
  live: TaskDetail,
  result: WorkflowGraphTaskRunResult,
  abortProvenance: PausedAbortProvenance | undefined,
  pausedAborted: boolean,
  resumeLanesMemo?: { lanes?: ResumeLanes },
): Promise<boolean> {
    /*
    FNXC:WorkflowLifecycle 2026-06-19-00:05:
    FN-6735 treats a generic engine pause/resume abort at the merge seam as transient only when the row is still a clean in-review auto-merge candidate: no user/global pause, no pre-existing failure, no merge-confirmed partial landing, no terminal conflict/contamination value, within mergeRetries budget, and still eligible for auto-merge or shared-branch local integration. Anything outside those guards keeps the existing terminal operator-action park.
    */
    if (!pausedAborted) return false;
    if (abortProvenance === "global-pause" || live.userPaused === true) return false;
    if (abortProvenance === "completion-finalize") return false;
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet: executor.ts review-lane classifiers, on top of #2689):
    "IS THIS CARD IN THE REVIEW LANE?" from the task's own workflow. Five pause-abort classifiers asked it
    as the default lineage's literal, and each refusal drops the card through to the operator-action park
    these paths exist to avoid (FN-6796's benign in-review abort, the manual-merge-hold abort, the two
    stale-replay handlers, this retryable merge abort). The literal made the recovery inert, silently.
    */
    if (live.column !== (await deps.resolveResumeLanes(live.id, resumeLanesMemo)).review
      || !isRetryableMergePauseAbortStatus(live.status) || live.error != null) return false;
    if (live.mergeDetails?.mergeConfirmed === true) return false;
    const failureValue = graphFailureValue(result);
    if (isTerminalMergeGraphFailureValue(failureValue)) return false;
    /* FNXC:WorkflowMerge 2026-07-12-17:38: FN-1165 / Runfusion#1991 — missing implementation proof is not a transient merge pause. Let the implementation-incomplete classifier fail closed or requeue resumable parsed steps before any requester can mint a no-branch no-op merge proof. */
    if (failureValue === "implementation-incomplete") return false;
    const failedNode = result.visitedNodeIds[result.visitedNodeIds.length - 1];
    if (!isMergeGraphFailure(failedNode)) return false;
    let settings: Settings | undefined;
    try {
      settings = await deps.store.getSettings();
    } catch {
      return false;
    }
    // FNXC:SharedBranchMemberHold 2026-08-08-01:58: project Off fences every
    // non-opted-in member before the live intermediate-group fast path.
    if (hasSharedBranchMemberAutoMergeHold(live, settings)) return false;
    const sharedBranchMember = await deps.isLiveSharedBranchGroupMember(live);
    if (!sharedBranchMember && !allowsAutoMergeProcessing(live, settings)) return false;
    if (!sharedBranchMember && resolveEffectiveAutoMerge(live, settings) === false) return false;
    if ((live.mergeRetries ?? 0) >= resolveMaxAutoMergeRetries(settings)) return false;
    return true;
}
