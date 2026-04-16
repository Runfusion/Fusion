import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { PluginLoader } from "./plugin-loader.js";
import { PluginStore } from "./plugin-store.js";
import type { FusionPlugin, PluginManifest } from "./plugin-types.js";

// Test plugin manifest
function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    description: "A test plugin",
    ...overrides,
  };
}

// Create a minimal FusionPlugin for testing
function makePlugin(manifest: PluginManifest): FusionPlugin {
  return {
    manifest,
    state: "installed",
    hooks: {},
    tools: [],
    routes: [],
  };
}

// Write a plugin module to disk - creates a simple module without hooks
async function writePluginModule(
  dir: string,
  filename: string,
  plugin: FusionPlugin,
): Promise<string> {
  const filepath = join(dir, filename);
  await mkdir(dir, { recursive: true });

  const manifest = JSON.stringify(plugin.manifest, null, 2);

  // Create a module that exports the plugin
  const moduleCode = `
const manifest = ${manifest};
const plugin = {
  manifest,
  state: "${plugin.state}",
  hooks: {},
  tools: ${JSON.stringify(plugin.tools || [])},
  routes: ${JSON.stringify(plugin.routes || [])},
};

export default plugin;
export { plugin };
`;

  await writeFile(filepath, moduleCode);
  return filepath;
}

// Create a plugin module with hooks
async function writePluginWithHooks(
  dir: string,
  filename: string,
  hooks: {
    onLoad?: string;
    onUnload?: string;
    onTaskCreated?: string;
    onError?: string;
  },
  manifest: PluginManifest,
): Promise<string> {
  const filepath = join(dir, filename);
  await mkdir(dir, { recursive: true });

  const manifestStr = JSON.stringify(manifest, null, 2);

  const hooksCode = Object.entries(hooks)
    .map(([name, body]) => `${name}: ${body}`)
    .join(",\n    ");

  const moduleCode = `
const manifest = ${manifestStr};
const plugin = {
  manifest,
  state: "installed",
  hooks: {
    ${hooksCode}
  },
  tools: [],
  routes: [],
};

export default plugin;
export { plugin };
`;

  await writeFile(filepath, moduleCode);
  return filepath;
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-plugin-loader-test-"));
}

// Mock TaskStore for testing
const mockTaskStore = {
  logActivity: vi.fn(),
} as any;

