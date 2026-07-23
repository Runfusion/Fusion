/**
 * FNXC:CodeOrganization 2026-07-22-14:00:
 * Board config, distributed task-id reservations, autostash, merge result, and column labels peeled from types.ts.
 */

import type { Column } from "./board.js";
import type { Settings } from "./settings-scope.js";
import type { MergeDetails, Task } from "./task-core.js";

export interface BoardConfig {
  nextId: number;
  settings?: Settings;
}

export interface DistributedTaskIdReserveInput {
  prefix: string;
  nodeId: string;
  ttlMs?: number;
}

export interface DistributedTaskIdReserveResult {
  reservationId: string;
  taskId: string;
  sequence: number;
  expiresAt: string;
  committedClusterTaskCount: number;
}

export interface DistributedTaskIdCommitInput {
  reservationId: string;
  nodeId: string;
}

export interface DistributedTaskIdCommitResult {
  reservationId: string;
  taskId: string;
  sequence: number;
  committedClusterTaskCount: number;
  committedAt: string;
}

export interface DistributedTaskIdAbortInput {
  reservationId: string;
  nodeId: string;
  reason: "abort" | "expired" | "failed-create";
}

export interface DistributedTaskIdAbortResult {
  reservationId: string;
  taskId: string;
  sequence: number;
  committedClusterTaskCount: number;
  abortedAt: string;
}

export interface DistributedTaskIdStateInput {
  prefix: string;
}

export interface DistributedTaskIdStateResult {
  nextSequence: number;
  committedClusterTaskCount: number;
  activeReservationCount: number;
  burnedReservationCount: number;
  lastCommittedTaskId?: string;
}

export interface AutostashOrphanRecord {
  sha: string;
  ref: string;
  label: string;
  sourceTaskId: string | null;
  createdAt: string | null;
  changedPaths: string[];
  classification: "subsumed" | "live" | "unknown";
  /** Merge/recovery phase that created this stash label when known. */
  sourcePhase?: string | null;
  /** Task that detected/surfaced this orphan in the current run. */
  detectedByTaskId?: string | null;
  /** ISO timestamp when this orphan was surfaced in the current run. */
  detectedAt?: string | null;
}

/**
 * Outcome of restoring the developer's pre-merge autostash after the merge
 * completes. Surfaced on MergeResult so the UI / dashboard can show whether
 * the dev's uncommitted work was reapplied cleanly, AI-resolved, or left
 * stashed for manual recovery.
 *
 * Background: when rootDir is the developer's primary checkout, the merger
 * stashes any uncommitted edits before running its hard resets, then applies
 * them back at the end. Historically a pop conflict would log a warning and
 * silently leave the stash in place — developers had no way to discover this
 * had happened. See `restoreUnrelatedRootDirChanges` in merger.ts.
 */
export type AutostashOutcome =
  | { status: "no-changes" }
  | { status: "restored"; stashSha: string }
  | {
      status: "ai-resolved";
      stashSha: string;
      conflictedFiles: string[];
    }
  | {
      status: "conflict-needs-manual";
      stashSha: string;
      conflictedFiles: string[];
      message: string;
    }
  | { status: "failed"; stashSha?: string; errorMessage: string };

export interface MergeResult extends MergeDetails {
  task: Task;
  branch: string;
  merged: boolean;
  noOp?: boolean;
  ok?: true;
  reason?: string;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  error?: string;
  /** Whether the merged result was pushed to the remote. Only set when pushAfterMerge is enabled. */
  pushedToRemote?: boolean;
  /** Error message if push to remote failed. Non-fatal — merge is already committed locally. */
  pushError?: string;
  /** Outcome of restoring the developer's pre-merge autostash, when one was
   *  created. Absent when the working tree was already clean at merge start. */
  autostash?: AutostashOutcome;
  /** Internal flag to track if a build retry has been attempted. Not persisted. */
  _buildRetried?: boolean;
}

export type TaskCommitAssociationMatchSource =
  | "canonical-lineage-trailer"
  | "legacy-task-id-trailer"
  | "legacy-subject"
  | "manual-reconciliation";

export type TaskCommitAssociationConfidence = "canonical" | "legacy" | "ambiguous";

export interface TaskCommitAssociation {
  id: string;
  taskLineageId: string;
  taskIdSnapshot: string;
  commitSha: string;
  commitSubject: string;
  authoredAt: string;
  matchedBy: TaskCommitAssociationMatchSource;
  confidence: TaskCommitAssociationConfidence;
  note?: string;
  additions?: number;
  deletions?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommitAssociationDiffBackfillReport {
  scannedRows: number;
  distinctCommits: number;
  updatedRows: number;
  skippedUnavailableCommits: number;
  skippedInvalidShas: number;
  dryRun: boolean;
}

export const COLUMN_LABELS: Record<Column, string> = {
  triage: "Planning",
  todo: "Todo",
  "in-progress": "In Progress",
  "in-review": "In Review",
  done: "Done",
  archived: "Archived",
};

/*
FNXC:BoardColumnDescriptions 2026-07-21-00:00:
Todo and In Review must not carry redundant status prose in board headers.
Their omitted entries intentionally suppress the description element.
*/
export const COLUMN_DESCRIPTIONS: Partial<Record<Column, string>> = {
  triage: "Raw ideas — AI will plan these",
  "in-progress": "AI is working on this in a worktree",
  done: "Merged and closed",
  archived: "Completed and archived",
};

/**
 * @deprecated (workflowColumns, U12) The hardcoded legacy transition graph.
 * Transition validity is resolved from the task's workflow column graph
 * (`resolveAllowedColumns` in `workflow-transitions.ts`) plus trait guards in
 * `moveTaskInternal` — this constant remains the default-workflow parity oracle
 * while legacy call sites are retired.
 */
export const VALID_TRANSITIONS: Record<Column, Column[]> = {
  // FN-4892: intake-side heuristics may cold-archive tasks before execution starts.
  triage: ["todo", "archived"],
  // FN-4892: allow direct archival for newly specified intake tasks.
  todo: ["in-progress", "triage", "archived"],
  // NOTE: "in-progress" → "done" is enabled for mission validation tasks that complete directly.
  // Regular implementation tasks should move through "in-review" before "done".
  "in-progress": ["in-review", "todo", "triage", "done"],
  "in-review": ["done", "in-progress", "todo", "triage"],
  done: ["todo", "triage", "archived"],
  archived: ["done"],
};

