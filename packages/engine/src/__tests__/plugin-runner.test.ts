/**
 * PluginRunner Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PluginRunner, type PluginRunnerOptions } from "../plugin-runner.js";
import type { PluginLoader, PluginStore } from "@fusion/core";
import type { FusionPlugin, PluginToolDefinition, PluginRouteDefinition } from "@fusion/core";

const loggerSpies = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  executorLog: vi.fn(),
  executorWarn: vi.fn(),
  executorError: vi.fn(),
}));

// Mock the logger to suppress output during tests
vi.mock("../logger.js", () => ({
  createLogger: () => ({
    log: loggerSpies.log,
    warn: loggerSpies.warn,
    error: loggerSpies.error,
  }),
  executorLog: {
    log: loggerSpies.executorLog,
    warn: loggerSpies.executorWarn,
    error: loggerSpies.executorError,
  },
}));

describe("PluginRunner", () => {
  let mockPluginLoader: {
    loadAllPlugins: ReturnType<typeof vi.fn>;
    stopAllPlugins: ReturnType<typeof vi.fn>;
    invokeHook: ReturnType<typeof vi.fn>;
    getPluginTools: ReturnType<typeof vi.fn>;
    getPluginRoutes: ReturnType<typeof vi.fn>;
    getLoadedPlugins: ReturnType<typeof vi.fn>;
    getPlugin: ReturnType<typeof vi.fn>;
    loadPlugin: ReturnType<typeof vi.fn>;
    stopPlugin: ReturnType<typeof vi.fn>;
    reloadPlugin: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
  let mockPluginStore: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    getPlugin: ReturnType<typeof vi.fn>;
  };
  let mockTaskStore: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    getTask: ReturnType<typeof vi.fn>;
  };
  let pluginRunner: PluginRunner;

  const createMockPlugin = (overrides: Partial<FusionPlugin> = {}): FusionPlugin => ({
    manifest: {
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
    },
    state: "started",
    hooks: {},
    ...overrides,
  });

  beforeEach(() => {
    // Create fresh mocks for each test
    mockPluginLoader = {
      loadAllPlugins: vi.fn().mockResolvedValue({ loaded: 2, errors: 0 }),
      stopAllPlugins: vi.fn().mockResolvedValue(undefined),
      invokeHook: vi.fn().mockResolvedValue(undefined),
      getPluginTools: vi.fn().mockReturnValue([]),
      getPluginRoutes: vi.fn().mockReturnValue([]),
      getLoadedPlugins: vi.fn().mockReturnValue([]),
      getPlugin: vi.fn(),
      loadPlugin: vi.fn().mockResolvedValue({}),
      stopPlugin: vi.fn().mockResolvedValue(undefined),
      reloadPlugin: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      off: vi.fn(),
    };

    const mockOn = vi.fn();
    const mockOff = vi.fn();
    mockTaskStore = {
      on: mockOn,
      off: mockOff,
      getTask: vi.fn(),
    };

    mockPluginStore = {
      on: mockOn,
      off: mockOff,
      getPlugin: vi.fn().mockResolvedValue({
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        settings: {},
        settingsSchema: undefined,
      }),
    };

    pluginRunner = new PluginRunner({
      pluginLoader: mockPluginLoader as unknown as PluginLoader,
      pluginStore: mockPluginStore as unknown as PluginStore,
      taskStore: mockTaskStore as any,
      rootDir: "/test/project",
      hookTimeoutMs: 5000,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("init()", () => {
    it("should call loadAllPlugins on the loader", async () => {
      await pluginRunner.init();
      expect(mockPluginLoader.loadAllPlugins).toHaveBeenCalledTimes(1);
    });

    it("should subscribe to task store events", async () => {
      await pluginRunner.init();
      // Should have subscribed to task:created and task:moved
      expect(mockTaskStore.on).toHaveBeenCalledWith("task:created", expect.any(Function));
      expect(mockTaskStore.on).toHaveBeenCalledWith("task:moved", expect.any(Function));
    });

    it("should subscribe to plugin store events for cache invalidation", async () => {
      await pluginRunner.init();
      expect(mockPluginStore.on).toHaveBeenCalledWith("plugin:stateChanged", expect.any(Function));
      expect(mockPluginStore.on).toHaveBeenCalledWith("plugin:updated", expect.any(Function));
    });
  });

  describe("shutdown()", () => {
    it("should call stopAllPlugins on the loader", async () => {
      await pluginRunner.shutdown();
      expect(mockPluginLoader.stopAllPlugins).toHaveBeenCalledTimes(1);
    });

    it("should unsubscribe from store events", async () => {
      await pluginRunner.shutdown();
      expect(mockTaskStore.off).toHaveBeenCalledWith("task:created", expect.any(Function));
      expect(mockTaskStore.off).toHaveBeenCalledWith("task:moved", expect.any(Function));
    });
  });

  describe("invokeHook()", () => {
    it("should delegate to pluginLoader.invokeHook", async () => {
      await pluginRunner.init();
      await pluginRunner.invokeHook("onTaskCreated", { id: "FN-001" } as any);

      expect(mockPluginLoader.invokeHook).toHaveBeenCalledWith("onTaskCreated", { id: "FN-001" });
    });

    it("should pass all arguments to the hook", async () => {
      await pluginRunner.init();
      const task = { id: "FN-001" } as any;
      const from = "todo";
      const to = "in-progress";

      await pluginRunner.invokeHook("onTaskMoved", task, from, to);

      expect(mockPluginLoader.invokeHook).toHaveBeenCalledWith("onTaskMoved", task, from, to);
    });
  });

  describe("getPluginTools()", () => {
    it("should return empty array when no plugins have tools", async () => {
      await pluginRunner.init();
      const tools = pluginRunner.getPluginTools();
      expect(tools).toEqual([]);
    });

    it("should return converted tools from loaded plugins", async () => {
      const executeFn = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "result" }],
      });

      const pluginTool: PluginToolDefinition = {
        name: "testTool",
        description: "A test tool",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string" },
          },
        },
        execute: executeFn,
      };

      const plugin = createMockPlugin({
        manifest: { id: "test-plugin", name: "Test Plugin", version: "1.0.0" },
        tools: [pluginTool],
      });

      mockPluginLoader.getLoadedPlugins.mockReturnValue([plugin]);
      mockPluginLoader.getPluginTools.mockReturnValue([pluginTool]);
      mockPluginLoader.getPlugin.mockReturnValue(plugin);

      await pluginRunner.init();
      const tools = pluginRunner.getPluginTools();

      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe("plugin_testTool");
      expect(tools[0].label).toBe("testTool");
      expect(tools[0].description).toBe("A test tool");
    });

    it("should wrap execute function correctly", async () => {
      const executeFn = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "test result" }],
        isError: false,
      });

      const pluginTool: PluginToolDefinition = {
        name: "testTool",
        description: "A test tool",
        parameters: { type: "object", properties: {} },
        execute: executeFn,
      };

      const plugin = createMockPlugin({
        manifest: { id: "test-plugin", name: "Test Plugin", version: "1.0.0" },
        tools: [pluginTool],
      });

      mockPluginLoader.getLoadedPlugins.mockReturnValue([plugin]);
      mockPluginLoader.getPluginTools.mockReturnValue([pluginTool]);
      mockPluginLoader.getPlugin.mockReturnValue(plugin);

      await pluginRunner.init();
      const tools = pluginRunner.getPluginTools();

      // Call the wrapped execute
      const result = await tools[0].execute(
        "tool-call-1",
        { input: "test" },
        undefined,
        undefined,
        {} as any,
      );

      expect(executeFn).toHaveBeenCalledWith(
        { input: "test" },
        expect.objectContaining({
          pluginId: "test-plugin",
          taskStore: mockTaskStore,
        }),
      );

      expect(result).toEqual({
        content: [{ type: "text", text: "test result" }],
        isError: false,
        details: {},
      });
    });

    it("should fall back to empty settings when plugin store lookup fails", async () => {
      const executeFn = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      });

      const pluginTool: PluginToolDefinition = {
        name: "testTool",
        description: "A test tool",
        parameters: { type: "object", properties: {} },
        execute: executeFn,
      };

      const plugin = createMockPlugin({
        manifest: { id: "test-plugin", name: "Test Plugin", version: "1.0.0" },
        tools: [pluginTool],
      });

      mockPluginStore.getPlugin.mockRejectedValue(new Error("Plugin lookup failed"));
      mockPluginLoader.getLoadedPlugins.mockReturnValue([plugin]);
      mockPluginLoader.getPluginTools.mockReturnValue([pluginTool]);
      mockPluginLoader.getPlugin.mockReturnValue(plugin);

      await pluginRunner.init();
      const tools = pluginRunner.getPluginTools();

      await expect(
        tools[0].execute("tool-call-1", { input: "test" }, undefined, undefined, {} as any),
      ).resolves.toEqual({
        content: [{ type: "text", text: "ok" }],
        isError: false,
        details: {},
      });

      expect(executeFn).toHaveBeenCalledWith(
        { input: "test" },
        expect.objectContaining({
          pluginId: "test-plugin",
          settings: {},
        }),
      );
      expect(loggerSpies.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to get settings for plugin test-plugin: Plugin lookup failed"),
      );
    });

    it("should invalidate cache when plugin state changes", async () => {
      const pluginTool: PluginToolDefinition = {
        name: "testTool",
        description: "A test tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn().mockResolvedValue({ content: [] }),
      };

      const plugin = createMockPlugin({
        manifest: { id: "test-plugin", name: "Test Plugin", version: "1.0.0" },
        tools: [pluginTool],
      });

      mockPluginLoader.getLoadedPlugins.mockReturnValue([plugin]);
      mockPluginLoader.getPluginTools.mockReturnValue([pluginTool]);
      mockPluginLoader.getPlugin.mockReturnValue(plugin);

      await pluginRunner.init();

      // First call caches the tools
      const tools1 = pluginRunner.getPluginTools();

      // Simulate plugin state change
      const stateChangeHandler = mockPluginStore.on.mock.calls.find(
        (call) => call[0] === "plugin:stateChanged",
      )?.[1];
      stateChangeHandler?.();

      // Second call should rebuild cache
      mockPluginLoader.getPluginTools.mockReturnValue([pluginTool]);
      const tools2 = pluginRunner.getPluginTools();

      // Both should return tools (cache was rebuilt)
      expect(tools1.length).toBe(1);
      expect(tools2.length).toBe(1);
    });
  });

  describe("getPluginRoutes()", () => {
    it("should return routes from the loader", async () => {
      const routes: Array<{ pluginId: string; route: PluginRouteDefinition }> = [
        {
          pluginId: "test-plugin",
          route: {
            method: "GET",
            path: "/status",
            handler: vi.fn(),
          },
        },
      ];

      mockPluginLoader.getPluginRoutes.mockReturnValue(routes);

      await pluginRunner.init();
      const result = pluginRunner.getPluginRoutes();

      expect(result).toEqual(routes);
      expect(mockPluginLoader.getPluginRoutes).toHaveBeenCalledTimes(1);
    });

    it("should return empty array when no routes", async () => {
      await pluginRunner.init();
      const result = pluginRunner.getPluginRoutes();
      expect(result).toEqual([]);
    });
  });

  describe("getLoader() / getStore()", () => {
    it("should return the plugin loader", () => {
      expect(pluginRunner.getLoader()).toBe(mockPluginLoader);
    });

    it("should return the plugin store", () => {
      expect(pluginRunner.getStore()).toBe(mockPluginStore);
    });
  });

  describe("task lifecycle hooks", () => {
    it("should invoke onTaskCreated when task:created event fires", async () => {
      await pluginRunner.init();

      // Find the task:created handler
      const createdHandler = mockTaskStore.on.mock.calls.find(
        (call) => call[0] === "task:created",
      )?.[1] as (task: any) => void;

      const mockTask = { id: "FN-001", title: "Test Task" };
      createdHandler?.(mockTask);

      // Give async handler time to run
      await new Promise((r) => setTimeout(r, 10));

      expect(mockPluginLoader.invokeHook).toHaveBeenCalledWith("onTaskCreated", mockTask);
    });

    it("should invoke onTaskMoved when task:moved event fires", async () => {
      await pluginRunner.init();

      const movedHandler = mockTaskStore.on.mock.calls.find(
        (call) => call[0] === "task:moved",
      )?.[1] as (event: any) => void;

      const event = { task: { id: "FN-001" }, from: "todo", to: "in-progress" };
      movedHandler?.(event);

      await new Promise((r) => setTimeout(r, 10));

      expect(mockPluginLoader.invokeHook).toHaveBeenCalledWith("onTaskMoved", event.task, event.from, event.to);
    });

    it("should invoke onTaskCompleted when task moves to done", async () => {
      await pluginRunner.init();

      const movedHandler = mockTaskStore.on.mock.calls.find(
        (call) => call[0] === "task:moved",
      )?.[1] as (event: any) => void;

      const event = { task: { id: "FN-001" }, from: "in-progress", to: "done" };
      movedHandler?.(event);

      await new Promise((r) => setTimeout(r, 10));

      expect(mockPluginLoader.invokeHook).toHaveBeenCalledWith("onTaskCompleted", event.task);
    });
  });

  describe("hook timeout", () => {
    it("should handle slow hooks with timeout", async () => {
      // Create a runner with a short timeout
      const slowMockLoader = {
        ...mockPluginLoader,
        invokeHook: vi.fn().mockImplementation(async () => {
          // Simulate slow hook
          await new Promise((r) => setTimeout(r, 100));
        }),
      };

      const runner = new PluginRunner({
        pluginLoader: slowMockLoader as unknown as PluginLoader,
        pluginStore: mockPluginStore as unknown as PluginStore,
        taskStore: mockTaskStore as any,
        rootDir: "/test/project",
        hookTimeoutMs: 50, // Very short timeout
      });

      await runner.init();

      // The invokeHook should complete (the slow plugin's error is logged but not thrown)
      await expect(runner.invokeHook("onTaskCreated", {})).resolves.not.toThrow();
    });

    it("should warn when invokeHookSafe times out", async () => {
      const slowMockLoader = {
        ...mockPluginLoader,
        invokeHook: vi.fn().mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 100));
        }),
      };

      const runner = new PluginRunner({
        pluginLoader: slowMockLoader as unknown as PluginLoader,
        pluginStore: mockPluginStore as unknown as PluginStore,
        taskStore: mockTaskStore as any,
        rootDir: "/test/project",
        hookTimeoutMs: 50,
      });

      await runner.init();

      const createdHandler = mockTaskStore.on.mock.calls.find(
        (call) => call[0] === "task:created",
      )?.[1] as (task: any) => void;

      expect(() => createdHandler?.({ id: "FN-001" })).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(loggerSpies.warn).toHaveBeenCalledWith(
        expect.stringContaining("Hook onTaskCreated failed: Hook onTaskCreated timed out"),
      );
    });
  });

  describe("Hot-load via store events", () => {
    it("should auto-load plugin when plugin:enabled event fires", async () => {
      await pluginRunner.init();

      // Find the plugin:enabled handler
      const enabledHandler = mockPluginStore.on.mock.calls.find(
        (call) => call[0] === "plugin:enabled",
      )?.[1] as (plugin: any) => void;

      // Simulate plugin:enabled event
      await enabledHandler?.({ id: "test-plugin", name: "Test Plugin", version: "1.0.0" });

      // Should have called loadPlugin
      expect(mockPluginLoader.loadPlugin).toHaveBeenCalledWith("test-plugin");
    });

    it("should auto-stop plugin when plugin:disabled event fires", async () => {
      await pluginRunner.init();

      // Find the plugin:disabled handler
      const disabledHandler = mockPluginStore.on.mock.calls.find(
        (call) => call[0] === "plugin:disabled",
      )?.[1] as (plugin: any) => void;

      // Simulate plugin:disabled event
      await disabledHandler?.({ id: "test-plugin", name: "Test Plugin", version: "1.0.0" });

      // Should have called stopPlugin
      expect(mockPluginLoader.stopPlugin).toHaveBeenCalledWith("test-plugin");
    });

    it("should stop plugin when plugin:unregistered event fires", async () => {
      await pluginRunner.init();

      // Find the plugin:unregistered handler
      const unregisteredHandler = mockPluginStore.on.mock.calls.find(
        (call) => call[0] === "plugin:unregistered",
      )?.[1] as (plugin: any) => void;

      // Simulate plugin:unregistered event
      await unregisteredHandler?.({ id: "test-plugin", name: "Test Plugin", version: "1.0.0" });

      // Should have called stopPlugin
      expect(mockPluginLoader.stopPlugin).toHaveBeenCalledWith("test-plugin");
    });

    it("should warn and isolate errors when unregistered plugin stop fails", async () => {
      await pluginRunner.init();
      mockPluginLoader.stopPlugin.mockRejectedValue(new Error("Plugin already stopped"));

      const unregisteredHandler = mockPluginStore.on.mock.calls.find(
        (call) => call[0] === "plugin:unregistered",
      )?.[1] as (plugin: any) => void;

      await expect(
        unregisteredHandler?.({ id: "test-plugin", name: "Test Plugin", version: "1.0.0" }),
      ).resolves.not.toThrow();

      expect(loggerSpies.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to stop unregistered plugin test-plugin: Plugin already stopped"),
      );
    });

    it("should isolate errors in auto-load", async () => {
      await pluginRunner.init();

      // Make loadPlugin throw
      mockPluginLoader.loadPlugin.mockRejectedValue(new Error("Load failed"));

      // Find the plugin:enabled handler
      const enabledHandler = mockPluginStore.on.mock.calls.find(
        (call) => call[0] === "plugin:enabled",
      )?.[1] as (plugin: any) => void;

      // Should not throw
      await expect(
        enabledHandler?.({ id: "test-plugin", name: "Test Plugin", version: "1.0.0" }),
      ).resolves.not.toThrow();
    });

    it("should isolate errors in auto-stop", async () => {
      await pluginRunner.init();

      // Make stopPlugin throw
      mockPluginLoader.stopPlugin.mockRejectedValue(new Error("Stop failed"));

      // Find the plugin:disabled handler
      const disabledHandler = mockPluginStore.on.mock.calls.find(
        (call) => call[0] === "plugin:disabled",
      )?.[1] as (plugin: any) => void;

      // Should not throw
      await expect(
        disabledHandler?.({ id: "test-plugin", name: "Test Plugin", version: "1.0.0" }),
      ).resolves.not.toThrow();
    });
  });

  describe("reloadPlugin()", () => {
    it("should call pluginLoader.reloadPlugin", async () => {
      await pluginRunner.init();
      await pluginRunner.reloadPlugin("test-plugin");
      expect(mockPluginLoader.reloadPlugin).toHaveBeenCalledWith("test-plugin");
    });

    it("should invalidate caches after reload", async () => {
      const pluginTool: PluginToolDefinition = {
        name: "testTool",
        description: "A test tool",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      };

      const plugin = createMockPlugin({
        manifest: { id: "test-plugin", name: "Test Plugin", version: "1.0.0" },
        tools: [pluginTool],
      });

      mockPluginLoader.getLoadedPlugins.mockReturnValue([plugin]);
      mockPluginLoader.getPluginTools.mockReturnValue([pluginTool]);
      mockPluginLoader.getPlugin.mockReturnValue(plugin);

      await pluginRunner.init();

      // Get tools to build cache
      const tools1 = pluginRunner.getPluginTools();
      expect(tools1.length).toBe(1);

      // Reload
      await pluginRunner.reloadPlugin("test-plugin");

      // Cache should be invalidated, getPluginTools called again
      expect(mockPluginLoader.getPluginTools).toHaveBeenCalled();
    });
  });

  describe("Plugin loader events", () => {
    it("should subscribe to plugin:loaded event", async () => {
      await pluginRunner.init();
      expect(mockPluginLoader.on).toHaveBeenCalledWith("plugin:loaded", expect.any(Function));
    });

    it("should subscribe to plugin:unloaded event", async () => {
      await pluginRunner.init();
      expect(mockPluginLoader.on).toHaveBeenCalledWith("plugin:unloaded", expect.any(Function));
    });

    it("should subscribe to plugin:reloaded event", async () => {
      await pluginRunner.init();
      expect(mockPluginLoader.on).toHaveBeenCalledWith("plugin:reloaded", expect.any(Function));
    });
  });

  describe("Event cleanup on shutdown", () => {
    it("should unsubscribe from plugin store events", async () => {
      await pluginRunner.init();
      await pluginRunner.shutdown();

      expect(mockPluginStore.off).toHaveBeenCalledWith("plugin:enabled", expect.any(Function));
      expect(mockPluginStore.off).toHaveBeenCalledWith("plugin:disabled", expect.any(Function));
      expect(mockPluginStore.off).toHaveBeenCalledWith("plugin:unregistered", expect.any(Function));
      expect(mockPluginStore.off).toHaveBeenCalledWith("plugin:stateChanged", expect.any(Function));
      expect(mockPluginStore.off).toHaveBeenCalledWith("plugin:updated", expect.any(Function));
    });

    it("should unsubscribe from plugin loader events", async () => {
      await pluginRunner.init();
      await pluginRunner.shutdown();

      expect(mockPluginLoader.off).toHaveBeenCalledWith("plugin:loaded", expect.any(Function));
      expect(mockPluginLoader.off).toHaveBeenCalledWith("plugin:unloaded", expect.any(Function));
      expect(mockPluginLoader.off).toHaveBeenCalledWith("plugin:reloaded", expect.any(Function));
    });
  });

  describe("Cache invalidation lifecycle", () => {
    it("should invalidate caches on plugin:loaded event", async () => {
      await pluginRunner.init();

      // Build cache
      mockPluginLoader.getPluginTools.mockReturnValue([]);
      mockPluginLoader.getPluginRoutes.mockReturnValue([]);
      pluginRunner.getPluginTools();
      pluginRunner.getPluginRoutes();

      const initialToolsCalls = mockPluginLoader.getPluginTools.mock.calls.length;

      // Find and trigger plugin:loaded handler
      const loadedHandler = mockPluginLoader.on.mock.calls.find(
        (call) => call[0] === "plugin:loaded",
      )?.[1] as (event: any) => void;
      loadedHandler?.({ pluginId: "test-plugin" });

      // Get tools again - should rebuild cache
      mockPluginLoader.getPluginTools.mockReturnValue([]);
      pluginRunner.getPluginTools();

      // Should have called getPluginTools again (cache invalidated and rebuilt)
      expect(mockPluginLoader.getPluginTools.mock.calls.length).toBeGreaterThan(initialToolsCalls);
    });

    it("should invalidate caches on plugin:unloaded event", async () => {
      await pluginRunner.init();

      // Build cache
      mockPluginLoader.getPluginTools.mockReturnValue([]);
      mockPluginLoader.getPluginRoutes.mockReturnValue([]);
      pluginRunner.getPluginTools();
      pluginRunner.getPluginRoutes();

      const initialToolsCalls = mockPluginLoader.getPluginTools.mock.calls.length;

      // Find and trigger plugin:unloaded handler
      const unloadedHandler = mockPluginLoader.on.mock.calls.find(
        (call) => call[0] === "plugin:unloaded",
      )?.[1] as (event: any) => void;
      unloadedHandler?.({ pluginId: "test-plugin" });

      // Get tools again - should rebuild cache
      mockPluginLoader.getPluginTools.mockReturnValue([]);
      pluginRunner.getPluginTools();

      expect(mockPluginLoader.getPluginTools.mock.calls.length).toBeGreaterThan(initialToolsCalls);
    });
  });
});