describe("PluginLoader", () => {
  let rootDir: string;
  let pluginStore: PluginStore;
  let loader: PluginLoader;

  beforeEach(() => {
    rootDir = makeTmpDir();
    pluginStore = new PluginStore(rootDir);
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(rootDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // ── Constructor & init ─────────────────────────────────────────────

  describe("constructor", () => {
    it("creates loader with options", () => {
      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });
      expect(loader).toBeTruthy();
    });

    it("accepts custom plugin directories", () => {
      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
        pluginDirs: ["/custom/plugins"],
      });
      expect(loader).toBeTruthy();
    });
  });

  // ── resolveLoadOrder ──────────────────────────────────────────────

  describe("resolveLoadOrder", () => {
    it("returns plugins in dependency order", async () => {
      await pluginStore.init();
      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: "plugin-a", dependencies: [] }),
        path: "/a",
      });
      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: "plugin-b", dependencies: ["plugin-a"] }),
        path: "/b",
      });

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      const plugins = await pluginStore.listPlugins();
      const sorted = loader.resolveLoadOrder(plugins);

      expect(sorted[0].id).toBe("plugin-a");
      expect(sorted[1].id).toBe("plugin-b");
    });

    it("handles complex dependency chains", async () => {
      await pluginStore.init();
      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: "base", dependencies: [] }),
        path: "/base",
      });
      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: "middle", dependencies: ["base"] }),
        path: "/middle",
      });
      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: "top", dependencies: ["middle", "base"] }),
        path: "/top",
      });

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      const plugins = await pluginStore.listPlugins();
      const sorted = loader.resolveLoadOrder(plugins);

      // base must come before middle and top
      expect(sorted.findIndex((p) => p.id === "base")).toBeLessThan(
        sorted.findIndex((p) => p.id === "middle"),
      );
      expect(sorted.findIndex((p) => p.id === "base")).toBeLessThan(
        sorted.findIndex((p) => p.id === "top"),
      );
      // middle must come before top
      expect(sorted.findIndex((p) => p.id === "middle")).toBeLessThan(
        sorted.findIndex((p) => p.id === "top"),
      );
    });

    it("throws on circular dependencies", async () => {
      await pluginStore.init();
      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: "a", dependencies: ["b"] }),
        path: "/a",
      });
      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: "b", dependencies: ["a"] }),
        path: "/b",
      });

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      const plugins = await pluginStore.listPlugins();
      expect(() => loader.resolveLoadOrder(plugins)).toThrow(
        "Circular dependency detected",
      );
    });

    it("handles plugins with no dependencies", async () => {
      await pluginStore.init();
      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: "solo" }),
        path: "/solo",
      });

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      const plugins = await pluginStore.listPlugins();
      const sorted = loader.resolveLoadOrder(plugins);

      expect(sorted).toHaveLength(1);
      expect(sorted[0].id).toBe("solo");
    });
  });

  // ── loadPlugin ─────────────────────────────────────────────────────

  describe("loadPlugin", () => {
    it("loads a valid plugin from file path", async () => {
      await pluginStore.init();

      const pluginDir = join(rootDir, "plugins");
      const plugin = makePlugin(makeManifest({ id: "load-test" }));
      const pluginPath = await writePluginModule(pluginDir, "index.js", plugin);

      await pluginStore.registerPlugin({
        manifest: plugin.manifest,
        path: pluginPath,
      });

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      const loaded = await loader.loadPlugin("load-test");

      expect(loaded.manifest.id).toBe("load-test");
      expect(loaded.state).toBe("started");
      expect(loader.isPluginLoaded("load-test")).toBe(true);
    });

    it("updates plugin state to started", async () => {
      await pluginStore.init();

      const plugin = makePlugin(makeManifest({ id: "state-test" }));
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginModule(pluginDir, "index.js", plugin);

      await pluginStore.registerPlugin({
        manifest: plugin.manifest,
        path: pluginPath,
      });

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      await loader.loadPlugin("state-test");

      const updated = await pluginStore.getPlugin("state-test");
      expect(updated.state).toBe("started");
    });

    it("skips disabled plugins", async () => {
      await pluginStore.init();

      const plugin = makePlugin(makeManifest({ id: "disabled-test" }));
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginModule(pluginDir, "index.js", plugin);

      await pluginStore.registerPlugin({
        manifest: plugin.manifest,
        path: pluginPath,
      });
      await pluginStore.disablePlugin("disabled-test");

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      await expect(loader.loadPlugin("disabled-test")).rejects.toThrow(
        "disabled",
      );
    });

    it("loads dependencies before loading dependent", async () => {
      await pluginStore.init();

      const depPlugin = makePlugin(makeManifest({ id: "dep-plugin" }));
      const mainPlugin = makePlugin(
        makeManifest({ id: "main-plugin", dependencies: ["dep-plugin"] }),
      );

      const pluginDir = join(rootDir, "plugins");
      const depPath = await writePluginModule(pluginDir, "dep.js", depPlugin);
      const mainPath = await writePluginModule(pluginDir, "main.js", mainPlugin);

      await pluginStore.registerPlugin({
        manifest: depPlugin.manifest,
        path: depPath,
      });
      await pluginStore.registerPlugin({
        manifest: mainPlugin.manifest,
        path: mainPath,
      });

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Use loadAllPlugins to test dependency ordering
      const result = await loader.loadAllPlugins();

      expect(result.loaded).toBe(2);
      expect(loader.isPluginLoaded("dep-plugin")).toBe(true);
      expect(loader.isPluginLoaded("main-plugin")).toBe(true);
    });

    it("fails when dependency is missing", async () => {
      await pluginStore.init();

      const plugin = makePlugin(
        makeManifest({ id: "orphan-plugin", dependencies: ["nonexistent"] }),
      );

      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginModule(pluginDir, "index.js", plugin);

      await pluginStore.registerPlugin({
        manifest: plugin.manifest,
        path: pluginPath,
      });

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      await expect(loader.loadPlugin("orphan-plugin")).rejects.toThrow(
        "depends on nonexistent",
      );
    });

    it("error isolation - plugin crash during load doesn't crash loader", async () => {
      await pluginStore.init();

      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginWithHooks(
        pluginDir,
        "bad.js",
        {
          onLoad: "(async () => { throw new Error('Plugin crashed!'); })",
        },
        makeManifest({ id: "bad-plugin" }),
      );

      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: "bad-plugin" }),
        path: pluginPath,
      });

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Should throw but not crash the process
      await expect(loader.loadPlugin("bad-plugin")).rejects.toThrow(
        "Plugin crashed!",
      );

      // Plugin should be in error state
      const updated = await pluginStore.getPlugin("bad-plugin");
      expect(updated.state).toBe("error");
      expect(updated.error).toContain("Plugin crashed!");
    });
  });

  // ── loadAllPlugins ─────────────────────────────────────────────────

  describe("loadAllPlugins", () => {
    it("loads all enabled plugins", async () => {
      await pluginStore.init();

      const plugins: FusionPlugin[] = [
        makePlugin(makeManifest({ id: "all-a" })),
        makePlugin(makeManifest({ id: "all-b", dependencies: ["all-a"] })),
      ];

      const pluginDir = join(rootDir, "plugins");
      for (const plugin of plugins) {
        const path = await writePluginModule(
          pluginDir,
          `${plugin.manifest.id}.js`,
          plugin,
        );
        await pluginStore.registerPlugin({
          manifest: plugin.manifest,
          path,
        });
      }

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      const result = await loader.loadAllPlugins();

      expect(result.loaded).toBe(2);
      expect(result.errors).toBe(0);
      expect(loader.isPluginLoaded("all-a")).toBe(true);
      expect(loader.isPluginLoaded("all-b")).toBe(true);
    });

    it("returns error count for failed plugins", async () => {
      await pluginStore.init();

      const goodPlugin = makePlugin(makeManifest({ id: "good-plugin" }));
      const pluginDir = join(rootDir, "plugins");

      const goodPath = await writePluginModule(
        pluginDir,
        "good.js",
        goodPlugin,
      );
      const badPath = await writePluginWithHooks(
        pluginDir,
        "bad.js",
        {
          onLoad: "(async () => { throw new Error('Load failed'); })",
        },
        makeManifest({ id: "bad-plugin" }),
      );

      await pluginStore.registerPlugin({
        manifest: goodPlugin.manifest,
        path: goodPath,
      });
      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: "bad-plugin" }),
        path: badPath,
      });

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      const result = await loader.loadAllPlugins();

      expect(result.loaded).toBe(1);
      expect(result.errors).toBe(1);
    });
  });

  // ── stopPlugin ────────────────────────────────────────────────────

  describe("stopPlugin", () => {
    it("updates plugin state to stopped", async () => {
      await pluginStore.init();

      const plugin = makePlugin(makeManifest({ id: "stop-state-test" }));
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginModule(pluginDir, "index.js", plugin);

      await pluginStore.registerPlugin({
        manifest: plugin.manifest,
        path: pluginPath,
      });

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      await loader.loadPlugin("stop-state-test");
      await loader.stopPlugin("stop-state-test");

      const updated = await pluginStore.getPlugin("stop-state-test");
      expect(updated.state).toBe("stopped");
    });

    it("removes plugin from loaded map", async () => {
      await pluginStore.init();

      const plugin = makePlugin(makeManifest({ id: "remove-test" }));
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginModule(pluginDir, "index.js", plugin);

      await pluginStore.registerPlugin({
        manifest: plugin.manifest,
        path: pluginPath,
      });

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      await loader.loadPlugin("remove-test");
      expect(loader.isPluginLoaded("remove-test")).toBe(true);

      await loader.stopPlugin("remove-test");
      expect(loader.isPluginLoaded("remove-test")).toBe(false);
    });

    it("no-ops for non-loaded plugin", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Should not throw
      await loader.stopPlugin("nonexistent");
    });
  });

  // ── stopAllPlugins ─────────────────────────────────────────────────

  describe("stopAllPlugins", () => {
    it("stops all loaded plugins", async () => {
      await pluginStore.init();

      const plugins: FusionPlugin[] = [
        makePlugin(makeManifest({ id: "stop-all-a" })),
        makePlugin(makeManifest({ id: "stop-all-b" })),
      ];

      const pluginDir = join(rootDir, "plugins");
      for (const plugin of plugins) {
        const path = await writePluginModule(
          pluginDir,
          `${plugin.manifest.id}.js`,
          plugin,
        );
        await pluginStore.registerPlugin({
          manifest: plugin.manifest,
          path,
        });
      }

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      await loader.loadAllPlugins();
      await loader.stopAllPlugins();

      expect(loader.isPluginLoaded("stop-all-a")).toBe(false);
      expect(loader.isPluginLoaded("stop-all-b")).toBe(false);
    });
  });

  // ── invokeHook ───────────────────────────────────────────────────

  describe("invokeHook", () => {
    it("calls hook on all plugins with the hook", async () => {
      await pluginStore.init();

      const hookA = vi.fn();
      const hookB = vi.fn();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Manually add plugins with hooks to the loader's internal state
      (loader as any).plugins.set("hook-a", {
        manifest: makeManifest({ id: "hook-a" }),
        state: "started",
        hooks: { onTaskCreated: hookA },
        tools: [],
        routes: [],
      } as FusionPlugin);
      (loader as any).plugins.set("hook-b", {
        manifest: makeManifest({ id: "hook-b" }),
        state: "started",
        hooks: { onTaskCreated: hookB },
        tools: [],
        routes: [],
      } as FusionPlugin);

      await loader.invokeHook("onTaskCreated", { id: "FN-001" } as any);

      expect(hookA).toHaveBeenCalledTimes(1);
      expect(hookB).toHaveBeenCalledTimes(1);
    });

    it("continues when one plugin's hook fails", async () => {
      await pluginStore.init();

      const hookGood = vi.fn();
      const hookBad = vi.fn().mockImplementation(() => {
        throw new Error("Hook failed!");
      });

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Manually add plugins with hooks
      (loader as any).plugins.set("good-hook", {
        manifest: makeManifest({ id: "good-hook" }),
        state: "started",
        hooks: { onTaskCreated: hookGood },
        tools: [],
        routes: [],
      } as FusionPlugin);
      (loader as any).plugins.set("bad-hook", {
        manifest: makeManifest({ id: "bad-hook" }),
        state: "started",
        hooks: { onTaskCreated: hookBad },
        tools: [],
        routes: [],
      } as FusionPlugin);

      // Should not throw
      await loader.invokeHook("onTaskCreated", { id: "FN-001" } as any);

      // Both hooks were attempted
      expect(hookGood).toHaveBeenCalledTimes(1);
      expect(hookBad).toHaveBeenCalledTimes(1);
    });

    it("no error when plugin doesn't have the hook", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Manually add plugin without hooks
      (loader as any).plugins.set("no-hook", {
        manifest: makeManifest({ id: "no-hook" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
      } as FusionPlugin);

      // Should not throw even though plugin has no hooks
      await loader.invokeHook("onTaskCreated", { id: "FN-001" } as any);
    });
  });

  // ── getPluginTools ─────────────────────────────────────────────────

  describe("getPluginTools", () => {
    it("aggregates tools from all loaded plugins", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Manually add plugins with tools
      (loader as any).plugins.set("tools-a", {
        manifest: makeManifest({ id: "tools-a" }),
        state: "started",
        hooks: {},
        tools: [
          {
            name: "tool_a1",
            description: "Tool A1",
            parameters: {},
            execute: async () => ({ content: [] }),
          },
        ],
        routes: [],
      } as FusionPlugin);
      (loader as any).plugins.set("tools-b", {
        manifest: makeManifest({ id: "tools-b" }),
        state: "started",
        hooks: {},
        tools: [
          {
            name: "tool_b1",
            description: "Tool B1",
            parameters: {},
            execute: async () => ({ content: [] }),
          },
        ],
        routes: [],
      } as FusionPlugin);

      const tools = loader.getPluginTools();

      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toContain("tool_a1");
      expect(tools.map((t) => t.name)).toContain("tool_b1");
    });

    it("returns empty array when no plugins have tools", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Manually add plugin without tools
      (loader as any).plugins.set("no-tools", {
        manifest: makeManifest({ id: "no-tools" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
      } as FusionPlugin);

      const tools = loader.getPluginTools();

      expect(tools).toEqual([]);
    });
  });

  // ── getPluginRoutes ───────────────────────────────────────────────

  describe("getPluginRoutes", () => {
    it("aggregates routes from all loaded plugins", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Manually add plugins with routes
      (loader as any).plugins.set("routes-a", {
        manifest: makeManifest({ id: "routes-a" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [
          {
            method: "GET",
            path: "/status",
            handler: async () => ({}),
          },
        ],
      } as FusionPlugin);
      (loader as any).plugins.set("routes-b", {
        manifest: makeManifest({ id: "routes-b" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [
          {
            method: "POST",
            path: "/action",
            handler: async () => ({}),
          },
        ],
      } as FusionPlugin);

      const routes = loader.getPluginRoutes();

      expect(routes).toHaveLength(2);
      expect(routes.find((r) => r.pluginId === "routes-a")?.route.path).toBe(
        "/status",
      );
      expect(routes.find((r) => r.pluginId === "routes-b")?.route.path).toBe(
        "/action",
      );
    });
  });

  // ── getPluginUiSlots ───────────────────────────────────────────────

  describe("getPluginUiSlots", () => {
    it("returns empty array when no plugins loaded", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      const slots = loader.getPluginUiSlots();
      expect(slots).toEqual([]);
    });

    it("returns empty array when plugins have no uiSlots", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Manually add plugin without uiSlots
      (loader as any).plugins.set("no-ui-slots", {
        manifest: makeManifest({ id: "no-ui-slots" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
      } as FusionPlugin);

      const slots = loader.getPluginUiSlots();
      expect(slots).toEqual([]);
    });

    it("returns aggregated slots from single plugin", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Manually add plugin with uiSlots
      (loader as any).plugins.set("slots-a", {
        manifest: makeManifest({ id: "slots-a" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
        uiSlots: [
          {
            slotId: "task-detail-tab",
            label: "Task Details",
            componentPath: "./components/TaskDetailTab.js",
          },
        ],
      } as FusionPlugin);

      const slots = loader.getPluginUiSlots();

      expect(slots).toHaveLength(1);
      expect(slots[0].pluginId).toBe("slots-a");
      expect(slots[0].slot.slotId).toBe("task-detail-tab");
      expect(slots[0].slot.label).toBe("Task Details");
      expect(slots[0].slot.componentPath).toBe("./components/TaskDetailTab.js");
    });

    it("returns aggregated slots from multiple plugins", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Manually add plugins with uiSlots
      (loader as any).plugins.set("slots-a", {
        manifest: makeManifest({ id: "slots-a" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
        uiSlots: [
          {
            slotId: "task-detail-tab",
            label: "Task Details",
            componentPath: "./components/TaskDetailTab.js",
          },
        ],
      } as FusionPlugin);
      (loader as any).plugins.set("slots-b", {
        manifest: makeManifest({ id: "slots-b" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
        uiSlots: [
          {
            slotId: "header-action",
            label: "Header Action",
            icon: "Plus",
            componentPath: "./components/HeaderAction.js",
          },
          {
            slotId: "settings-section",
            label: "Settings",
            componentPath: "./components/SettingsSection.js",
          },
        ],
      } as FusionPlugin);

      const slots = loader.getPluginUiSlots();

      expect(slots).toHaveLength(3);
      expect(slots.find((s) => s.pluginId === "slots-a")?.slot.slotId).toBe(
        "task-detail-tab",
      );
      expect(slots.find((s) => s.pluginId === "slots-b")?.slot.slotId).toBe(
        "header-action",
      );
      expect(slots.filter((s) => s.pluginId === "slots-b")).toHaveLength(2);
    });

    it("each slot includes correct pluginId", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Manually add plugins with overlapping slotIds (different plugins)
      (loader as any).plugins.set("plugin-x", {
        manifest: makeManifest({ id: "plugin-x" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
        uiSlots: [
          {
            slotId: "custom-tab",
            label: "Custom Tab",
            componentPath: "./components/CustomTab.js",
          },
        ],
      } as FusionPlugin);
      (loader as any).plugins.set("plugin-y", {
        manifest: makeManifest({ id: "plugin-y" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
        uiSlots: [
          {
            slotId: "custom-tab",
            label: "Custom Tab Y",
            componentPath: "./components/CustomTabY.js",
          },
        ],
      } as FusionPlugin);

      const slots = loader.getPluginUiSlots();

      // Both plugins can have slots with the same slotId
      const pluginXSlot = slots.find((s) => s.pluginId === "plugin-x");
      const pluginYSlot = slots.find((s) => s.pluginId === "plugin-y");

      expect(pluginXSlot?.slot.slotId).toBe("custom-tab");
      expect(pluginXSlot?.slot.label).toBe("Custom Tab");
      expect(pluginYSlot?.slot.slotId).toBe("custom-tab");
      expect(pluginYSlot?.slot.label).toBe("Custom Tab Y");
    });
  });

  // ── getLoadedPlugins ───────────────────────────────────────────────

  describe("getLoadedPlugins", () => {
    it("returns all loaded plugin instances", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Manually add plugins
      (loader as any).plugins.set("loaded-a", {
        manifest: makeManifest({ id: "loaded-a" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
      } as FusionPlugin);
      (loader as any).plugins.set("loaded-b", {
        manifest: makeManifest({ id: "loaded-b" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
      } as FusionPlugin);

      const loaded = loader.getLoadedPlugins();

      expect(loaded).toHaveLength(2);
      expect(loaded.map((p) => p.manifest.id).sort()).toEqual([
        "loaded-a",
        "loaded-b",
      ]);
    });

    it("returns empty array when no plugins loaded", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      const loaded = loader.getLoadedPlugins();

      expect(loaded).toEqual([]);
    });
  });
});
