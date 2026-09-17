import type { Task } from "../types.js";
import type { WorkflowIr, WorkflowIrV2 } from "../workflows/workflow-ir-types.js";
import { resolveColumnFlags } from "../workflows/trait-registry.js";
import { resolveRequiredPreMergeStepIds } from "../merge/required-pre-merge-steps.js";
import { workflowDeclaresColumnModel } from "../workflows/workflow-transitions.js";
import { buildManualRetryResetPatch } from "./manual-retry-reset.js";

export const RESTART_STAGE_FENCE_REASON = "restart-stage-publishing";

export type TaskColumnRestartScope = "plan" | "implementation" | "review" | "generic";

export interface TaskColumnRestartEntryNode {
  id: string;
  column?: string;
}

export interface TaskColumnRestartPlan {
  kind: "restart";
  columnId: string;
  scope: TaskColumnRestartScope;
  entryNodeId: string;
  columnNodeIds: string[];
  discardedWorkflowStepIds: string[];
  deletePrompt: boolean;
  releaseSymbolLocks: boolean;
  preservedWork: boolean;
  patch: Partial<Task>;
}

export interface TaskColumnRestartRefusal {
  kind: "refused";
  reason: "terminal-column" | "column-not-in-workflow" | "no-column-model" | "no-entry-node-in-column";
  detail?: { resolvedEntryNodeId?: string; resolvedEntryNodeColumn?: string };
}

