/**
 * Task branch-context source-metadata parsing helpers.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Extracted from the monolithic packages/core/src/store.ts (U5 decomposition).
 * Pure behavior-invariant move: function bodies are byte-identical to their
 * pre-extraction form. store.ts re-imports these helpers.
 */
import type { TaskBranchContext } from "../types.js";

const TASK_BRANCH_CONTEXT_METADATA_KEY = "fusionBranchContext";

export function parseTaskBranchContextFromSourceMetadata(sourceMetadata: Record<string, unknown> | undefined): TaskBranchContext | undefined {
  const raw = sourceMetadata?.[TASK_BRANCH_CONTEXT_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  // groupId is optional: only shared-mode members carry one. A non-shared
  // member persists source/assignmentMode without a groupId, so a missing or
  // empty groupId must NOT discard the whole context.
  const groupId = typeof candidate.groupId === "string"
    ? candidate.groupId.trim() || undefined
    : undefined;
  const source = candidate.source;
  const assignmentMode = candidate.assignmentMode;
  const hasAssignment = (source === "planning" || source === "mission" || source === "new-task")
    && (assignmentMode === "shared" || assignmentMode === "per-task-derived");
  const override = candidate.branchOverride;
  const overrideRecord = override && typeof override === "object" && !Array.isArray(override)
    ? override as Record<string, unknown>
    : undefined;
  const branchOverride = overrideRecord?.by === "operator"
    && typeof overrideRecord.at === "string"
    && typeof overrideRecord.branch === "string"
    && overrideRecord.branch.trim().length > 0
    ? {
        by: "operator" as const,
        at: overrideRecord.at,
        branch: overrideRecord.branch,
        ...(typeof overrideRecord.previousBranch === "string"
          ? { previousBranch: overrideRecord.previousBranch }
          : {}),
      }
    : undefined;
  if (!hasAssignment && !branchOverride) return undefined;
  const inheritedBaseBranch = typeof candidate.inheritedBaseBranch === "string" && candidate.inheritedBaseBranch.trim().length > 0
    ? candidate.inheritedBaseBranch.trim()
    : undefined;
  return {
    ...(groupId ? { groupId } : {}),
    ...(hasAssignment ? { source, assignmentMode } : {}),
    ...(inheritedBaseBranch ? { inheritedBaseBranch } : {}),
    ...(branchOverride ? { branchOverride } : {}),
  };
}

export function withTaskBranchContextInSourceMetadata(
  sourceMetadata: Record<string, unknown> | undefined,
  branchContext: TaskBranchContext | undefined,
): Record<string, unknown> | undefined {
  if (!branchContext) return sourceMetadata;
  return {
    ...(sourceMetadata ?? {}),
    [TASK_BRANCH_CONTEXT_METADATA_KEY]: {
      ...(branchContext.groupId?.trim()
        ? { groupId: branchContext.groupId.trim() }
        : {}),
      ...(branchContext.source ? { source: branchContext.source } : {}),
      ...(branchContext.assignmentMode ? { assignmentMode: branchContext.assignmentMode } : {}),
      ...(branchContext.inheritedBaseBranch ? { inheritedBaseBranch: branchContext.inheritedBaseBranch } : {}),
      ...(branchContext.branchOverride ? { branchOverride: branchContext.branchOverride } : {}),
    },
  };
}
