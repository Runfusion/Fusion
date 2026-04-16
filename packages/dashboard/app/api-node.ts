/**
 * Remote Node API functions for fetching data from remote nodes via the proxy.
 * All functions route through /api/proxy/:nodeId/... when a remote node is targeted.
 */

import type { ProjectInfo } from "./api";
import type { ProjectHealth, Task } from "@fusion/core";
import { api, proxyApi } from "./api";

/** Health information for a remote node */
export interface RemoteNodeHealth {
  status: string;
  version: string;
  nodeId: string;
}

/** Fetch health information from a remote node */
export async function fetchRemoteNodeHealth(nodeId: string): Promise<RemoteNodeHealth> {
  return proxyApi<RemoteNodeHealth>("/health", { nodeId });
}

/** Fetch all projects from a remote node */
export async function fetchRemoteNodeProjects(nodeId: string): Promise<ProjectInfo[]> {
  return proxyApi<ProjectInfo[]>("/projects", { nodeId });
}

/** Fetch tasks from a specific project on a remote node */
export async function fetchRemoteNodeTasks(
  nodeId: string,
  projectId: string,
  searchQuery?: string,
): Promise<Task[]> {
  const params = new URLSearchParams({ projectId });
  if (searchQuery && searchQuery.trim()) {
    params.set("q", searchQuery.trim());
  }
  return proxyApi<Task[]>(`/tasks?${params.toString()}`, { nodeId });
}

/** Fetch project health from a remote node */
export async function fetchRemoteNodeProjectHealth(
  nodeId: string,
  projectId: string,
): Promise<ProjectHealth> {
  return proxyApi<ProjectHealth>(`/project-health?projectId=${encodeURIComponent(projectId)}`, {
    nodeId,
  });
}

// ── Node Settings Sync API ──────────────────────────────────────────────────────

/** Settings scopes returned by GET /api/nodes/:id/settings */
export interface NodeSettingsScopes {
  global: Record<string, unknown>;
  project: Record<string, unknown>;
}

/** Result from settings push/pull operations */
export interface NodeSettingsSyncResult {
  success: boolean;
  syncedFields?: string[];
  appliedFields?: string[];
  skippedFields?: string[];
  error?: string;
}

/** Sync status returned by GET /api/nodes/:id/settings/sync-status */
export interface NodeSettingsSyncStatus {
  lastSyncAt: string | null;
  lastSyncDirection: string | null;
  localUpdatedAt: string;
  remoteReachable: boolean;
  diff: {
    global: string[];
    project: string[];
  };
}

/** Result from auth sync operation */
export interface NodeAuthSyncResult {
  success: boolean;
  syncedProviders: string[];
}

/** Fetch settings from a remote node */
export async function fetchNodeSettings(nodeId: string): Promise<NodeSettingsScopes> {
  return api<NodeSettingsScopes>(`/nodes/${encodeURIComponent(nodeId)}/settings`);
}

/** Push local settings to a remote node */
export async function pushNodeSettings(nodeId: string): Promise<NodeSettingsSyncResult> {
  return api<NodeSettingsSyncResult>(`/nodes/${encodeURIComponent(nodeId)}/settings/push`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** Pull settings from a remote node and apply locally */
export async function pullNodeSettings(nodeId: string): Promise<NodeSettingsSyncResult> {
  return api<NodeSettingsSyncResult>(`/nodes/${encodeURIComponent(nodeId)}/settings/pull`, {
    method: "POST",
    body: JSON.stringify({ conflictResolution: "last-write-wins" }),
  });
}

/** Get the sync status for a node (last sync time, diff summary, etc.) */
export async function fetchNodeSettingsSyncStatus(nodeId: string): Promise<NodeSettingsSyncStatus> {
  return api<NodeSettingsSyncStatus>(`/nodes/${encodeURIComponent(nodeId)}/settings/sync-status`);
}

/** Synchronize model auth credentials with a remote node */
export async function syncNodeAuth(nodeId: string): Promise<NodeAuthSyncResult> {
  return api<NodeAuthSyncResult>(`/nodes/${encodeURIComponent(nodeId)}/auth/sync`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
