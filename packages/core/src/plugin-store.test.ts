import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PluginStore } from "./plugin-store.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PluginManifest, PluginState } from "./plugin-types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-plugin-test-"));
}

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    description: "A test plugin",
    ...overrides,
  };
}

describe("PluginStore", () => {
  let rootDir: string;
  let store: PluginStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    store = new PluginStore(rootDir);
    await store.init();
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  // ── init ──────────────────────────────────────────────────────────

  describe("init", () => {
    it("creates the database file", async () => {
      const dbPath = join(rootDir, ".fusion", "fusion.db");
      const { existsSync } = await import("node:fs");
      expect(existsSync(dbPath)).toBe(true);
    });

    it("is idempotent", async () => {
      await store.init();
      await store.init();
      // Should not throw
      const plugins = await store.listPlugins();
      expect(plugins).toEqual([]);
    });

    it("creates the plugins table", async () => {
      // If the table doesn't exist, listPlugins would fail
      const plugins = await store.listPlugins();
      expect(Array.isArray(plugins)).toBe(true);
    });
  });

  // ── registerPlugin ─────────────────────────────────────────────────

  describe("registerPlugin", () => {
    it("registers a valid plugin and returns full record", async () => {
      const manifest = makeManifest();
      const plugin = await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      expect(plugin.id).toBe("test-plugin");
      expect(plugin.name).toBe("Test Plugin");
      expect(plugin.version).toBe("1.0.0");
      expect(plugin.description).toBe("A test plugin");
      expect(plugin.path).toBe("/path/to/plugin");
      expect(plugin.enabled).toBe(true);
      expect(plugin.state).toBe("installed");
      expect(plugin.settings).toEqual({});
      expect(plugin.dependencies).toEqual([]);
      expect(plugin.createdAt).toBeTruthy();
      expect(plugin.updatedAt).toBeTruthy();
    });

    it("registers plugin with custom settings", async () => {
      const manifest = makeManifest();
      const plugin = await store.registerPlugin({
        manifest,
        path: "/path/to/plugin",
        settings: { apiKey: "secret123", maxItems: 10 },
      });

      expect(plugin.settings).toEqual({ apiKey: "secret123", maxItems: 10 });
    });

    it("registers plugin with dependencies", async () => {
      const manifest = makeManifest({ dependencies: ["other-plugin"] });
      const plugin = await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      expect(plugin.dependencies).toEqual(["other-plugin"]);
    });

    it("registers plugin with settings schema", async () => {
      const manifest = makeManifest({
        settingsSchema: {
          apiKey: { type: "string", required: true },
          count: { type: "number", defaultValue: 5 },
        },
      });
      const plugin = await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      expect(plugin.settingsSchema).toBeTruthy();
      expect(plugin.settingsSchema!.apiKey.type).toBe("string");
      expect(plugin.settingsSchema!.count.defaultValue).toBe(5);
    });

    it("applies default values from settingsSchema when registering", async () => {
      const manifest = makeManifest({
        settingsSchema: {
          apiKey: { type: "string", defaultValue: "default-key" },
          count: { type: "number", defaultValue: 10 },
          enabled: { type: "boolean", defaultValue: true },
        },
      });
      const plugin = await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      // Defaults should be applied
      expect(plugin.settings.apiKey).toBe("default-key");
      expect(plugin.settings.count).toBe(10);
      expect(plugin.settings.enabled).toBe(true);
    });

    it("overrides defaults with explicit settings", async () => {
      const manifest = makeManifest({
        settingsSchema: {
          apiKey: { type: "string", defaultValue: "default-key" },
          count: { type: "number", defaultValue: 10 },
        },
      });
      const plugin = await store.registerPlugin({
        manifest,
        path: "/path/to/plugin",
        settings: { apiKey: "custom-key", count: 20 },
      });

      // Explicit settings should win over defaults
      expect(plugin.settings.apiKey).toBe("custom-key");
      expect(plugin.settings.count).toBe(20);
    });

    it("rejects missing manifest id", async () => {
      const manifest = makeManifest({ id: "" });
      await expect(
        store.registerPlugin({ manifest, path: "/path/to/plugin" }),
      ).rejects.toThrow("Invalid plugin manifest");
    });

    it("rejects missing manifest name", async () => {
      const manifest = makeManifest({ name: "" });
      await expect(
        store.registerPlugin({ manifest, path: "/path/to/plugin" }),
      ).rejects.toThrow("Invalid plugin manifest");
    });

    it("rejects missing manifest version", async () => {
      const manifest = makeManifest({ version: "" });
      await expect(
        store.registerPlugin({ manifest, path: "/path/to/plugin" }),
      ).rejects.toThrow("Invalid plugin manifest");
    });

    it("rejects invalid id format (uppercase)", async () => {
      const manifest = makeManifest({ id: "Test-Plugin" });
      await expect(
        store.registerPlugin({ manifest, path: "/path/to/plugin" }),
      ).rejects.toThrow("Invalid plugin manifest");
    });

    it("rejects invalid id format (underscores)", async () => {
      const manifest = makeManifest({ id: "test_plugin" });
      await expect(
        store.registerPlugin({ manifest, path: "/path/to/plugin" }),
      ).rejects.toThrow("Invalid plugin manifest");
    });

    it("rejects invalid id format (starts with hyphen)", async () => {
      const manifest = makeManifest({ id: "-test-plugin" });
      await expect(
        store.registerPlugin({ manifest, path: "/path/to/plugin" }),
      ).rejects.toThrow("Invalid plugin manifest");
    });

    it("rejects empty path", async () => {
      const manifest = makeManifest({ id: "valid-plugin" });
      await expect(
        store.registerPlugin({ manifest, path: "" }),
      ).rejects.toThrow("Plugin path is required");
    });

    it("rejects duplicate plugin id", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin1" });

      await expect(
        store.registerPlugin({ manifest, path: "/path/to/plugin2" }),
      ).rejects.toThrow("already registered");
    });

    it("emits plugin:registered event", async () => {
      const listener = vi.fn();
      store.on("plugin:registered", listener);

      const manifest = makeManifest({ id: "event-plugin" });
      const plugin = await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      expect(listener).toHaveBeenCalledWith(plugin);
    });
  });

  // ── unregisterPlugin ─────────────────────────────────────────────

  describe("unregisterPlugin", () => {
    it("removes a registered plugin", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      const removed = await store.unregisterPlugin("test-plugin");
      expect(removed.id).toBe("test-plugin");

      await expect(store.getPlugin("test-plugin")).rejects.toThrow("not found");
    });

    it("throws on non-existent plugin", async () => {
      await expect(store.unregisterPlugin("nonexistent")).rejects.toThrow(
        "not found",
      );
    });

    it("emits plugin:unregistered event", async () => {
      const listener = vi.fn();
      store.on("plugin:unregistered", listener);

      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });
      await store.unregisterPlugin("test-plugin");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].id).toBe("test-plugin");
    });
  });

  // ── getPlugin ────────────────────────────────────────────────────

  describe("getPlugin", () => {
    it("returns registered plugin", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      const plugin = await store.getPlugin("test-plugin");
      expect(plugin.id).toBe("test-plugin");
      expect(plugin.name).toBe("Test Plugin");
    });

    it("throws ENOENT on non-existent plugin", async () => {
      await expect(store.getPlugin("nonexistent")).rejects.toThrow("not found");
    });
  });

  // ── listPlugins ──────────────────────────────────────────────────

  describe("listPlugins", () => {
    it("returns all registered plugins", async () => {
      await store.registerPlugin({
        manifest: makeManifest({ id: "plugin-a" }),
        path: "/path/a",
      });
      await store.registerPlugin({
        manifest: makeManifest({ id: "plugin-b" }),
        path: "/path/b",
      });

      const plugins = await store.listPlugins();
      expect(plugins).toHaveLength(2);
      expect(plugins.map((p) => p.id).sort()).toEqual(["plugin-a", "plugin-b"]);
    });

    it("filters by enabled status", async () => {
      await store.registerPlugin({
        manifest: makeManifest({ id: "plugin-a" }),
        path: "/path/a",
      });
      const b = await store.registerPlugin({
        manifest: makeManifest({ id: "plugin-b" }),
        path: "/path/b",
      });
      await store.disablePlugin("plugin-a");

      const enabled = await store.listPlugins({ enabled: true });
      expect(enabled).toHaveLength(1);
      expect(enabled[0].id).toBe("plugin-b");

      const disabled = await store.listPlugins({ enabled: false });
      expect(disabled).toHaveLength(1);
      expect(disabled[0].id).toBe("plugin-a");
    });

    it("filters by state", async () => {
      await store.registerPlugin({
        manifest: makeManifest({ id: "plugin-a" }),
        path: "/path/a",
      });
      await store.registerPlugin({
        manifest: makeManifest({ id: "plugin-b" }),
        path: "/path/b",
      });

      // Start plugin-a
      await store.updatePluginState("plugin-a", "started");

      const installed = await store.listPlugins({ state: "installed" });
      expect(installed).toHaveLength(1);
      expect(installed[0].id).toBe("plugin-b");

      const started = await store.listPlugins({ state: "started" });
      expect(started).toHaveLength(1);
      expect(started[0].id).toBe("plugin-a");
    });

    it("returns empty array when no plugins", async () => {
      const plugins = await store.listPlugins();
      expect(plugins).toEqual([]);
    });
  });

  // ── enablePlugin ─────────────────────────────────────────────────

  describe("enablePlugin", () => {
    it("sets enabled to true", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });
      await store.disablePlugin("test-plugin");

      const plugin = await store.enablePlugin("test-plugin");
      expect(plugin.enabled).toBe(true);
    });

    it("emits plugin:enabled event", async () => {
      const listener = vi.fn();
      store.on("plugin:enabled", listener);

      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });
      await store.enablePlugin("test-plugin");

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("emits plugin:updated event", async () => {
      const listener = vi.fn();
      store.on("plugin:updated", listener);

      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });
      await store.enablePlugin("test-plugin");

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ── disablePlugin ────────────────────────────────────────────────

  describe("disablePlugin", () => {
    it("sets enabled to false", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      const plugin = await store.disablePlugin("test-plugin");
      expect(plugin.enabled).toBe(false);
    });

    it("emits plugin:disabled event", async () => {
      const listener = vi.fn();
      store.on("plugin:disabled", listener);

      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });
      await store.disablePlugin("test-plugin");

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ── updatePluginState ────────────────────────────────────────────

  describe("updatePluginState", () => {
    it("updates state to started", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      const plugin = await store.updatePluginState("test-plugin", "started");
      expect(plugin.state).toBe("started");
    });

    it("updates state to stopped", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });
      await store.updatePluginState("test-plugin", "started");

      const plugin = await store.updatePluginState("test-plugin", "stopped");
      expect(plugin.state).toBe("stopped");
    });

    it("updates state to error with message", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      const plugin = await store.updatePluginState(
        "test-plugin",
        "error",
        "Failed to load",
      );
      expect(plugin.state).toBe("error");
      expect(plugin.error).toBe("Failed to load");
    });

    it("allows any state to transition to error", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });
      await store.updatePluginState("test-plugin", "started");

      // installed -> error is valid
      const plugin1 = await store.updatePluginState(
        "test-plugin",
        "error",
        "test",
      );
      expect(plugin1.state).toBe("error");
    });

    it("rejects invalid state transitions", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      // Cannot go from stopped directly back to installed
      await store.updatePluginState("test-plugin", "stopped");
      await expect(
        store.updatePluginState("test-plugin", "installed"),
      ).rejects.toThrow("Invalid state transition");
    });

    it("allows restarting from stopped", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });
      await store.updatePluginState("test-plugin", "started");
      await store.updatePluginState("test-plugin", "stopped");

      const plugin = await store.updatePluginState("test-plugin", "started");
      expect(plugin.state).toBe("started");
    });

    it("emits plugin:stateChanged event", async () => {
      const listener = vi.fn();
      store.on("plugin:stateChanged", listener);

      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });
      await store.updatePluginState("test-plugin", "started");

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].id).toBe("test-plugin");
      expect(listener.mock.calls[0][1]).toBe("installed");
      expect(listener.mock.calls[0][2]).toBe("started");
    });
  });

  // ── updatePluginSettings ─────────────────────────────────────────

  describe("updatePluginSettings", () => {
    it("merges settings", async () => {
      const manifest = makeManifest({
        settingsSchema: {
          apiKey: { type: "string" },
          count: { type: "number", defaultValue: 5 },
        },
      });
      await store.registerPlugin({
        manifest,
        path: "/path/to/plugin",
        settings: { apiKey: "secret123" },
      });

      const plugin = await store.updatePluginSettings("test-plugin", {
        count: 10,
      });

      expect(plugin.settings).toEqual({ apiKey: "secret123", count: 10 });
    });

    it("validates required settings", async () => {
      const manifest = makeManifest({
        settingsSchema: {
          apiKey: { type: "string", required: true },
        },
      });
      await store.registerPlugin({
        manifest,
        path: "/path/to/plugin",
        settings: {},
      });

      await expect(
        store.updatePluginSettings("test-plugin", {}),
      ).rejects.toThrow('Setting "apiKey" is required');
    });

    it("validates setting types", async () => {
      const manifest = makeManifest({
        settingsSchema: {
          count: { type: "number" },
        },
      });
      await store.registerPlugin({
        manifest,
        path: "/path/to/plugin",
        settings: {},
      });

      await expect(
        store.updatePluginSettings("test-plugin", { count: "not a number" }),
      ).rejects.toThrow('Setting "count" must be a number');
    });

    it("validates enum values", async () => {
      const manifest = makeManifest({
        settingsSchema: {
          color: { type: "enum", enumValues: ["red", "green", "blue"] },
        },
      });
      await store.registerPlugin({
        manifest,
        path: "/path/to/plugin",
        settings: {},
      });

      await expect(
        store.updatePluginSettings("test-plugin", { color: "yellow" }),
      ).rejects.toThrow('Setting "color" must be one of');
    });

    it("validates password type as string", async () => {
      const manifest = makeManifest({
        settingsSchema: {
          apiSecret: { type: "password" },
        },
      });
      await store.registerPlugin({
        manifest,
        path: "/path/to/plugin",
        settings: {},
      });

      // Valid: string value for password
      const plugin1 = await store.updatePluginSettings("test-plugin", {
        apiSecret: "valid-secret",
      });
      expect(plugin1.settings.apiSecret).toBe("valid-secret");

      // Invalid: non-string value for password
      await expect(
        store.updatePluginSettings("test-plugin", { apiSecret: 12345 }),
      ).rejects.toThrow('Setting "apiSecret" must be a string');
    });

    it("validates array type", async () => {
      const manifest = makeManifest({
        settingsSchema: {
          tags: { type: "array", itemType: "string" },
        },
      });
      await store.registerPlugin({
        manifest,
        path: "/path/to/plugin",
        settings: {},
      });

      // Valid: array of strings
      const plugin1 = await store.updatePluginSettings("test-plugin", {
        tags: ["bug", "feature"],
      });
      expect(plugin1.settings.tags).toEqual(["bug", "feature"]);

      // Invalid: non-array value
      await expect(
        store.updatePluginSettings("test-plugin", { tags: "not-an-array" }),
      ).rejects.toThrow('Setting "tags" must be an array');

      // Invalid: array with wrong item type
      await expect(
        store.updatePluginSettings("test-plugin", { tags: [1, 2, 3] }),
      ).rejects.toThrow('Setting "tags" must be an array of string');
    });

    it("validates number array type", async () => {
      const manifest = makeManifest({
        settingsSchema: {
          scores: { type: "array", itemType: "number" },
        },
      });
      await store.registerPlugin({
        manifest,
        path: "/path/to/plugin",
        settings: {},
      });

      // Valid: array of numbers
      const plugin1 = await store.updatePluginSettings("test-plugin", {
        scores: [10, 20, 30],
      });
      expect(plugin1.settings.scores).toEqual([10, 20, 30]);

      // Invalid: array with wrong item type
      await expect(
        store.updatePluginSettings("test-plugin", { scores: ["a", "b"] }),
      ).rejects.toThrow('Setting "scores" must be an array of number');
    });

    it("emits plugin:updated event", async () => {
      const listener = vi.fn();
      store.on("plugin:updated", listener);

      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });
      await store.updatePluginSettings("test-plugin", { key: "value" });

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // ── updatePlugin ─────────────────────────────────────────────────

  describe("updatePlugin", () => {
    it("updates name", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      const plugin = await store.updatePlugin("test-plugin", { name: "New Name" });
      expect(plugin.name).toBe("New Name");
    });

    it("updates version", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      const plugin = await store.updatePlugin("test-plugin", { version: "2.0.0" });
      expect(plugin.version).toBe("2.0.0");
    });

    it("updates description", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      const plugin = await store.updatePlugin("test-plugin", {
        description: "New description",
      });
      expect(plugin.description).toBe("New description");
    });

    it("updates path", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      const plugin = await store.updatePlugin("test-plugin", {
        path: "/new/path/to/plugin",
      });
      expect(plugin.path).toBe("/new/path/to/plugin");
    });

    it("updates dependencies", async () => {
      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });

      const plugin = await store.updatePlugin("test-plugin", {
        dependencies: ["dep-a", "dep-b"],
      });
      expect(plugin.dependencies).toEqual(["dep-a", "dep-b"]);
    });

    it("emits plugin:updated event", async () => {
      const listener = vi.fn();
      store.on("plugin:updated", listener);

      const manifest = makeManifest();
      await store.registerPlugin({ manifest, path: "/path/to/plugin" });
      await store.updatePlugin("test-plugin", { name: "Updated" });

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
