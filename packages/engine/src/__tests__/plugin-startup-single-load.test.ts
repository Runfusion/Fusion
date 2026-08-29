import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginLoader } from "@fusion/core";
import { PluginRunner } from "../plugins/plugin-runner.js";

function createStore(root: string, entry: string) {
  const installation = {
    id: "startup-single-load", name: "Startup single load", version: "1.0.0", description: "fixture",
    path: entry, enabled: true, state: "installed", settings: {}, dependencies: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const events = new EventEmitter();
  return {
    pluginStore: {
      getPlugin: vi.fn(async () => ({ ...installation })),
      listPlugins: vi.fn(async () => [{ ...installation }]),
      updatePluginState: vi.fn(async () => ({ ...installation })),
      on: events.on.bind(events), off: events.off.bind(events),
    },
    taskStore: {
      getRootDir: () => root,
      preflightPluginSchema: vi.fn(() => null), runPluginSchemaInits: vi.fn(async () => undefined),
      on: vi.fn(), off: vi.fn(),
    },
  };
}

describe("PluginRunner startup lifecycle", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    delete (globalThis as Record<string, unknown>).__fusionEngineStartupOnLoad;
  });

  it("does not repeat onLoad when host loadAll and engine runner init race", async () => {
    const root = await mkdtemp(join(tmpdir(), "fusion-engine-plugin-startup-"));
    roots.push(root);
    const entry = join(root, "plugin.mjs");
    await writeFile(entry, `export default {
      manifest: { id: "startup-single-load", name: "fixture", version: "1.0.0", description: "fixture" },
      state: "installed",
      hooks: { onLoad: async () => { globalThis.__fusionEngineStartupOnLoad = (globalThis.__fusionEngineStartupOnLoad || 0) + 1; await new Promise(resolve => setTimeout(resolve, 20)); } },
    };`);

    const host = createStore(root, entry);
    const engine = createStore(root, entry);
    const hostLoader = new PluginLoader({ pluginStore: host.pluginStore as any, taskStore: host.taskStore as any });
    const engineLoader = new PluginLoader({ pluginStore: engine.pluginStore as any, taskStore: engine.taskStore as any });
    const runner = new PluginRunner({ pluginLoader: engineLoader, pluginStore: engine.pluginStore as any, taskStore: engine.taskStore as any, rootDir: root });

    await Promise.all([hostLoader.loadAllPlugins(), runner.init()]);

    expect((globalThis as Record<string, unknown>).__fusionEngineStartupOnLoad).toBe(1);
    expect(engineLoader.isPluginLoaded("startup-single-load")).toBe(true);
  });
});
