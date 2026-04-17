import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function getFusionAgentDir(home = process.env.HOME || process.env.USERPROFILE || homedir()): string {
  return join(home, ".fusion", "agent");
}

export function getLegacyAgentDir(home = process.env.HOME || process.env.USERPROFILE || homedir()): string {
  return join(home, ".pi", "agent");
}

export function getFusionAuthPath(home = process.env.HOME || process.env.USERPROFILE || homedir()): string {
  return join(getFusionAgentDir(home), "auth.json");
}

export function getLegacyAuthPaths(home = process.env.HOME || process.env.USERPROFILE || homedir()): string[] {
  return [
    join(home, ".pi", "agent", "auth.json"),
    join(home, ".pi", "auth.json"),
  ];
}

export function getFusionModelsPath(home = process.env.HOME || process.env.USERPROFILE || homedir()): string {
  return join(getFusionAgentDir(home), "models.json");
}

export function getLegacyModelsPaths(home = process.env.HOME || process.env.USERPROFILE || homedir()): string[] {
  return [
    join(home, ".pi", "agent", "models.json"),
    join(home, ".pi", "models.json"),
  ];
}

export function getModelRegistryModelsPath(home = process.env.HOME || process.env.USERPROFILE || homedir()): string {
  const fusionModelsPath = getFusionModelsPath(home);
  if (existsSync(fusionModelsPath)) {
    return fusionModelsPath;
  }

  return getLegacyModelsPaths(home).find((modelsPath) => existsSync(modelsPath)) ?? fusionModelsPath;
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function hasPackageManagerSettings(settings: Record<string, unknown>): boolean {
  return Array.isArray(settings.packages) || Array.isArray(settings.npmCommand);
}

export function getPackageManagerAgentDir(home = process.env.HOME || process.env.USERPROFILE || homedir()): string {
  const fusionAgentDir = getFusionAgentDir(home);
  const legacyAgentDir = getLegacyAgentDir(home);
  const fusionSettings = readJsonObject(join(fusionAgentDir, "settings.json"));
  const legacySettings = readJsonObject(join(legacyAgentDir, "settings.json"));

  if (hasPackageManagerSettings(fusionSettings) || !existsSync(legacyAgentDir)) {
    return fusionAgentDir;
  }
  if (hasPackageManagerSettings(legacySettings)) {
    return legacyAgentDir;
  }
  return existsSync(fusionAgentDir) ? fusionAgentDir : legacyAgentDir;
}
