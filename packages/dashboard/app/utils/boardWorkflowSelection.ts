import { getScopedItem, removeScopedItem, setScopedItem } from "./projectStorage";

export const BOARD_WORKFLOW_SELECTION_STORAGE_KEY = "kb-dashboard-board-workflow-selection";

function isValidWorkflowSelection(value: unknown): value is string {
  if (typeof value !== "string") return false;

  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  if (/\p{C}/u.test(trimmed)) return false;

  return true;
}

/**
 * FNXC:BoardWorkflowSelection 2026-06-29-12:00:
 * Persist only the last selected workflow id in project-scoped localStorage so Board, Header, Graph, and List selectors can restore the operator's workflow after board remounts, task state changes, respecification returns, and browser/server restarts. Storage is best-effort because private-mode, SSR, missing APIs, and quota failures must never block board rendering.
 */
export function readBoardWorkflowSelection(projectId?: string): string | null {
  try {
    const stored = getScopedItem(BOARD_WORKFLOW_SELECTION_STORAGE_KEY, projectId);
    return isValidWorkflowSelection(stored) ? stored.trim() : null;
  } catch {
    return null;
  }
}

export function writeBoardWorkflowSelection(projectId: string | undefined, workflowId: string): void {
  try {
    const trimmed = workflowId.trim();
    if (!isValidWorkflowSelection(trimmed)) {
      removeScopedItem(BOARD_WORKFLOW_SELECTION_STORAGE_KEY, projectId);
      return;
    }

    setScopedItem(BOARD_WORKFLOW_SELECTION_STORAGE_KEY, trimmed, projectId);
  } catch {
    // Best-effort preference persistence; board rendering must continue on storage failures.
  }
}

export function removeBoardWorkflowSelection(projectId?: string): void {
  try {
    removeScopedItem(BOARD_WORKFLOW_SELECTION_STORAGE_KEY, projectId);
  } catch {
    // Best-effort preference cleanup; storage failures are non-fatal.
  }
}
