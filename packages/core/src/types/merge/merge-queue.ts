/**
 * Merge-queue, merge-request, and workflow work-item domain types.
 *
 * FNXC:CodeOrganization 2026-07-15-00:00:
 * Extracted from types.ts; re-exported from the browser-safe types barrel.
 */

import type { TaskPriority } from "../board/board.js";

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
  /** Fenced durable principal for this claimed workflow attempt. */
  principalAgentId: string | null;
  workflowRole: "triage" | "executor" | "reviewer" | "merger" | null;
  authorityKind: "task-assignee" | "review-node-override" | "column-binding" | "role-pool" | null;
  nodeInstanceId: string | null;
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
  /** Set once when a classified node is claimed; retries retain the fence. */
  principalAgentId?: string | null;
  workflowRole?: "triage" | "executor" | "reviewer" | "merger" | null;
  authorityKind?: "task-assignee" | "review-node-override" | "column-binding" | "role-pool" | null;
  nodeInstanceId?: string | null;
  now?: string;
}

export interface WorkflowWorkItemTransitionPatch {
  attempt?: number;
  retryAfter?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  lastError?: string | null;
  blockedReason?: string | null;
  /** Principal fencing may be set only before the session handler starts. */
  principalAgentId?: string | null;
  workflowRole?: "triage" | "executor" | "reviewer" | "merger" | null;
  authorityKind?: "task-assignee" | "review-node-override" | "column-binding" | "role-pool" | null;
  nodeInstanceId?: string | null;
  now?: string;
  /*
  FNXC:WorkflowWorkItemCas 2026-07-27-22:10 (U7, PR #2491 review — greptile P1):
  Compare-and-set guard. When set, the transition is applied ONLY if the row's
  state read INSIDE the transaction still equals this value; otherwise it is a
  no-op that returns the current row unchanged (no write, no run-audit row).

  Why this exists: a caller that decided from a due-poll SNAPSHOT and then writes
  unconditionally can clobber a newer state another node reached in between —
  resetting a `running` claim back to `runnable` (double-claim) is the concrete
  case. The terminal-state check below already refuses cancelled/succeeded/failed,
  so `running` was the unguarded gap. Callers that legitimately force a state
  (the executor's own lifecycle writes) simply omit this and behave as before.
  */
  expectedState?: WorkflowWorkItemState;
  /*
  FNXC:WorkflowWorkItemLeaseCas 2026-09-06-01:28:
  State alone cannot fence a lease renewal because a reclaimed work item can return to `running`
  under a different owner. Callers that renew or terminalize an owned attempt must also compare the
  exact durable owner so an old callback cannot overwrite or complete its successor's lease.
  */
  expectedLeaseOwner?: string | null;
}

export interface WorkflowWorkItemDueFilter {
  /** Required by project-bound callers so due work cannot cross a tenant boundary. */
  projectId?: string;
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
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-01:25 (#2819 review — greptile):
  Resolves a task's review lanes for the stale-row sweep that runs at the start of lease acquisition.
  That sweep deletes rows whose task has left review, and its predicate is evaluated by PostgreSQL —
  which cannot know a workflow. Without this the SQL literal deleted every queued row on a renamed
  board, so the queue filled and emptied and nothing merged.

  Optional so a caller with only a data layer keeps today's behaviour; `TaskStore.acquireMergeQueueLease`
  supplies it, which is the path production uses.
  */
  resolveReviewColumnsFor?: (taskId: string) => Promise<ReadonlySet<string>>;
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
