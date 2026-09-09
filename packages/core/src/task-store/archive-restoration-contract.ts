import type { ArchivedTaskEntry, Task } from "../types.js";

/*
FNXC:TaskArchiveReintegration 2026-09-06-08:00:
Historical archive snapshots preserve durable user-visible evidence, including explicit zero, false,
and empty-array values. Runtime ownership is deliberately outside this contract: worktrees, workspace
leases/checkouts, active sessions, status, blockers, pauses, and active execution errors must never be
recreated from cold history. Add a durable field here once so archive writers and readers cannot drift.
*/
export const ARCHIVE_RESTORABLE_TASK_FIELDS = [
  "executionMode",
  "plannerOversightLevel",
  "sessionAdvisorEnabled",
  "reviewState",
  "firstExecutionAt",
  "cumulativeActiveMs",
  "cumulativePlanningMs",
  "planningStartedAt",
  "columnDwellMs",
  "executionStartedAt",
  "executionCompletedAt",
  "modelPresetId",
  "modelProvider",
  "credentialInstanceId",
  "modelId",
  "validatorModelProvider",
  "validatorCredentialInstanceId",
  "validatorModelId",
  "planningModelProvider",
  "planningCredentialInstanceId",
  "planningModelId",
  "mergerModelProvider",
  "mergerCredentialInstanceId",
  "mergerModelId",
  "mergerThinkingLevel",
  "tokenUsage",
  "noCommitsExpected",
  "baseBranch",
  "branchContext",
  "autoMerge",
  "baseCommitSha",
  "modifiedFiles",
  "declaredSymbols",
  "missionId",
  "sliceId",
  "assigneeUserId",
  "mergeDetails",
] as const satisfies readonly (keyof ArchivedTaskEntry & keyof Task)[];

export type ArchiveRestorableTaskField = typeof ARCHIVE_RESTORABLE_TASK_FIELDS[number];

/** PostgreSQL descriptor columns fed by each canonical field during a non-destructive revive. */
export const ARCHIVE_RESTORABLE_PERSISTENCE_COLUMNS: Readonly<Record<ArchiveRestorableTaskField, readonly string[]>> = {
  executionMode: ["executionMode"],
  plannerOversightLevel: ["plannerOversightLevel"],
  sessionAdvisorEnabled: ["sessionAdvisorEnabled"],
  reviewState: ["reviewState"],
  firstExecutionAt: ["firstExecutionAt"],
  cumulativeActiveMs: ["cumulativeActiveMs"],
  cumulativePlanningMs: ["cumulativePlanningMs"],
  planningStartedAt: ["planningStartedAt"],
  columnDwellMs: ["columnDwellMs"],
  executionStartedAt: ["executionStartedAt"],
  executionCompletedAt: ["executionCompletedAt"],
  modelPresetId: ["modelPresetId"],
  modelProvider: ["modelProvider"],
  credentialInstanceId: ["credentialInstanceId"],
  modelId: ["modelId"],
  validatorModelProvider: ["validatorModelProvider"],
  validatorCredentialInstanceId: ["validatorCredentialInstanceId"],
  validatorModelId: ["validatorModelId"],
  planningModelProvider: ["planningModelProvider"],
  planningCredentialInstanceId: ["planningCredentialInstanceId"],
  planningModelId: ["planningModelId"],
  mergerModelProvider: ["mergerModelProvider"],
  mergerCredentialInstanceId: ["mergerCredentialInstanceId"],
  mergerModelId: ["mergerModelId"],
  mergerThinkingLevel: ["mergerThinkingLevel"],
  tokenUsage: [
    "tokenUsageInputTokens", "tokenUsageOutputTokens", "tokenUsageCachedTokens",
    "tokenUsageCacheWriteTokens", "tokenUsageTotalTokens", "tokenUsageFirstUsedAt",
    "tokenUsageLastUsedAt", "tokenUsageModelProvider", "tokenUsageModelId", "tokenUsagePerModel",
  ],
  noCommitsExpected: ["noCommitsExpected"],
  baseBranch: ["baseBranch"],
  // branchContext has no standalone PostgreSQL column; it remains snapshot/file provenance only.
  branchContext: [],
  autoMerge: ["autoMerge"],
  baseCommitSha: ["baseCommitSha"],
  modifiedFiles: ["modifiedFiles"],
  declaredSymbols: ["declaredSymbols"],
  missionId: ["missionId"],
  sliceId: ["sliceId"],
  assigneeUserId: ["assigneeUserId"],
  mergeDetails: ["mergeDetails"],
};

export function pickArchiveRestorableTaskFields(
  source: Pick<Partial<Task>, ArchiveRestorableTaskField> | Pick<Partial<ArchivedTaskEntry>, ArchiveRestorableTaskField>,
): Pick<Partial<Task>, ArchiveRestorableTaskField> {
  const result: Partial<Task> = {};
  for (const field of ARCHIVE_RESTORABLE_TASK_FIELDS) {
    const value = source[field];
    if (value !== undefined) {
      (result as Record<string, unknown>)[field] = value;
    }
  }
  return result;
}

/** Fields that are intentionally excluded even when a legacy snapshot happens to contain them. */
export const ARCHIVE_FORBIDDEN_RUNTIME_FIELDS = [
  "worktree",
  "workspaceWorktrees",
  "status",
  "blockedBy",
  "paused",
  "userPaused",
  "error",
  "executionStartBranch",
] as const satisfies readonly (keyof Task)[];
