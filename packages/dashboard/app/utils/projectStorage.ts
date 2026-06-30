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
  "kb-dashboard-list-collapsed",
  "kb-dashboard-selected-tasks",
  "kb-dashboard-list-selected-task",
  "kb-dashboard-list-sidebar-width",
  "kb-dashboard-mailbox-sidebar-width",
  "kb-dashboard-agents-sidebar-width",
  "kb-dashboard-github-import-list-width",
  "kb-quick-entry-text",
  "kb-inline-create-text",
  "fn-agent-view",
  "kb-terminal-tabs",
  "kb-planning-last-description",
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

  return getItem.call(window.localStorage, scopedKey(baseKey, projectId));
}

export function setScopedItem(baseKey: string, value: string, projectId?: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const setItem = window.localStorage?.setItem;
  if (typeof setItem !== "function") {
    return;
  }

  setItem.call(window.localStorage, scopedKey(baseKey, projectId), value);
}

export function removeScopedItem(baseKey: string, projectId?: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const removeItem = window.localStorage?.removeItem;
  if (typeof removeItem !== "function") {
    return;
  }

  removeItem.call(window.localStorage, scopedKey(baseKey, projectId));
}
