import { getScopedItem, setScopedItem } from "./projectStorage";

export const TASK_DETAIL_TAB_ORDER_STORAGE_KEY = "kb-task-detail-tab-order";

/**
 * Reconciles durable user order with the tabs currently available. Unknown and duplicate
 * persisted ids are discarded; newly available destinations retain canonical placement.
 */
export function reconcileTaskDetailTabOrder(
  persisted: unknown,
  canonicalIds: readonly string[],
): string[] {
  const available = new Set(canonicalIds);
  const seen = new Set<string>();
  const retained = Array.isArray(persisted)
    ? persisted.filter((id): id is string => {
        if (typeof id !== "string" || !available.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
    : [];

  const result = [...retained];
  for (const id of canonicalIds) {
    if (seen.has(id)) continue;
    const canonicalIndex = canonicalIds.indexOf(id);
    const nextKnown = canonicalIds.slice(canonicalIndex + 1).find((candidate) => seen.has(candidate));
    const insertionIndex = nextKnown ? result.indexOf(nextKnown) : result.length;
    result.splice(insertionIndex, 0, id);
    seen.add(id);
  }
  return result;
}

export function parseTaskDetailTabOrder(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function hasSavedTaskDetailTabOrder(projectId: string | undefined): boolean {
  return Boolean(projectId && getScopedItem(TASK_DETAIL_TAB_ORDER_STORAGE_KEY, projectId));
}

export function loadTaskDetailTabOrder(projectId: string | undefined, canonicalIds: readonly string[]): string[] {
  if (!projectId) return [...canonicalIds];
  return reconcileTaskDetailTabOrder(
    parseTaskDetailTabOrder(getScopedItem(TASK_DETAIL_TAB_ORDER_STORAGE_KEY, projectId)),
    canonicalIds,
  );
}

export function saveTaskDetailTabOrder(projectId: string | undefined, ids: readonly string[]): boolean {
  if (!projectId) return false;
  return setScopedItem(TASK_DETAIL_TAB_ORDER_STORAGE_KEY, JSON.stringify(ids), projectId);
}

export function moveTaskDetailTab(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
  position: "before" | "after",
): string[] {
  if (sourceId === targetId || !ids.includes(sourceId) || !ids.includes(targetId)) return [...ids];
  const next = ids.filter((id) => id !== sourceId);
  const targetIndex = next.indexOf(targetId);
  next.splice(targetIndex + (position === "after" ? 1 : 0), 0, sourceId);
  return next;
}
