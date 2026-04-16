import { describe, it, expect, beforeAll } from "vitest";
import { definePlugin } from "./index.js";
import type { FusionPlugin } from "../../core/src/plugin-types.js";
import type { TaskStore } from "../../core/src/store.js";
import { validatePluginManifest } from "../../core/src/plugin-types.js";

let validateFn: typeof validatePluginManifest;

beforeAll(async () => {
  validateFn = validatePluginManifest;
});

describe("Plugin SDK", () => {
  // ── definePlugin ────────────────────────────────────────────────────

  describe("definePlugin", () => {
    it("returns the input unchanged (identity function)", () => {
      const plugin = {
        manifest: {
          id: "test-plugin",
          name: "Test Plugin",
          version: "1.0.0",
        },
        state: "installed" as const,
        hooks: {},
        tools: [],
        routes: [],
      };

      const result = definePlugin(plugin);

      expect(result).toBe(plugin);
    });

    it("provides type narrowing for plugin definitions", () => {
      // This test verifies that definePlugin provides proper TypeScript inference
      const plugin = definePlugin({
        manifest: {
          id: "my-plugin",
          name: "My Plugin",
          version: "1.0.0",
          description: "A test plugin",
        },
        state: "installed",
        hooks: {
          onLoad: async (ctx) => {
            ctx.logger.info("Loaded!");
          },
        },
        tools: [
          {
            name: "my_tool",
            description: "A useful tool",
            parameters: {},
            execute: async (_params, _ctx) => ({
              content: [{ type: "text" as const, text: "Hello!" }],
            }),
          },
        ],
        routes: [],
      });

      expect(plugin.manifest.id).toBe("my-plugin");
      expect(plugin.manifest.name).toBe("My Plugin");
      expect(plugin.hooks.onLoad).toBeDefined();
      expect(plugin.tools).toHaveLength(1);
      expect(plugin.tools![0].name).toBe("my_tool");
    });

    it("works with minimal plugin definition", () => {
      const plugin = definePlugin({
        manifest: {
          id: "minimal",
          name: "Minimal",
          version: "0.1.0",
        },
        state: "installed",
        hooks: {},
        tools: [],
        routes: [],
      });

      expect(plugin.manifest.id).toBe("minimal");
    });

    it("preserves all plugin properties", () => {
      const plugin = definePlugin({
        manifest: {
          id: "full-plugin",
          name: "Full Plugin",
          version: "2.0.0",
          description: "A full-featured plugin",
          author: "Test Author",
          homepage: "https://example.com",
          fusionVersion: "1.0.0",
          dependencies: ["other-plugin"],
          settingsSchema: {
            apiKey: {
              type: "string" as const,
              required: true,
            },
          },
        },
        state: "installed",
        hooks: {
          onLoad: async () => {},
          onUnload: async () => {},
          onTaskCreated: async () => {},
          onTaskMoved: async () => {},
          onTaskCompleted: async () => {},
          onError: async () => {},
        },
        tools: [
          {
            name: "tool1",
            description: "Tool 1",
            parameters: {},
            execute: async () => ({ content: [] }),
          },
        ],
        routes: [
          {
            method: "GET" as const,
            path: "/status",
            handler: async () => ({ status: "ok" }),
            description: "Health check",
          },
        ],
      });

      expect(plugin.manifest.id).toBe("full-plugin");
      expect(plugin.manifest.description).toBe("A full-featured plugin");
      expect(plugin.manifest.author).toBe("Test Author");
      expect(plugin.manifest.homepage).toBe("https://example.com");
      expect(plugin.manifest.fusionVersion).toBe("1.0.0");
      expect(plugin.manifest.dependencies).toEqual(["other-plugin"]);
      expect(plugin.manifest.settingsSchema).toBeDefined();
      expect(plugin.hooks.onLoad).toBeDefined();
      expect(plugin.hooks.onUnload).toBeDefined();
      expect(plugin.hooks.onTaskCreated).toBeDefined();
      expect(plugin.hooks.onTaskMoved).toBeDefined();
      expect(plugin.hooks.onTaskCompleted).toBeDefined();
      expect(plugin.hooks.onError).toBeDefined();
      expect(plugin.tools).toHaveLength(1);
      expect(plugin.routes).toHaveLength(1);
    });
  });

  // ── Type exports ────────────────────────────────────────────────────

  describe("type exports", () => {
    it("exports PluginManifest type", () => {
      // This is a compile-time test - if types are exported correctly, this will compile
      const manifest: import("../../core/src/plugin-types.js").PluginManifest = {
        id: "test",
        name: "Test",
        version: "1.0.0",
      };
      expect(manifest.id).toBe("test");
    });

    it("exports FusionPlugin type", () => {
      const plugin: FusionPlugin = {
        manifest: {
          id: "test",
          name: "Test",
          version: "1.0.0",
        },
        state: "installed",
        hooks: {},
        tools: [],
        routes: [],
      };
      expect(plugin.manifest.id).toBe("test");
    });

    it("exports PluginContext type", () => {
      const ctx: import("../../core/src/plugin-types.js").PluginContext = {
        pluginId: "test",
        taskStore: {} as unknown as TaskStore,
        settings: {},
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
        emitEvent: () => {},
      };
      expect(ctx.pluginId).toBe("test");
    });

    it("exports PluginUiSlotDefinition type", () => {
      // This is a compile-time test - if types are exported correctly, this will compile
      const slot: import("../../core/src/plugin-types.js").PluginUiSlotDefinition = {
        slotId: "task-detail-tab",
        label: "Task Details",
        icon: "FileText",
        componentPath: "./components/TaskDetailTab.js",
      };
      expect(slot.slotId).toBe("task-detail-tab");
      expect(slot.label).toBe("Task Details");
      expect(slot.icon).toBe("FileText");
      expect(slot.componentPath).toBe("./components/TaskDetailTab.js");
    });

    it("PluginUiSlotDefinition icon is optional", () => {
      // This is a compile-time test - if types are exported correctly, this will compile
      const slot: import("../../core/src/plugin-types.js").PluginUiSlotDefinition = {
        slotId: "header-action",
        label: "Header Action",
        componentPath: "./components/HeaderAction.js",
      };
      expect(slot.slotId).toBe("header-action");
      expect((slot as any).icon).toBeUndefined();
    });

    it("PluginUiSlotDefinition can be used in FusionPlugin", () => {
      // This verifies that PluginUiSlotDefinition can be used in the FusionPlugin interface
      const plugin: FusionPlugin = {
        manifest: {
          id: "test",
          name: "Test",
          version: "1.0.0",
        },
        state: "installed",
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
      };
      expect(plugin.uiSlots).toHaveLength(1);
      expect(plugin.uiSlots![0].slotId).toBe("custom-tab");
    });
  });

  // ── validatePluginManifest ───────────────────────────────────────────

  describe("validatePluginManifest", () => {
    it("validates a valid manifest", () => {
      const result = validateFn({
        id: "valid-plugin",
        name: "Valid Plugin",
        version: "1.0.0",
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects invalid manifest", () => {
      const result = validateFn({
        id: "",
        name: "",
        version: "",
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
