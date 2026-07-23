import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleOrgBundle, materializeOrgBundle, scrubOrgBundleSecrets, type OrgBundle } from "../agents/org-bundle.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const settings = { version: 2 as const, exportedAt: "2026-01-01T00:00:00.000Z", global: { daemonToken: "daemon-value", secretsAccessPolicy: { mode: "allow" }, secretsSyncPassphraseConfigured: true, customProviders: [{ apiKey: "provider-value" }], remoteAccess: { providers: { cloudflare: { tunnelToken: "tunnel-value" } }, tokenStrategy: { persistent: { token: "persistent-value" } } } }, project: { githubAuthToken: "github-value", secretsEnv: { values: { TOKEN: "env-value" } }, mcpServers: [{ secretRef: "kept-key" }] } };
function stores(root: string) {
  const createdAgents: Array<{ id: string; name: string }> = [];
  const routines: any[] = [];
  return {
    projectRoot: root,
    agentStore: { listAgents: vi.fn(async () => [{ id: "source-agent", name: "Source", role: "engineer", metadata: {}, instructionsText: "token=inline-value" }]), createAgent: vi.fn(async (input) => { const agent = { id: `destination-${createdAgents.length}`, ...input }; createdAgents.push(agent); return agent; }), updateAgent: vi.fn() },
    routineStore: { listRoutines: vi.fn(async () => routines), createRoutine: vi.fn(async (input) => { routines.push({ id: "routine", ...input }); return routines.at(-1); }) },
    automationStore: { listSchedules: vi.fn(async () => []), createSchedule: vi.fn() },
    settingsStore: { getGlobalSettingsStore: () => ({ getSettings: async () => settings.global }), getSettingsByScope: async () => ({ project: settings.project }), listWorkflowSettingValuesForProject: async () => ({}), getWorkflowSettingsProjectId: () => "project", updateWorkflowSettingValues: vi.fn(), updateGlobalSettings: vi.fn(), updateSettings: vi.fn() },
    createdAgents, routines,
  };
}
describe("org bundles", () => {
  it("preserves raw custom SKILL.md content while scrubbing every secret-bearing setting", async () => {
    const root = await mkdtemp(join(tmpdir(), "org-bundle-")); roots.push(root);
    await mkdir(join(root, ".agents/skills/custom"), { recursive: true });
    const skill = "---\nname: custom\ncustomFrontmatter: survives\n---\n# Actual body\n";
    await writeFile(join(root, ".agents/skills/custom/SKILL.md"), skill);
    const fixture = stores(root);
    const bundle = await assembleOrgBundle(fixture as any);
    expect(bundle.skills[0]).toEqual({ sourceRelativePath: ".agents/skills/custom/SKILL.md", rawSkillMd: skill });
    expect(JSON.stringify(bundle)).not.toContain("daemon-value");
    expect(JSON.stringify(bundle)).not.toContain("provider-value");
    expect(JSON.stringify(bundle)).not.toContain("tunnel-value");
    expect(bundle.settings.global).toMatchObject({ secretsAccessPolicy: { mode: "allow" }, secretsSyncPassphraseConfigured: true });
    expect(JSON.stringify(bundle)).toContain("kept-key");
  });
  it("remaps routine agents and has a no-write dry run", async () => {
    const root = await mkdtemp(join(tmpdir(), "org-bundle-")); roots.push(root);
    const fixture = stores(root);
    fixture.agentStore.listAgents.mockResolvedValue([]);
    const bundle: OrgBundle = { version: 1, assembledAt: new Date().toISOString(), agents: [{ key: "source", manifest: { name: "Source", role: "engineer", schema: "agentcompanies/v1" } }], skills: [{ sourceRelativePath: "skills/custom/SKILL.md", rawSkillMd: "# real" }], routines: [{ agentKey: "source", routine: { id: "old", agentId: "old", name: "Routine", trigger: { type: "manual" }, catchUpPolicy: "run_one", executionPolicy: "queue", enabled: true, runCount: 0, runHistory: [], createdAt: "", updatedAt: "" } }], automations: [], settings: { version: 2, exportedAt: new Date().toISOString(), project: {} } };
    const dry = await materializeOrgBundle(fixture as any, bundle, { dryRun: true });
    expect(dry.agentIdMap.source).toBe("planned:source");
    expect(fixture.createdAgents).toHaveLength(0);
    const result = await materializeOrgBundle(fixture as any, bundle);
    expect(fixture.routines[0].agentId).toBe(result.agentIdMap.source);
    expect(await readFile(join(root, "skills/custom/SKILL.md"), "utf8")).toBe("# real");
  });
  it("preserves an existing skill by default and creates a suffixed directory on request", async () => {
    const root = await mkdtemp(join(tmpdir(), "org-bundle-")); roots.push(root);
    const fixture = stores(root);
    fixture.agentStore.listAgents.mockResolvedValue([]);
    await mkdir(join(root, "skills/custom"), { recursive: true });
    await writeFile(join(root, "skills/custom/SKILL.md"), "# existing");
    const bundle = { version: 1, assembledAt: "", agents: [], skills: [{ sourceRelativePath: "skills/custom/SKILL.md", rawSkillMd: "# imported" }], routines: [], automations: [], settings: { version: 2, exportedAt: "", project: {} } } as OrgBundle;

    const skipped = await materializeOrgBundle(fixture as any, bundle);
    expect(skipped.skipped.skills).toEqual(["skills/custom/SKILL.md"]);
    expect(await readFile(join(root, "skills/custom/SKILL.md"), "utf8")).toBe("# existing");

    const suffixed = await materializeOrgBundle(fixture as any, bundle, { collisionMode: "suffix" });
    expect(suffixed.created.skills).toEqual(["skills/custom-2/SKILL.md"]);
    expect(await readFile(join(root, "skills/custom-2/SKILL.md"), "utf8")).toBe("# imported");
  });
  it("keeps secret references but removes secret values", () => {
    const bundle = { version: 1, assembledAt: "", agents: [], skills: [], routines: [], automations: [], settings: { version: 2, exportedAt: "", global: { daemonToken: "no", mcp: { secretRef: "name" } } } } as OrgBundle;
    expect(scrubOrgBundleSecrets(bundle).settings.global).toEqual({ mcp: { secretRef: "name" } });
  });
});
