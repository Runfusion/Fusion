/*
 * This test drives the exported factory seam used by InProcessRuntime.start(),
 * rather than recreating its provider options. A full runtime is unnecessary:
 * a real owner loader and PluginRunner expose the cache/skill symptom directly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginLoader, createProjectScopedPluginMcpProvider, type PluginInstallation } from "@fusion/core";
import { PluginRunner } from "../plugin-runner.js";
import { collectPluginSkillNames } from "../session-skill-context.js";
import { createDiscoveryPluginLoaderOptions, createRuntimePluginMcpProviderOptions } from "../runtimes/in-process-runtime.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function project(root?: string) {
  const projectRoot = root ?? await mkdtemp(join(tmpdir(), "fusion-engine-mcp-isolation-"));
  if (!root) roots.push(projectRoot);
  const path = join(projectRoot, "plugin.mjs");
  await writeFile(path, `export default {
    manifest: { id: "engine-fixture", name: "Engine fixture", version: "1.0.0", description: "fixture" }, state: "installed", hooks: {},
    skills: [{ skillId: "fixture-skill", name: "fixture-skill", description: "fixture", skillFiles: [], enabled: true }],
    mcpServers: [{ name: "fixture-mcp", transport: "stdio", command: "fixture" }]
  };`);
  const installation: PluginInstallation = { id: "engine-fixture", name: "Engine fixture", version: "1.0.0", description: "fixture", path, enabled: true, state: "installed", settings: {}, dependencies: [], createdAt: "", updatedAt: "1" };
  const pluginStore = { init: vi.fn(async () => undefined), getPlugin: vi.fn(async () => ({ ...installation })), listPlugins: vi.fn(async () => [{ ...installation }]), updatePluginState: vi.fn(async () => undefined) };
  const taskStore = { getRootDir: () => projectRoot, getPluginStore: () => pluginStore, preflightPluginSchema: vi.fn(() => null), runPluginSchemaInits: vi.fn(async () => undefined), recordPluginActivation: vi.fn() };
  return { root: projectRoot, pluginStore, taskStore };
}

describe("InProcessRuntime plugin MCP discovery factory", () => {
  it("keeps PluginRunner caches and session skills stable across production-seam cross-root discovery", async () => {
    const target = await project();
    const owner = new PluginLoader({ pluginStore: target.pluginStore as any, taskStore: target.taskStore as any });
    await owner.loadAllPlugins();
    const runner = new PluginRunner({ pluginLoader: owner, pluginStore: target.pluginStore as any, taskStore: target.taskStore as any, rootDir: target.root });
    expect(runner.getPluginSkills()).toHaveLength(1);
    expect(runner.getPluginMcpServers()).toHaveLength(1);
    const skillNamesBefore = collectPluginSkillNames(runner, target.root).names;
    const versionsBefore = { skills: (runner as any).skillsCacheVersion, mcp: (runner as any).mcpServersCacheVersion };
    target.pluginStore.updatePluginState.mockClear();

    const host = await project();
    const options = createRuntimePluginMcpProviderOptions({ hostRootDir: host.root, hostLoader: new PluginLoader({ pluginStore: host.pluginStore as any, taskStore: host.taskStore as any }), PluginLoaderClass: PluginLoader });
    const entries = await createProjectScopedPluginMcpProvider(options).get(target.taskStore);

    expect(entries.map((entry) => entry.server.name)).toEqual(["fixture-mcp"]);
    expect(owner.isPluginLoaded("engine-fixture")).toBe(true);
    expect(runner.getPluginSkills()).toHaveLength(1);
    expect(runner.getPluginMcpServers()).toHaveLength(1);
    expect(collectPluginSkillNames(runner, target.root).names).toEqual(skillNamesBefore);
    expect((runner as any).skillsCacheVersion).toBe(versionsBefore.skills);
    expect((runner as any).mcpServersCacheVersion).toBe(versionsBefore.mcp);
    expect(target.pluginStore.updatePluginState).not.toHaveBeenCalled();
    expect([...((PluginLoader as any).processPluginLifecycles as Map<string, unknown>).keys()].some((key) => key.startsWith(`${target.root}\0`))).toBe(true);
    await owner.stopAllPlugins();
  });

  it("constructs isolated non-persisting loaders through the runtime seam", () => {
    const scopedStore = { getPluginStore: () => ({}) };
    expect(createDiscoveryPluginLoaderOptions(scopedStore)).toMatchObject({ lifecycleScope: "isolated", persistRuntimeState: false });
    let captured: unknown;
    class Loader { constructor(options: unknown) { captured = options; } getPluginMcpServers() { return []; } }
    createRuntimePluginMcpProviderOptions({ hostRootDir: "/host", hostLoader: new Loader() as any, PluginLoaderClass: Loader as any }).createScopedLoader(scopedStore);
    expect(captured).toMatchObject({ lifecycleScope: "isolated", persistRuntimeState: false });
  });
});
