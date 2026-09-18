/*
FNXC:OverlapWaitSynchronization 2026-09-17-00:00:
A file-scope contention wait must remain durable after the transient `task.overlapBlockedBy`
display marker clears (Reset, blocker completion, another producer overwriting it). Each
observed predecessor edge is persisted as its own episode so a re-validated resume can prove
which specific predecessor's delivery it already accounted for, independent of whatever the
marker currently says. See docs/storage.md "Overlap wait synchronization episodes".
*/

/** Lifecycle of one durable overlap-wait episode. */
export type OverlapWaitPhase =
  | "observed"
  | "analyzing"
  | "freshness-pending"
  | "revalidation-pending"
  | "repair-required"
  | "ready"
  | "delivered"
  | "cancelled";

/** The executor's resume decision once a wait's delivery has been analyzed. */
export type OverlapWaitDecision = "resume" | "briefing" | "revalidate";

/** Whether the delivered predecessor content has been proven present in the resuming checkout. */
export type OverlapWaitFreshness = "not-required" | "proven" | "pending" | "conflict" | "unavailable";

export interface OverlapWaitLandedPath {
  repository: string;
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

/** A predecessor's delivery snapshot, captured at publication time (merge/land) so it survives blocker deletion. */
export interface OverlapWaitDeliverySnapshot {
  blockerTaskId: string;
  blockerLineageId?: string;
  repository: string;
  target?: string;
  landedSha?: string;
  paths?: OverlapWaitLandedPath[];
  noOp?: boolean;
  evidence: "merge-details" | "workspace-landing" | "git-recapture" | "unavailable";
  summary?: string;
}

/** Per-repository freshness proof recorded on the release receipt. */
export interface OverlapWaitDeliveryProof {
  repository: string;
  target?: string;
  landedSha?: string;
  landedFiles?: string[];
  noOp?: boolean;
  evidence?: "merge-details" | "workspace-landing" | "git-recapture" | "unavailable";
  freshness?: OverlapWaitFreshness;
}

/** The durable, deterministic outcome of resolving one overlap-wait episode. */
export interface OverlapWaitReceipt {
  decision: OverlapWaitDecision;
  freshness: OverlapWaitFreshness;
  commonFiles: string[];
  deliveryProofs: OverlapWaitDeliveryProof[];
  decisionFingerprint: string;
  briefing?: string;
  reason?: string;
  decidedAt: string;
  contextDeliveredAt?: string;
  revalidationVerdict?: "APPROVE" | "REVISE";
  invalidatedPromise?: string;
  revalidationFeedback?: string;
}

/** One row of `project.task_overlap_waits`. */
export interface TaskOverlapWait {
  projectId: string;
  taskId: string;
  episodeId: string;
  blockerTaskId: string;
  taskLineageId?: string;
  blockerLineageId?: string;
  observedAt: string;
  planFingerprint?: string;
  phase: OverlapWaitPhase;
  revision: number;
  owner?: string;
  attempt: number;
  checkoutEpoch?: string;
  observation?: Record<string, unknown>;
  receipt?: OverlapWaitReceipt;
  updatedAt: string;
}

/**
 * Freshness-fencing identity captured at claim time and re-checked at completion so a resumed
 * plan/checkout that has since moved (a new plan revision, a new checkout epoch, a different
 * node incarnation) cannot publish a decision computed against stale state.
 */
export interface OverlapWaitExecutionIdentity {
  taskLineageId?: string;
  planFingerprint?: string;
  checkoutEpoch?: string;
  worktree?: string;
  branch?: string;
  headSha?: string;
  repository?: string;
  target?: string;
  nodeId?: string;
  nodeInstanceId?: string;
}

export interface OverlapWaitClaim {
  taskId: string;
  episodeId: string;
  expectedRevision: number;
  owner: string;
  checkoutEpoch?: string;
  executionIdentity?: OverlapWaitExecutionIdentity;
}
