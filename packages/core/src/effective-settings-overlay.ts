import type { Settings } from "./types.js";

export interface WorkflowSettingsOverlayInput {
  effective: Record<string, unknown>;
  storedKeys: ReadonlySet<string>;
}

/**
 * FNXC:ModelResolution 2026-06-27-10:52:
 * Per-task workflow setting values and the project workflow-lane baseline share one overlay rule. The resolver presents project model lanes as stored flat values and retains lower-precedence selected-workflow lanes in `selectedWorkflowModelLanes`; other stored workflow values remain flat. Stored flat values override base settings while declaration defaults only fill missing base keys.
 */
export function applyWorkflowSettingsOverlay<T extends Partial<Settings>>(
  base: T,
  detailed: WorkflowSettingsOverlayInput,
): T {
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(detailed.effective)) {
    const value = detailed.effective[key];
    if (value === undefined) continue;
    if (detailed.storedKeys.has(key)) {
      merged[key] = value;
    } else if (merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged as T;
}
