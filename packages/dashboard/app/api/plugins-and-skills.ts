/**
 * FNXC:CodeOrganization 2026-07-18-14:00:
 * Plugin management and skills client API peeled from legacy.ts.
 */
import type {
  PluginInstallation,
  PluginSetupCheckResult,
  PluginState,
  PluginUiSlotDefinition,
  PluginUiContributionDefinition,
  PluginDashboardViewDefinition,
} from "@fusion/core";
import type {
  DiscoveredSkill,
  CatalogFetchResult,
  ToggleSkillResult,
  SkillContent,
  SkillFileContent,
} from "@fusion/dashboard";
import { api } from "./client.js";
import { withProjectId } from "./health.js";
import { dedupe } from "./dedupe.js";

// ── Plugin Management ────────────────────────────────────────────────────────

export interface RegistryPluginEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: "runtime" | "integration";
  npmPackage?: string;
  path?: string;
  homepage?: string;
  tags?: string[];
  installed: boolean;
  state?: PluginState;
  installedVersion?: string;
  canInstall: boolean;
}

/** Fetch all installed plugins */
export async function fetchPlugins(projectId?: string): Promise<PluginInstallation[]> {
  return api<PluginInstallation[]>(withProjectId("/plugins", projectId));
}

/** Fetch curated registry plugins with installed-state metadata */
export async function fetchPluginRegistry(
  query?: string,
  category?: string,
  projectId?: string,
): Promise<RegistryPluginEntry[]> {
  const params = new URLSearchParams();
  if (query?.trim()) {
    params.set("q", query.trim());
  }
  if (category?.trim()) {
    params.set("category", category.trim());
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const response = await api<{ plugins: RegistryPluginEntry[] }>(withProjectId(`/plugins/registry${suffix}`, projectId));
  return response.plugins;
}

/** Fetch a single plugin by ID */
export async function fetchPluginDetail(id: string, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}`, projectId));
}

/** Install a plugin from local path or npm package */
export async function installPlugin(
  source: { path: string; aiScanOnLoad?: boolean } | { package: string; aiScanOnLoad?: boolean },
  projectId?: string,
): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId("/plugins", projectId), {
    method: "POST",
    body: JSON.stringify({ mode: "install", ...source }),
  });
}

/** Enable a plugin */
export async function enablePlugin(id: string, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}/enable`, projectId), {
    method: "POST",
  });
}

/** Disable a plugin */
export async function disablePlugin(id: string, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}/disable`, projectId), {
    method: "POST",
  });
}

/** Uninstall a plugin */
export async function uninstallPlugin(id: string, projectId?: string): Promise<void> {
  return api<void>(withProjectId(`/plugins/${encodeURIComponent(id)}`, projectId), {
    method: "DELETE",
  });
}

/** Fetch plugin settings */
export async function fetchPluginSettings(id: string, projectId?: string): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>(withProjectId(`/plugins/${encodeURIComponent(id)}/settings`, projectId));
}

/** Update plugin settings */
export async function updatePluginSettings(
  id: string,
  settings: Record<string, unknown>,
  projectId?: string,
): Promise<Record<string, unknown>> {
  return api<Record<string, unknown>>(withProjectId(`/plugins/${encodeURIComponent(id)}/settings`, projectId), {
    method: "PUT",
    body: JSON.stringify({ settings }),
  });
}

export type PluginSetupStatusResponse =
  | { hasSetup: false }
  | ({ hasSetup: true } & PluginSetupCheckResult)
  | {
    hasSetup: true;
    setupCheckDeferred: true;
    deferredReason: "plugin-not-started";
    pluginState: PluginInstallation["state"];
  };

/** Fetch plugin setup status */
export async function fetchPluginSetupStatus(id: string, projectId?: string): Promise<PluginSetupStatusResponse> {
  return api<PluginSetupStatusResponse>(withProjectId(`/plugins/${encodeURIComponent(id)}/setup-status`, projectId));
}

/** Trigger plugin setup install hook */
export async function installPluginSetup(id: string, projectId?: string): Promise<{ success: boolean; error?: string }> {
  return api<{ success: boolean; error?: string }>(withProjectId(`/plugins/${encodeURIComponent(id)}/setup/install`, projectId), {
    method: "POST",
  });
}

/** Reload a running plugin with updated code */
export async function reloadPlugin(id: string, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}/reload`, projectId), {
    method: "POST",
  });
}

