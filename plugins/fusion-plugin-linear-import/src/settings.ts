import type { PluginSettingSchema } from "@fusion/plugin-sdk";

export const LINEAR_PLUGIN_ID = "fusion-plugin-linear-import";

export const linearSettingsSchema: Record<string, PluginSettingSchema> = {
  apiKey: {
    type: "password",
    label: "Linear API key",
    description: "Personal Linear API key used only by this plugin to browse and import issues.",
    required: true,
    group: "Authentication",
  },
  defaultTeamKey: {
    type: "string",
    label: "Default team key or ID",
    description: "Optional Linear team key or UUID to prefill issue searches.",
    group: "Defaults",
  },
  defaultStateFilter: {
    type: "enum",
    label: "Default issue state filter",
    description: "Initial issue state filter for browse and import tools.",
    enumValues: ["active", "backlog", "started", "unstarted", "completed", "canceled", "all"],
    defaultValue: "active",
    group: "Defaults",
  },
  defaultAssigneeId: {
    type: "string",
    label: "Default assignee ID",
    description: "Optional Linear user UUID used as the default assignee filter.",
    group: "Defaults",
  },
};

export type LinearStateFilter = "active" | "backlog" | "started" | "unstarted" | "completed" | "canceled" | "all";

export interface LinearPluginSettings {
  apiKey?: string;
  defaultTeamKey?: string;
  defaultStateFilter: LinearStateFilter;
  defaultAssigneeId?: string;
}

function optionalTrimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveLinearSettings(settings: Record<string, unknown>): LinearPluginSettings {
  const rawState = optionalTrimmed(settings.defaultStateFilter);
  const defaultStateFilter = rawState && linearSettingsSchema.defaultStateFilter.enumValues?.includes(rawState)
    ? rawState as LinearStateFilter
    : "active";

  /*
  FNXC:LinearImport 2026-07-02-00:00:
  FN-7443 requires Linear credentials to be plugin-owned settings, not host settings. Resolve only sanitized defaults here and keep the password value out of logs, task descriptions, route responses, and tool details.
  */
  return {
    apiKey: optionalTrimmed(settings.apiKey),
    defaultTeamKey: optionalTrimmed(settings.defaultTeamKey),
    defaultStateFilter,
    defaultAssigneeId: optionalTrimmed(settings.defaultAssigneeId),
  };
}

export function hasLinearApiKey(settings: Record<string, unknown>): boolean {
  return Boolean(resolveLinearSettings(settings).apiKey);
}
