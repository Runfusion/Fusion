export const GLOBAL_STORAGE_KEYS: string[] = [
  "kb-dashboard-theme-mode",
  "kb-dashboard-color-theme",
  "kb-dashboard-view-mode",
  "kb-dashboard-current-project",
  "kb-dashboard-recent-projects",
];

export const PROJECT_STORAGE_KEYS: string[] = [
  "kb-dashboard-task-view",
  "kb-dashboard-list-columns",
  "kb-dashboard-hide-done",
  "kb-dashboard-list-collapsed",
  "kb-dashboard-selected-tasks",
  "kb-quick-entry-text",
  "kb-inline-create-text",
  "fn-agent-view",
  "fn-agent-tree-expanded",
  "kb-terminal-tabs",
  "kb-planning-last-description",
  "kb-subtask-last-description",
  "kb-mission-last-goal",
  "kb-usage-view-mode",
  "kb-usage-hidden-windows",
  "kb-chat-active-session",
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

  return window.localStorage.getItem(scopedKey(baseKey, projectId));
}

export function setScopedItem(baseKey: string, value: string, projectId?: string): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(scopedKey(baseKey, projectId), value);
}

export function removeScopedItem(baseKey: string, projectId?: string): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(scopedKey(baseKey, projectId));
}
