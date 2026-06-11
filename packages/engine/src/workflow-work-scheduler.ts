import type { WorkflowWorkItem, WorkflowWorkItemDueFilter, WorkflowWorkItemKind } from "@fusion/core";

export interface WorkflowWorkSchedulerStore {
  listDueWorkflowWorkItems(filter?: WorkflowWorkItemDueFilter): WorkflowWorkItem[];
  acquireWorkflowWorkItemLease(
    id: string,
    leaseOwner: string,
    opts: { leaseDurationMs: number; now?: string },
  ): WorkflowWorkItem | null;
}

export interface WorkflowWorkDispatch {
  workItem: WorkflowWorkItem;
  runId: string;
  taskId: string;
  nodeId: string;
}

export interface ClaimWorkflowWorkOptions {
  now?: string;
  limit?: number;
  leaseOwner: string;
  leaseDurationMs: number;
  kinds?: WorkflowWorkItemKind[];
}

export function claimDueWorkflowWorkItem(
  store: WorkflowWorkSchedulerStore,
  opts: ClaimWorkflowWorkOptions,
): WorkflowWorkDispatch | null {
  const due = store.listDueWorkflowWorkItems({
    now: opts.now,
    limit: opts.limit ?? 25,
    kinds: opts.kinds,
  });

  for (const candidate of due) {
    const workItem = store.acquireWorkflowWorkItemLease(candidate.id, opts.leaseOwner, {
      now: opts.now,
      leaseDurationMs: opts.leaseDurationMs,
    });
    if (!workItem) continue;
    return {
      workItem,
      runId: workItem.runId,
      taskId: workItem.taskId,
      nodeId: workItem.nodeId,
    };
  }

  return null;
}
