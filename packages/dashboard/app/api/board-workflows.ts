/**
 * FNXC:CodeOrganization 2026-07-16-20:00:
 * Board workflow client types/API peeled from legacy.ts.
 */
import type {
  Task,
  WorkflowFieldDefinition,
  WorkflowFieldType,
  WorkflowFieldOption,
  WorkflowFieldRender,
  WorkflowSettingDefinition,
  WorkflowSettingType,
  WorkflowSettingOption,
  WorkflowSettingRender,
  WorkflowSettingRejection,
} from "@fusion/core";
import { api } from "./client.js";
import type { FetchOptions } from "./client.js";
import { withProjectId } from "./health.js";
import { dedupe } from "./dedupe.js";

// Workflow field/setting declaration types re-exported from @fusion/core so
// WorkflowSettingsPanel can import them from `../api` (KTD-13/14, U6/KTD-1).
export type {
  WorkflowFieldDefinition,
  WorkflowFieldType,
  WorkflowFieldOption,
  WorkflowFieldRender,
  WorkflowSettingDefinition,
  WorkflowSettingType,
  WorkflowSettingOption,
  WorkflowSettingRender,
  WorkflowSettingRejection,
};

/** Resolved trait flags for a board column (subset the client cares about). */
export interface BoardWorkflowColumnFlags {
  countsTowardWip?: boolean;
  complete?: boolean;
  archived?: boolean;
  hiddenFromBoard?: boolean;
  hold?: boolean;
  intake?: boolean;
  mergeBlocker?: boolean;
  humanReview?: boolean;
  [key: string]: boolean | undefined;
}

export interface BoardWorkflowColumn {
  id: string;
  name: string;
  flags: BoardWorkflowColumnFlags;
}

export interface BoardWorkflowDefinition {
  id: string;
  name: string;
  /** Optional compact custom workflow icon; built-ins render the Fusion mark by id. */
  icon?: string;
  columns: BoardWorkflowColumn[];
  /** Custom field definitions declared by this workflow (U13/KTD-14). Absent on
   *  workflows with no fields, or from older servers. */
  fields?: WorkflowFieldDefinition[];
}

export interface BoardWorkflowsPayload {
  flagEnabled: boolean;
  defaultWorkflowId: string;
  workflows: BoardWorkflowDefinition[];
  taskWorkflowIds: Record<string, string>;
}

/** A typed custom-field rejection surfaced by the PATCH endpoint (KTD-13). */
export interface CustomFieldRejection {
  code: "no-fields-defined" | "unknown-field" | "type-mismatch" | "enum-violation";
  fieldId: string;
  detail: string;
}

/**
 * Patch a task's custom field values (U13/KTD-14). The server validates the
 * patch against the task's workflow field schema and returns the updated task;
 * a validation failure surfaces as a 400 carrying `{ fieldId, code, detail }`.
 * A `null` value for a field deletes it.
 */
export function updateTaskCustomFields(
  id: string,
  customFields: Record<string, unknown>,
  projectId?: string,
): Promise<Task> {
  return api<Task>(withProjectId(`/tasks/${id}/custom-fields`, projectId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customFields }),
  });
}

/** Fetch the multi-lane board metadata (U9). When the flag is OFF the server
 *  returns `{ flagEnabled: false }` and the board renders its legacy form. */
export function fetchBoardWorkflows(projectId?: string, options?: FetchOptions): Promise<BoardWorkflowsPayload> {
  const path = withProjectId("/tasks/board-workflows", projectId);
  return dedupe(path, () => api<BoardWorkflowsPayload>(path), options);
}


