/** CLI entrypoint for importing portable organization bundles. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentStore, AutomationStore, RoutineStore, createTaskStoreForBackend, materializeOrgBundle, type OrgBundle } from "@fusion/core";
import { resolveProjectPathOnly } from "../project-context.js";

export async function runOrgImport(file: string, options: { project?: string; dryRun?: boolean; collisionMode?: "skip" | "suffix" } = {}): Promise<void> {
  const rootDir = options.project ? await resolveProjectPathOnly(options.project) : process.cwd();
  const bundle = JSON.parse(await readFile(resolve(file), "utf8")) as OrgBundle;
  const boot = await createTaskStoreForBackend({ rootDir });
  const agents = new AgentStore({ rootDir: `${rootDir}/.fusion`, asyncLayer: boot.taskStore.asyncLayer! });
  try {
    await agents.init();
    const result = await materializeOrgBundle({ projectRoot: rootDir, agentStore: agents, routineStore: new RoutineStore(rootDir, { asyncLayer: boot.taskStore.asyncLayer! }), automationStore: new AutomationStore(rootDir, { asyncLayer: boot.taskStore.asyncLayer! }), settingsStore: boot.taskStore }, bundle, { dryRun: options.dryRun, collisionMode: options.collisionMode });
    console.log(options.dryRun ? "Organization import dry-run:" : "Organization imported:");
    console.log(JSON.stringify(result, null, 2));
  } finally { agents.close(); await boot.shutdown(); }
}
