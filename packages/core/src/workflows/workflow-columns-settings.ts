import type { Settings } from "../types.js";

/**
 * Resolve whether workflow-defined columns are active for a settings snapshot.
 *
 * FNXC:WorkflowColumns 2026-06-22-18:00:
 * Workflow columns graduated from the experimental runtime flag. Public runtime checks must treat stale persisted false values as enabled so engine scheduling and dashboard callers do not reactivate the retired legacy dispatcher.
 */
export function isWorkflowColumnsEnabled(
  _settings: Pick<Settings, "experimentalFeatures"> | undefined,
): boolean {
  return true;
}
