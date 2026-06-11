import { randomUUID } from "node:crypto";
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
  listWorkflowWorkItemsForTask?: (taskId: string, opts?: { kinds?: ["recovery"] }) => WorkflowWorkItem[];
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
  const baseRunId = input.runId ?? `recovery:${input.kind}:${input.taskId}`;
  const runId = input.runId ? baseRunId : recoveryRunIdForPublish(store, input.taskId, baseRunId);
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

function recoveryRunIdForPublish(store: WorkflowRecoveryEventStore, taskId: string, baseRunId: string): string {
  const existing = store.listWorkflowWorkItemsForTask?.(taskId, { kinds: ["recovery"] })
    .find((item) => item.runId === baseRunId && item.nodeId === "recovery-router" && item.kind === "recovery");
  if (!existing) return baseRunId;
  if (existing.state === "succeeded" || existing.state === "failed" || existing.state === "cancelled" || existing.state === "exhausted") {
    return `${baseRunId}:${randomUUID()}`;
  }
  return baseRunId;
}
