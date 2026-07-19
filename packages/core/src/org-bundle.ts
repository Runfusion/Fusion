/** Portable, secret-safe organization bundles. */
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { AgentStore } from "./agent-store.js";
import type { AgentManifest } from "./agent-companies-types.js";
import { agentToCompaniesManifest, slugify } from "./agent-companies-exporter.js";
import { prepareAgentCompaniesImport } from "./agent-companies-parser.js";
import type { AutomationStore } from "./automation-store.js";
import type { ScheduledTask, ScheduledTaskCreateInput } from "./automation.js";
import { redactSecrets } from "./redact-secrets.js";
import type { RoutineStore } from "./routine-store.js";
import type { Routine, RoutineCreateInput } from "./routine.js";
import { exportSettings, importSettings, validateImportData, type SettingsExportData } from "./settings-export.js";
import type { TaskStore } from "./store.js";

export const ORG_BUNDLE_VERSION = 1 as const;

/** A raw skill file, deliberately not a lossy SkillManifest. */
export interface OrgBundleSkill {
  sourceRelativePath: string;
  rawSkillMd: string;
}
export interface OrgBundleAgent { key: string; manifest: AgentManifest; }
export interface OrgBundleRoutine { routine: Routine; agentKey: string; }
export interface OrgBundle {
  version: typeof ORG_BUNDLE_VERSION;
  assembledAt: string;
  source?: string;
  agents: OrgBundleAgent[];
  skills: OrgBundleSkill[];
  routines: OrgBundleRoutine[];
  automations: ScheduledTask[];
  settings: SettingsExportData;
}
export interface OrgBundleStores {
  projectRoot: string;
  agentStore: AgentStore;
  routineStore: RoutineStore;
  automationStore: AutomationStore;
  settingsStore: TaskStore;
}

/*
FNXC:OrgPortability 2026-07-16-00:00:
Whole-org portability is one selected project's agents, real skills, routines and automations plus global/project/workflow settings. SkillManifest is intentionally not used for skill files because its fixed frontmatter drops custom keys; raw SKILL.md bytes and source paths are the portable artifact.
*/
const SKILL_ROOTS = ["skills", ".fusion/skills", ".agents/skills"];
const SECRET_KEY = /(?:api[_-]?key|token|password|credential|auth|secret)(?!ref$)/i;
const SAFE_SECRET_CONFIG = new Set(["secretRef", "secretsAccessPolicy", "secretsSyncPassphraseConfigured"]);

async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "SKILL.md") out.push(path);
    }
  }
  await visit(root); return out;
}
async function readSkills(projectRoot: string): Promise<OrgBundleSkill[]> {
  const root = resolve(projectRoot);
  const paths = (await Promise.all(SKILL_ROOTS.map((skillRoot) => filesUnder(join(root, skillRoot))))).flat();
  return Promise.all(paths.sort().map(async (path) => ({
    sourceRelativePath: relative(root, path).split(sep).join("/"), rawSkillMd: await readFile(path, "utf8"),
  })));
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function scrubValue(value: unknown, key?: string): unknown {
  if (SAFE_SECRET_CONFIG.has(key ?? "")) return value;
  if (key && (key === "secretsEnv" || SECRET_KEY.test(key))) return undefined;
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .flatMap(([entryKey, entryValue]) => {
      const scrubbed = scrubValue(entryValue, entryKey);
      return scrubbed === undefined ? [] : [[entryKey, scrubbed]];
    }));
}
/** Removes secret values while retaining reference-only configuration such as MCP secretRef. */
export function scrubOrgBundleSecrets(bundle: OrgBundle): OrgBundle {
  const copy = clone(bundle);
  copy.agents = copy.agents.map((agent) => ({ ...agent, manifest: scrubValue(agent.manifest) as AgentManifest }));
  copy.skills = copy.skills.map((skill) => ({ ...skill, rawSkillMd: redactSecrets(skill.rawSkillMd) }));
  copy.routines = copy.routines.map(({ routine, agentKey }) => ({ routine: scrubValue(routine) as Routine, agentKey }));
  copy.automations = copy.automations.map((automation) => scrubValue(automation) as ScheduledTask);
  copy.settings = scrubValue(copy.settings) as SettingsExportData;
  return copy;
}

