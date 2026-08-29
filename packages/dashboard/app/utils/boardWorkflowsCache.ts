import type { BoardWorkflowDefinition, BoardWorkflowsPayload } from "../api";

const BOARD_WORKFLOWS_CACHE_PREFIX = "fusion:board-workflows:";
const DEFAULT_PROJECT_CACHE_KEY = "default";

function cacheKey(projectId?: string): string {
  return `${BOARD_WORKFLOWS_CACHE_PREFIX}${projectId ?? DEFAULT_PROJECT_CACHE_KEY}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoardWorkflowsPayload(value: unknown): value is BoardWorkflowsPayload {
  if (!isRecord(value)) return false;
  if (typeof value.flagEnabled !== "boolean") return false;
  if (!Array.isArray(value.workflows)) return false;
  if (typeof value.defaultWorkflowId !== "string") return false;
  if (!isRecord(value.taskWorkflowIds)) return false;
  // FNXC:BoardWorkflows 2026-06-20-20:10:
  // Validate each cached workflow's shape and the taskWorkflowIds value types,
  // not just the container types. A malformed entry (e.g. `[{}]` from a stale or
  // partially-written cache) would otherwise pass and later throw in Board/ListView
  // when accessing workflow.name/columns — re-introducing the legacy flash this
  // cache exists to prevent. Mirrors the BoardWorkflowDefinition contract (id, name,
  // columns) and the Record<string,string> taskWorkflowIds map.
  if (!value.workflows.every((workflow): workflow is BoardWorkflowDefinition => (
    isRecord(workflow)
    && typeof workflow.id === "string"
    && typeof workflow.name === "string"
    && Array.isArray(workflow.columns)
  ))) return false;
  if (!Object.values(value.taskWorkflowIds).every((workflowId) => typeof workflowId === "string")) return false;
  return true;
}

/**
 * FNXC:BoardWorkflows 2026-06-20-08:50:
 * Cache the last successful board-workflows payload per project in sessionStorage so Board and ListView can render the correct workflow-lane layout immediately on remount and never flash the legacy single-lane board before the async revalidation finishes.
 */
export function readBoardWorkflowsCache(projectId?: string): BoardWorkflowsPayload | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(cacheKey(projectId));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    return isBoardWorkflowsPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeBoardWorkflowsCache(projectId: string | undefined, payload: BoardWorkflowsPayload): void {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(cacheKey(projectId), JSON.stringify(payload));
  } catch {
    // Private-mode/quota failures should never prevent board rendering.
  }
}

export function clearBoardWorkflowsCache(projectId?: string): void {
  if (typeof window === "undefined") return;

  try {
    /*
    FNXC:ChatWorkflowAuthoring 2026-07-01-10:55:
    Chat workflow tools create/update/delete definitions outside mounted workflow UI components. Clear only the matching project's board-workflows snapshot before forced refetch so a chat-created workflow cannot be hidden by a pre-mutation session cache or leak into another project.
    */
    window.sessionStorage.removeItem(cacheKey(projectId));
  } catch {
    // Private-mode/quota failures should never prevent board rendering.
  }
}
