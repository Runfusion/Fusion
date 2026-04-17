import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";

export interface PackageManagerSettingsView {
  getGlobalSettings(): Record<string, any>;
  getProjectSettings(): Record<string, any>;
  getNpmCommand(): string[] | undefined;
}

function siblingAgentDir(agentDir: string, siblingRoot: ".fusion" | ".pi"): string | undefined {
  if (basename(agentDir) !== "agent") {
    return undefined;
  }
  return join(dirname(dirname(agentDir)), siblingRoot, "agent");
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
  const fusionAgentDir = agentDir.includes(`${join(".fusion", "agent")}`)
    ? agentDir
    : siblingAgentDir(agentDir, ".fusion");
  const legacyAgentDir = agentDir.includes(`${join(".pi", "agent")}`)
    ? agentDir
    : siblingAgentDir(agentDir, ".pi");
  const legacyGlobalSettings = legacyAgentDir ? readJsonObject(join(legacyAgentDir, "settings.json")) : {};
  const fusionGlobalSettings = fusionAgentDir ? readJsonObject(join(fusionAgentDir, "settings.json")) : {};
  const directGlobalSettings = readJsonObject(join(agentDir, "settings.json"));
  const globalSettings = { ...legacyGlobalSettings, ...directGlobalSettings, ...fusionGlobalSettings };
  const fusionProjectSettings = readJsonObject(join(cwd, ".fusion", "settings.json"));
  const mergedSettings = { ...globalSettings, ...fusionProjectSettings };

  return {
    getGlobalSettings: () => structuredClone(globalSettings),
    getProjectSettings: () => structuredClone(fusionProjectSettings),
    getNpmCommand: () => Array.isArray(mergedSettings.npmCommand)
      ? [...mergedSettings.npmCommand]
      : undefined,
  };
}

/**
 * Project settings persistence helper.
 *
 * Reads from and writes to `.fusion/settings.json`.
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

  function readSettings(): Record<string, any> {
    if (existsSync(fusionSettingsPath)) {
      try {
        return JSON.parse(readFileSync(fusionSettingsPath, "utf-8")) as Record<string, any>;
      } catch {
        // Return empty on parse error
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
