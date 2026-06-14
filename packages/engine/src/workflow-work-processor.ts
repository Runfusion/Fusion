import type { Settings, WorkflowWorkItem, WorkflowWorkItemKind, WorkflowWorkItemState } from "@fusion/core";
import { claimDueWorkflowWorkItem, type WorkflowWorkSchedulerStore } from "./workflow-work-scheduler.js";
import { WorkflowTaskRuntime, type WorkflowTaskRuntimeResult } from "./workflow-task-runtime.js";

export interface WorkflowWorkProcessorOptions {
  leaseOwner: string;
  leaseDurationMs: number;
  now?: string;
  kinds?: WorkflowWorkItemKind[];
}

export interface WorkflowWorkProcessorResult {
  claimed: boolean;
  workItemId?: string;
  taskId?: string;
  runtime?: WorkflowTaskRuntimeResult;
}

type WorkflowWorkProcessorStore = WorkflowWorkSchedulerStore & {
  transitionWorkflowWorkItem?: (
    id: string,
    state: WorkflowWorkItemState,
    patch?: { now?: string; lastError?: string | null; leaseOwner?: string | null; leaseExpiresAt?: string | null },
  ) => WorkflowWorkItem;
};

export async function processDueWorkflowWorkItem(
  store: WorkflowWorkProcessorStore,
  runtime: WorkflowTaskRuntime,
  settings: (Pick<Settings, "experimentalFeatures"> & Partial<Settings>) | undefined,
  opts: WorkflowWorkProcessorOptions,
): Promise<WorkflowWorkProcessorResult> {
  const dispatch = claimDueWorkflowWorkItem(store, {
    now: opts.now,
    leaseOwner: opts.leaseOwner,
    leaseDurationMs: opts.leaseDurationMs,
    kinds: opts.kinds,
  });
  if (!dispatch) return { claimed: false };

  let runtimeResult: WorkflowTaskRuntimeResult;
  try {
    runtimeResult = await runtime.runWorkItem(dispatch.workItem, settings);
  } catch (err) {
    const reason = `workflow-work-item-runtime-error:${err instanceof Error ? err.message : String(err)}`;
    try {
      store.transitionWorkflowWorkItem?.(dispatch.workItem.id, "failed", {
        now: opts.now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: reason,
      });
    } catch {
      // Best-effort cleanup; callers still need the claimed work identity on double-failure.
    }
    runtimeResult = {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: [],
      context: {},
      reason,
    };
  }
  return {
    claimed: true,
    workItemId: dispatch.workItem.id,
    taskId: dispatch.taskId,
    runtime: runtimeResult,
  };
}

export function workflowMergeWorkKinds(): WorkflowWorkItemKind[] {
  return ["merge", "manual-hold"];
}
