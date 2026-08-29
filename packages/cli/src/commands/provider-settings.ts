import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";

export interface PackageManagerSettingsView {
  getGlobalSettings(): Record<string, unknown>;
  getProjectSettings(): Record<string, unknown>;
  getNpmCommand(): string[] | undefined;
  isProjectTrusted(): boolean;
}

function siblingAgentDir(agentDir: string, siblingRoot: ".fusion" | ".pi"): string | undefined {
  if (basename(agentDir) !== "agent") {
    return undefined;
  }
  return join(dirname(dirname(agentDir)), siblingRoot, "agent");
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed !== null && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
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
    // Pi's SettingsManager defaults projects to trusted. Fusion workspaces are
    // user-owned, so preserve pre-upgrade behavior and keep project-scoped
    // .fusion resources loadable through the read-only settings view.
    isProjectTrusted: () => true,
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
  read(): Record<string, unknown>;
  /** Write the project settings (merges with existing values) */
  write(settings: Record<string, unknown>): void;
  /** Get the path to the settings file */
  getSettingsPath(): string;
} {
  const fusionSettingsPath = join(projectPath, ".fusion", "settings.json");

  function readSettings(): Record<string, unknown> {
    if (existsSync(fusionSettingsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(fusionSettingsPath, "utf-8")) as unknown;
        if (parsed !== null && typeof parsed === "object") {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Return empty on parse error
      }
    }
    return {};
  }

  function writeSettings(settings: Record<string, unknown>): void {
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
