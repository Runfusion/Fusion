/*
FNXC:PreMergeApproval 2026-09-02-10:36:
FN-9243 repairs resultless enabled pre-merge gates by seeding the earliest missing gate, never by
inventing a verdict or moving a review-lane card backward. The idle seed lets the real gate inspect
current content and produce its own genuine result.
*/
import {
  computeWorkflowIrPin,
  evaluatePreMergeApprovals,
  resolveWorkflowIrForTask,
  type MergeContentDescriptor,
  type Task,
  type TaskStore,
} from "@fusion/core";

export type UnrunPreMergeGateRerouteReason =
  | "seeded"
  | "active-continuation"
  | "no-unrun-gate"
  | "no-review-route"
  | "not-singular"
  | "operator-held";

export async function rerouteUnrunPreMergeGateToReview(
  store: TaskStore,
  task: Task,
  options: { requiredPreMergeStepIds: ReadonlySet<string>; mergeContent: MergeContentDescriptor },
): Promise<{ rerouted: boolean; reason: UnrunPreMergeGateRerouteReason; nodeId?: string; workflowStepId?: string }> {
  const { mergeContent, requiredPreMergeStepIds } = options;
  if (mergeContent.kind !== "singular" || task.workspaceWorktrees !== undefined) return { rerouted: false, reason: "not-singular" };
  if (task.paused || task.userPaused || task.deletedAt || task.autoMerge === false) return { rerouted: false, reason: "operator-held" };
  if (requiredPreMergeStepIds.size === 0) return { rerouted: false, reason: "no-unrun-gate" };

  const missing = new Set(evaluatePreMergeApprovals(task, { requiredPreMergeStepIds, mergeContent })
    .filter((approval) => approval.state === "missing")
    .map((approval) => approval.workflowStepId));
  if (missing.size === 0) return { rerouted: false, reason: "no-unrun-gate" };

  const ir = await resolveWorkflowIrForTask(store, task.id);
  const node = ir.nodes.find((candidate) => requiredPreMergeStepIds.has(candidate.id) && missing.has(candidate.id));
  if (!node) return { rerouted: false, reason: "no-review-route" };

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  const result = await store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:unrun-pre-merge-gate-reseed:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    targetColumn: node.column ?? task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
  });
  return result.seeded
    ? { rerouted: true, reason: "seeded", nodeId: node.id, workflowStepId: node.id }
    : { rerouted: false, reason: "active-continuation", nodeId: node.id, workflowStepId: node.id };
}
