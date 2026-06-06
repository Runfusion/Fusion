import {
  GlobalSettingsStore,
  type Settings,
  type GlobalSettings,
  DEFAULT_SETTINGS,
  resolveWorktrunkSettings,
  SUPPORTED_LOCALES,
} from "@fusion/core";
import { probeWorktrunk, resolveWorktrunkBinary } from "@fusion/engine";
import { resolveProject } from "../project-context.js";

// Settings that can be updated via CLI.
//
// NOTE: the step/review/model-lane policy keys (`runStepsInNewSessions`,
// `maxParallelSteps`, `requirePlanApproval`, etc.) were MOVED to workflow settings
// (U4/KTD-5) and are intentionally ABSENT here — they live as per-workflow values,
// not project/global settings. See WORKFLOW_SETTINGS_REDIRECT_HINT below.
export const VALID_SETTINGS = [
  "maxConcurrent",
  "maxWorktrees",
  "worktreeNaming",
  "worktreesDir",
  "taskPrefix",
  "ntfyTopic",
  "autoResolveConflicts",
  "smartConflictResolution",
  "ntfyEnabled",
  "defaultModel",
  "defaultNodeId",
  "unavailableNodePolicy",
  "worktrunk.enabled",
  "worktrunk.binaryPath",
  "worktrunk.onFailure",
  "language",
] as const;

// One-line redirect surfaced wherever the CLI lists/validates settings keys, so
// users who reach for a moved key learn where it lives now (U5/KTD-8).
export const WORKFLOW_SETTINGS_REDIRECT_HINT =
  "Note: step, review, and model-lane policy now live in workflow settings — edit them in the workflow editor or via fn_workflow_settings.";

const GLOBAL_ONLY_SETTINGS = ["ntfyEnabled", "ntfyTopic", "defaultModel", "language"] as const;
const PROJECT_ONLY_SETTINGS = [
  "maxConcurrent",
  "maxWorktrees",
  "worktreeNaming",
  "worktreesDir",
  "taskPrefix",
  "autoResolveConflicts",
  "smartConflictResolution",
  "defaultNodeId",
  "unavailableNodePolicy",
] as const;

type ValidSettingKey = (typeof VALID_SETTINGS)[number];

// Type guards for setting categories
const BOOLEAN_SETTINGS: readonly string[] = [
  "autoResolveConflicts",
  "smartConflictResolution",
  "ntfyEnabled",
  "worktrunk.enabled",
];

const NUMBER_SETTINGS: readonly string[] = ["maxConcurrent", "maxWorktrees"];

const ENUM_SETTINGS: Record<string, readonly string[]> = {
  worktreeNaming: ["random", "task-id", "task-title"],
  unavailableNodePolicy: ["block", "fallback-local"],
  "worktrunk.onFailure": ["fail", "fallback-native"],
  // "auto" clears the persisted locale and reverts to runtime detection.
  language: [...SUPPORTED_LOCALES, "auto"],
};

const STRING_SETTINGS: readonly string[] = [
  "taskPrefix",
  "ntfyTopic",
  "defaultModel",
  "defaultNodeId",
  "worktreesDir",
  "worktrunk.binaryPath",
];

