/*
FNXC:PreMergeApproval 2026-09-01-06:53:
FN-9234 requires a singular stale approval to exit through review of CURRENT content, never by
transferring a lane's approval to content it did not inspect. The seed is idle-guarded, so a live
graph continuation wins. Selecting only a stale lane and refusing no-progress makes this route
terminating rather than a merge-retry loop.

FNXC:PreMergeApproval 2026-09-06-00:11:
FN-9264 deliberately defers a stale-content seed that is discovered from a live merge node. The
one-active-task-continuation constraint means excluding or retiring the merge row would race its
runner's terminal transition; the idle self-healing owner seeds only after that row is terminal.
*/
import {
  computeWorkflowIrPin,
  resolveWorkflowIrForTask,
  type MergeContentDescriptor,
  type Task,
  type TaskStore,
  type WorkflowIrNode,
} from "@fusion/core";

export type SingularStaleContentRerouteReason =
  | "seeded"
  | "active-continuation"
  | "no-review-route"
  | "no-progress"
  | "not-singular"
  | "operator-held";

function isContentReviewNode(node: WorkflowIrNode): boolean {
  if (node.kind !== "optional-group" && node.kind !== "step-review") return false;
  const name = typeof node.config?.name === "string" ? node.config.name : "";
  return node.id === "code-review" || node.config?.reviewKind === "code" || /code review/i.test(name);
}

export async function rerouteSingularStaleContentToReview(
  store: TaskStore,
  task: Task,
  options: { requiredPreMergeStepIds: ReadonlySet<string>; mergeContent: MergeContentDescriptor },
): Promise<{ rerouted: boolean; reason: SingularStaleContentRerouteReason; nodeId?: string; workflowStepId?: string }> {
  const mergeContent = options.mergeContent;
  if (mergeContent.kind !== "singular" || task.workspaceWorktrees !== undefined) {
    return { rerouted: false, reason: "not-singular" };
  }
  if (task.paused || task.userPaused || task.deletedAt || task.autoMerge === false) {
    return { rerouted: false, reason: "operator-held" };
  }
  if (mergeContent.diff.state !== "fingerprint") return { rerouted: false, reason: "no-progress" };
  const currentFingerprint = mergeContent.diff.fingerprint;

  const ir = await resolveWorkflowIrForTask(store, task.id);
  const selection = store.getTaskWorkflowSelectionAsync
    ? await store.getTaskWorkflowSelectionAsync(task.id)
    : store.getTaskWorkflowSelection(task.id);
  const selected = selection?.stepIds ?? [];
  const nodes = ir.nodes.filter((node) => {
    if (!isContentReviewNode(node) || !options.requiredPreMergeStepIds.has(node.id)) return false;
    return node.config?.defaultOn === true || selected.includes(node.id);
  });
  const node = nodes.find((candidate) => {
    const latest = task.workflowStepResults?.filter((result) => result.workflowStepId === candidate.id).at(-1);
    return latest?.reviewInputFingerprint !== currentFingerprint;
  });
  if (!node) return { rerouted: false, reason: nodes.length ? "no-progress" : "no-review-route" };

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  const result = await store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:stale-content-review-reroute:${node.id}:${items.length}`,
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
