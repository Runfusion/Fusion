import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveGlobalDirForHome, type CustomProvider } from "@fusion/core";

export function readCustomProviders(homeDir = homedir()): CustomProvider[] {
  try {
    const settingsPath = join(resolveGlobalDirForHome(homeDir), "settings.json");
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as { customProviders?: CustomProvider[] };
    return Array.isArray(parsed.customProviders) ? parsed.customProviders : [];
  } catch {
    return [];
  }
}
