import type { WorkflowWorkItem } from "@fusion/core";

export type WorkflowRecoveryEventKind =
  | "mergeable-in-review"
  | "stale-merge-status"
  | "transient-merge-failure"
  | "already-landed"
  | "completion-handoff-limbo";

export interface WorkflowRecoveryEventInput {
  taskId: string;
  runId?: string;
  kind: WorkflowRecoveryEventKind;
  source: string;
  reason?: string;
  now?: string;
}

export interface WorkflowRecoveryEventStore {
  upsertWorkflowWorkItem(input: {
    runId: string;
    taskId: string;
    nodeId: string;
    kind: "recovery";
    state: "runnable";
    blockedReason?: string | null;
    lastError?: string | null;
    now?: string;
  }): WorkflowWorkItem;
}

export function publishWorkflowRecoveryEvent(
  store: WorkflowRecoveryEventStore,
  input: WorkflowRecoveryEventInput,
): WorkflowWorkItem {
  const runId = input.runId ?? `recovery:${input.kind}:${input.taskId}`;
  return store.upsertWorkflowWorkItem({
    runId,
    taskId: input.taskId,
    nodeId: "recovery-router",
    kind: "recovery",
    state: "runnable",
    blockedReason: input.kind,
    lastError: input.reason ?? null,
    now: input.now,
  });
}
