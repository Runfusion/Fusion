import {
  computeWorkflowIrPin,
  resolveWorkflowIrForTask,
  type Task,
  type TaskStore,
  type WorkflowIrNode,
} from "@fusion/core";

function isCodeReviewNode(node: WorkflowIrNode): boolean {
  if (node.kind !== "optional-group" && node.kind !== "step-review") return false;
  const name = typeof node.config?.name === "string" ? node.config.name : "";
  return node.id === "code-review"
    || node.config?.reviewKind === "code"
    || /code review/i.test(name);
}

/**
 * Seed exactly one durable Code Review owner after workspace landing rejects stale evidence.
 * A live continuation wins the race; it will consume the graph's own rework path instead.
 */
export async function rerouteWorkspaceReviewToCodeReview(
  store: TaskStore,
  task: Task,
): Promise<{ rerouted: boolean; reason: "seeded" | "active-continuation" | "no-code-review-route" }> {
  const ir = await resolveWorkflowIrForTask(store, task.id);
  const node = ir.nodes.find(isCodeReviewNode);
  if (!node) return { rerouted: false, reason: "no-code-review-route" };

  const selection = store.getTaskWorkflowSelectionAsync
    ? await store.getTaskWorkflowSelectionAsync(task.id)
    : store.getTaskWorkflowSelection(task.id);
  const selected = selection?.stepIds ?? [];
  const defaultOn = node.config?.defaultOn === true;
  if (!defaultOn && !selected.includes(node.id)) return { rerouted: false, reason: "no-code-review-route" };

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  const result = await store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:workspace-review-reroute:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    targetColumn: node.column ?? task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
  });
  return result.seeded
    ? { rerouted: true, reason: "seeded" }
    : { rerouted: false, reason: "active-continuation" };
}
