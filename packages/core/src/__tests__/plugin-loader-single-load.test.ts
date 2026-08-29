import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginLoader } from "../plugins/plugin-loader.js";
import type { PluginInstallation } from "../plugins/plugin-types.js";

async function createFixture(onLoadSource: string, onUnloadSource?: string) {
  const root = await mkdtemp(join(tmpdir(), "fusion-plugin-single-load-"));
  const entry = join(root, "plugin.mjs");
  await writeFile(entry, `
export default {
  manifest: { id: "single-load", name: "Single load", version: "1.0.0", description: "fixture" },
  state: "installed",
  hooks: { onLoad: ${onLoadSource}${onUnloadSource ? `, onUnload: ${onUnloadSource}` : ""} },
};
`);
  return { root, entry };
}

function createStore(root: string, entry: string) {
  const installation: PluginInstallation = {
    id: "single-load", name: "Single load", version: "1.0.0", description: "fixture",
    path: entry, enabled: true, state: "installed", settings: {}, dependencies: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const events = new EventEmitter();
  const pluginStore = {
    getPlugin: vi.fn(async () => ({ ...installation })),
    listPlugins: vi.fn(async () => [{ ...installation }]),
    updatePluginState: vi.fn(async (_id: string, state: PluginInstallation["state"]) => ({ ...installation, state })),
    on: events.on.bind(events), off: events.off.bind(events),
  };
  const taskStore = {
    getRootDir: () => root,
    preflightPluginSchema: vi.fn(() => null),
    runPluginSchemaInits: vi.fn(async () => undefined),
  };
  return { pluginStore, taskStore };
}

describe("PluginLoader process single-load lifecycle", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    delete (globalThis as Record<string, unknown>).__fusionPluginOnLoadCount;
    delete (globalThis as Record<string, unknown>).__fusionPluginFailOnce;
    delete (globalThis as Record<string, unknown>).__fusionPluginOnUnloadCount;
  });

  it("skips malformed MCP contribution containers without blocking healthy plugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-plugin-mcp-container-"));
    roots.push(root);
    const malformedEntry = join(root, "malformed.mjs");
    const healthyEntry = join(root, "healthy.mjs");
    await writeFile(malformedEntry, `export default { manifest: { id: "malformed", name: "Malformed", version: "1.0.0", description: "fixture" }, state: "installed", hooks: {}, mcpServers: {} };`);
    await writeFile(healthyEntry, `export default { manifest: { id: "healthy", name: "Healthy", version: "1.0.0", description: "fixture" }, state: "installed", hooks: {}, mcpServers: [{ name: "navigator", transport: "stdio", command: "navigator" }] };`);
    const malformed = createStore(root, malformedEntry);
    const installations = new Map([
      ["malformed", { ...(await malformed.pluginStore.getPlugin("single-load")), id: "malformed", name: "Malformed", path: malformedEntry }],
      ["healthy", { ...(await malformed.pluginStore.getPlugin("single-load")), id: "healthy", name: "Healthy", path: healthyEntry }],
    ]);
    malformed.pluginStore.getPlugin = vi.fn(async (id: string) => installations.get(id)!);
    malformed.pluginStore.listPlugins = vi.fn(async () => [...installations.values()]);
    const loader = new PluginLoader({ pluginStore: malformed.pluginStore as any, taskStore: malformed.taskStore as any });

    await loader.loadAllPlugins();

    expect(loader.getPluginMcpServers()).toEqual([
      { pluginId: "healthy", server: { name: "navigator", transport: "stdio", command: "navigator" } },
    ]);
  });

  it("coalesces concurrent host and engine-style loaders for one project", async () => {
    const fixture = await createFixture("async () => { globalThis.__fusionPluginOnLoadCount = (globalThis.__fusionPluginOnLoadCount || 0) + 1; await new Promise(resolve => setTimeout(resolve, 20)); }");
    roots.push(fixture.root);
    const host = createStore(fixture.root, fixture.entry);
    const engine = createStore(fixture.root, fixture.entry);
    const hostLoader = new PluginLoader({ pluginStore: host.pluginStore as any, taskStore: host.taskStore as any });
    const engineLoader = new PluginLoader({ pluginStore: engine.pluginStore as any, taskStore: engine.taskStore as any });

    await Promise.all([hostLoader.loadAllPlugins(), engineLoader.loadAllPlugins()]);

    expect((globalThis as Record<string, unknown>).__fusionPluginOnLoadCount).toBe(1);
    expect(hostLoader.isPluginLoaded("single-load")).toBe(true);
    expect(engineLoader.isPluginLoaded("single-load")).toBe(true);
  });

  it("coalesces concurrent calls on the same loader", async () => {
    const fixture = await createFixture("async () => { globalThis.__fusionPluginOnLoadCount = (globalThis.__fusionPluginOnLoadCount || 0) + 1; await new Promise(resolve => setTimeout(resolve, 20)); }");
    roots.push(fixture.root);
    const store = createStore(fixture.root, fixture.entry);
    const loader = new PluginLoader({ pluginStore: store.pluginStore as any, taskStore: store.taskStore as any });

    await Promise.all([loader.loadPlugin("single-load"), loader.loadAllPlugins()]);

    expect((globalThis as Record<string, unknown>).__fusionPluginOnLoadCount).toBe(1);
  });

  it("coordinates cross-loader reload and stop after dual bootstrap", async () => {
    const fixture = await createFixture(
      "async () => { globalThis.__fusionPluginOnLoadCount = (globalThis.__fusionPluginOnLoadCount || 0) + 1; }",
      "async () => { globalThis.__fusionPluginOnUnloadCount = (globalThis.__fusionPluginOnUnloadCount || 0) + 1; }",
    );
    roots.push(fixture.root);
    const host = createStore(fixture.root, fixture.entry);
    const engine = createStore(fixture.root, fixture.entry);
    const hostLoader = new PluginLoader({ pluginStore: host.pluginStore as any, taskStore: host.taskStore as any });
    const engineLoader = new PluginLoader({ pluginStore: engine.pluginStore as any, taskStore: engine.taskStore as any });

    await Promise.all([hostLoader.loadAllPlugins(), engineLoader.loadAllPlugins()]);
    await engineLoader.reloadPlugin("single-load");

    expect((globalThis as Record<string, unknown>).__fusionPluginOnLoadCount).toBe(2);
    expect((globalThis as Record<string, unknown>).__fusionPluginOnUnloadCount).toBe(1);
    expect(hostLoader.getPlugin("single-load")).toBe(engineLoader.getPlugin("single-load"));

    await hostLoader.stopPlugin("single-load");

    expect((globalThis as Record<string, unknown>).__fusionPluginOnUnloadCount).toBe(2);
    expect(hostLoader.isPluginLoaded("single-load")).toBe(false);
    expect(engineLoader.isPluginLoaded("single-load")).toBe(false);
  });

  it("starts one fresh lifecycle after explicit reload", async () => {
    const fixture = await createFixture("async () => { globalThis.__fusionPluginOnLoadCount = (globalThis.__fusionPluginOnLoadCount || 0) + 1; }");
    roots.push(fixture.root);
    const store = createStore(fixture.root, fixture.entry);
    const loader = new PluginLoader({ pluginStore: store.pluginStore as any, taskStore: store.taskStore as any });

    await loader.loadPlugin("single-load");
    await loader.reloadPlugin("single-load");

    expect((globalThis as Record<string, unknown>).__fusionPluginOnLoadCount).toBe(2);
  });

  it("clears a rejected lifecycle so a later intentional load can retry", async () => {
    const fixture = await createFixture("async () => { if (!globalThis.__fusionPluginFailOnce) { globalThis.__fusionPluginFailOnce = true; throw new Error('first load fails'); } globalThis.__fusionPluginOnLoadCount = (globalThis.__fusionPluginOnLoadCount || 0) + 1; }");
    roots.push(fixture.root);
    const store = createStore(fixture.root, fixture.entry);
    const loader = new PluginLoader({ pluginStore: store.pluginStore as any, taskStore: store.taskStore as any });

    await expect(loader.loadPlugin("single-load")).rejects.toThrow("first load fails");
    await expect(loader.loadPlugin("single-load")).resolves.toMatchObject({ manifest: { id: "single-load" } });

    expect((globalThis as Record<string, unknown>).__fusionPluginOnLoadCount).toBe(1);
  });
});
