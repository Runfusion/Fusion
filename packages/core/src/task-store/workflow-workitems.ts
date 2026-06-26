/**
 * Workflow work-items responsibility area.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Responsibility boundary for workflow work-items and completion handoff.
 * The logic currently lives in the TaskStore class body (upsertWorkflowWorkItem,
 * transitionWorkflowWorkItem, completion handoff markers). This module
 * documents the boundary; U14 will migrate these call sites.
 */
export type {
  WorkflowWorkItem,
  WorkflowWorkItemDueFilter,
  WorkflowWorkItemKind,
  WorkflowWorkItemState,
  WorkflowWorkItemTransitionPatch,
  WorkflowWorkItemUpsertInput,
} from "../types.js";

export type { WorkflowWorkItemRow } from "./row-types.js";