// Validation ranges for numeric settings
const NUMBER_RANGES: Record<string, { min: number; max: number }> = {
  maxConcurrent: { min: 1, max: 10 },
  maxWorktrees: { min: 1, max: 20 },
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
function readDottedSetting(settings: GlobalSettings | Settings, key: string): unknown {
  const parts = key.split(".");
  let cursor: unknown = settings;
  for (const part of parts) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function applyDottedSetting(key: string, value: unknown, current: Record<string, unknown>): Record<string, unknown> {
  if (!key.includes(".")) {
    return { [key]: value };
  }

  const [root, leaf] = key.split(".", 2);
  const existingRoot = current[root];
  const nested =
    existingRoot && typeof existingRoot === "object" && !Array.isArray(existingRoot)
      ? (existingRoot as Record<string, unknown>)
      : {};

  return {
    [root]: {
      ...nested,
      [leaf]: value,
    },
  };
}

type CliSettingKey = string;

function formatSettingValue(
  key: CliSettingKey,
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
    const defaultValue = readDottedSetting(DEFAULT_SETTINGS, key);
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
function getSettingLabel(key: CliSettingKey): string {
  if (key === "ntfyEnabled") return "ntfy Enabled";
  if (key === "ntfyTopic") return "ntfy Topic";
  if (key === "worktrunk.enabled") return "Worktrunk Enabled";
  if (key === "worktrunk.binaryPath") return "Worktrunk Binary Path";
  if (key === "worktrunk.onFailure") return "Worktrunk On Failure";

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
      title: "Worktrees",
      keys: ["worktreeNaming", "worktreesDir", "recycleWorktrees"],
    },
    {
      title: "Worktrunk Integration",
      keys: ["worktrunk.enabled", "worktrunk.binaryPath", "worktrunk.onFailure"],
    },
    {
      title: "Tasks",
      keys: ["taskPrefix", "includeTaskIdInCommit"],
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
    const hasValues = group.keys.some((key) => readDottedSetting(settings, key) !== undefined);
    if (!hasValues) continue;

    console.log();
    console.log(`  ${group.title}:`);

    for (const key of group.keys) {
      const value = readDottedSetting(settings, key);
      const label = getSettingLabel(key);
      const formattedValue = formatSettingValue(key, value, settings);
      console.log(`    ${label.padEnd(25)} ${formattedValue}`);
    }
  }

  console.log();
  console.log(`  ${WORKFLOW_SETTINGS_REDIRECT_HINT}`);
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
    console.error(WORKFLOW_SETTINGS_REDIRECT_HINT);
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

    if (key === "language" && parsedValue === "auto") {
      // null-as-delete: removes the persisted key so the dashboard re-detects
      // from the browser and the TUI falls back to the environment locale.
      await globalStore!.updateSettings({ language: null } as unknown as Partial<GlobalSettings>);
      console.log();
      console.log("  ✓ Language reset to auto-detect (browser/environment locale)");
      console.log();
      return;
    }

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

    if (key === "worktrunk.enabled" && parsedValue === true) {
      const currentWorktrunk = store
        ? await store.getSettingsByScope().then((scoped) =>
            resolveWorktrunkSettings(scoped.global?.worktrunk, scoped.project?.worktrunk),
          )
        : resolveWorktrunkSettings((await globalStore!.getSettings()).worktrunk, undefined);
      const nextWorktrunk = { ...currentWorktrunk, enabled: true };

      try {
        const resolved = await resolveWorktrunkBinary({ settings: nextWorktrunk });
        const probe = await probeWorktrunk(resolved.binaryPath);
        if (!probe.ok) {
          throw new Error("worktrunk probe failed");
        }
      } catch {
        throw new Error(
          "worktrunk.enabled cannot be set to true until the binary is installed and verified. Install it from Settings → Worktrunk integration (or /api/worktrunk/install-request) first.",
        );
      }
    }

    if (store) {
      if (key.includes(".")) {
        const currentSettings = await store.getSettingsByScope();
        const projectPatch = applyDottedSetting(
          key,
          parsedValue,
          (currentSettings.project ?? {}) as Record<string, unknown>,
        );
        await store.updateSettings(projectPatch as Partial<Settings>);
      } else {
        await store.updateSettings({ [key]: parsedValue } as Partial<Settings>);
      }
    } else if (key.includes(".")) {
      const currentGlobalSettings = await globalStore!.getSettings();
      const globalPatch = applyDottedSetting(key, parsedValue, currentGlobalSettings as Record<string, unknown>);
      await globalStore!.updateSettings(globalPatch as Partial<GlobalSettings>);
    } else {
      await globalStore!.updateSettings({ [key]: parsedValue } as Partial<GlobalSettings>);
    }

    const currentSettings = store ? await store.getSettings() : await globalStore!.getSettings();
    console.log();
    console.log(`  ✓ Updated ${getSettingLabel(key)} to ${formatSettingValue(key, parsedValue, currentSettings as Settings)}`);
    console.log();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }
}
