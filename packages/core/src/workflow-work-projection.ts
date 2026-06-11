import type { Task, WorkflowWorkItem } from "./types.js";

export type WorkflowWorkProjectionStatus =
  | "merge-queued"
  | "merge-running"
  | "retrying"
  | "manual-hold"
  | "recovery"
  | "failed"
  | "complete"
  | "legacy";

export interface WorkflowWorkProjection {
  status: WorkflowWorkProjectionStatus;
  source: "workflow" | "legacy";
  taskId: string;
  workItemId?: string;
  reason?: string | null;
  retryAfter?: string | null;
  attempt?: number;
}

export function projectWorkflowWorkStatus(
  task: Pick<Task, "id" | "mergeRetries" | "mergeTransientRetryCount" | "status">,
  workItems: WorkflowWorkItem[],
): WorkflowWorkProjection {
  const active = [...workItems].sort(compareWorkItemsForProjection).find((item) =>
    item.state !== "succeeded" && item.state !== "cancelled",
  );
  if (!active) {
    const completed = workItems.find((item) => item.state === "succeeded");
    if (completed) {
      return { status: "complete", source: "workflow", taskId: task.id, workItemId: completed.id };
    }
    return {
      status: "legacy",
      source: "legacy",
      taskId: task.id,
      reason: task.status ?? null,
      attempt: task.mergeRetries ?? task.mergeTransientRetryCount ?? undefined,
    };
  }

  if (active.kind === "recovery") {
    return workflowProjection(active, "recovery");
  }
  if (active.kind === "manual-hold" || active.state === "manual-required" || active.state === "held") {
    return workflowProjection(active, "manual-hold");
  }
  if (active.state === "retrying") {
    return workflowProjection(active, "retrying");
  }
  if (active.state === "running") {
    return workflowProjection(active, "merge-running");
  }
  if (active.state === "failed" || active.state === "exhausted") {
    return workflowProjection(active, "failed");
  }
  return workflowProjection(active, "merge-queued");
}

function workflowProjection(item: WorkflowWorkItem, status: WorkflowWorkProjectionStatus): WorkflowWorkProjection {
  return {
    status,
    source: "workflow",
    taskId: item.taskId,
    workItemId: item.id,
    reason: item.blockedReason ?? item.lastError,
    retryAfter: item.retryAfter,
    attempt: item.attempt,
  };
}

function compareWorkItemsForProjection(a: WorkflowWorkItem, b: WorkflowWorkItem): number {
  const priority = (item: WorkflowWorkItem): number => {
    if (item.kind === "recovery") return 0;
    if (item.kind === "manual-hold" || item.state === "manual-required" || item.state === "held") return 1;
    if (item.state === "running") return 2;
    if (item.state === "retrying") return 3;
    if (item.kind === "merge") return 4;
    return 5;
  };
  return priority(a) - priority(b) || a.createdAt.localeCompare(b.createdAt);
}
