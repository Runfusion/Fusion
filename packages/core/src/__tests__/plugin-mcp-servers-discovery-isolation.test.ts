import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginLoader } from "../plugin-loader.js";
import { createProjectScopedPluginMcpProvider } from "../plugin-mcp-servers.js";
import type { PluginInstallation } from "../plugin-types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function createProject(options: { plugins?: Array<{ id: string; dependencies?: string[]; broken?: boolean }>; root?: string } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "fusion-mcp-isolation-"));
  if (!options.root) roots.push(root);
  const definitions = options.plugins ?? [{ id: "fixture" }];
  const installations: PluginInstallation[] = await Promise.all(definitions.map(async ({ id, dependencies = [], broken }) => {
    const path = join(root, `${id}.mjs`);
    await writeFile(path, broken ? "export default { broken: true };" : `export default {
      manifest: { id: "${id}", name: "${id}", version: "1.0.0", description: "fixture", dependencies: ${JSON.stringify(dependencies)} },
      state: "installed", hooks: {},
      mcpServers: [{ name: "${id}-mcp", transport: "stdio", command: "${id}" }]
    };`);
    return { id, name: id, version: "1.0.0", description: "fixture", path, enabled: true, state: "installed", settings: {}, dependencies, createdAt: "", updatedAt: id };
  }));
  const pluginStore = {
    init: vi.fn(async () => undefined),
    getPlugin: vi.fn(async (id: string) => {
      const plugin = installations.find((candidate) => candidate.id === id);
      if (!plugin) throw new Error(`missing ${id}`);
      return { ...plugin };
    }),
    listPlugins: vi.fn(async () => installations.map((plugin) => ({ ...plugin }))),
    updatePluginState: vi.fn(async () => undefined),
  };
  const taskStore = { getRootDir: () => root, getPluginStore: () => pluginStore, preflightPluginSchema: vi.fn(() => null), runPluginSchemaInits: vi.fn(async () => undefined), recordPluginActivation: vi.fn() };
  return { root, pluginStore, taskStore };
}

function discoveryProvider(host: Awaited<ReturnType<typeof createProject>>) {
  return createProjectScopedPluginMcpProvider({
    hostRootDir: host.root,
    hostLoader: new PluginLoader({ pluginStore: host.pluginStore as any, taskStore: host.taskStore as any }),
    createScopedLoader: (scoped) => new PluginLoader({ pluginStore: scoped.getPluginStore() as any, taskStore: scoped as any, lifecycleScope: "isolated", persistRuntimeState: false }),
  });
}

function lifecycleKeysFor(root: string): string[] {
  return [...((PluginLoader as any).processPluginLifecycles as Map<string, unknown>).keys()].filter((key) => key.startsWith(`${root}\0`));
}

describe("project-scoped plugin MCP discovery isolation", () => {
  it("preserves an already-loaded cross-root owner, registry, and runtime state", async () => {
    const target = await createProject();
    const owner = new PluginLoader({ pluginStore: target.pluginStore as any, taskStore: target.taskStore as any });
    await owner.loadAllPlugins();
    const registryBefore = lifecycleKeysFor(target.root);
    target.pluginStore.updatePluginState.mockClear();

    const entries = await discoveryProvider(await createProject()).get(target.taskStore);

    expect(entries.map((entry) => entry.server.name)).toEqual(["fixture-mcp"]);
    expect(owner.isPluginLoaded("fixture")).toBe(true);
    expect(owner.getPluginMcpServers()).toHaveLength(1);
    expect(lifecycleKeysFor(target.root)).toEqual(registryBefore);
    expect(target.pluginStore.updatePluginState).not.toHaveBeenCalled();
    await owner.stopAllPlugins();
  });

  it("discovers an unloaded project privately without creating shared lifecycle state", async () => {
    const target = await createProject();
    target.pluginStore.updatePluginState.mockClear();
    const entries = await discoveryProvider(await createProject()).get(target.taskStore);
    expect(entries.map((entry) => entry.pluginId)).toEqual(["fixture"]);
    expect(lifecycleKeysFor(target.root)).toEqual([]);
    expect(target.pluginStore.updatePluginState).not.toHaveBeenCalled();
  });

  it("returns no entries and constructs no loader for a project with zero enabled plugins", async () => {
    const target = await createProject({ plugins: [] });
    const host = await createProject();
    const createScopedLoader = vi.fn();
    const provider = createProjectScopedPluginMcpProvider({ hostRootDir: host.root, hostLoader: new PluginLoader({ pluginStore: host.pluginStore as any, taskStore: host.taskStore as any }), createScopedLoader });
    await expect(provider.get(target.taskStore)).resolves.toEqual([]);
    expect(createScopedLoader).not.toHaveBeenCalled();
    expect(target.pluginStore.updatePluginState).not.toHaveBeenCalled();
  });

  it("returns multiple enabled contributions in dependency load order without persistence", async () => {
    const target = await createProject({ plugins: [{ id: "dependent", dependencies: ["base"] }, { id: "base" }] });
    target.pluginStore.updatePluginState.mockClear();
    const entries = await discoveryProvider(await createProject()).get(target.taskStore);
    expect(entries.map((entry) => entry.pluginId)).toEqual(["base", "dependent"]);
    expect(target.pluginStore.updatePluginState).not.toHaveBeenCalled();
    expect(lifecycleKeysFor(target.root)).toEqual([]);
  });

  it("tears down a failed discovery privately without shared registry or state changes", async () => {
    const target = await createProject({ plugins: [{ id: "broken", broken: true }] });
    target.pluginStore.updatePluginState.mockClear();
    await expect(discoveryProvider(await createProject()).get(target.taskStore)).resolves.toEqual([]);
    expect(lifecycleKeysFor(target.root)).toEqual([]);
    expect(target.pluginStore.updatePluginState).not.toHaveBeenCalled();
  });

  it("keeps same-root lookup on the host loader without constructing discovery loader", async () => {
    const host = await createProject();
    const hostLoader = new PluginLoader({ pluginStore: host.pluginStore as any, taskStore: host.taskStore as any });
    await hostLoader.loadAllPlugins();
    const createScopedLoader = vi.fn();
    const provider = createProjectScopedPluginMcpProvider({ hostRootDir: host.root, hostLoader, createScopedLoader });
    await expect(provider.get(host.taskStore)).resolves.toHaveLength(1);
    expect(createScopedLoader).not.toHaveBeenCalled();
    await hostLoader.stopAllPlugins();
  });
});
