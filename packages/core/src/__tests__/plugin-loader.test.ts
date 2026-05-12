import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { PluginLoader } from "../plugin-loader.js";
import * as loggerModule from "../logger.js";

const scanPluginSecurityMock = vi.fn();
vi.mock("../plugin-security-scan.js", () => ({
  scanPluginSecurity: (...args: unknown[]) => scanPluginSecurityMock(...args),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  AssistantMessageEventStream: class AssistantMessageEventStream {
    push() {}
    end() {}
  },
  calculateCost: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
}));
import { PluginStore } from "../plugin-store.js";
import { setCreateAiSessionFactory } from "../ai-engine-loader.js";
import type { CreateAiSessionOptions, FusionPlugin, PluginManifest } from "../plugin-types.js";

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

function droidPluginModulePath(): string {
  return fileURLToPath(
    new URL("../../../../plugins/fusion-plugin-droid-runtime/src/index.ts", import.meta.url),
  );
}

// Mock TaskStore for testing
const mockTaskStore = {
  logActivity: vi.fn(),
  getRootDir: () => "/tmp/plugin-loader-test-root",
  getPluginStore: vi.fn(),
} as any;

type MockStructuredLogger = {
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function mockStructuredLoggerFactory() {
  const loggerMap = new Map<string, MockStructuredLogger>();
  const createLoggerMock = vi.fn((prefix: string): MockStructuredLogger => {
    const existing = loggerMap.get(prefix);
    if (existing) return existing;

    const logger: MockStructuredLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    loggerMap.set(prefix, logger);
    return logger;
  });

  // Use a spy instead of resetModules/doMock so this suite cannot corrupt
  // other modules' live exports (notably plugin-types normalization helpers).
  vi.spyOn(loggerModule, "createLogger").mockImplementation(createLoggerMock);
  return { createLoggerMock, loggerMap };
}

describe("PluginLoader", () => {
  let rootDir: string;
  let pluginStore: PluginStore;
  let loader: PluginLoader;

  beforeEach(() => {
    rootDir = makeTmpDir();
    pluginStore = new PluginStore(rootDir, { inMemoryDb: true, centralGlobalDir: rootDir });
    setCreateAiSessionFactory(undefined);
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(rootDir, { recursive: true, force: true });
    setCreateAiSessionFactory(undefined);
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
    beforeEach(() => {
      scanPluginSecurityMock.mockReset();
      scanPluginSecurityMock.mockResolvedValue({
        verdict: "clean",
        summary: "clean",
        findings: [],
        scannedAt: new Date().toISOString(),
        scannedFiles: ["manifest.json"],
      });
    });
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

    it("loads the migrated Droid plugin through register→loadAllPlugins→loadPlugin pipeline", async () => {
      await pluginStore.init();

      const droidManifest = {
        id: "fusion-plugin-droid-runtime",
        name: "Droid Runtime Plugin",
        version: "0.1.0",
        description: "Droid runtime plugin for Fusion",
        runtime: {
          runtimeId: "droid",
          name: "Droid Runtime",
          description: "Drives the Droid CLI for Fusion agents",
          version: "0.1.0",
        },
      } as const;

      await pluginStore.registerPlugin({
        manifest: droidManifest,
        path: droidPluginModulePath(),
      });

      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      const loadAllResult = await loader.loadAllPlugins();

      expect(loadAllResult).toEqual({ loaded: 1, errors: 0 });
      expect(loader.isPluginLoaded("fusion-plugin-droid-runtime")).toBe(true);

      const loaded = await loader.loadPlugin("fusion-plugin-droid-runtime");
      expect(loaded.manifest.id).toBe("fusion-plugin-droid-runtime");
      expect(loaded.state).toBe("started");

      const installed = await pluginStore.getPlugin("fusion-plugin-droid-runtime");
      expect(installed.state).toBe("started");

      const slots = loader
        .getPluginUiSlots()
        .filter((entry) => entry.pluginId === "fusion-plugin-droid-runtime");
      expect(slots.map((entry) => entry.slot.slotId)).toEqual(
        expect.arrayContaining([
          "onboarding-provider-card",
          "onboarding-setup-help",
          "post-onboarding-recommendation",
          "settings-provider-card",
          "settings-integration-card",
        ]),
      );
      expect(slots).toHaveLength(5);
      expect(slots[0]?.slot).toHaveProperty("label");
      expect(slots[0]?.slot).toHaveProperty("componentPath");

      const runtimes = loader
        .getPluginRuntimes()
        .filter((entry) => entry.pluginId === "fusion-plugin-droid-runtime");
      expect(runtimes).toHaveLength(1);
      expect(runtimes[0].runtime.metadata).toMatchObject({
        runtimeId: "droid",
        name: "Droid Runtime",
        version: "0.1.0",
      });
      expect(typeof runtimes[0].runtime.factory).toBe("function");
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

    it("recovers a previously errored plugin to started and clears the stored error", async () => {
      await pluginStore.init();

      const plugin = makePlugin(makeManifest({ id: "recover-error-test" }));
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginModule(pluginDir, "recover-error.js", plugin);

      await pluginStore.registerPlugin({
        manifest: plugin.manifest,
        path: pluginPath,
      });
      await pluginStore.updatePluginState("recover-error-test", "error", "previous load failed");

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      await loader.loadPlugin("recover-error-test");

      const updated = await pluginStore.getPlugin("recover-error-test");
      expect(updated.state).toBe("started");
      expect(updated.error ?? null).toBeNull();
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

    it("blocks load when ai scan verdict is blocked", async () => {
      await pluginStore.init();
      scanPluginSecurityMock.mockResolvedValueOnce({
        verdict: "blocked",
        summary: "blocked by scan",
        findings: [],
        scannedAt: new Date().toISOString(),
        scannedFiles: ["manifest.json"],
      });

      const plugin = makePlugin(makeManifest({ id: "scan-blocked" }));
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginModule(pluginDir, "index.js", plugin);

      await pluginStore.registerPlugin({
        manifest: plugin.manifest,
        path: pluginPath,
        aiScanOnLoad: true,
      });

      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      await expect(loader.loadPlugin("scan-blocked")).rejects.toThrow("Security scan blocked");
      expect(loader.isPluginLoaded("scan-blocked")).toBe(false);
    });

    it("runs ai scan before loading when aiScanOnLoad is enabled", async () => {
      await pluginStore.init();

      const plugin = makePlugin(makeManifest({ id: "scan-enabled" }));
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginModule(pluginDir, "index.js", plugin);

      await pluginStore.registerPlugin({
        manifest: plugin.manifest,
        path: pluginPath,
        aiScanOnLoad: true,
      });

      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      await loader.loadPlugin("scan-enabled");

      expect(scanPluginSecurityMock).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "scan-enabled" }));
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

    it("fails when plugin module manifest is invalid", async () => {
      await pluginStore.init();

      const pluginDir = join(rootDir, "plugins");
      const pluginPath = join(pluginDir, "invalid-manifest.js");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        pluginPath,
        `
const plugin = {
  manifest: { id: "invalid-manifest", version: "1.0.0" },
  state: "installed",
  hooks: {},
};
export default plugin;
`,
      );

      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: "invalid-manifest" }),
        path: pluginPath,
      });

      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });

      await expect(loader.loadPlugin("invalid-manifest")).rejects.toThrow(
        "Invalid plugin manifest",
      );

      const stored = await pluginStore.getPlugin("invalid-manifest");
      expect(stored.state).toBe("error");
    });

    it("fails when plugin entrypoint is missing", async () => {
      await pluginStore.init();

      const missingPath = join(rootDir, "plugins", "missing-entrypoint.js");
      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: "missing-entrypoint" }),
        path: missingPath,
      });

      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });

      await expect(loader.loadPlugin("missing-entrypoint")).rejects.toThrow();
      const stored = await pluginStore.getPlugin("missing-entrypoint");
      expect(stored.state).toBe("error");
      expect(stored.error).toBeTruthy();
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

    it("skips disabled plugins during loadAllPlugins", async () => {
      await pluginStore.init();

      const pluginDir = join(rootDir, "plugins");
      const enabledPlugin = makePlugin(makeManifest({ id: "enabled-plugin" }));
      const disabledPlugin = makePlugin(makeManifest({ id: "disabled-plugin" }));

      const enabledPath = await writePluginModule(pluginDir, "enabled.js", enabledPlugin);
      const disabledPath = await writePluginModule(pluginDir, "disabled.js", disabledPlugin);

      await pluginStore.registerPlugin({ manifest: enabledPlugin.manifest, path: enabledPath });
      await pluginStore.registerPlugin({ manifest: disabledPlugin.manifest, path: disabledPath });
      await pluginStore.disablePlugin("disabled-plugin");

      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      const result = await loader.loadAllPlugins();

      expect(result).toEqual({ loaded: 1, errors: 0 });
      expect(loader.isPluginLoaded("enabled-plugin")).toBe(true);
      expect(loader.isPluginLoaded("disabled-plugin")).toBe(false);
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

    it("passes plugin context to onUnload", async () => {
      await pluginStore.init();

      const plugin = makePlugin(makeManifest({ id: "stop-context-test" }));
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginWithHooks(
        pluginDir,
        "stop-context.js",
        {
          onUnload:
            "(ctx => { globalThis.__pluginUnloadCtx = { pluginId: ctx.pluginId, taskStore: ctx.taskStore }; })",
        },
        plugin.manifest,
      );

      await pluginStore.registerPlugin({
        manifest: plugin.manifest,
        path: pluginPath,
      });

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      await loader.loadPlugin("stop-context-test");
      await loader.stopPlugin("stop-context-test");

      const unloadCtx = (globalThis as { __pluginUnloadCtx?: { pluginId: string; taskStore: unknown } })
        .__pluginUnloadCtx;
      expect(unloadCtx).toBeDefined();
      expect(unloadCtx?.pluginId).toBe("stop-context-test");
      expect(unloadCtx?.taskStore).toBe(mockTaskStore);
      delete (globalThis as { __pluginUnloadCtx?: unknown }).__pluginUnloadCtx;
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

  // ── structured logging ──────────────────────────────────────────────

  describe("structured logging", () => {

    it("keeps plugin-types normalization exports callable after logger mocking", async () => {
      mockStructuredLoggerFactory();
      const pluginTypes = await import("../plugin-types.js");
      expect(typeof pluginTypes.normalizePluginUiContributionDefinition).toBe("function");
      expect(typeof pluginTypes.normalizePluginUiContributionSurface).toBe("function");
    });

    it("logs when skipping a disabled plugin", async () => {
      await pluginStore.init();

      const plugin = makePlugin(makeManifest({ id: "disabled-log-test" }));
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginModule(pluginDir, "disabled-log.js", plugin);

      await pluginStore.registerPlugin({
        manifest: plugin.manifest,
        path: pluginPath,
      });
      await pluginStore.disablePlugin("disabled-log-test");

      const { loggerMap } = mockStructuredLoggerFactory();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });

      await expect(loader.loadPlugin("disabled-log-test")).rejects.toThrow("disabled");
      expect(loggerMap.get("plugin-loader")?.log).toHaveBeenCalledWith(
        "Skipping disabled plugin: disabled-log-test",
      );
    });

    it("logs when plugin is already loaded", async () => {
      await pluginStore.init();

      const plugin = makePlugin(makeManifest({ id: "already-loaded-log" }));
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginModule(pluginDir, "already-loaded.js", plugin);

      await pluginStore.registerPlugin({
        manifest: plugin.manifest,
        path: pluginPath,
      });

      const { loggerMap } = mockStructuredLoggerFactory();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });

      await loader.loadPlugin("already-loaded-log");
      await loader.loadPlugin("already-loaded-log");

      expect(loggerMap.get("plugin-loader")?.log).toHaveBeenCalledWith(
        "Plugin already loaded: already-loaded-log",
      );
    });

    it("logs when reloading a plugin", async () => {
      await pluginStore.init();

      const plugin = makePlugin(makeManifest({ id: "reload-log-test" }));
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginModule(pluginDir, "reload-log.js", plugin);

      await pluginStore.registerPlugin({
        manifest: plugin.manifest,
        path: pluginPath,
      });

      const { loggerMap } = mockStructuredLoggerFactory();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });

      await loader.loadPlugin("reload-log-test");
      await loader.reloadPlugin("reload-log-test");

      expect(loggerMap.get("plugin-loader")?.log).toHaveBeenCalledWith(
        "Reloading plugin: reload-log-test",
      );
    });

    it("logs reload failures", async () => {
      await pluginStore.init();

      const pluginId = "reload-failure-log";
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = join(pluginDir, "reload-failure.js");

      await writePluginModule(pluginDir, "reload-failure.js", makePlugin(makeManifest({ id: pluginId })));
      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: pluginId }),
        path: pluginPath,
      });

      const { loggerMap } = mockStructuredLoggerFactory();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });

      await loader.loadPlugin(pluginId);
      await writePluginWithHooks(
        pluginDir,
        "reload-failure.js",
        {
          onLoad: "(async () => { throw new Error('reload failed'); })",
        },
        makeManifest({ id: pluginId }),
      );

      await expect(loader.reloadPlugin(pluginId)).rejects.toThrow("reload failed");
      expect(loggerMap.get("plugin-loader")?.error).toHaveBeenCalledWith(
        `Reload failed for ${pluginId}, rolling back:`,
        expect.any(Error),
      );
    });

    it("logs rollback failures", async () => {
      await pluginStore.init();

      const pluginId = "rollback-failure-log";
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = join(pluginDir, "rollback-failure.js");

      await writePluginWithHooks(
        pluginDir,
        "rollback-failure.js",
        {
          onLoad: "((() => { let count = 0; return async () => { count += 1; if (count > 1) throw new Error('old onLoad failed on retry'); }; })())",
        },
        makeManifest({ id: pluginId }),
      );

      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: pluginId }),
        path: pluginPath,
      });

      const { loggerMap } = mockStructuredLoggerFactory();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });

      await loader.loadPlugin(pluginId);
      await writePluginWithHooks(
        pluginDir,
        "rollback-failure.js",
        {
          onLoad: "(async () => { throw new Error('new onLoad failed'); })",
        },
        makeManifest({ id: pluginId }),
      );

      await expect(loader.reloadPlugin(pluginId)).rejects.toThrow("new onLoad failed");
      expect(loggerMap.get("plugin-loader")?.error).toHaveBeenCalledWith(
        `Rollback failed for ${pluginId}, removing plugin:`,
        expect.any(Error),
      );
    });

    it("logs onUnload hook errors when stopping", async () => {
      await pluginStore.init();

      const pluginId = "stop-hook-log";
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginWithHooks(
        pluginDir,
        "stop-hook.js",
        {
          onUnload: "(() => { throw new Error('stop failed'); })",
        },
        makeManifest({ id: pluginId }),
      );

      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: pluginId }),
        path: pluginPath,
      });

      const { loggerMap } = mockStructuredLoggerFactory();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });

      await loader.loadPlugin(pluginId);
      await loader.stopPlugin(pluginId);

      expect(loggerMap.get("plugin-loader")?.error).toHaveBeenCalledWith(
        `Error in onUnload for ${pluginId}:`,
        expect.any(Error),
      );
    });

    it("logs loadAllPlugins failures", async () => {
      await pluginStore.init();

      const pluginDir = join(rootDir, "plugins");
      const goodPlugin = makePlugin(makeManifest({ id: "good-load-all-log" }));
      const goodPath = await writePluginModule(pluginDir, "good-load-all.js", goodPlugin);
      const badPath = await writePluginWithHooks(
        pluginDir,
        "bad-load-all.js",
        {
          onLoad: "(async () => { throw new Error('load all failure'); })",
        },
        makeManifest({ id: "bad-load-all-log" }),
      );

      await pluginStore.registerPlugin({ manifest: goodPlugin.manifest, path: goodPath });
      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: "bad-load-all-log" }),
        path: badPath,
      });

      const { loggerMap } = mockStructuredLoggerFactory();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });

      await loader.loadAllPlugins();

      expect(loggerMap.get("plugin-loader")?.error).toHaveBeenCalledWith(
        "Failed to load plugin bad-load-all-log:",
        expect.any(Error),
      );
    }, 15_000);

    it("logs invokeHook failures", async () => {
      await pluginStore.init();

      const { loggerMap } = mockStructuredLoggerFactory();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });

      (loader as any).plugins.set("hook-error-log", {
        manifest: makeManifest({ id: "hook-error-log" }),
        state: "started",
        hooks: {
          onTaskCreated: () => {
            throw new Error("hook failure");
          },
        },
        tools: [],
        routes: [],
      } as FusionPlugin);

      await loader.invokeHook("onTaskCreated", { id: "FN-123" } as any);

      expect(loggerMap.get("plugin-loader")?.error).toHaveBeenCalledWith(
        "Error in onTaskCreated hook for hook-error-log:",
        expect.any(Error),
      );
    });

    it("logs custom events from createContext through structured logger", async () => {
      await pluginStore.init();

      const pluginId = "custom-event-log";
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginWithHooks(
        pluginDir,
        "custom-event.js",
        {
          onLoad: "(async (ctx) => { ctx.emitEvent('custom-event', { payload: 'ok' }); })",
        },
        makeManifest({ id: pluginId }),
      );

      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: pluginId }),
        path: pluginPath,
      });

      const { loggerMap } = mockStructuredLoggerFactory();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });

      await loader.loadPlugin(pluginId);

      expect(loggerMap.get("plugin-loader")?.log).toHaveBeenCalledWith(
        `[plugin:${pluginId}] Custom event: custom-event`,
        { payload: "ok" },
      );
    });
  });

  describe("createAiSession plugin context injection", () => {
    it("createContext includes createAiSession when factory is registered", async () => {
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      const factory = vi.fn(async () => ({
        session: { prompt: async () => {}, state: { messages: [] } },
      }));
      setCreateAiSessionFactory(factory);

      const context = await (loader as any).createContext(makePlugin(makeManifest({ id: "ctx-ai" })));

      expect(context.createAiSession).toBe(factory);
    });

    it("createContext sets createAiSession to undefined when no factory is registered", async () => {
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });

      const context = await (loader as any).createContext(makePlugin(makeManifest({ id: "ctx-no-ai" })));

      expect(context).toHaveProperty("createAiSession");
      expect(context.createAiSession).toBeUndefined();
    });

    it("createAiSession calls through to underlying factory with provided options", async () => {
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      const factory = vi.fn(async () => ({
        session: { prompt: async () => {}, state: { messages: [] } },
      }));
      setCreateAiSessionFactory(factory);

      const context = await (loader as any).createContext(makePlugin(makeManifest({ id: "ctx-call-through" })));
      const options: CreateAiSessionOptions = {
        cwd: rootDir,
        systemPrompt: "You are a plugin test agent",
        tools: "readonly",
        defaultProvider: "anthropic",
        defaultModelId: "claude-sonnet",
      };

      await context.createAiSession?.(options);

      expect(factory).toHaveBeenCalledWith(options);
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it("allows plugin onLoad to call ctx.createAiSession and receive a result", async () => {
      await pluginStore.init();

      const pluginId = "onload-create-ai-session";
      const pluginDir = join(rootDir, "plugins");
      const pluginPath = await writePluginWithHooks(
        pluginDir,
        "onload-create-ai-session.js",
        {
          onLoad:
            "(async (ctx) => { const result = await ctx.createAiSession({ cwd: process.cwd(), systemPrompt: 'test prompt' }); if (!result?.session?.state?.messages) throw new Error('missing session result'); })",
        },
        makeManifest({ id: pluginId }),
      );

      await pluginStore.registerPlugin({
        manifest: makeManifest({ id: pluginId }),
        path: pluginPath,
      });

      setCreateAiSessionFactory(async () => ({
        session: {
          prompt: async () => {},
          state: { messages: [{ role: "assistant", content: "ok" }] },
        },
        sessionFile: join(rootDir, "session.json"),
      }));

      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      const plugin = await loader.loadPlugin(pluginId);

      expect(plugin.state).toBe("started");
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
      expect(slots[0].slot.surface).toBe("task-detail-tab");
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
      expect(slots.map((slot) => slot.pluginId)).toEqual(["slots-a", "slots-b", "slots-b"]);
    });

    it("sorts slots by order and then pluginId/slotId", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      (loader as any).plugins.set("plugin-b", {
        manifest: makeManifest({ id: "plugin-b" }),
        state: "started",
        hooks: {},
        uiSlots: [
          {
            slotId: "onboarding-provider-card",
            label: "B",
            componentPath: "./B.js",
            order: 10,
          },
        ],
      } as FusionPlugin);

      (loader as any).plugins.set("plugin-a", {
        manifest: makeManifest({ id: "plugin-a" }),
        state: "started",
        hooks: {},
        uiSlots: [
          {
            slotId: "onboarding-provider-card",
            label: "A-first",
            componentPath: "./A.js",
            order: 1,
          },
          {
            slotId: "settings-section",
            label: "A-second",
            componentPath: "./A2.js",
          },
        ],
      } as FusionPlugin);

      const slots = loader.getPluginUiSlots();
      expect(slots.map((slot) => slot.slot.label)).toEqual(["A-first", "B", "A-second"]);
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



  describe("getPluginUiContributions", () => {
    it("returns normalized structured contributions and sorts deterministically", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      (loader as any).plugins.set("plugin-b", {
        manifest: makeManifest({ id: "plugin-b" }),
        state: "started",
        hooks: {},
        uiContributions: [
          {
            surface: "onboarding-recommendation-card",
            contributionId: "rec-b",
            providerId: "openai",
            title: "OpenAI",
            reason: "default",
            order: 10,
          },
        ],
      } as FusionPlugin);

      (loader as any).plugins.set("plugin-a", {
        manifest: makeManifest({ id: "plugin-a" }),
        state: "started",
        hooks: {},
        uiContributions: [
          {
            surface: "settings-integration-card",
            contributionId: "cfg-a",
            sectionId: "openai",
            title: "OpenAI settings",
            pluginSettingKeys: ["openai.apiKey"],
            order: 1,
          },
        ],
      } as FusionPlugin);

      const contributions = loader.getPluginUiContributions();

      expect(contributions).toHaveLength(2);
      expect(contributions[0]?.pluginId).toBe("plugin-a");
      expect(contributions[0]?.contribution.surface).toBe("settings-config-section");
      expect(contributions[1]?.contribution.surface).toBe("onboarding-provider-recommendation");
    });
  });

  describe("getPluginDashboardViews", () => {
    it("returns empty array when no plugins loaded", async () => {
      await pluginStore.init();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      expect(loader.getPluginDashboardViews()).toEqual([]);
    });

    it("returns aggregated views from a single plugin", async () => {
      await pluginStore.init();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      (loader as any).plugins.set("views-a", {
        manifest: makeManifest({ id: "views-a" }),
        state: "started",
        hooks: {},
        dashboardViews: [
          { viewId: "graph", label: "Graph", componentPath: "./graph.js", placement: "more" },
          { viewId: "timeline", label: "Timeline", componentPath: "./timeline.js", placement: "overflow" },
        ],
      } as FusionPlugin);

      const views = loader.getPluginDashboardViews();
      expect(views.map((entry) => entry.pluginId + ":" + entry.view.viewId)).toEqual([
        "views-a:graph",
        "views-a:timeline",
      ]);
    });

    it("aggregates dashboard views from multiple plugins and keeps uiSlots separate", async () => {
      await pluginStore.init();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      (loader as any).plugins.set("views-a", {
        manifest: makeManifest({ id: "views-a" }),
        state: "started",
        hooks: {},
        uiSlots: [{ slotId: "task-detail-tab", label: "Tab", componentPath: "./tab.js" }],
        dashboardViews: [{ viewId: "graph", label: "Graph", componentPath: "./graph.js", placement: "more" }],
      } as FusionPlugin);
      (loader as any).plugins.set("views-b", {
        manifest: makeManifest({ id: "views-b" }),
        state: "started",
        hooks: {},
        dashboardViews: [{ viewId: "timeline", label: "Timeline", componentPath: "./timeline.js" }],
      } as FusionPlugin);

      const views = loader.getPluginDashboardViews();
      expect(views).toHaveLength(2);
      expect(views.map((entry) => entry.pluginId + ":" + entry.view.viewId)).toEqual([
        "views-a:graph",
        "views-b:timeline",
      ]);
      expect(loader.getPluginUiSlots()).toHaveLength(1);
      expect(loader.getPluginTools()).toEqual([]);
      expect(loader.getPluginRoutes()).toEqual([]);
    });

    it("returns pluginId and complete view payload for each dashboard view entry", async () => {
      await pluginStore.init();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      (loader as any).plugins.set("views-shape", {
        manifest: makeManifest({ id: "views-shape" }),
        state: "started",
        hooks: {},
        dashboardViews: [
          {
            viewId: "graph",
            label: "Graph",
            componentPath: "./graph.js",
            icon: "Network",
            placement: "more",
            description: "Task dependency graph",
            order: 40,
          },
        ],
      } as FusionPlugin);

      expect(loader.getPluginDashboardViews()).toEqual([
        {
          pluginId: "views-shape",
          view: {
            viewId: "graph",
            label: "Graph",
            componentPath: "./graph.js",
            icon: "Network",
            placement: "more",
            description: "Task dependency graph",
            order: 40,
          },
        },
      ]);
    });
  });

  describe("getPluginSchemaInitHooks", () => {
    it("returns empty array when no plugins define onSchemaInit", async () => {
      await pluginStore.init();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      (loader as any).plugins.set("no-hook", {
        manifest: makeManifest({ id: "no-hook" }),
        state: "started",
        hooks: {},
      } as FusionPlugin);

      expect(loader.getPluginSchemaInitHooks()).toEqual([]);
    });

    it("returns hooks only from plugins that define onSchemaInit", async () => {
      await pluginStore.init();
      const loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      const hookA = async () => {};
      const hookB = () => {};

      (loader as any).plugins.set("schema-a", {
        manifest: makeManifest({ id: "schema-a" }),
        state: "started",
        hooks: { onSchemaInit: hookA },
      } as FusionPlugin);
      (loader as any).plugins.set("schema-b", {
        manifest: makeManifest({ id: "schema-b" }),
        state: "started",
        hooks: { onLoad: async () => {} },
      } as FusionPlugin);
      (loader as any).plugins.set("schema-c", {
        manifest: makeManifest({ id: "schema-c" }),
        state: "started",
        hooks: { onSchemaInit: hookB },
      } as FusionPlugin);

      const hooks = loader.getPluginSchemaInitHooks();
      expect(hooks.map((entry) => entry.pluginId)).toEqual(["schema-a", "schema-c"]);
      expect(hooks[0]?.hook).toBe(hookA);
      expect(hooks[1]?.hook).toBe(hookB);
    });
  });

  // ── getPluginRuntimes ─────────────────────────────────────────────

  describe("getPluginRuntimes", () => {
    it("returns empty array when no plugins loaded", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      const runtimes = loader.getPluginRuntimes();
      expect(runtimes).toEqual([]);
    });

    it("returns empty array when plugins have no runtime registration", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Manually add plugin without runtime
      (loader as any).plugins.set("no-runtime", {
        manifest: makeManifest({ id: "no-runtime" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
      } as FusionPlugin);

      const runtimes = loader.getPluginRuntimes();
      expect(runtimes).toEqual([]);
    });

    it("returns runtime registration from single plugin with runtime", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      const mockRuntime = {
        metadata: {
          runtimeId: "code-interpreter",
          name: "Code Interpreter",
          description: "Executes code in a sandbox",
          version: "1.0.0",
        },
        factory: async () => ({ execute: async () => {} }),
      };

      // Manually add plugin with runtime
      (loader as any).plugins.set("runtime-plugin", {
        manifest: makeManifest({ id: "runtime-plugin" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
        runtime: mockRuntime,
      } as FusionPlugin);

      const runtimes = loader.getPluginRuntimes();

      expect(runtimes).toHaveLength(1);
      expect(runtimes[0].pluginId).toBe("runtime-plugin");
      expect(runtimes[0].runtime.metadata.runtimeId).toBe("code-interpreter");
      expect(runtimes[0].runtime.metadata.name).toBe("Code Interpreter");
      expect(runtimes[0].runtime.metadata.description).toBe("Executes code in a sandbox");
      expect(runtimes[0].runtime.metadata.version).toBe("1.0.0");
      expect(typeof runtimes[0].runtime.factory).toBe("function");
    });

    it("returns runtime registrations from multiple plugins", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      const runtimeA = {
        metadata: {
          runtimeId: "runtime-a",
          name: "Runtime A",
        },
        factory: async () => {},
      };

      const runtimeB = {
        metadata: {
          runtimeId: "runtime-b",
          name: "Runtime B",
          description: "Another runtime",
          version: "2.0.0",
        },
        factory: async () => {},
      };

      // Manually add plugins with runtimes
      (loader as any).plugins.set("plugin-a", {
        manifest: makeManifest({ id: "plugin-a" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
        runtime: runtimeA,
      } as FusionPlugin);
      (loader as any).plugins.set("plugin-b", {
        manifest: makeManifest({ id: "plugin-b" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
        runtime: runtimeB,
      } as FusionPlugin);

      const runtimes = loader.getPluginRuntimes();

      expect(runtimes).toHaveLength(2);
      expect(runtimes.find((r) => r.pluginId === "plugin-a")?.runtime.metadata.runtimeId).toBe("runtime-a");
      expect(runtimes.find((r) => r.pluginId === "plugin-b")?.runtime.metadata.runtimeId).toBe("runtime-b");
    }, 15_000);

    it("skips plugins without runtime registration when other plugins have runtimes", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      const mockRuntime = {
        metadata: {
          runtimeId: "code-interpreter",
          name: "Code Interpreter",
        },
        factory: async () => {},
      };

      // Manually add plugins - one with runtime, one without
      (loader as any).plugins.set("plugin-with-runtime", {
        manifest: makeManifest({ id: "plugin-with-runtime" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
        runtime: mockRuntime,
      } as FusionPlugin);
      (loader as any).plugins.set("plugin-no-runtime", {
        manifest: makeManifest({ id: "plugin-no-runtime" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
      } as FusionPlugin);

      const runtimes = loader.getPluginRuntimes();

      expect(runtimes).toHaveLength(1);
      expect(runtimes[0].pluginId).toBe("plugin-with-runtime");
      expect(runtimes[0].runtime.metadata.runtimeId).toBe("code-interpreter");
    });

    it("includes both metadata and factory from runtime registration", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      const factoryFn = async () => ({ result: "test" });
      const mockRuntime = {
        metadata: {
          runtimeId: "test-runtime",
          name: "Test Runtime",
          description: "Test description",
        },
        factory: factoryFn,
      };

      (loader as any).plugins.set("test-plugin", {
        manifest: makeManifest({ id: "test-plugin" }),
        state: "started",
        hooks: {},
        tools: [],
        routes: [],
        runtime: mockRuntime,
      } as FusionPlugin);

      const runtimes = loader.getPluginRuntimes();

      expect(runtimes).toHaveLength(1);
      expect(runtimes[0].runtime.metadata).toEqual({
        runtimeId: "test-runtime",
        name: "Test Runtime",
        description: "Test description",
      });
      expect(runtimes[0].runtime.factory).toBe(factoryFn);
    });

    it("returns deterministic empty array when no runtime registrations available", async () => {
      await pluginStore.init();

      const loader = new PluginLoader({
        pluginStore,
        taskStore: mockTaskStore,
      });

      // Multiple calls return same result
      const runtimes1 = loader.getPluginRuntimes();
      const runtimes2 = loader.getPluginRuntimes();
      const runtimes3 = loader.getPluginRuntimes();

      expect(runtimes1).toEqual([]);
      expect(runtimes2).toEqual([]);
      expect(runtimes3).toEqual([]);
    });
  });

  // ── new plugin contribution accessors ───────────────────────────────

  describe("new contribution accessors", () => {
    it("returns empty arrays when no contribution types are present", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      expect(loader.getCliProviderContributions()).toEqual([]);
      expect(loader.getPluginSkills()).toEqual([]);
      expect(loader.getPluginWorkflowSteps()).toEqual([]);
      expect(loader.getPluginWorkflowStepTemplates()).toEqual([]);
      expect(loader.getPluginPromptContributions()).toEqual([]);
      expect(loader.getPluginSetupInfo()).toEqual([]);
    });

    it("getCliProviderContributions returns contributed CLI providers with pluginId", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      (loader as any).plugins.set("cli-provider-plugin", {
        manifest: makeManifest({ id: "cli-provider-plugin" }),
        state: "started",
        hooks: {},
        cliProviders: [
          {
            providerId: "cursor-cli",
            displayName: "Cursor CLI",
            binaryName: "cursor-agent",
            providerType: "cli",
            statusRoute: "/providers/cursor-cli/status",
            authRoute: "/auth/cursor-cli",
          },
        ],
      } as FusionPlugin);
      expect(loader.getCliProviderContributions()).toEqual([
        {
          pluginId: "cli-provider-plugin",
          contribution: {
            providerId: "cursor-cli",
            displayName: "Cursor CLI",
            binaryName: "cursor-agent",
            providerType: "cli",
            statusRoute: "/providers/cursor-cli/status",
            authRoute: "/auth/cursor-cli",
          },
        },
      ]);
    });

    it("getPluginSkills returns skills with pluginId", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      (loader as any).plugins.set("skills-plugin", {
        manifest: makeManifest({ id: "skills-plugin" }),
        state: "started",
        hooks: {},
        skills: [{ skillId: "browser", name: "Browser", description: "Web", skillFiles: ["./SKILL.md"] }],
      } as FusionPlugin);
      expect(loader.getPluginSkills()).toEqual([
        {
          pluginId: "skills-plugin",
          skill: { skillId: "browser", name: "Browser", description: "Web", skillFiles: ["./SKILL.md"] },
        },
      ]);
    });

    it("returns workflow steps, prompt contributions, and setup info", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      const checkSetup = vi.fn().mockResolvedValue({ status: "installed" });
      (loader as any).plugins.set("contrib-plugin", {
        manifest: makeManifest({ id: "contrib-plugin" }),
        state: "started",
        hooks: {},
        workflowSteps: [{ stepId: "wf", name: "WF", description: "desc", mode: "prompt", prompt: "check" }],
        promptContributions: {
          enabledByDefault: true,
          contributions: [{ surface: "executor-system", content: "inject" }],
        },
        setup: {
          manifest: { binaryName: "agent-browser", description: "Binary" },
          hooks: { checkSetup },
        },
      } as FusionPlugin);

      expect(loader.getPluginWorkflowSteps()).toEqual([
        {
          pluginId: "contrib-plugin",
          step: { stepId: "wf", name: "WF", description: "desc", mode: "prompt", prompt: "check" },
        },
      ]);
      expect(loader.getPluginWorkflowStepTemplates()).toEqual([
        {
          pluginId: "contrib-plugin",
          template: expect.objectContaining({
            id: "plugin:contrib-plugin:wf",
            name: "WF",
            description: "desc",
            prompt: "check",
            category: "Plugin",
            icon: "puzzle",
          }),
        },
      ]);
      expect(loader.getPluginPromptContributions()).toEqual([
        {
          pluginId: "contrib-plugin",
          contribution: { surface: "executor-system", content: "inject" },
          config: {
            enabledByDefault: true,
            contributions: [{ surface: "executor-system", content: "inject" }],
          },
        },
      ]);
      expect(loader.getPluginSetupInfo()).toEqual([
        {
          pluginId: "contrib-plugin",
          manifest: { binaryName: "agent-browser", description: "Binary" },
          hooks: { checkSetup },
        },
      ]);
    });

    it("getPluginWorkflowStepTemplates maps multiple plugins with prefixed ids", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      (loader as any).plugins.set("alpha", {
        manifest: makeManifest({ id: "alpha" }),
        state: "started",
        hooks: {},
        workflowSteps: [{ stepId: "one", name: "One", description: "First", mode: "script", scriptName: "check" }],
      } as FusionPlugin);
      (loader as any).plugins.set("beta", {
        manifest: makeManifest({ id: "beta" }),
        state: "started",
        hooks: {},
        workflowSteps: [{ stepId: "two", name: "Two", description: "Second", mode: "prompt" }],
      } as FusionPlugin);

      expect(loader.getPluginWorkflowStepTemplates()).toEqual([
        {
          pluginId: "alpha",
          template: expect.objectContaining({
            id: "plugin:alpha:one",
            name: "One",
            description: "First",
            prompt: "",
            category: "Plugin",
            icon: "puzzle",
          }),
        },
        {
          pluginId: "beta",
          template: expect.objectContaining({
            id: "plugin:beta:two",
            name: "Two",
            description: "Second",
            prompt: "",
            category: "Plugin",
            icon: "puzzle",
          }),
        },
      ]);
    });

    it("stopped or unloaded plugins are not included", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      (loader as any).plugins.set("started-plugin", {
        manifest: makeManifest({ id: "started-plugin" }),
        state: "started",
        hooks: {},
        skills: [{ skillId: "a", name: "A", description: "A", skillFiles: ["./a.md"] }],
      } as FusionPlugin);
      (loader as any).plugins.set("stopped-plugin", {
        manifest: makeManifest({ id: "stopped-plugin" }),
        state: "stopped",
        hooks: {},
        skills: [{ skillId: "b", name: "B", description: "B", skillFiles: ["./b.md"] }],
      } as FusionPlugin);

      const filtered = loader.getPluginSkills().filter((entry) => {
        const plugin = loader.getPlugin(entry.pluginId);
        return plugin?.state === "started";
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].pluginId).toBe("started-plugin");

      (loader as any).plugins.delete("stopped-plugin");
      expect(loader.getPluginSkills().map((entry) => entry.pluginId)).toEqual(["started-plugin"]);
    });
  });

  describe("plugin setup lifecycle", () => {
    it("checkPluginSetup returns installed for plugins without setup", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      (loader as any).plugins.set("plain-plugin", {
        manifest: makeManifest({ id: "plain-plugin" }),
        state: "started",
        hooks: {},
      } as FusionPlugin);

      await expect(loader.checkPluginSetup("plain-plugin")).resolves.toEqual({ status: "installed" });
    });

    it("checkPluginSetup throws when plugin is not loaded", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      await expect(loader.checkPluginSetup("missing-plugin")).rejects.toThrow('Plugin "missing-plugin" is not loaded');
    });

    it("checkPluginSetup calls hook and returns result", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      const checkSetup = vi.fn().mockResolvedValue({ status: "installed", version: "1.2.3", binaryPath: "/bin/agent-browser" });
      (loader as any).plugins.set("setup-plugin", {
        manifest: makeManifest({ id: "setup-plugin" }),
        state: "started",
        hooks: {},
        setup: {
          manifest: { binaryName: "agent-browser", description: "Binary" },
          hooks: { checkSetup },
        },
      } as FusionPlugin);

      await expect(loader.checkPluginSetup("setup-plugin")).resolves.toEqual({
        status: "installed",
        version: "1.2.3",
        binaryPath: "/bin/agent-browser",
      });
      expect(checkSetup).toHaveBeenCalledTimes(1);
    });

    it("checkPluginSetup returns error status when hook throws", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      const checkSetup = vi.fn().mockRejectedValue(new Error("probe failed"));
      (loader as any).plugins.set("error-setup-plugin", {
        manifest: makeManifest({ id: "error-setup-plugin" }),
        state: "started",
        hooks: {},
        setup: { manifest: { binaryName: "agent-browser", description: "Binary" }, hooks: { checkSetup } },
      } as FusionPlugin);

      await expect(loader.checkPluginSetup("error-setup-plugin")).resolves.toEqual({ status: "error", error: "probe failed" });
    });

    it("checkPluginSetup returns error status when hook times out", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      vi.useFakeTimers();
      const checkSetup = vi.fn().mockImplementation(() => new Promise(() => undefined));
      (loader as any).plugins.set("timeout-setup-plugin", {
        manifest: makeManifest({ id: "timeout-setup-plugin" }),
        state: "started",
        hooks: {},
        setup: {
          manifest: { binaryName: "agent-browser", description: "Binary", defaultTimeoutMs: 5 },
          hooks: { checkSetup },
        },
      } as FusionPlugin);

      const resultPromise = loader.checkPluginSetup("timeout-setup-plugin");
      await vi.advanceTimersByTimeAsync(6);
      await expect(resultPromise).resolves.toEqual({
        status: "error",
        error: 'Setup check for "timeout-setup-plugin" timed out after 5ms',
      });
      vi.useRealTimers();
    });

    it("checkPluginSetup respects manifest defaultTimeoutMs", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      vi.useFakeTimers();
      const checkSetup = vi.fn().mockImplementation(() => new Promise(() => undefined));
      (loader as any).plugins.set("custom-timeout-setup-plugin", {
        manifest: makeManifest({ id: "custom-timeout-setup-plugin" }),
        state: "started",
        hooks: {},
        setup: {
          manifest: { binaryName: "agent-browser", description: "Binary", defaultTimeoutMs: 12 },
          hooks: { checkSetup },
        },
      } as FusionPlugin);

      const resultPromise = loader.checkPluginSetup("custom-timeout-setup-plugin");
      await vi.advanceTimersByTimeAsync(11);
      expect(checkSetup).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(resultPromise).resolves.toEqual({
        status: "error",
        error: 'Setup check for "custom-timeout-setup-plugin" timed out after 12ms',
      });
      vi.useRealTimers();
    });

    it("installPluginSetup calls install hook", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      const install = vi.fn().mockResolvedValue(undefined);
      (loader as any).plugins.set("install-plugin", {
        manifest: makeManifest({ id: "install-plugin" }),
        state: "started",
        hooks: {},
        setup: {
          manifest: { binaryName: "agent-browser", description: "Binary" },
          hooks: { checkSetup: vi.fn().mockResolvedValue({ status: "installed" }), install },
        },
      } as FusionPlugin);

      await expect(loader.installPluginSetup("install-plugin")).resolves.toBeUndefined();
      expect(install).toHaveBeenCalledTimes(1);
    });

    it("installPluginSetup throws when plugin has no install hook", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      (loader as any).plugins.set("no-install-plugin", {
        manifest: makeManifest({ id: "no-install-plugin" }),
        state: "started",
        hooks: {},
        setup: { manifest: { binaryName: "agent-browser", description: "Binary" }, hooks: { checkSetup: vi.fn() } },
      } as FusionPlugin);

      await expect(loader.installPluginSetup("no-install-plugin")).rejects.toThrow('Plugin "no-install-plugin" has no install hook');
    });

    it("installPluginSetup throws when plugin is not loaded", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      await expect(loader.installPluginSetup("missing-install-plugin")).rejects.toThrow('Plugin "missing-install-plugin" is not loaded');
    });

    it("installPluginSetup throws on timeout", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      vi.useFakeTimers();
      const install = vi.fn().mockImplementation(() => new Promise(() => undefined));
      (loader as any).plugins.set("timeout-install-plugin", {
        manifest: makeManifest({ id: "timeout-install-plugin" }),
        state: "started",
        hooks: {},
        setup: {
          manifest: { binaryName: "agent-browser", description: "Binary", defaultTimeoutMs: 5 },
          hooks: { checkSetup: vi.fn(), install },
        },
      } as FusionPlugin);

      const installPromise = loader.installPluginSetup("timeout-install-plugin");
      const installAssertion = expect(installPromise).rejects.toThrow('Install command for "timeout-install-plugin" timed out after 5ms');
      await vi.advanceTimersByTimeAsync(6);
      await installAssertion;
      vi.useRealTimers();
    });

    it("uninstallPluginSetup calls uninstall hook", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      const uninstall = vi.fn().mockResolvedValue(undefined);
      (loader as any).plugins.set("uninstall-plugin", {
        manifest: makeManifest({ id: "uninstall-plugin" }),
        state: "started",
        hooks: {},
        setup: {
          manifest: { binaryName: "agent-browser", description: "Binary" },
          hooks: { checkSetup: vi.fn().mockResolvedValue({ status: "installed" }), uninstall },
        },
      } as FusionPlugin);

      await expect(loader.uninstallPluginSetup("uninstall-plugin")).resolves.toBeUndefined();
      expect(uninstall).toHaveBeenCalledTimes(1);
    });

    it("uninstallPluginSetup returns silently when no uninstall hook", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      (loader as any).plugins.set("no-uninstall-plugin", {
        manifest: makeManifest({ id: "no-uninstall-plugin" }),
        state: "started",
        hooks: {},
        setup: { manifest: { binaryName: "agent-browser", description: "Binary" }, hooks: { checkSetup: vi.fn() } },
      } as FusionPlugin);

      await expect(loader.uninstallPluginSetup("no-uninstall-plugin")).resolves.toBeUndefined();
    });

    it("uninstallPluginSetup respects timeout", async () => {
      await pluginStore.init();
      loader = new PluginLoader({ pluginStore, taskStore: mockTaskStore });
      vi.useFakeTimers();
      const uninstall = vi.fn().mockImplementation(() => new Promise(() => undefined));
      (loader as any).plugins.set("timeout-uninstall-plugin", {
        manifest: makeManifest({ id: "timeout-uninstall-plugin" }),
        state: "started",
        hooks: {},
        setup: {
          manifest: { binaryName: "agent-browser", description: "Binary", defaultTimeoutMs: 5 },
          hooks: { checkSetup: vi.fn(), uninstall },
        },
      } as FusionPlugin);

      const uninstallPromise = loader.uninstallPluginSetup("timeout-uninstall-plugin");
      const uninstallAssertion = expect(uninstallPromise).rejects.toThrow('Uninstall command for "timeout-uninstall-plugin" timed out after 5ms');
      await vi.advanceTimersByTimeAsync(6);
      await uninstallAssertion;
      vi.useRealTimers();
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
