import { pruneStaleCacheEntries } from "./swrCache";

export const MAX_PERSISTED_DRAFT_BYTES = 64_000;

export const VOLATILE_DRAFT_STORAGE_KEYS = [
  "kb-quick-entry-text",
  "kb-inline-create-text",
  "kb-planning-last-description",
  "kb-mission-last-goal",
] as const;

export const GLOBAL_STORAGE_KEYS: string[] = [
  "kb-dashboard-theme-mode",
  "kb-dashboard-color-theme",
  "kb-dashboard-view-mode",
  "kb-dashboard-current-project",
  "kb-dashboard-recent-projects",
  "fn-agent-log-markdown",
  "fn-agent-log-tool-output",
];

export const PROJECT_STORAGE_KEYS: string[] = [
  "kb-dashboard-task-view",
  "kb-dashboard-list-columns",
  "kb-dashboard-hide-done",
  "kb-dashboard-todo-hide-done",
  "kb-dashboard-list-collapsed",
  "kb-dashboard-selected-tasks",
  "kb-dashboard-list-selected-task",
  "kb-dashboard-list-sidebar-width",
  "kb-dashboard-mailbox-sidebar-width",
  "kb-dashboard-agents-sidebar-width",
  "kb-dashboard-github-import-list-width",
  "kb-dashboard-github-import-state",
  "kb-quick-entry-text",
  "kb-inline-create-text",
  "fn-agent-view",
  "kb-terminal-tabs",
  "kb-planning-last-description",
  "kb-planning-active-session",
  "kb-subtask-last-description",
  "kb-mission-last-goal",
  "kb-usage-view-mode",
  "kb-usage-hidden-windows",
  "kb-usage-modal-size",
  "kb-usage-provider-order",
  "kb-chat-active-session",
  "kb-dashboard-working-branch-filter",
  "kb-dashboard-base-branch-filter",
  "kb-capacity-risk-banner-dismissed",
  "kb-github-setup-warning-missing-since",
  "kb-files-line-numbers",
  "kb-dashboard-dock-files-current",
  "kb-dashboard-board-workflow-selection",
  "fusion-plugin-dependency-graph:positions",
];

export function scopedKey(baseKey: string, projectId?: string): string {
  if (typeof projectId !== "string" || projectId.length === 0) {
    return baseKey;
  }

  return `kb:${projectId}:${baseKey}`;
}

export function getScopedItem(baseKey: string, projectId?: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const getItem = window.localStorage?.getItem;
  if (typeof getItem !== "function") {
    return null;
  }

  try {
    return getItem.call(window.localStorage, scopedKey(baseKey, projectId));
  } catch {
    return null;
  }
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function removeStorageKey(storage: Storage, key: string): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reclaims optional restoration state only after a scoped write hits storage quota.
 * The sweep is deliberately bounded and preserves the active project's drafts.
 */
export function reclaimScopedStorageQuota(options?: { keepProjectId?: string }): number {
  const storage = getStorage();
  if (!storage) {
    return 0;
  }

  let removed = 0;
  try {
    const keys: string[] = [];
    const maxEntries = Math.min(storage.length, 1_000);
    for (let index = 0; index < maxEntries; index += 1) {
      const key = storage.key(index);
      if (key !== null) keys.push(key);
    }

    for (const key of keys) {
      const isOtherProjectDraft = VOLATILE_DRAFT_STORAGE_KEYS.some((draftKey) => (
        key.startsWith("kb:")
        && key.endsWith(`:${draftKey}`)
        && key !== scopedKey(draftKey, options?.keepProjectId)
      ));
      if (isOtherProjectDraft && removeStorageKey(storage, key)) {
        removed += 1;
      }
    }
  } catch {
    // Storage enumeration is best-effort; stale SWR pruning can still reclaim space.
  }

  try {
    removed += pruneStaleCacheEntries();
  } catch {
    // A blocked storage implementation must not make draft persistence throw.
  }
  return removed;
}

/*
FNXC:ProjectStorage 2026-08-20-00:43:
Issue #3477 reported `kb:<projectId>:kb-quick-entry-text` exhausting localStorage. Draft persistence is optional restoration state, so writes must never throw or saturate the origin: capped callers skip oversized values and quota failures evict, reclaim stale volatile state, then fail closed.
*/
export function setScopedItem(
  baseKey: string,
  value: string,
  projectId?: string,
  options?: { maxBytes?: number },
): boolean {
  const storage = getStorage();
  if (!storage || typeof storage.setItem !== "function") {
    return false;
  }

  const key = scopedKey(baseKey, projectId);
  if (typeof options?.maxBytes === "number" && new TextEncoder().encode(value).length > options.maxBytes) {
    removeStorageKey(storage, key);
    return false;
  }

  const tryWrite = (): boolean => {
    try {
      storage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  };

  if (tryWrite()) return true;
  removeStorageKey(storage, key);
  if (tryWrite()) return true;
  reclaimScopedStorageQuota({ keepProjectId: projectId });
  return tryWrite();
}

export function removeScopedItem(baseKey: string, projectId?: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const removeItem = window.localStorage?.removeItem;
  if (typeof removeItem !== "function") {
    return;
  }

  try {
    removeItem.call(window.localStorage, scopedKey(baseKey, projectId));
  } catch {
    // Storage removal is also optional restoration cleanup.
  }
}