export async function assembleOrgBundle(stores: OrgBundleStores): Promise<OrgBundle> {
  const agents = await stores.agentStore.listAgents();
  const used = new Set<string>();
  const keys = new Map<string, string>();
  for (const agent of agents) { let key = slugify(agent.name, "agent"); let n = 2; while (used.has(key)) key = `${slugify(agent.name, "agent")}-${n++}`; used.add(key); keys.set(agent.id, key); }
  const routines = await stores.routineStore.listRoutines();
  const bundle: OrgBundle = {
    version: ORG_BUNDLE_VERSION, assembledAt: new Date().toISOString(), source: resolve(stores.projectRoot),
    agents: agents.map((agent) => ({ key: keys.get(agent.id)!, manifest: agentToCompaniesManifest(agent, { reportsTo: agent.reportsTo ? keys.get(agent.reportsTo) ?? null : null }) })),
    skills: await readSkills(stores.projectRoot),
    routines: routines.flatMap((routine) => { const agentKey = keys.get(routine.agentId); return agentKey ? [{ routine, agentKey }] : []; }),
    automations: await stores.automationStore.listSchedules(), settings: await exportSettings(stores.settingsStore, { scope: "both", source: resolve(stores.projectRoot) }),
  };
  return scrubOrgBundleSecrets(bundle);
}

