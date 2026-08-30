import { DefaultPackageManager, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { createReadOnlyProviderSettingsView } from "./provider-settings.js";

/*
 * FNXC:Skills 2026-08-27-03:10:
 * Each dashboard request must resolve skills from its selected project root. Do not cache these managers: the read-only settings view snapshots project settings, so rebuilding preserves newly toggled skills on the next request.
 */
export function createProjectScopedPackageManagerFactory(agentDir: string) {
  return (rootDir: string) => new DefaultPackageManager({
    cwd: resolve(rootDir),
    agentDir,
    settingsManager: createReadOnlyProviderSettingsView(rootDir, agentDir) as unknown as SettingsManager,
  });
}
