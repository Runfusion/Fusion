import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginLoader } from "../plugin-loader.js";
import { PluginStore } from "../plugin-store.js";
import type { FusionPlugin, PluginManifest } from "../plugin-types.js";

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return { id: "test-plugin", name: "Test Plugin", version: "1.0.0", ...overrides };
}

function makePlugin(manifest: PluginManifest): FusionPlugin {
  return { manifest, state: "installed", hooks: {}, tools: [], routes: [] };
}

async function writePluginModule(dir: string, filename: string, plugin: FusionPlugin): Promise<string> {
  const filepath = join(dir, filename);
  await mkdir(dir, { recursive: true });
  await writeFile(
    filepath,
    `const plugin = ${JSON.stringify(plugin, null, 2)}; export default plugin; export { plugin };`,
  );
  return filepath;
}

const hasContributionApis =
  "getPluginSkills" in PluginLoader.prototype &&
  "getPluginWorkflowSteps" in PluginLoader.prototype &&
  "getPluginPromptContributions" in PluginLoader.prototype &&
  "getPluginSetupInfo" in PluginLoader.prototype;

describe.skipIf(!hasContributionApis)("PluginLoader contribution loading", () => {
  let rootDir: string;
  let pluginStore: PluginStore;
  let loader: PluginLoader;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "kb-plugin-loader-contrib-"));
    pluginStore = new PluginStore(rootDir, { inMemoryDb: true, centralGlobalDir: rootDir });
    loader = new PluginLoader({ pluginStore, taskStore: { logActivity: vi.fn() } as any });
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(rootDir, { recursive: true, force: true });
  });

  it("aggregates skills/workflow/prompts with plugin ownership", async () => {
    await pluginStore.init();
    const pluginDir = join(rootDir, "plugins");

    const alpha = makePlugin(
      makeManifest({ id: "plugin-alpha", skills: [{ skillId: "alpha", name: "Alpha" }], workflowSteps: [{ stepId: "wf-alpha", name: "WF Alpha", mode: "prompt" }], promptSurfaces: ["triage"] }),
    );
    alpha.skills = [{ skillId: "alpha", name: "Alpha", description: "alpha", enabled: false } as any];
    alpha.workflowSteps = [{ stepId: "wf-alpha", name: "WF Alpha", description: "wf", mode: "prompt", prompt: "Run", enabled: false } as any];
    alpha.promptContributions = { enabledByDefault: false, contributions: [{ surface: "triage", content: "Alpha triage" }] };

    const beta = makePlugin(makeManifest({ id: "plugin-beta" }));
    beta.skills = [{ skillId: "beta", name: "Beta", description: "beta", enabled: true } as any];
    beta.workflowSteps = [{ stepId: "wf-beta", name: "WF Beta", description: "wf", mode: "script", scriptName: "test" } as any];
    beta.promptContributions = { enabledByDefault: true, contributions: [{ surface: "reviewer", content: "Beta reviewer" }] };

    const alphaPath = await writePluginModule(pluginDir, "alpha.mjs", alpha);
    const betaPath = await writePluginModule(pluginDir, "beta.mjs", beta);

    await pluginStore.registerPlugin({ manifest: alpha.manifest, path: alphaPath });
    await pluginStore.registerPlugin({ manifest: beta.manifest, path: betaPath });
    await loader.loadAllPlugins();

    const skills = loader.getPluginSkills();
    const steps = loader.getPluginWorkflowSteps();
    const prompts = loader.getPluginPromptContributions();

    expect(skills.map((s) => s.pluginId).sort()).toEqual(["plugin-alpha", "plugin-beta"]);
    expect(steps.map((s) => s.pluginId).sort()).toEqual(["plugin-alpha", "plugin-beta"]);
    expect(prompts.map((p) => p.pluginId).sort()).toEqual(["plugin-alpha", "plugin-beta"]);
    expect(skills.some((s) => s.skill.enabled === false)).toBe(true);
    expect(steps.some((s) => s.step.enabled === false)).toBe(true);
  });

  it("removes contributions when stopping and refreshes when loaded again", async () => {
    await pluginStore.init();
    const pluginDir = join(rootDir, "plugins");
    const manifest = makeManifest({ id: "plugin-reload" });
    const plugin = makePlugin(manifest);
    plugin.skills = [{ skillId: "before", name: "Before", description: "before" } as any];

    const path = await writePluginModule(pluginDir, "reload.mjs", plugin);
    await pluginStore.registerPlugin({ manifest, path });
    await loader.loadAllPlugins();

    expect(loader.getPluginSkills().some((s) => s.skill.skillId === "before")).toBe(true);

    await loader.stopPlugin("plugin-reload");
    expect(loader.getPluginSkills().some((s) => s.pluginId === "plugin-reload")).toBe(false);

    const updated = makePlugin(manifest);
    updated.skills = [{ skillId: "after", name: "After", description: "after" } as any];
    await writePluginModule(pluginDir, "reload.mjs", updated);

    await loader.loadPlugin("plugin-reload");
    expect(loader.getPluginSkills().some((s) => s.skill.skillId === "after")).toBe(true);
  });

  it("provides setup info and delegates check/install hooks", async () => {
    await pluginStore.init();
    const pluginDir = join(rootDir, "plugins");
    const modulePath = join(pluginDir, "setup.mjs");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      modulePath,
      `
const plugin = {
  manifest: { id: "plugin-setup", name: "Plugin Setup", version: "1.0.0" },
  state: "installed",
  hooks: {},
  setup: {
    manifest: { binaryName: "agent-browser", description: "browser", defaultTimeoutMs: 5000 },
    hooks: {
      checkSetup: async () => ({ status: "installed", version: "1.0.0", binaryPath: "/tmp/agent-browser" }),
      install: async () => ({ ok: true }),
    },
  },
};
export default plugin;
`,
    );

    await pluginStore.registerPlugin({ manifest: { id: "plugin-setup", name: "Plugin Setup", version: "1.0.0" }, path: modulePath });
    await loader.loadAllPlugins();

    const setupInfo = loader.getPluginSetupInfo();
    const check = await loader.checkPluginSetup("plugin-setup");
    await expect(loader.installPluginSetup("plugin-setup")).resolves.toBeUndefined();

    expect(setupInfo).toHaveLength(1);
    expect(check.status).toBe("installed");
  });
});
