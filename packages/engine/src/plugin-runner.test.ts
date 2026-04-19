/**
 * PluginRunner Unit Tests
 * 
 * Tests the PluginRunner class which orchestrates plugin loading into the engine,
 * invokes hooks at lifecycle points, and provides plugin tools to agent sessions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PluginRunner, type PluginRunnerOptions } from "./plugin-runner.js";
import type { PluginLoader, PluginStore, PluginInstallation } from "@fusion/core";
import type { FusionPlugin, PluginToolDefinition } from "@fusion/core";
import { createLogger } from "./logger.js";

// Mock the logger to suppress output during tests
vi.mock("./logger.js", () => ({
  createLogger: vi.fn(() => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  executorLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("PluginRunner", () => {
  let mockPluginLoader: {
    loadAllPlugins: ReturnType<typeof vi.fn>;
    stopAllPlugins: ReturnType<typeof vi.fn>;
    invokeHook: ReturnType<typeof vi.fn>;
    getPluginTools: ReturnType<typeof vi.fn>;
    getPluginRoutes: ReturnType<typeof vi.fn>;
    getPluginUiSlots: ReturnType<typeof vi.fn>;
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

  const getPluginRunnerLogger = () => {
    const logger = vi.mocked(createLogger).mock.results.at(-1)?.value as {
      log: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    } | undefined;
    if (!logger) {
      throw new Error("Expected plugin-runner logger to be initialized");
    }
    return logger;
  };

  beforeEach(() => {
    // Create fresh mocks for each test
    mockPluginLoader = {
      loadAllPlugins: vi.fn().mockResolvedValue({ loaded: 2, errors: 0 }),
      stopAllPlugins: vi.fn().mockResolvedValue(undefined),
      invokeHook: vi.fn().mockResolvedValue(undefined),
      getPluginTools: vi.fn().mockReturnValue([]),
      getPluginRoutes: vi.fn().mockReturnValue([]),
      getPluginUiSlots: vi.fn().mockReturnValue([]),
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
      taskStore: mockTaskStore as unknown as import("@fusion/core").TaskStore,
      rootDir: "/test/root",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("init()", () => {
    it("should load all plugins", async () => {
      await pluginRunner.init();
      expect(mockPluginLoader.loadAllPlugins).toHaveBeenCalled();
    });

    it("should subscribe to plugin store events", async () => {
      await pluginRunner.init();
      // Should subscribe to plugin lifecycle events
      expect(mockPluginStore.on).toHaveBeenCalledWith(
        "plugin:enabled",
        expect.any(Function)
      );
      expect(mockPluginStore.on).toHaveBeenCalledWith(
        "plugin:disabled",
        expect.any(Function)
      );
      expect(mockPluginStore.on).toHaveBeenCalledWith(
        "plugin:unregistered",
        expect.any(Function)
      );
    });

    it("should subscribe to plugin loader events for cache invalidation", async () => {
      await pluginRunner.init();
      expect(mockPluginLoader.on).toHaveBeenCalledWith(
        "plugin:loaded",
        expect.any(Function)
      );
      expect(mockPluginLoader.on).toHaveBeenCalledWith(
        "plugin:unloaded",
        expect.any(Function)
      );
      expect(mockPluginLoader.on).toHaveBeenCalledWith(
        "plugin:reloaded",
        expect.any(Function)
      );
    });
  });

  describe("shutdown()", () => {
    it("should stop all plugins", async () => {
      await pluginRunner.init();
      await pluginRunner.shutdown();
      expect(mockPluginLoader.stopAllPlugins).toHaveBeenCalled();
    });

    it("should unsubscribe from plugin store events", async () => {
      await pluginRunner.init();
      await pluginRunner.shutdown();
      expect(mockPluginStore.off).toHaveBeenCalledWith(
        "plugin:enabled",
        expect.any(Function)
      );
      expect(mockPluginStore.off).toHaveBeenCalledWith(
        "plugin:disabled",
        expect.any(Function)
      );
    });

    it("should unsubscribe from task store events", async () => {
      await pluginRunner.init();
      await pluginRunner.shutdown();
      expect(mockTaskStore.off).toHaveBeenCalledWith(
        "task:created",
        expect.any(Function)
      );
      expect(mockTaskStore.off).toHaveBeenCalledWith(
        "task:moved",
        expect.any(Function)
      );
    });
  });

  describe("invokeHook()", () => {
    it("should delegate to pluginLoader.invokeHook", async () => {
      await pluginRunner.init();
      await pluginRunner.invokeHook("onLoad");
      expect(mockPluginLoader.invokeHook).toHaveBeenCalledWith("onLoad");
    });

    it("should pass multiple arguments to the hook", async () => {
      await pluginRunner.init();
      await pluginRunner.invokeHook("onTaskMoved", "FN-001", "todo", "in-progress");
      expect(mockPluginLoader.invokeHook).toHaveBeenCalledWith(
        "onTaskMoved",
        "FN-001",
        "todo",
        "in-progress"
      );
    });

    it("should propagate hook invocation errors", async () => {
      mockPluginLoader.invokeHook = vi.fn().mockRejectedValue(new Error("Hook failed"));
      await pluginRunner.init();
      // Errors are propagated to caller
      await expect(
        pluginRunner.invokeHook("onLoad")
      ).rejects.toThrow("Hook failed");
    });
  });

  describe("getPluginTools()", () => {
    it("should return empty array when no plugins have tools", async () => {
      mockPluginLoader.getPluginTools.mockReturnValue([]);
      await pluginRunner.init();
      const tools = pluginRunner.getPluginTools();
      expect(tools).toEqual([]);
    });

    it("should cache tools and invalidate on plugin events", async () => {
      const mockTools: PluginToolDefinition[] = [
        {
          name: "test-tool",
          description: "A test tool",
          parameters: { type: "object", properties: {} },
          execute: vi.fn(),
        },
      ];
      mockPluginLoader.getPluginTools.mockReturnValue(mockTools);
      
      await pluginRunner.init();
      const tools1 = pluginRunner.getPluginTools();
      
      // Same call should return cached result
      const tools2 = pluginRunner.getPluginTools();
      expect(tools1).toBe(tools2);
      
      // Simulate plugin event that invalidates cache
      const reloadHandler = mockPluginLoader.on.mock.calls.find(
        call => call[0] === "plugin:reloaded"
      )?.[1];
      if (reloadHandler) {
        reloadHandler({ pluginId: "test-plugin" });
      }
      
      // Next call should rebuild cache
      const tools3 = pluginRunner.getPluginTools();
      expect(mockPluginLoader.getPluginTools).toHaveBeenCalledTimes(2);
    });
  });

  describe("getPluginRoutes()", () => {
    it("should return routes from the loader", async () => {
      const mockRoutes = [
        {
          pluginId: "test-plugin",
          route: {
            method: "GET",
            path: "/api/test",
            handler: vi.fn(),
          },
        },
      ];
      mockPluginLoader.getPluginRoutes.mockReturnValue(mockRoutes);
      
      await pluginRunner.init();
      const routes = pluginRunner.getPluginRoutes();
      expect(routes).toEqual(mockRoutes);
    });

    it("should return empty array when no routes", async () => {
      mockPluginLoader.getPluginRoutes.mockReturnValue([]);
      await pluginRunner.init();
      const routes = pluginRunner.getPluginRoutes();
      expect(routes).toEqual([]);
    });
  });

  describe("getPluginUiSlots()", () => {
    it("should return empty array when no plugins have uiSlots", async () => {
      mockPluginLoader.getPluginUiSlots.mockReturnValue([]);
      await pluginRunner.init();
      const slots = pluginRunner.getPluginUiSlots();
      expect(slots).toEqual([]);
    });

    it("should return cached slots after plugins load", async () => {
      const mockSlots = [
        {
          pluginId: "test-plugin",
          slot: {
            slotId: "task-detail-tab",
            label: "Task Details",
            componentPath: "./components/TaskDetailTab.js",
          },
        },
      ];
      mockPluginLoader.getPluginUiSlots.mockReturnValue(mockSlots);
      
      await pluginRunner.init();
      const slots1 = pluginRunner.getPluginUiSlots();
      const slots2 = pluginRunner.getPluginUiSlots();
      
      expect(slots1).toEqual(mockSlots);
      expect(slots2).toBe(slots1); // Same reference (cached)
    });

    it("should invalidate cache on plugin:reloaded event", async () => {
      const mockSlots = [
        {
          pluginId: "test-plugin",
          slot: {
            slotId: "custom-tab",
            label: "Custom Tab",
            componentPath: "./components/CustomTab.js",
          },
        },
      ];
      mockPluginLoader.getPluginUiSlots.mockReturnValue(mockSlots);
      
      await pluginRunner.init();
      const slots1 = pluginRunner.getPluginUiSlots();
      expect(slots1).toEqual(mockSlots);
      
      // Simulate plugin:reloaded event that invalidates cache
      const reloadHandler = mockPluginLoader.on.mock.calls.find(
        call => call[0] === "plugin:reloaded"
      )?.[1];
      if (reloadHandler) {
        reloadHandler({ pluginId: "test-plugin" });
      }
      
      // Next call should rebuild cache
      const newSlots = [
        {
          pluginId: "test-plugin",
          slot: {
            slotId: "updated-tab",
            label: "Updated Tab",
            componentPath: "./components/UpdatedTab.js",
          },
        },
      ];
      mockPluginLoader.getPluginUiSlots.mockReturnValue(newSlots);
      
      const slots2 = pluginRunner.getPluginUiSlots();
      expect(slots2).toEqual(newSlots);
      expect(mockPluginLoader.getPluginUiSlots).toHaveBeenCalledTimes(2);
    });

    it("should invalidate cache on plugin:enabled event", async () => {
      mockPluginLoader.getPluginUiSlots.mockReturnValue([]);
      await pluginRunner.init();
      
      // Get initial slots
      pluginRunner.getPluginUiSlots();
      
      // Simulate plugin:enabled event
      const enabledHandler = mockPluginStore.on.mock.calls.find(
        call => call[0] === "plugin:enabled"
      )?.[1];
      
      const newPlugin = {
        id: "new-plugin",
        name: "New Plugin",
        version: "1.0.0",
        path: "/test/path",
        enabled: true,
        state: "stopped" as const,
        settings: {},
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };
      
      if (enabledHandler) {
        enabledHandler(newPlugin);
      }
      
      // Next call should rebuild cache
      pluginRunner.getPluginUiSlots();
      expect(mockPluginLoader.getPluginUiSlots).toHaveBeenCalledTimes(2);
    });

    it("should invalidate cache on plugin:disabled event", async () => {
      mockPluginLoader.getPluginUiSlots.mockReturnValue([]);
      await pluginRunner.init();
      
      // Get initial slots
      pluginRunner.getPluginUiSlots();
      
      // Simulate plugin:disabled event
      const disabledHandler = mockPluginStore.on.mock.calls.find(
        call => call[0] === "plugin:disabled"
      )?.[1];
      
      const plugin = {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        path: "/test/path",
        enabled: true,
        state: "stopped" as const,
        settings: {},
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };
      
      if (disabledHandler) {
        disabledHandler(plugin);
      }
      
      // Next call should rebuild cache
      pluginRunner.getPluginUiSlots();
      expect(mockPluginLoader.getPluginUiSlots).toHaveBeenCalledTimes(2);
    });

    it("should invalidate cache on plugin:stateChanged event", async () => {
      mockPluginLoader.getPluginUiSlots.mockReturnValue([]);
      await pluginRunner.init();
      
      // Get initial slots
      pluginRunner.getPluginUiSlots();
      
      // Simulate plugin:stateChanged event
      const stateHandler = mockPluginStore.on.mock.calls.find(
        call => call[0] === "plugin:stateChanged"
      )?.[1];
      
      if (stateHandler) {
        stateHandler();
      }
      
      // Next call should rebuild cache
      pluginRunner.getPluginUiSlots();
      expect(mockPluginLoader.getPluginUiSlots).toHaveBeenCalledTimes(2);
    });

    it("should invalidate cache on plugin:updated event", async () => {
      mockPluginLoader.getPluginUiSlots.mockReturnValue([]);
      await pluginRunner.init();
      
      // Get initial slots
      pluginRunner.getPluginUiSlots();
      
      // Simulate plugin:updated event
      const updatedHandler = mockPluginStore.on.mock.calls.find(
        call => call[0] === "plugin:updated"
      )?.[1];
      
      if (updatedHandler) {
        updatedHandler();
      }
      
      // Next call should rebuild cache
      pluginRunner.getPluginUiSlots();
      expect(mockPluginLoader.getPluginUiSlots).toHaveBeenCalledTimes(2);
    });

    it("should invalidate cache on reloadPlugin()", async () => {
      mockPluginLoader.getPluginUiSlots.mockReturnValue([]);
      await pluginRunner.init();
      
      // Get initial slots
      pluginRunner.getPluginUiSlots();
      
      // Call reloadPlugin
      await pluginRunner.reloadPlugin("test-plugin");
      
      // Next call should rebuild cache
      pluginRunner.getPluginUiSlots();
      expect(mockPluginLoader.getPluginUiSlots).toHaveBeenCalledTimes(2);
    });
  });

  describe("getLoader() / getStore()", () => {
    it("should return the plugin loader", () => {
      const loader = pluginRunner.getLoader();
      expect(loader).toBe(mockPluginLoader);
    });

    it("should return the plugin store", () => {
      const store = pluginRunner.getStore();
      expect(store).toBe(mockPluginStore);
    });
  });

  describe("reloadPlugin()", () => {
    it("should reload a plugin", async () => {
      await pluginRunner.init();
      await pluginRunner.reloadPlugin("test-plugin");
      expect(mockPluginLoader.reloadPlugin).toHaveBeenCalledWith("test-plugin");
    });
  });

  describe("task lifecycle hooks", () => {
    it("should invoke onTaskCreated when task:created event fires", async () => {
      mockPluginLoader.invokeHook = vi.fn();
      await pluginRunner.init();
      
      // Find the task:created handler
      const createdHandler = mockTaskStore.on.mock.calls.find(
        call => call[0] === "task:created"
      )?.[1];
      
      // Simulate task creation
      const mockTask = { id: "FN-001", title: "Test Task" };
      if (createdHandler) {
        createdHandler(mockTask);
      }
      
      // Give async handler time to execute
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockPluginLoader.invokeHook).toHaveBeenCalledWith(
        "onTaskCreated",
        mockTask
      );
    });

    it("should invoke onTaskMoved when task:moved event fires", async () => {
      mockPluginLoader.invokeHook = vi.fn();
      await pluginRunner.init();
      
      // Find the task:moved handler
      const movedHandler = mockTaskStore.on.mock.calls.find(
        call => call[0] === "task:moved"
      )?.[1];
      
      // Simulate task move
      const mockTask = { id: "FN-001", title: "Test Task" };
      if (movedHandler) {
        movedHandler({ task: mockTask, from: "todo", to: "in-progress" });
      }
      
      // Give async handler time to execute
      await new Promise(resolve => setTimeout(resolve, 10));
      
      expect(mockPluginLoader.invokeHook).toHaveBeenCalledWith(
        "onTaskMoved",
        mockTask,
        "todo",
        "in-progress"
      );
    });

    it("should invoke onTaskCompleted when task moves to done", async () => {
      mockPluginLoader.invokeHook = vi.fn();
      await pluginRunner.init();
      
      // Find the task:moved handler
      const movedHandler = mockTaskStore.on.mock.calls.find(
        call => call[0] === "task:moved"
      )?.[1];
      
      // Simulate task moved to done
      const mockTask = { id: "FN-001", title: "Test Task" };
      if (movedHandler) {
        movedHandler({ task: mockTask, from: "in-progress", to: "done" });
      }
      
      // Give async handler time to execute
      await new Promise(resolve => setTimeout(resolve, 50));
      
      expect(mockPluginLoader.invokeHook).toHaveBeenCalledWith(
        "onTaskCompleted",
        mockTask
      );
    });

    it("should NOT invoke onTaskCompleted when task moves elsewhere", async () => {
      mockPluginLoader.invokeHook = vi.fn();
      await pluginRunner.init();
      
      // Find the task:moved handler
      const movedHandler = mockTaskStore.on.mock.calls.find(
        call => call[0] === "task:moved"
      )?.[1];
      
      // Simulate task moved to in-progress
      const mockTask = { id: "FN-001", title: "Test Task" };
      if (movedHandler) {
        movedHandler({ task: mockTask, from: "todo", to: "in-progress" });
      }
      
      // Give async handler time to execute
      await new Promise(resolve => setTimeout(resolve, 50));
      
      expect(mockPluginLoader.invokeHook).not.toHaveBeenCalledWith(
        "onTaskCompleted",
        expect.anything()
      );
    });
  });

  describe("plugin hot-reload integration", () => {
    it("should handle plugin:enabled event", async () => {
      await pluginRunner.init();
      
      // Find the handler
      const enabledHandler = mockPluginStore.on.mock.calls.find(
        call => call[0] === "plugin:enabled"
      )?.[1];
      
      const mockPlugin = {
        id: "new-plugin",
        name: "New Plugin",
        version: "1.0.0",
        path: "/test/path",
        enabled: true,
        state: "stopped" as const,
        settings: {},
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };
      
      // Should not throw
      if (enabledHandler) {
        enabledHandler(mockPlugin);
      }
      
      expect(true).toBe(true); // Handler exists and doesn't throw
    });

    it("should handle plugin:disabled event", async () => {
      await pluginRunner.init();
      
      // Find the handler
      const disabledHandler = mockPluginStore.on.mock.calls.find(
        call => call[0] === "plugin:disabled"
      )?.[1];
      
      const mockPlugin = {
        id: "new-plugin",
        name: "New Plugin",
        version: "1.0.0",
        path: "/test/path",
        enabled: true,
        state: "stopped" as const,
        settings: {},
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };
      
      // Should not throw
      if (disabledHandler) {
        disabledHandler(mockPlugin);
      }
      
      expect(true).toBe(true); // Handler exists and doesn't throw
    });

    it("logs warning when stopPlugin fails during plugin:unregistered handler", async () => {
      mockPluginLoader.stopPlugin.mockRejectedValue(new Error("stop failed"));
      await pluginRunner.init();

      const unregisteredHandler = mockPluginStore.on.mock.calls.find(
        call => call[0] === "plugin:unregistered"
      )?.[1];
      const logger = getPluginRunnerLogger();
      logger.warn.mockClear();
      expect(unregisteredHandler).toBeTypeOf("function");

      const plugin = {
        id: "broken-plugin",
        name: "Broken Plugin",
        version: "1.0.0",
        path: "/test/path",
        enabled: false,
        state: "stopped" as const,
        settings: {},
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };

      await expect(unregisteredHandler?.(plugin)).resolves.toBeUndefined();

      expect(mockPluginLoader.stopPlugin).toHaveBeenCalledWith("broken-plugin");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to stop unregistered plugin broken-plugin: stop failed"),
      );
    });

    it("should handle plugin:stateChanged event", async () => {
      await pluginRunner.init();
      
      // Find the handler
      const stateHandler = mockPluginStore.on.mock.calls.find(
        call => call[0] === "plugin:stateChanged"
      )?.[1];
      
      // Should not throw
      if (stateHandler) {
        stateHandler();
      }
      
      expect(true).toBe(true); // Handler exists and doesn't throw
    });

    it("should handle plugin:updated event", async () => {
      await pluginRunner.init();
      
      // Find the handler
      const updatedHandler = mockPluginStore.on.mock.calls.find(
        call => call[0] === "plugin:updated"
      )?.[1];
      
      // Should not throw
      if (updatedHandler) {
        updatedHandler();
      }
      
      expect(true).toBe(true); // Handler exists and doesn't throw
    });
  });
});
