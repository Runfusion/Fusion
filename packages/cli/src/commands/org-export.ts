/** CLI entrypoint for portable, secret-scrubbed organization bundles. */
import { resolve } from "node:path";
import { AgentStore, AutomationStore, RoutineStore, assembleOrgBundle, createTaskStoreForBackend } from "@fusion/core";
import { resolveProjectPathOnly } from "../project-context.js";

/* FNXC:OrgPortability 2026-07-16-00:00: org-export always writes the scrubbed composition returned by core, so the CLI artifact is safe to hand off or commit without an operator secret audit. */
export async function runOrgExport(output: string, options: { project?: string } = {}): Promise<void> {
  const rootDir = options.project ? await resolveProjectPathOnly(options.project) : process.cwd();
  const boot = await createTaskStoreForBackend({ rootDir });
  const agents = new AgentStore({ rootDir: `${rootDir}/.fusion`, asyncLayer: boot.taskStore.asyncLayer! });
  try {
    await agents.init();
    const bundle = await assembleOrgBundle({ projectRoot: rootDir, agentStore: agents, routineStore: new RoutineStore(rootDir, { asyncLayer: boot.taskStore.asyncLayer! }), automationStore: new AutomationStore(rootDir, { asyncLayer: boot.taskStore.asyncLayer! }), settingsStore: boot.taskStore });
    await import("node:fs/promises").then(({ writeFile, rename }) => writeFile(`${resolve(output)}.tmp`, JSON.stringify(bundle, null, 2)).then(() => rename(`${resolve(output)}.tmp`, resolve(output))));
    console.log(`Organization bundle exported to ${resolve(output)}`);
    console.log(`Agents: ${bundle.agents.length}; skills: ${bundle.skills.length}; routines: ${bundle.routines.length}; automations: ${bundle.automations.length}`);
    console.log("Secrets scrubbed: credentials are omitted; secret references are retained by key.");
  } finally { agents.close(); await boot.shutdown(); }
}
