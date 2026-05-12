import { GlobalSettingsStore, type Settings, type GlobalSettings, DEFAULT_SETTINGS } from "@fusion/core";
import { resolveProject } from "../project-context.js";

// Settings that can be updated via CLI
export const VALID_SETTINGS = [
  "maxConcurrent",
  "maxWorktrees",
  "worktreeNaming",
  "taskPrefix",
  "ntfyTopic",
  "autoResolveConflicts",
  "smartConflictResolution",
  "requirePlanApproval",
  "ntfyEnabled",
  "defaultModel",
  "runStepsInNewSessions",
  "maxParallelSteps",
  "defaultNodeId",
  "unavailableNodePolicy",
  "mergeStrategy",
  "requirePrApproval",
  "autoMerge",
  "pushAfterMerge",
  "pushRemote",
] as const;

const GLOBAL_ONLY_SETTINGS = ["ntfyEnabled", "ntfyTopic", "defaultModel"] as const;
const PROJECT_ONLY_SETTINGS = [
  "maxConcurrent",
  "maxWorktrees",
  "worktreeNaming",
  "taskPrefix",
  "autoResolveConflicts",
  "smartConflictResolution",
  "requirePlanApproval",
  "runStepsInNewSessions",
  "maxParallelSteps",
  "defaultNodeId",
  "unavailableNodePolicy",
] as const;

type ValidSettingKey = (typeof VALID_SETTINGS)[number];

// Type guards for setting categories
const BOOLEAN_SETTINGS: readonly string[] = [
  "autoResolveConflicts",
  "smartConflictResolution",
  "requirePlanApproval",
  "ntfyEnabled",
  "runStepsInNewSessions",
];

const NUMBER_SETTINGS: readonly string[] = ["maxConcurrent", "maxWorktrees", "maxParallelSteps"];

const ENUM_SETTINGS: Record<string, readonly string[]> = {
  worktreeNaming: ["random", "task-id", "task-title"],
  unavailableNodePolicy: ["block", "fallback-local"],
};

const STRING_SETTINGS: readonly string[] = ["taskPrefix", "ntfyTopic", "defaultModel", "defaultNodeId"];

// Validation ranges for numeric settings
const NUMBER_RANGES: Record<string, { min: number; max: number }> = {
  maxConcurrent: { min: 1, max: 10 },
  maxWorktrees: { min: 1, max: 20 },
  maxParallelSteps: { min: 1, max: 4 },
};

async function getGlobalSettingsStore(): Promise<GlobalSettingsStore> {
  const store = new GlobalSettingsStore();
  await store.init();
  return store;
}

function isGlobalOnlySetting(key: ValidSettingKey): boolean {
  return GLOBAL_ONLY_SETTINGS.includes(key as (typeof GLOBAL_ONLY_SETTINGS)[number]);
}

function isProjectOnlySetting(key: ValidSettingKey): boolean {
  return PROJECT_ONLY_SETTINGS.includes(key as (typeof PROJECT_ONLY_SETTINGS)[number]);
}

/**
 * Parse and validate a setting value based on its key's expected type
 */
export function parseValue(key: ValidSettingKey, value: string): unknown {
  const trimmed = value.trim();

  // Boolean settings
  if (BOOLEAN_SETTINGS.includes(key)) {
    const lower = trimmed.toLowerCase();
    if (lower === "true" || lower === "yes") return true;
    if (lower === "false" || lower === "no") return false;
    throw new Error(
      `Invalid boolean value for ${key}: "${value}". Use: true, false, yes, or no`
    );
  }

  // Number settings
  if (NUMBER_SETTINGS.includes(key)) {
    const num = parseInt(trimmed, 10);
    if (isNaN(num)) {
      throw new Error(`Invalid numeric value for ${key}: "${value}". Expected an integer.`);
    }
    const range = NUMBER_RANGES[key];
    if (range && (num < range.min || num > range.max)) {
      throw new Error(
        `Value out of range for ${key}: ${num}. Must be between ${range.min} and ${range.max}.`
      );
    }
    return num;
  }

  // Enum settings
  if (key in ENUM_SETTINGS) {
    const validValues = ENUM_SETTINGS[key];
    if (!validValues.includes(trimmed)) {
      throw new Error(
        `Invalid value for ${key}: "${value}". Valid options: ${validValues.join(", ")}`
      );
    }
    return trimmed;
  }

  // String settings (default)
  if (STRING_SETTINGS.includes(key)) {
    return trimmed;
  }

  return trimmed;
}

/**
 * Format a setting value for display
 */
function formatSettingValue(
  key: keyof Settings,
  value: unknown,
  _settings: GlobalSettings | Settings
): string {
  if (Array.isArray(value)) {
    return value.length > 0 ? `[${value.join(", ")}]` : "[]";
  }

  if (value === undefined) {
    return "(not set)";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "string") {
    const defaultValue = DEFAULT_SETTINGS[key];
    if (value === defaultValue) {
      return `"${value}" (default)`;
    }
    return `"${value}"`;
  }

  return String(value);
}

