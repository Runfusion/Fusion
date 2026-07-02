/**
 * Database row shape interfaces for TaskStore satellite tables.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Extracted from the monolithic packages/core/src/store.ts (U5 decomposition).
 * Pure behavior-invariant move: interface definitions are byte-identical to
 * their pre-extraction form. store.ts re-imports these types.
 */
import type {
  ArtifactType,
  GoalCitationSurface,
  PrEntityState,
  PrThreadOutcome,
  TaskCommitAssociationConfidence,
  TaskCommitAssociationMatchSource,
} from "../types.js";

export interface BranchGroupRow {
  id: string;
  sourceType: "mission" | "planning" | "new-task";
  sourceId: string;
  branchName: string;
  worktreePath: string | null;
  autoMerge: number;
  prState: "none" | "open" | "merged" | "closed";
  prUrl: string | null;
  prNumber: number | null;
  status: "open" | "finalized" | "abandoned";
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface PrEntityRow {
  id: string;
  sourceType: "task" | "branch-group";
  sourceId: string;
  repo: string;
  headBranch: string;
  baseBranch: string | null;
  state: PrEntityState;
  prNumber: number | null;
  prUrl: string | null;
  headOid: string | null;
  mergeable: string | null;
  checksRollup: string | null;
  reviewDecision: string | null;
  autoMerge: number;
  unverified: number;
  failureReason: string | null;
  responseRounds: number;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface PrThreadStateRow {
  prEntityId: string;
  threadId: string;
  headOid: string;
  outcome: PrThreadOutcome;
  fixCommitSha: string | null;
  updatedAt: number;
}

export interface TaskCommitAssociationRow {
  id: string;
  taskLineageId: string;
  taskIdSnapshot: string;
  commitSha: string;
  commitSubject: string;
  authoredAt: string;
  matchedBy: TaskCommitAssociationMatchSource;
  confidence: TaskCommitAssociationConfidence;
  note: string | null;
  additions: number | null;
  deletions: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommitAssociationDiffBackfillCandidateRow {
  commitSha: string;
  rowCount: number;
}

export interface TaskDocumentRow {
  id: string;
  taskId: string;
  key: string;
  content: string;
  revision: number;
  author: string;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Database row shape for the artifacts table. */
export interface ArtifactRow {
  id: string;
  type: ArtifactType;
  title: string;
  description: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  uri: string | null;
  content: string | null;
  authorId: string;
  authorType: "agent" | "user" | "system";
  taskId: string | null;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Database row shape for the task_document_revisions table. */
export interface TaskDocumentRevisionRow {
  id: number;
  taskId: string;
  key: string;
  content: string;
  revision: number;
  author: string;
  metadata: string | null;
  createdAt: string;
}

export interface GoalCitationRow {
  id: number;
  goalId: string;
  agentId: string;
  taskId: string | null;
  surface: GoalCitationSurface;
  sourceRef: string;
  snippet: string;
  timestamp: string;
}

/** Database row shape for the runAuditEvents table. */
export interface RunAuditEventRow {
  id: string;
  timestamp: string;
  taskId: string | null;
  agentId: string;
  runId: string;
  domain: string;
  mutationType: string;
  target: string;
  metadata: string | null;
}

export interface MergeQueueRow {
  taskId: string;
  enqueuedAt: string;
  priority: string;
  leasedBy: string | null;
  leasedAt: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  lastError: string | null;
}

export interface MergeRequestRow {
  taskId: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  lastError: string | null;
}

export interface CompletionHandoffMarkerRow {
  taskId: string;
  acceptedAt: string;
  source: string;
}

export interface WorkflowWorkItemRow {
  id: string;
  runId: string;
  taskId: string;
  nodeId: string;
  kind: string;
  state: string;
  attempt: number;
  retryAfter: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Database row shape for the config table. */
export interface ConfigRow {
  nextId: number;
  settings: string | null;
  nextWorkflowStepId: number | null;
}

/** Database row shape for the activityLog table. */
export interface ActivityLogRow {
  id: string;
  timestamp: string;
  type: string;
  taskId: string | null;
  taskTitle: string | null;
  details: string;
  metadata: string | null;
}
