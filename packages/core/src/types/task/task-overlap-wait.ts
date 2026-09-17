export type OverlapWaitPhase =
  | "observed"
  | "analyzing"
  | "freshness-pending"
  | "ready"
  | "delivered"
  | "cancelled";

export type OverlapWaitDecision = "resume" | "briefing";
export type OverlapWaitFreshness = "not-required" | "proven" | "pending" | "conflict" | "unavailable";

export interface OverlapWaitLandedPath {
  repository: string;
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

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

export interface OverlapWaitDeliveryProof {
  repository: string;
  target?: string;
  landedSha?: string;
  /*
  FNXC:OverlapWaitSynchronization 2026-09-15-19:20:
  FN-429. A delivery rewritten by an integration-branch rebase keeps its patch and Fusion trailers while
  changing SHA, so freshness cannot be proven from `landedSha` alone. `reconciledSha` records the SHA that
  was proven equivalent and `reconciliationProof` the cumulative evidence that admitted it, both stored in
  the existing receipt JSON (no migration). Persisting them is what lets Retry, an engine restart, or a
  deleted worktree resume without re-deriving the proof — and `landedSha` is preserved, never rewritten.
  */
  reconciledSha?: string;
  reconciliationProof?: string;
  landedFiles?: string[];
  noOp?: boolean;
  evidence?: "merge-details" | "workspace-landing" | "git-recapture" | "unavailable";
  freshness?: OverlapWaitFreshness;
}

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
}

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
