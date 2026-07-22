/**
 * Merge-queue, merge-request, and workflow work-item domain types.
 *
 * FNXC:CodeOrganization 2026-07-15-00:00:
 * Extracted from types.ts; re-exported from the browser-safe types barrel.
 */

import type { TaskPriority } from "./board.js";

export const MERGE_REQUEST_STATES = [
  "queued",
  "running",
  "retrying",
  "succeeded",
  "exhausted",
  "cancelled",
  "manual-required",
] as const;

export type MergeRequestState = (typeof MERGE_REQUEST_STATES)[number];

export const WORKFLOW_WORK_ITEM_KINDS = [
  "task",
  "merge",
  "retry",
  "manual-hold",
  "recovery",
] as const;

export type WorkflowWorkItemKind = (typeof WORKFLOW_WORK_ITEM_KINDS)[number];

export const WORKFLOW_WORK_ITEM_STATES = [
  "runnable",
  "running",
  "held",
  "retrying",
  "manual-required",
  "succeeded",
  "failed",
  "cancelled",
  "exhausted",
] as const;

export type WorkflowWorkItemState = (typeof WORKFLOW_WORK_ITEM_STATES)[number];

/** FNXC:WorkflowContinuations 2026-07-21-12:30:
 * States that keep a workflow work item eligible for continuation ownership. */
export const ACTIVE_WORKFLOW_WORK_ITEM_STATES: readonly WorkflowWorkItemState[] = [
  "runnable",
  "running",
  "held",
  "retrying",
];

export interface WorkflowWorkItem {
  id: string;
  runId: string;
  taskId: string;
  nodeId: string;
  kind: WorkflowWorkItemKind;
  state: WorkflowWorkItemState;
  attempt: number;
  retryAfter: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  blockedReason: string | null;
  stableWorkflowRunId: string | null;
  continuationSequence: number | null;
  waitReason: "planning" | "capacity" | null;
  sourceColumn: string | null;
  targetColumn: string | null;
  irHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowWorkItemUpsertInput {
  id?: string;
  runId: string;
  taskId: string;
  nodeId: string;
  kind: WorkflowWorkItemKind;
  state?: WorkflowWorkItemState;
  attempt?: number;
  retryAfter?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  lastError?: string | null;
  blockedReason?: string | null;
  stableWorkflowRunId?: string | null;
  continuationSequence?: number | null;
  waitReason?: "planning" | "capacity" | null;
  sourceColumn?: string | null;
  targetColumn?: string | null;
  irHash?: string | null;
  now?: string;
}

export interface WorkflowWorkItemTransitionPatch {
  attempt?: number;
  retryAfter?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  lastError?: string | null;
  blockedReason?: string | null;
  now?: string;
}

export interface WorkflowWorkItemDueFilter {
  now?: string;
  limit?: number;
  kinds?: WorkflowWorkItemKind[];
  states?: WorkflowWorkItemState[];
}

export interface MergeRequestWorkflowProjectionOptions {
  runId?: string;
  nodeId?: string;
  now?: string;
}

export interface MergeQueueEntry {
  taskId: string;
  enqueuedAt: string;
  priority: TaskPriority;
  leasedBy: string | null;
  leasedAt: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  lastError: string | null;
}

export interface MergeRequestRecord {
  taskId: string;
  state: MergeRequestState;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  lastError: string | null;
}

export interface CompletionHandoffMarker {
  taskId: string;
  acceptedAt: string;
  source: string;
}

export interface MergeQueueEnqueueOptions {
  priority?: TaskPriority;
  now?: string;
}

export interface MergeQueueAcquireOptions {
  leaseDurationMs: number;
  now?: string;
  /** If provided, the lease attempt targets this specific task first.
   *  The task must be unexpired/available; otherwise falls back to normal queue-head selection. */
  targetTaskId?: string;
}

export type MergeQueueReleaseOutcome =
  | { kind: "success" }
  | { kind: "failure"; error: string };

export interface HandoffEvidence {
  /** Reason text recorded on the run-audit event (for example "fn_task_done"). */
  reason: string;
  /** Optional run id captured for forensics. */
  runId?: string;
  /** Optional agent id captured for forensics. */
  agentId?: string;
}

export interface HandoffToReviewOptions {
  ownerAgentId: string | null;
  evidence: HandoffEvidence;
  moveOptions?: {
    preserveResumeState?: boolean;
    preserveProgress?: boolean;
    preserveWorktree?: boolean;
    preserveStatus?: boolean;
    moveSource?: "user" | "engine";
    skipMergeBlocker?: boolean;
  };
  /** Inject a clock for tests. */
  now?: string;
}