/** Update plugin security-scan configuration */
export async function updatePlugin(id: string, updates: { aiScanOnLoad: boolean }, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}`, projectId), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

/** Trigger plugin rescan + reload flow */
export async function rescanPlugin(id: string, projectId?: string): Promise<PluginInstallation> {
  return api<PluginInstallation>(withProjectId(`/plugins/${encodeURIComponent(id)}/rescan`, projectId), {
    method: "POST",
  });
}

/** A UI slot entry returned by GET /api/plugins/ui-slots */
export interface PluginUiSlotEntry {
  pluginId: string;
  slot: PluginUiSlotDefinition;
}

/** A structured UI contribution entry returned by GET /api/plugins/ui-contributions */
export interface PluginUiContributionEntry {
  pluginId: string;
  contribution: PluginUiContributionDefinition;
}

/** A dashboard view entry returned by GET /api/plugins/dashboard-views */
export interface PluginDashboardViewEntry {
  pluginId: string;
  view: PluginDashboardViewDefinition;
}

/** Plugin runtime metadata returned by GET /api/plugins/runtimes */
export interface PluginRuntimeInfo {
  pluginId: string;
  runtimeId: string;
  name: string;
  description?: string;
  version?: string;
}

/** Fetch all UI slot definitions from active plugins */
export async function fetchPluginUiSlots(projectId?: string): Promise<PluginUiSlotEntry[]> {
  const path = withProjectId("/plugins/ui-slots", projectId);
  return dedupe(path, () => api<PluginUiSlotEntry[]>(path));
}


/** Fetch all structured UI contributions from active plugins */
export async function fetchPluginUiContributions(projectId?: string): Promise<PluginUiContributionEntry[]> {
  return api<PluginUiContributionEntry[]>(withProjectId("/plugins/ui-contributions", projectId));
}

/** Fetch all top-level dashboard view definitions from active plugins */
export async function fetchPluginDashboardViews(projectId?: string): Promise<PluginDashboardViewEntry[]> {
  return api<PluginDashboardViewEntry[]>(withProjectId("/plugins/dashboard-views", projectId));
}

/** Fetch all plugin runtime metadata from active plugins */
export async function fetchPluginRuntimes(projectId?: string): Promise<PluginRuntimeInfo[]> {
  return api<PluginRuntimeInfo[]>(withProjectId("/plugins/runtimes", projectId));
}

// ── Skills Management ─────────────────────────────────────────────────────────

/** Fetch all discovered skills with their enabled state */
export async function fetchDiscoveredSkills(projectId?: string): Promise<DiscoveredSkill[]> {
  const response = await api<{ skills: DiscoveredSkill[] }>(withProjectId("/skills/discovered", projectId));
  return response.skills;
}

/** Toggle a skill's enabled/disabled state */
export async function toggleExecutionSkill(
  skillId: string,
  enabled: boolean,
  projectId?: string,
): Promise<ToggleSkillResult> {
  return api<ToggleSkillResult>(withProjectId("/skills/execution", projectId), {
    method: "PATCH",
    body: JSON.stringify({ skillId, enabled }),
  });
}

/** Install a catalog skill from skills.sh */
export async function installSkill(
  source: string,
  skill: string | undefined,
  projectId?: string,
): Promise<{ success: true }> {
  return api<{ success: true }>(withProjectId("/skills/install", projectId), {
    method: "POST",
    body: JSON.stringify({ source, skill }),
  });
}

/** Fetch the skills.sh catalog */
export async function fetchSkillsCatalog(
  query?: string,
  limit?: number,
  projectId?: string,
): Promise<CatalogFetchResult> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (limit !== undefined) params.set("limit", String(limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return api<CatalogFetchResult>(withProjectId(`/skills/catalog${suffix}`, projectId));
}

/** Fetch the contents of a skill's SKILL.md file */
export async function fetchSkillContent(skillId: string, projectId?: string): Promise<SkillContent> {
  const response = await api<{ content: SkillContent }>(
    withProjectId(`/skills/${encodeURIComponent(skillId)}/content`, projectId)
  );
  return response.content;
}

/*
FNXC:Skills 2026-06-23-04:15:
Fetch one supplementary file's content for the SkillsView detail-pane file viewer. The skill-dir-relative path is passed as an encoded `path` query param; the server resolves + traversal-guards it. Returns isText:false for binary/oversized files so the UI shows a non-previewable notice.
*/
export async function fetchSkillFileContent(skillId: string, relativePath: string, projectId?: string): Promise<SkillFileContent> {
  const base = withProjectId(`/skills/${encodeURIComponent(skillId)}/file`, projectId);
  const sep = base.includes("?") ? "&" : "?";
  const response = await api<{ file: SkillFileContent }>(
    `${base}${sep}path=${encodeURIComponent(relativePath)}`
  );
  return response.file;
}