/**
 * Get display name for a setting (convert camelCase to readable)
 */
function getSettingLabel(key: string): string {
  if (key === "ntfyEnabled") return "ntfy Enabled";
  if (key === "ntfyTopic") return "ntfy Topic";

  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase());
}

/**
 * Run settings show command.
 *
 * Behavior:
 * - `fn settings` shows global settings
 * - `fn settings --project <name>` shows project settings for that project
 */
export async function runSettingsShow(projectName?: string): Promise<void> {
  const project = projectName ? await resolveProject(projectName) : undefined;
  const settings = project
    ? await project.store.getSettings()
    : await (await getGlobalSettingsStore()).getSettings();

  console.log();
  console.log(project
    ? `  fn Settings for project '${project.projectName}'`
    : "  fn Global Settings");
  console.log("  " + "─".repeat(50));

  const settingGroups = [
    {
      title: "Engine",
      keys: ["maxConcurrent", "maxWorktrees", "autoResolveConflicts", "smartConflictResolution"],
    },
    {
      title: "Execution",
      keys: ["runStepsInNewSessions", "maxParallelSteps"],
    },
    {
      title: "Worktrees",
      keys: ["worktreeNaming", "recycleWorktrees"],
    },
    {
      title: "Tasks",
      keys: ["taskPrefix", "requirePlanApproval", "includeTaskIdInCommit"],
    },
    {
      title: "Node Routing",
      keys: ["defaultNodeId", "unavailableNodePolicy"],
    },
    {
      title: "Notifications",
      keys: ["ntfyEnabled", "ntfyTopic"],
    },
    {
      title: "AI Model",
      keys: ["defaultProvider", "defaultModelId", "defaultThinkingLevel"],
    },
  ];

  for (const group of settingGroups) {
    const settingsRecord = settings as Record<string, unknown>;
    const hasValues = group.keys.some((key) => settingsRecord[key] !== undefined);
    if (!hasValues) continue;

    console.log();
    console.log(`  ${group.title}:`);

    for (const key of group.keys) {
      const value = settingsRecord[key];
      const label = getSettingLabel(key);
      const formattedValue = formatSettingValue(key as keyof Settings, value, settings);
      console.log(`    ${label.padEnd(25)} ${formattedValue}`);
    }
  }

  console.log();
}

/**
 * Run settings set command - updates a single setting.
 *
 * Scope rules:
 * - Global-only settings (`ntfy*`, `defaultModel`) update global settings
 * - Project-only settings require an explicit `--project` target
 */
export async function runSettingsSet(key: string, value: string, projectName?: string): Promise<void> {
  if (!VALID_SETTINGS.includes(key as ValidSettingKey)) {
    console.error(`Error: Unknown setting "${key}"`);
    console.error(`Valid settings: ${VALID_SETTINGS.join(", ")}`);
    process.exit(1);
    return;
  }

  const validKey = key as ValidSettingKey;

  if (projectName && isGlobalOnlySetting(validKey)) {
    console.error(`Error: Setting "${key}" is global-only. Omit --project to update it.`);
    process.exit(1);
    return;
  }

  if (!projectName && isProjectOnlySetting(validKey)) {
    console.error(`Error: Setting "${key}" is project-only. Use --project or run from a project directory.`);
    process.exit(1);
    return;
  }

  const projectContext = projectName ? await resolveProject(projectName) : undefined;
  const store = projectContext?.store;
  const globalStore = store ? undefined : await getGlobalSettingsStore();

  try {
    const parsedValue = parseValue(validKey, value);

    if (key === "defaultModel") {
      const parts = (parsedValue as string).split("/");
      if (parts.length !== 2) {
        console.error(
          `Error: Invalid format for defaultModel. Use "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5")`
        );
        process.exit(1);
        return;
      }
      const [provider, modelId] = parts;
      if (store) {
        await store.updateSettings({ defaultProvider: provider, defaultModelId: modelId });
      } else {
        await globalStore!.updateSettings({ defaultProvider: provider, defaultModelId: modelId });
      }
      console.log();
      console.log(`  ✓ Updated default model to ${provider}/${modelId}`);
      console.log();
      return;
    }

    const patch: Partial<Settings> = { [key]: parsedValue };
    if (store) {
      await store.updateSettings(patch);
    } else {
      await globalStore!.updateSettings(patch);
    }

    const currentSettings = store ? await store.getSettings() : await globalStore!.getSettings();
    console.log();
    console.log(`  ✓ Updated ${getSettingLabel(key)} to ${formatSettingValue(key as keyof Settings, parsedValue, currentSettings as Settings)}`);
    console.log();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }
}
