import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface PackageManagerSettingsView {
  getGlobalSettings(): Record<string, any>;
  getProjectSettings(): Record<string, any>;
  getNpmCommand(): string[] | undefined;
}

function readJsonObject(path: string): Record<string, any> {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

export function createReadOnlyProviderSettingsView(cwd: string, agentDir: string): PackageManagerSettingsView {
  const globalSettings = readJsonObject(join(agentDir, "settings.json"));
  const legacyProjectSettings = readJsonObject(join(cwd, ".pi", "settings.json"));
  const fusionProjectSettings = readJsonObject(join(cwd, ".fusion", "settings.json"));
  const projectSettings = { ...legacyProjectSettings, ...fusionProjectSettings };
  const mergedSettings = { ...globalSettings, ...projectSettings };

  return {
    getGlobalSettings: () => structuredClone(globalSettings),
    getProjectSettings: () => structuredClone(projectSettings),
    getNpmCommand: () => Array.isArray(mergedSettings.npmCommand)
      ? [...mergedSettings.npmCommand]
      : undefined,
  };
}

/**
 * Project settings persistence helper.
 *
 * Reads from and writes to `.fusion/settings.json` with fallback to `.pi/settings.json`
 * for backward compatibility. Changes are always written to `.fusion/settings.json`.
 *
 * @param projectPath - Absolute path to the project root
 * @returns Object with read/write methods for project settings
 */
export function createProjectSettingsPersistence(projectPath: string): {
  /** Read the current project settings */
  read(): Record<string, any>;
  /** Write the project settings (merges with existing values) */
  write(settings: Record<string, any>): void;
  /** Get the path to the settings file */
  getSettingsPath(): string;
} {
  const fusionSettingsPath = join(projectPath, ".fusion", "settings.json");
  const legacySettingsPath = join(projectPath, ".pi", "settings.json");

  function readSettings(): Record<string, any> {
    // Try .fusion first
    if (existsSync(fusionSettingsPath)) {
      try {
        return JSON.parse(readFileSync(fusionSettingsPath, "utf-8")) as Record<string, any>;
      } catch {
        // Fall through to legacy
      }
    }
    // Fall back to .pi
    if (existsSync(legacySettingsPath)) {
      try {
        return JSON.parse(readFileSync(legacySettingsPath, "utf-8")) as Record<string, any>;
      } catch {
        // Return empty
      }
    }
    return {};
  }

  function writeSettings(settings: Record<string, any>): void {
    // Ensure .fusion directory exists
    const fusionDir = dirname(fusionSettingsPath);
    if (!existsSync(fusionDir)) {
      mkdirSync(fusionDir, { recursive: true });
    }
    writeFileSync(fusionSettingsPath, JSON.stringify(settings, null, 2));
  }

  return {
    read: readSettings,
    write: writeSettings,
    getSettingsPath: () => fusionSettingsPath,
  };
}
