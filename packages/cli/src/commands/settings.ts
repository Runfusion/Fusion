import { TaskStore, type Settings, DEFAULT_SETTINGS } from "@fusion/core";

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
] as const;

type ValidSettingKey = (typeof VALID_SETTINGS)[number];

// Type guards for setting categories
const BOOLEAN_SETTINGS: readonly string[] = [
  "autoResolveConflicts",
  "smartConflictResolution",
  "requirePlanApproval",
  "ntfyEnabled",
];

const NUMBER_SETTINGS: readonly string[] = ["maxConcurrent", "maxWorktrees"];

const ENUM_SETTINGS: Record<string, readonly string[]> = {
  worktreeNaming: ["random", "task-id", "task-title"],
};

const STRING_SETTINGS: readonly string[] = ["taskPrefix", "ntfyTopic", "defaultModel"];

// Validation ranges for numeric settings
const NUMBER_RANGES: Record<string, { min: number; max: number }> = {
  maxConcurrent: { min: 1, max: 10 },
  maxWorktrees: { min: 1, max: 20 },
};

async function getStore(): Promise<TaskStore> {
  const store = new TaskStore(process.cwd());
  await store.init();
  return store;
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
    // Allow empty string to clear the value (will be stored as empty string, merged with default)
    return trimmed;
  }

  // Fallback for any other settings - treat as string
  return trimmed;
}

/**
 * Format a setting value for display
 */
function formatSettingValue(
  key: keyof Settings,
  value: unknown,
  settings: Settings
): string {
  // Special case for githubTokenConfigured - show as indicator
  if (key === "githubTokenConfigured") {
    return value ? "(configured)" : "(not configured)";
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.length > 0 ? `[${value.join(", ")}]` : "[]";
  }

  // Handle undefined
  if (value === undefined) {
    return "(not set)";
  }

  // Handle booleans
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  // Handle numbers
  if (typeof value === "number") {
    return String(value);
  }

  // Handle strings
  if (typeof value === "string") {
    // Check if this is the same as default
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
  // Special cases
  if (key === "ntfyEnabled") return "ntfy Enabled";
  if (key === "ntfyTopic") return "ntfy Topic";

  // Convert camelCase to space-separated words with capital first letters
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase());
}

/**
 * Run settings show command - displays all settings
 */
export async function runSettingsShow(): Promise<void> {
  const store = await getStore();
  const settings = await store.getSettings();

  console.log();
  console.log("  kb Configuration Settings");
  console.log("  " + "─".repeat(50));

  // Define the order and grouping of settings for display
  const settingGroups = [
    {
      title: "Engine",
      keys: ["maxConcurrent", "maxWorktrees", "autoResolveConflicts", "smartConflictResolution"],
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
      title: "Notifications",
      keys: ["ntfyEnabled", "ntfyTopic"],
    },
    {
      title: "GitHub",
      keys: ["githubTokenConfigured"],
    },
    {
      title: "AI Model",
      keys: ["defaultProvider", "defaultModelId", "defaultThinkingLevel"],
    },
  ];

  for (const group of settingGroups) {
    // Check if any setting in this group has a value
    const hasValues = group.keys.some((key) => settings[key as keyof Settings] !== undefined);
    if (!hasValues) continue;

    console.log();
    console.log(`  ${group.title}:`);

    for (const key of group.keys) {
      const value = settings[key as keyof Settings];
      const label = getSettingLabel(key);
      const formattedValue = formatSettingValue(key as keyof Settings, value, settings);
      console.log(`    ${label.padEnd(25)} ${formattedValue}`);
    }
  }

  console.log();
}

/**
 * Run settings set command - updates a single setting
 */
export async function runSettingsSet(key: string, value: string): Promise<void> {
  // Validate the setting key is allowed
  if (!VALID_SETTINGS.includes(key as ValidSettingKey)) {
    console.error(`Error: Unknown setting "${key}"`);
    console.error(`Valid settings: ${VALID_SETTINGS.join(", ")}`);
    process.exit(1);
    return; // Required for tests where process.exit is mocked
  }

  const store = await getStore();

  try {
    const parsedValue = parseValue(key as ValidSettingKey, value);

    // Special handling for defaultModel - splits into provider and modelId
    if (key === "defaultModel") {
      const parts = (parsedValue as string).split("/");
      if (parts.length !== 2) {
        console.error(
          `Error: Invalid format for defaultModel. Use "provider/model-id" (e.g., "anthropic/claude-sonnet-4-5")`
        );
        process.exit(1);
        return; // Required for tests where process.exit is mocked
      }
      const [provider, modelId] = parts;
      await store.updateSettings({ defaultProvider: provider, defaultModelId: modelId });
      console.log();
      console.log(`  ✓ Updated default model to ${provider}/${modelId}`);
      console.log();
      return;
    }

    // Normal single-setting update
    const patch: Partial<Settings> = { [key]: parsedValue };
    await store.updateSettings(patch);

    console.log();
    console.log(`  ✓ Updated ${getSettingLabel(key)} to ${formatSettingValue(key as keyof Settings, parsedValue, await store.getSettings())}`);
    console.log();
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
    return; // Required for tests where process.exit is mocked
  }
}