/*
FNXC:TaskRecoveryVocabulary 2026-08-28-00:38:
FN-206 calls this operation Retry in operator-facing surfaces. The module and durable publication
fence retain their restart-stage names so existing parked task state remains recognizable.

FNXC:ColumnRestart 2026-08-28-00:00:
Retry uses the current column's traits, rather than column ids, so renamed and custom boards
preserve their lifecycle meaning. Review wins over WIP and WIP wins over hold/intake because a
multi-trait column must have one deterministic artifact boundary.

`resolveColumnResumeNode` may deliberately answer with the first node at or after a card column.
For a pure hold column without a node, that answer belongs to a later column; accepting it would
discard this stage and silently skip it. Restart therefore requires exact column equality before
any caller can publish a mutation.

Pre-merge results are discarded only for nodes in the restarted column. Review additionally drops
failed/pending undeclared results: merge blocking inspects those statuses even when no graph node
can rerun them. Passed/skipped orphans remain earlier-stage evidence, and post-merge results are
never discarded, including a post-merge node placed in this column.

Pause lifecycle is intentionally absent from this patch. `updateTask` cannot write `userPaused`,
and the publisher's pauseTask fence/unfence atomically owns paused, userPaused, pausedReason, and
pausedByAgentId. Keeping those writes separate prevents the planner patch from disagreeing with
the durable publication fence.

FNXC:ColumnRestart 2026-08-28-15:15:
Workspace rows restart through the same scope plan as single-repository rows, but the patch never
writes `workspaceWorktrees`. That map is the canonical workspace merge-routing discriminator, and
its per-repository writes belong to `mergeWorkspaceWorktreeEntryImpl` under the task advisory lock;
a wholesale restart write would both risk routing into the single-repository merger and reopen the
Phase-B sibling-clobber race. Implementation restart still clears the singular `worktree` and
`branch` aliases because null is the healthy workspace steady state, while each remembered
repository checkout is independently liveness-checked before re-acquisition.

FNXC:ColumnRestart 2026-09-17-09:16:
FN-499 adds an opt-in preserve-work mode for the WIP scope only. An operator who replays the
current step must keep the artifacts that step is still producing, so the preserving branch writes
neither the execution artifacts (`worktree`, `branch`, `baseCommitSha`, `summary`, `modifiedFiles`,
`declaredSymbols`, `scopeAutoWiden`, `executionStartBranch`, `executionStartedAt`) nor `currentStep`.
Only `in-progress` steps fall back to `pending` so the interrupted step reruns while completed work
stays completed, and `executionCompletedAt` is cleared so a stale completion cannot survive the
replay. `releaseSymbolLocks` is false in this mode for the same reason: the card still owns its
checkout, so handing its symbol locks to another task would strand live work. The shared patch and
the workflow-step-result discard predicate are deliberately identical in both modes so the graph
node can always rerun. Preserve-work is rejected for plan/review/generic scopes because those
scopes own no in-flight implementation artifacts to keep.
*/
export function planTaskColumnRestart(input: {
  task: Task;
  ir: WorkflowIr | undefined;
  entryNode: TaskColumnRestartEntryNode | undefined;
  now?: string;
  preserveWork?: boolean;
}): TaskColumnRestartPlan | TaskColumnRestartRefusal {
  const { task, ir, entryNode } = input;
  if (!ir || !workflowDeclaresColumnModel(ir)) return { kind: "refused", reason: "no-column-model" };

  const columns = (ir as WorkflowIrV2).columns;
  const column = columns.find((candidate) => candidate.id === task.column);
  if (!column) return { kind: "refused", reason: "column-not-in-workflow" };
  const flags = resolveColumnFlags(column);
  if (flags.complete) return { kind: "refused", reason: "terminal-column" };
  if (!entryNode || entryNode.column !== task.column) {
    return {
      kind: "refused",
      reason: "no-entry-node-in-column",
      ...(entryNode ? { detail: { resolvedEntryNodeId: entryNode.id, resolvedEntryNodeColumn: entryNode.column } } : {}),
    };
  }

  const scope: TaskColumnRestartScope = flags.mergeBlocker || flags.humanReview
    ? "review"
    : flags.countsTowardWip
      ? "implementation"
      : flags.intake || flags.hold
        ? "plan"
        : "generic";
  const preservedWork = input.preserveWork === true && scope === "implementation";
  const columnNodeIds = ir.nodes.filter((node) => node.column === task.column).map((node) => node.id);
  const columnNodeIdSet = new Set(columnNodeIds);
  const declaredNodeIds = new Set(ir.nodes.map((node) => node.id));
  const requiredPreMergeStepIds = resolveRequiredPreMergeStepIds(ir, task.enabledWorkflowSteps, task);
  /*
  FNXC:BlockingGateRetry 2026-09-12-22:54:
  A review Retry clears a failed or pending enabled required gate from an earlier column only to make
  it missing. The merge door still refuses missing evidence, while the in-place FN-9243 reseed reruns
  the real gate without a backward lifecycle move or implementation replay.
  */
  const shouldDiscard = (result: NonNullable<Task["workflowStepResults"]>[number]): boolean => {
    if ((result.phase ?? "pre-merge") === "post-merge" || result.bypassedBy) return false;
    if (columnNodeIdSet.has(result.workflowStepId)) return true;
    return scope === "review"
      && (result.status === "failed" || result.status === "pending")
      && (!declaredNodeIds.has(result.workflowStepId) || requiredPreMergeStepIds.has(result.workflowStepId));
  };
  const workflowStepResults = (task.workflowStepResults ?? []).filter((result) => !shouldDiscard(result));
  // Keep the discard predicate separate so duplicate workflow-step attempts stay observable.
  const discarded = (task.workflowStepResults ?? []).filter(shouldDiscard);
  const now = input.now ?? new Date().toISOString();
  const patch: Partial<Task> = {
    ...buildManualRetryResetPatch({ resetMergeRetries: true }),
    status: null as unknown as Task["status"],
    error: null as unknown as Task["error"],
    pausedByAgentId: null as unknown as Task["pausedByAgentId"],
    checkedOutBy: null as unknown as Task["checkedOutBy"],
    checkedOutAt: null as unknown as Task["checkedOutAt"],
    checkoutNodeId: null as unknown as Task["checkoutNodeId"],
    checkoutRunId: null as unknown as Task["checkoutRunId"],
    checkoutLeaseRenewedAt: null as unknown as Task["checkoutLeaseRenewedAt"],
    sessionFile: null as unknown as Task["sessionFile"],
    effectiveNodeId: null as unknown as Task["effectiveNodeId"],
    effectiveNodeSource: null as unknown as Task["effectiveNodeSource"],
    workflowIrPin: null as unknown as Task["workflowIrPin"],
    workflowIrPinNodeId: null as unknown as Task["workflowIrPinNodeId"],
    workflowIrPinColumnId: null as unknown as Task["workflowIrPinColumnId"],
    blockedBy: null as unknown as Task["blockedBy"],
    overlapBlockedBy: null as unknown as Task["overlapBlockedBy"],
    executeRequeueLoopSignature: null as unknown as Task["executeRequeueLoopSignature"],
    resumeLimboTipSha: null as unknown as Task["resumeLimboTipSha"],
    resumeLimboStepSignature: null as unknown as Task["resumeLimboStepSignature"],
    columnMovedAt: now,
    workflowStepResults,
    updatedAt: now,
  };

  if (scope === "plan") {
    Object.assign(patch, {
      status: "needs-replan",
      steps: [],
      currentStep: 0,
      approvedPlanFingerprint: null as unknown as Task["approvedPlanFingerprint"],
      awaitingApprovalReason: null as unknown as Task["awaitingApprovalReason"],
    });
  } else if (scope === "implementation" && preservedWork) {
    Object.assign(patch, {
      // Terminal steps stay as delivered; every non-terminal step (including the interrupted one) returns to `pending` so the card replays exactly the work that did not finish.
      steps: task.steps.map((step) => (step.status === "done" || step.status === "skipped" ? { ...step } : { ...step, status: "pending" })),
      executionCompletedAt: null as unknown as Task["executionCompletedAt"],
    });
  } else if (scope === "implementation") {
    Object.assign(patch, {
      steps: task.steps.map((step) => ({ ...step, status: "pending" })),
      currentStep: 0,
      worktree: null as unknown as Task["worktree"],
      branch: null as unknown as Task["branch"],
      branchWriteOrigin: "engine",
      executionStartBranch: null as unknown as Task["executionStartBranch"],
      baseCommitSha: null as unknown as Task["baseCommitSha"],
      executionStartedAt: null as unknown as Task["executionStartedAt"],
      executionCompletedAt: null as unknown as Task["executionCompletedAt"],
      summary: null as unknown as Task["summary"],
      modifiedFiles: [],
      declaredSymbols: [],
      scopeAutoWiden: [],
    });
  } else if (scope === "review") {
    Object.assign(patch, {
      review: null as unknown as Task["review"],
      reviewState: null as unknown as Task["reviewState"],
      mergeDetails: null as unknown as Task["mergeDetails"],
      aiMergeReviewReconciliation: null as unknown as Task["aiMergeReviewReconciliation"],
      awaitingApprovalReason: null as unknown as Task["awaitingApprovalReason"],
    });
  }

  return {
    kind: "restart",
    columnId: task.column,
    scope,
    entryNodeId: entryNode.id,
    columnNodeIds,
    discardedWorkflowStepIds: discarded.map((result) => result.workflowStepId),
    deletePrompt: scope === "plan",
    releaseSymbolLocks: scope === "implementation" && !preservedWork,
    preservedWork,
    patch,
  };
}
