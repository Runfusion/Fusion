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
  if (candidate.source !== "planning" && candidate.source !== "mission" && candidate.source !== "new-task") return undefined;
  if (candidate.assignmentMode !== "shared" && candidate.assignmentMode !== "per-task-derived") return undefined;
  const inheritedBaseBranch = typeof candidate.inheritedBaseBranch === "string" && candidate.inheritedBaseBranch.trim().length > 0
    ? candidate.inheritedBaseBranch.trim()
    : undefined;
  return {
    ...(groupId ? { groupId } : {}),
    source: candidate.source,
    assignmentMode: candidate.assignmentMode,
    inheritedBaseBranch,
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
      source: branchContext.source,
      assignmentMode: branchContext.assignmentMode,
      ...(branchContext.inheritedBaseBranch ? { inheritedBaseBranch: branchContext.inheritedBaseBranch } : {}),
    },
  };
}
