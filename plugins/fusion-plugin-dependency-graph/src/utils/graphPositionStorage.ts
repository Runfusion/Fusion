import { getScopedItem, removeScopedItem, setScopedItem } from "@fusion/dashboard/app/utils/projectStorage";

export type NodePositions = Record<string, { x: number; y: number }>;

const STORAGE_KEY = "fusion-plugin-dependency-graph:positions";

function isPosition(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { x?: unknown; y?: unknown };
  return typeof candidate.x === "number" && Number.isFinite(candidate.x) && typeof candidate.y === "number" && Number.isFinite(candidate.y);
}

export function loadPositions(projectId?: string): NodePositions {
  const raw = getScopedItem(STORAGE_KEY, projectId);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};

    const result: NodePositions = {};
    for (const [taskId, value] of Object.entries(parsed)) {
      if (isPosition(value)) {
        result[taskId] = value;
      }
    }

    return result;
  } catch {
    return {};
  }
}

export function savePositions(positions: NodePositions, visibleTaskIds: Set<string>, projectId?: string): void {
  const filtered: NodePositions = {};
  for (const [taskId, position] of Object.entries(positions)) {
    if (visibleTaskIds.has(taskId) && isPosition(position)) {
      filtered[taskId] = position;
    }
  }

  setScopedItem(STORAGE_KEY, JSON.stringify(filtered), projectId);
}

export function clearPositions(projectId?: string): void {
  removeScopedItem(STORAGE_KEY, projectId);
}

export function mergePositions(autoLayoutPositions: NodePositions, savedPositions: NodePositions, visibleTaskIds: Set<string>): NodePositions {
  const merged: NodePositions = {};

  for (const [taskId, position] of Object.entries(autoLayoutPositions)) {
    if (visibleTaskIds.has(taskId) && isPosition(position)) {
      merged[taskId] = position;
    }
  }

  for (const [taskId, position] of Object.entries(savedPositions)) {
    if (visibleTaskIds.has(taskId) && isPosition(position)) {
      merged[taskId] = position;
    }
  }

  return merged;
}
