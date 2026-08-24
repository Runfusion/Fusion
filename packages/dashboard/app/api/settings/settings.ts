/**
 * FNXC:CodeOrganization 2026-07-16-14:00:
 * Settings/config/update client API peeled from legacy.ts.
 */
import type { Settings } from "@fusion/core";
import { api } from "../client/client.js";
import type { FetchOptions } from "../client/client.js";
import { withProjectId } from "../client/health.js";
import type { UpdateCheckResponse } from "../client/health.js";
import { dedupe } from "../client/dedupe.js";

export function fetchConfig(projectId?: string): Promise<{
  maxConcurrent: number;
  effectiveMaxConcurrent: number;
  concurrencyBindingKnob: "maxConcurrent" | "maxWorktrees";
  rootDir: string;
}> {
  const path = withProjectId("/config", projectId);
  return dedupe(path, () => api<{
    maxConcurrent: number;
    effectiveMaxConcurrent: number;
    concurrencyBindingKnob: "maxConcurrent" | "maxWorktrees";
    rootDir: string;
  }>(path));
}

export function fetchSettings(projectId?: string, options?: FetchOptions): Promise<Settings> {
  const path = withProjectId("/settings", projectId);
  return dedupe(path, () => api<Settings>(path), options);
}

export function fetchTaskEffectiveSettings(taskId: string, projectId?: string, options?: FetchOptions): Promise<Settings> {
  const path = withProjectId(`/tasks/${taskId}/effective-settings`, projectId);
  return dedupe(path, () => api<Settings>(path), options);
}

export function updateSettings(settings: Partial<Settings>, projectId?: string): Promise<Settings> {
  return api<Settings>(withProjectId("/settings", projectId), {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function checkForUpdate(projectId?: string): Promise<UpdateCheckResponse> {
  return api<UpdateCheckResponse>(withProjectId("/update-check", projectId));
}

export function refreshUpdateCheck(projectId?: string): Promise<UpdateCheckResponse> {
  return api<UpdateCheckResponse>(withProjectId("/update-check/refresh", projectId), {
    method: "POST",
  });
}

export interface UpdateInstallResponse {
  currentVersion: string;
  latestVersion: string | null;
  updated: boolean;
  outcome?: "installed" | "no-update-available" | "check-failed" | "unsupported-install-method" | "failed";
  message?: string;
  error?: string;
  restartAttempted?: boolean;
  restartScheduled?: boolean;
  /** PID of the process that accepted an automatic update restart. */
  priorPid?: number;
}

/** The old dashboard process retains this successful install until it restarts. */
export type PendingUpdateInstall = UpdateInstallResponse;

export function installUpdate(projectId?: string): Promise<UpdateInstallResponse> {
  return api<UpdateInstallResponse>(withProjectId("/update-check/install", projectId), {
    method: "POST",
  });
}

