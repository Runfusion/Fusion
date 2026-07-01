import { getScopedItem, removeScopedItem, setScopedItem } from "./projectStorage";

export const BOARD_WORKFLOW_SELECTION_STORAGE_KEY = "kb-dashboard-board-workflow-selection";
export const ALL_WORKFLOWS_BOARD_VIEW_ID = "__all_workflows__";

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
 * Persist the last selected Board workflow view in project-scoped localStorage so Board, Header, Graph, and List selectors can restore the operator's workflow after board remounts, task state changes, respecification returns, and browser/server restarts. Storage is best-effort because private-mode, SSR, missing APIs, and quota failures must never block board rendering.
 *
 * FNXC:BoardWorkflowSelection 2026-06-30-00:00:
 * The durable Board view preference may be either a real workflow id or the Board-only All workflows sentinel so a refresh can restore the aggregate board. Shared real-workflow consumers must call `readBoardWorkflowSelection`; it filters the sentinel out so task creation, workflow APIs, and other backend handoffs never receive `__all_workflows__` as a real workflow id.
 *
 * FNXC:WorkflowAggregation 2026-07-01-00:00:
 * Top-level dashboard selectors (Board/List/Planning/Missions/Graph) may display the aggregate sentinel as view state, but any task-creating or workflow-editing path must translate it to a real workflow id or `null` default behavior before crossing component/API boundaries.
 */
export function readBoardWorkflowViewSelection(projectId?: string): string | null {
  try {
    const stored = getScopedItem(BOARD_WORKFLOW_SELECTION_STORAGE_KEY, projectId);
    return isValidWorkflowSelection(stored) ? stored.trim() : null;
  } catch {
    return null;
  }
}

export function readBoardWorkflowSelection(projectId?: string): string | null {
  const selection = readBoardWorkflowViewSelection(projectId);
  return selection === ALL_WORKFLOWS_BOARD_VIEW_ID ? null : selection;
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
