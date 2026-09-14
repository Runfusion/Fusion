import type { Settings } from "../types.js";

export interface WorkflowSettingsOverlayInput {
  effective: Record<string, unknown>;
  storedKeys: ReadonlySet<string>;
}

/**
 * FNXC:ModelResolution 2026-06-27-10:52:
 * Workflow policy uses stored overrides and declaration-default fill semantics. Model lanes remain an isolated, higher-precedence workflow tier; project model lanes never come from a workflow row.
 * FNXC:ModelResolution 2026-09-14-19:06:
 * Recomposition replaces the previous workflow tier, including an empty tier, so switching workflows cannot retain an unrelated workflow's models.
 */
export function applyWorkflowSettingsOverlay<T extends Partial<Settings>>(
  base: T,
  detailed: WorkflowSettingsOverlayInput,
): T {
  const merged: Record<string, unknown> = { ...base };
  delete merged.selectedWorkflowModelLanes;
  for (const key of Object.keys(detailed.effective)) {
    const value = detailed.effective[key];
    if (value === undefined) continue;
    if (key === "selectedWorkflowModelLanes" || detailed.storedKeys.has(key)) {
      merged[key] = value;
    } else if (merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged as T;
}
