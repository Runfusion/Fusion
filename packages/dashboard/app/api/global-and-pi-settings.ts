/**
 * FNXC:CodeOrganization 2026-07-17-12:00:
 * Global settings and pi-extension/package client API peeled from legacy.ts.
 */
import type { GlobalSettings, ProjectSettings, Settings } from "@fusion/core";
import { api } from "./client.js";
import type { FetchOptions } from "./client.js";
import { withProjectId } from "./health.js";
import { dedupe } from "./dedupe.js";

export function fetchGlobalSettings(options?: FetchOptions): Promise<GlobalSettings> {
  return dedupe("/settings/global", () => api<GlobalSettings>("/settings/global"), options);
}

/** Update global (user-level) settings. These persist across all fn projects. */
export function updateGlobalSettings(settings: Partial<GlobalSettings>): Promise<Settings> {
  return api<Settings>("/settings/global", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

/** Fetch settings separated by scope: { global, project } */
export function fetchSettingsByScope(projectId?: string): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
  return api<{ global: GlobalSettings; project: Partial<ProjectSettings> }>(withProjectId("/settings/scopes", projectId));
}

export interface PiExtensionEntry {
  id: string;
  name: string;
  path: string;
  source: "fusion-global" | "pi-global" | "fusion-project" | "pi-project" | "package";
  enabled: boolean;
}

export interface PiExtensionSettings {
  extensions: PiExtensionEntry[];
  disabledIds: string[];
  settingsPath: string;
}

export function fetchPiExtensions(projectId?: string): Promise<PiExtensionSettings> {
  return api<PiExtensionSettings>(withProjectId("/settings/pi-extensions", projectId));
}

export function updatePiExtensions(disabledIds: string[], projectId?: string): Promise<PiExtensionSettings> {
  return api<PiExtensionSettings>(withProjectId("/settings/pi-extensions", projectId), {
    method: "PUT",
    body: JSON.stringify({ disabledIds }),
  });
}

/**
 * Test a notification provider by sending a test notification.
 * Supports "ntfy" and "webhook" provider IDs.
 */
export function testNotification(providerId: string, config?: Record<string, unknown>, projectId?: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>(withProjectId("/settings/test-notification", projectId), {
    method: "POST",
    // Pin providerId last so config.providerId cannot override the selected provider.
    body: JSON.stringify({ ...(config ?? {}), providerId }),
  });
}

/**
 * Backward-compatible ntfy test helper.
 * Wraps testNotification() while preserving the legacy function signature.
 */
export function testNtfyNotification(
  config?: {
    ntfyEnabled?: boolean;
    ntfyTopic?: string;
    ntfyBaseUrl?: string;
    ntfyAccessToken?: string;
  },
  projectId?: string,
): Promise<{ success: boolean }> {
  return testNotification("ntfy", config as Record<string, unknown> | undefined, projectId);
}

/** Pi extension settings from ~/.pi/agent/settings.json (global scope) */
export interface PiSettings {
  packages: Array<string | { source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] }>;
  extensions: string[];
  skills: string[];
  prompts: string[];
  themes: string[];
}

/** Fetch pi extension settings (global scope from ~/.pi/agent/settings.json) */
export function fetchPiSettings(): Promise<PiSettings> {
  return api<PiSettings>("/pi-settings");
}

/** Update pi extension settings (partial update, global scope) */
export async function updatePiSettings(settings: Partial<PiSettings>): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/pi-settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

/** Install a new pi package source (adds to ~/.pi/agent/settings.json) */
export async function installPiPackage(source: string): Promise<{ success: boolean }> {
  return api<{ success: boolean }>("/pi-settings/packages", {
    method: "POST",
    body: JSON.stringify({ source }),
  });
}

/** Reinstall Fusion's bundled pi package and ensure it remains in global Pi settings. */
export async function reinstallFusionPiPackage(projectId?: string): Promise<{ success: boolean; source: string }> {
  return api<{ success: boolean; source: string }>(withProjectId("/pi-settings/reinstall-fusion", projectId), {
    method: "POST",
  });
}

