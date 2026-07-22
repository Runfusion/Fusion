import type { Settings } from "../types.js";

export interface WorkflowSettingsOverlayInput {
  effective: Record<string, unknown>;
  storedKeys: ReadonlySet<string>;
}

/**
 * FNXC:ModelResolution 2026-06-27-10:52:
 * Per-task workflow setting values are where the moved model lanes now live, so the engine execution path and dashboard task-detail display must share one overlay rule. Stored workflow values override base settings while declaration defaults only fill missing base keys, ensuring the Workflow tab shows the same model the engine runs for FN-7123.
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
