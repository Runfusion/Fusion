/**
 * FNXC:CodeOrganization 2026-08-03-13:25:
 * isReentrantPausedAbortedInFlightNode peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowLifecycle 2026-06-28-18:32 / 2026-06-28-21:39:
 * Engine-internal pause aborts re-enter only for typed in-flight node interruptions.
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-21:40:
 * Resume lanes resolved once at top so renamed boards keep FN-7214 terminal rules.
 */
import type { Settings, TaskDetail, TaskStore } from "@fusion/core";
import { allowsAutoMergeProcessing, hasSharedBranchMemberAutoMergeHold } from "@fusion/core";
import type { WorkflowGraphTaskRunResult } from "../workflows/workflow-graph-task-runner.js";
import { WORKFLOW_NODE_ENGINE_PAUSE_ABORT_KIND } from "../workflows/workflow-graph-executor.js";
import type { PausedAbortProvenance } from "./paused-abort-provenance.js";
import { isGenericAbortProvenance } from "./paused-abort-provenance.js";
import { resolveTerminalColumnsFor } from "./lifecycle-columns.js";
import {
  graphFailureValue,
  isMergeGraphFailure,
} from "./graph-failure-pure.js";
import { isTerminalMergeGraphFailureValue } from "./task-predicates.js";
import type { ResumeLanes } from "./resolve-resume-lanes.js";

/** Shared with handleGraphFailure resume paths (kept local to avoid executor-only const coupling). */
const MAX_TRANSIENT_GRAPH_RESUME_RETRIES = 2;

export type IsReentrantPausedAbortedInFlightNodeDeps = {
  store: TaskStore;
  resolveResumeLanes: (
    taskId: string,
    memo?: { lanes?: ResumeLanes },
  ) => Promise<ResumeLanes>;
  isLiveSharedBranchGroupMember: (live: TaskDetail) => Promise<boolean>;
};

export async function isReentrantPausedAbortedInFlightNode(
  deps: IsReentrantPausedAbortedInFlightNodeDeps,
  live: TaskDetail,
  result: WorkflowGraphTaskRunResult,
  abortProvenance: PausedAbortProvenance | undefined,
  pausedAborted: boolean,
  userCanceled: boolean,
  resumeLanesMemo?: { lanes?: ResumeLanes },
): Promise<boolean> {
    /*
    FNXC:WorkflowLifecycle 2026-06-28-18:32:
    FN-7214 makes engine-internal pause aborts re-entrant only when the workflow graph reports a typed in-flight node interruption. User pauses, active global pauses, merge/finalize aborts, genuine node failures, autoMerge:false review rows, and exhausted retry budgets must continue through the existing protected failure paths.

    FNXC:WorkflowLifecycle 2026-06-28-21:39:
    A global engine pause aborts active workflow graph controllers with `global-pause` provenance; after the global pause is lifted, the typed interrupted-node marker is sufficient to re-enter that node. Only active global-pause settings and explicit task/user pauses remain terminal so resume never runs behind an operator-controlled pause.
    */
    if (!pausedAborted) return false;
    if (!isGenericAbortProvenance(abortProvenance) && abortProvenance !== "global-pause") return false;
    if (userCanceled) return false;
    if (live.paused || live.userPaused === true) return false;
    if (live.status != null || live.error != null) return false;
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet: executor.ts — the split-snapshot defect):
    THE LANES ARE RESOLVED HERE, AT THE TOP, because this method already resolved them — at the very END,
    for its return value — while every eligibility check below compared against the default lineage's
    literals. On a renamed board the four `in-review` gates all read false, so a card in review skipped the
    global-pause recheck, the `autoMerge === false` refusal, the shared-branch-member arbitration and the
    merge-confirmed refusal — and then the final line, which DOES resolve lanes, answered "re-entrant".
    FN-7214's comment above says an auto-merge-off review row must stay terminal.
    */
    const resumeLanes = await deps.resolveResumeLanes(live.id, resumeLanesMemo);
    if ((await resolveTerminalColumnsFor(deps.store, live.id)).includes(live.column)) return false;
    if (result.interruptedAbortKind !== WORKFLOW_NODE_ENGINE_PAUSE_ABORT_KIND) return false;
    if (!result.interruptedNodeId) return false;
    if (live.column === resumeLanes.review && result.interruptedNodeId === "plan") return false;
    if (isMergeGraphFailure(result.interruptedNodeId)) return false;
    if (isTerminalMergeGraphFailureValue(graphFailureValue(result))) return false;
    if ((live.graphResumeRetryCount ?? 0) >= MAX_TRANSIENT_GRAPH_RESUME_RETRIES) return false;
    let settings: Settings | undefined;
    if (abortProvenance === "global-pause" || live.column === resumeLanes.review) {
      try {
        settings = await deps.store.getSettings();
      } catch {
        return false;
      }
      if (settings.globalPause === true) return false;
    }
    if (live.column === resumeLanes.review) {
      if (!settings) return false;
      const sharedBranchMember = await deps.isLiveSharedBranchGroupMember(live);
      // FNXC:SharedBranchMemberHold 2026-08-08-01:58: project Off holds each
      // non-opted-in member even after a graph interruption; liveness cannot
      // reopen that manual checkpoint.
      if (hasSharedBranchMemberAutoMergeHold(live, settings) || (live.autoMerge === false && !sharedBranchMember)) return false;
      if (!sharedBranchMember && !allowsAutoMergeProcessing(live, settings)) return false;
      if (live.mergeDetails?.mergeConfirmed === true) return false;
    }
    return live.column === resumeLanes.hold
      || live.column === resumeLanes.review
      || live.column === resumeLanes.wip;
}
