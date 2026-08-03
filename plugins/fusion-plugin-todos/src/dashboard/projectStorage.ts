function key(keyName: string, projectId?: string): string { return projectId ? `${keyName}:${projectId}` : keyName; }
export function getScopedItem(keyName: string, projectId?: string): string | null { return window.localStorage.getItem(key(keyName, projectId)); }
export function setScopedItem(keyName: string, value: string, projectId?: string): void { window.localStorage.setItem(key(keyName, projectId), value); }