export interface OrgBundleMaterializeOptions { dryRun?: boolean; collisionMode?: "skip" | "suffix"; }
export interface OrgBundleMaterializeResult {
  created: { agents: string[]; skills: string[]; routines: string[]; automations: string[]; settings: boolean };
  skipped: { agents: string[]; skills: string[]; routines: string[]; automations: string[] };
  errors: Array<{ section: string; name: string; error: string }>;
  agentIdMap: Record<string, string>;
}
function validateBundle(bundle: OrgBundle): void {
  if (bundle?.version !== ORG_BUNDLE_VERSION) throw new Error(`Unsupported org bundle version: ${bundle?.version}`);
  if (!Array.isArray(bundle.agents) || !Array.isArray(bundle.skills) || !Array.isArray(bundle.routines) || !Array.isArray(bundle.automations)) throw new Error("Invalid org bundle shape");
  const errors = validateImportData(bundle.settings); if (errors.length) throw new Error(`Invalid bundle settings: ${errors.join("; ")}`);
}
function uniqueName(name: string, existing: Set<string>): string { let result = name, index = 2; while (existing.has(result.toLowerCase())) result = `${name} (${index++})`; return result; }
/** Materialize an org bundle without ever restoring a secret value. */
export async function materializeOrgBundle(stores: OrgBundleStores, input: OrgBundle, options: OrgBundleMaterializeOptions = {}): Promise<OrgBundleMaterializeResult> {
  const bundle = scrubOrgBundleSecrets(input); validateBundle(bundle);
  const result: OrgBundleMaterializeResult = { created: { agents: [], skills: [], routines: [], automations: [], settings: false }, skipped: { agents: [], skills: [], routines: [], automations: [] }, errors: [], agentIdMap: {} };
  const existingAgents = await stores.agentStore.listAgents(); const existingNames = new Set(existingAgents.map((agent) => agent.name.toLowerCase()));
  // Reuse the shared parser for manifest validation/normalization before creation.
  const prepared = prepareAgentCompaniesImport({ agents: bundle.agents.map((agent) => agent.manifest), teams: [], projects: [], tasks: [], skills: [] }, { existingAgents });
  const preparedByName = new Map(prepared.items.map((item) => [item.input.name, item]));
  for (const item of bundle.agents) {
    const existing = existingAgents.find((agent) => agent.name.toLowerCase() === item.manifest.name.toLowerCase());
    if (existing && options.collisionMode !== "suffix") { result.skipped.agents.push(item.key); result.agentIdMap[item.key] = existing.id; continue; }
    const parsed = preparedByName.get(item.manifest.name); if (!parsed) { result.errors.push({ section: "agents", name: item.key, error: "Invalid agent manifest" }); continue; }
    const name = existing ? uniqueName(parsed.input.name, existingNames) : parsed.input.name;
    if (options.dryRun) { result.created.agents.push(name); result.agentIdMap[item.key] = `planned:${item.key}`; existingNames.add(name.toLowerCase()); continue; }
    try { const created = await stores.agentStore.createAgent({ ...parsed.input, name }); result.created.agents.push(created.id); result.agentIdMap[item.key] = created.id; existingNames.add(name.toLowerCase()); }
    catch (error) { result.errors.push({ section: "agents", name, error: error instanceof Error ? error.message : String(error) }); }
  }
  // Assign manager links after all destination IDs exist.
  if (!options.dryRun) for (const item of bundle.agents) { const destination = result.agentIdMap[item.key], manager = item.manifest.reportsTo; if (destination && manager && result.agentIdMap[manager] && !destination.startsWith("planned:")) await stores.agentStore.updateAgent(destination, { reportsTo: result.agentIdMap[manager] }).catch((error) => result.errors.push({ section: "agents", name: item.key, error: String(error) })); }
  for (const skill of bundle.skills) {
    const projectRoot = resolve(stores.projectRoot);
    let target = resolve(projectRoot, skill.sourceRelativePath);
    if (!target.startsWith(projectRoot + sep)) { result.errors.push({ section: "skills", name: skill.sourceRelativePath, error: "Skill path escapes project root" }); continue; }
    const targetExists = await access(target).then(() => true).catch(() => false);
    if (targetExists && options.collisionMode !== "suffix") { result.skipped.skills.push(skill.sourceRelativePath); continue; }
    if (targetExists) {
      const skillDirectory = dirname(target);
      let index = 2;
      do { target = `${skillDirectory}-${index++}${sep}SKILL.md`; } while (await access(target).then(() => true).catch(() => false));
    }
    const destinationPath = relative(projectRoot, target).split(sep).join("/");
    /*
    FNXC:OrgPortability 2026-07-18-11:44:
    Imported SKILL.md files must honor the same collision policy as persisted entities. Default imports preserve an existing destination; suffix mode creates a sibling skill directory rather than overwriting its raw content.
    */
    result.created.skills.push(destinationPath); if (!options.dryRun) { await mkdir(dirname(target), { recursive: true }); await writeFile(target, skill.rawSkillMd, "utf8"); }
  }
  const routineNames = new Set((await stores.routineStore.listRoutines()).map((routine) => routine.name.toLowerCase()));
  for (const entry of bundle.routines) {
    const agentId = result.agentIdMap[entry.agentKey]; if (!agentId) { result.skipped.routines.push(entry.routine.name); continue; }
    if (routineNames.has(entry.routine.name.toLowerCase()) && options.collisionMode !== "suffix") { result.skipped.routines.push(entry.routine.name); continue; }
    const name = routineNames.has(entry.routine.name.toLowerCase()) ? uniqueName(entry.routine.name, routineNames) : entry.routine.name;
    result.created.routines.push(name); routineNames.add(name.toLowerCase()); if (!options.dryRun) await stores.routineStore.createRoutine({ ...entry.routine, id: undefined, name, agentId, lastRunAt: undefined, lastRunResult: undefined, nextRunAt: undefined, runCount: undefined, runHistory: undefined, createdAt: undefined, updatedAt: undefined } as unknown as RoutineCreateInput);
  }
  const automationNames = new Set((await stores.automationStore.listSchedules()).map((schedule) => schedule.name.toLowerCase()));
  for (const schedule of bundle.automations) {
    if (automationNames.has(schedule.name.toLowerCase()) && options.collisionMode !== "suffix") { result.skipped.automations.push(schedule.name); continue; }
    const name = automationNames.has(schedule.name.toLowerCase()) ? uniqueName(schedule.name, automationNames) : schedule.name;
    result.created.automations.push(name); automationNames.add(name.toLowerCase()); if (!options.dryRun) await stores.automationStore.createSchedule({ ...schedule, id: undefined, name, lastRunAt: undefined, lastRunResult: undefined, nextRunAt: undefined, runCount: undefined, runHistory: undefined, createdAt: undefined, updatedAt: undefined } as unknown as ScheduledTaskCreateInput);
  }
  if (!options.dryRun) { const imported = await importSettings(stores.settingsStore, bundle.settings, { scope: "both", merge: true }); if (!imported.success) result.errors.push({ section: "settings", name: "settings", error: imported.error ?? "Import failed" }); else result.created.settings = true; }
  return result;
}
