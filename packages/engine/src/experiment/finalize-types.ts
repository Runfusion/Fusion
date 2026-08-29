import type { ExperimentSessionRecord } from "@fusion/core";

export interface FinalizeGroup {
  id: string;
  title: string;
  description?: string;
  runRecordIds: string[];
  commits: string[];
  suggestedBranchName: string;
}

export interface FinalizePlan {
  sessionId: string;
  baselineCommit: string;
  integrationBranch: string;
  mergeBaseCommit: string;
  groups: FinalizeGroup[];
  orphanedRunRecordIds: string[];
  warnings: string[];
}

export interface FinalizeResult {
  sessionId: string;
  mergeBaseCommit: string;
  branches: Array<{ name: string; baseCommit: string; tipCommit: string; runRecordIds: string[]; commits: string[] }>;
  warnings: string[];
  finalizeRecordId: string;
}

export interface FinalizePlanOverrideGroup {
  id?: string;
  title?: string;
  description?: string;
  suggestedBranchName?: string;
  runRecordIds: string[];
}

export interface FinalizePlanOverride {
  groups: FinalizePlanOverrideGroup[];
}

class ExperimentFinalizeErrorBase extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ExperimentFinalizeStateError extends ExperimentFinalizeErrorBase {
  readonly code = "state_error" as const;
}

export class ExperimentFinalizeNoKeptRunsError extends ExperimentFinalizeErrorBase {
  readonly code = "no_kept_runs" as const;
}

export class ExperimentFinalizePlanError extends ExperimentFinalizeErrorBase {
  readonly code = "plan_error" as const;
}

export class ExperimentFinalizeMergeBaseError extends ExperimentFinalizeErrorBase {
  readonly code = "merge_base_error" as const;
}

export class ExperimentFinalizeCherryPickConflictError extends ExperimentFinalizeErrorBase {
  readonly code = "cherry_pick_conflict" as const;
  readonly groupId: string;
  readonly commit: string;
  readonly stderr: string;

  constructor(message: string, details: { groupId: string; commit: string; stderr: string }) {
    super(message);
    this.groupId = details.groupId;
    this.commit = details.commit;
    this.stderr = details.stderr;
  }
}

export class ExperimentFinalizeBranchExistsError extends ExperimentFinalizeErrorBase {
  readonly code = "branch_exists" as const;
}

export function getRunRecordById(records: ExperimentSessionRecord[], id: string): Extract<ExperimentSessionRecord, { type: "run" }> | undefined {
  return records.find((record): record is Extract<ExperimentSessionRecord, { type: "run" }> => record.id === id && record.type === "run");
}
