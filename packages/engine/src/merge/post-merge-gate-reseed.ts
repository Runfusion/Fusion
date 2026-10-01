import {
  allowsAutoMergeProcessing,
  computeWorkflowIrPin,
  getPostMergeFinalizeBlocker,
  isWorkflowOptionalGroupEnabled,
  resolveWorkflowIrForTaskWithProvenance,
  type TaskStore,
} from "@fusion/core";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { isTaskExecutionLive } from "./merge-execution-exclusion.js";

/**
 * FNXC:PostMergeRecovery 2026-10-01-04:43:
 * A landed card with an absent post-merge gate must resume at that gate, not repeatedly try to
 * finalize or rerun implementation/merge. Existing results (including REVISE) remain authoritative.
 * The idle, snapshot-fenced insert preserves live graph ownership and operator holds.
 */
export async function resumeMissingPostMergeGate(store: TaskStore, taskId: string): Promise<boolean> {
  if (typeof store.seedWorkspaceCodeReviewContinuationIfIdle !== "function") return false;
  const task = await store.getTask(taskId);
  const settings = await store.getSettings();
  if (!task.mergeDetails?.mergeConfirmed || !task.updatedAt
    || task.paused || task.userPaused || task.deletedAt || task.autoMerge === false
    || settings.globalPause || settings.enginePaused
    || !allowsAutoMergeProcessing(task, settings)
    || getPostMergeFinalizeBlocker(task)
    || isTaskExecutionLive(task.id, { activeSessionRegistry, executingTaskLock })) return false;

  const selection = await store.getTaskWorkflowSelectionAsync(task.id);
  const resolved = await resolveWorkflowIrForTaskWithProvenance(store, task.id);
  if (resolved.source === "default" && !resolved.selectionAbsent) return false;
  const { ir } = resolved;
  if (ir.version !== "v2") return false;
  const gates = ir.nodes.filter((node) => {
    if (node.kind !== "optional-group" || node.config?.phase !== "post-merge") return false;
    const template = node.config.template as { nodes?: Array<{ config?: { gateMode?: unknown } }> } | undefined;
    return template?.nodes?.some((inner) => inner.config?.gateMode === "gate")
      && isWorkflowOptionalGroupEnabled(task.enabledWorkflowSteps, node.id, node.config.defaultOn === true);
  });
  const node = gates.find((gate) => {
    const result = task.workflowStepResults?.find((entry) => entry.workflowStepId === gate.id);
    return !result || result.status !== "passed" || !["APPROVE", "APPROVE_WITH_NOTES"].includes(result.verdict ?? "");
  });
  if (!node || task.workflowStepResults?.some((entry) => entry.workflowStepId === node.id)) return false;

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  const seeded = await store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:post-merge-gate-reseed:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    targetColumn: task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
    expectedWorkflowSelection: selection ?? null,
    expectedTaskUpdatedAt: task.updatedAt,
  });
  if (!seeded.seeded) return false;
  await store.logEntry(task.id, `[post-merge] Resuming missing verification at '${node.id}'; already-landed implementation and merge will not run again.`);
  return true;
}
