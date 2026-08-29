/**
 * Branch groups / PR-entities responsibility area.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Responsibility boundary for branch groups and PR entities/threads. The logic
 * currently lives in the TaskStore class body (createBranchGroup, updateBranchGroup,
 * upsertPrEntity, upsertPrThreadState) and branch-assignment.ts. This module
 * documents the boundary; U14 will migrate these call sites.
 */
export type {
  BranchGroup,
  BranchGroupCreateInput,
  BranchGroupUpdate,
  TaskBranchAssignmentMode,
  PrEntity,
  PrEntityCreateInput,
  PrEntityUpdate,
  PrEntityState,
  PrThreadState,
} from "../types.js";

export type {
  BranchGroupRow,
  PrEntityRow,
  PrThreadStateRow,
} from "./row-types.js";

export {
  validateBranchGroupBranchName,
  filterTasksByBranchGroup,
} from "../branch/branch-assignment.js";

export {
  parseTaskBranchContextFromSourceMetadata,
  withTaskBranchContextInSourceMetadata,
} from "./branch-context.js";
