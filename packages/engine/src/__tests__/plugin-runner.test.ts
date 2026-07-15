/**
 * PluginRunner Unit Tests
 * 
 * Tests the PluginRunner class which orchestrates plugin loading into the engine,
 * invokes hooks at lifecycle points, and provides plugin tools to agent sessions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PluginRunner, type PluginRunnerOptions } from "../plugin-runner.js";
import {
  __resetWorkflowExtensionRegistryForTests,
  getWorkflowExtensionRegistry,
  workflowExtensionRegistryId,
  type PluginLoader,
  type PluginStore,
  type PluginInstallation,
} from "@fusion/core";
import type { FusionPlugin, PluginToolDefinition } from "@fusion/core";
import { createLogger, executorLog } from "../logger.js";

// Mock the logger to suppress output during tests
vi.mock("../logger.js", () => ({
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

/*
FNXC:PluginRunnerTests 2026-07-02-17:20:
Task lifecycle handlers are fire-and-forget (`void this.invokeHookSafe(...)`), but the mock
`invokeHook` seam resolves through awaited microtasks, never real timers. Flush a bounded number
of microtask turns deterministically instead of paying real `setTimeout` wall-clock sleeps
(FN-5048: prefer fake timers/deterministic seams over real time waits — no slow tests).
*/
async function flushMicrotasks(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

describe("PluginRunner", () => {
  let mockPluginLoader: {
    loadAllPlugins: ReturnType<typeof vi.fn>;
    stopAllPlugins: ReturnType<typeof vi.fn>;
    invokeHook: ReturnType<typeof vi.fn>;
    getPluginSchemaInitHooks: ReturnType<typeof vi.fn>;
    getPluginTools: ReturnType<typeof vi.fn>;
    getPluginRoutes: ReturnType<typeof vi.fn>;
    getPluginUiSlots: ReturnType<typeof vi.fn>;
    getPluginUiContributions: ReturnType<typeof vi.fn>;
    getPluginRuntimes: ReturnType<typeof vi.fn>;
    getCliProviderContributions: ReturnType<typeof vi.fn>;
    getPluginSkills: ReturnType<typeof vi.fn>;
    getPluginWorkflowSteps: ReturnType<typeof vi.fn>;
    getPluginWorkflowExtensions: ReturnType<typeof vi.fn>;
    getPluginWorkflowStepTemplates: ReturnType<typeof vi.fn>;
    getPluginPromptContributions: ReturnType<typeof vi.fn>;
    getPluginSetupInfo: ReturnType<typeof vi.fn>;
    checkPluginSetup: ReturnType<typeof vi.fn>;
    installPluginSetup: ReturnType<typeof vi.fn>;
    uninstallPluginSetup: ReturnType<typeof vi.fn>;
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
    getDatabase: ReturnType<typeof vi.fn>;
    runPluginSchemaInits: ReturnType<typeof vi.fn>;
    recordRunAuditEvent: ReturnType<typeof vi.fn>;
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
      getPluginSchemaInitHooks: vi.fn().mockReturnValue([]),
      getPluginTools: vi.fn().mockReturnValue([]),
      getPluginRoutes: vi.fn().mockReturnValue([]),
      getPluginUiSlots: vi.fn().mockReturnValue([]),
      getPluginUiContributions: vi.fn().mockReturnValue([]),
      getPluginRuntimes: vi.fn().mockReturnValue([]),
      getCliProviderContributions: vi.fn().mockReturnValue([]),
      getPluginSkills: vi.fn().mockReturnValue([]),
      getPluginWorkflowSteps: vi.fn().mockReturnValue([]),
      getPluginWorkflowExtensions: vi.fn().mockReturnValue([]),
      getPluginWorkflowStepTemplates: vi.fn().mockReturnValue([]),
      getPluginPromptContributions: vi.fn().mockReturnValue([]),
      getPluginSetupInfo: vi.fn().mockReturnValue([]),
      checkPluginSetup: vi.fn().mockResolvedValue({ status: "installed" }),
      installPluginSetup: vi.fn().mockResolvedValue(undefined),
      uninstallPluginSetup: vi.fn().mockResolvedValue(undefined),
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
    const mockRunPluginSchemaInits = vi.fn().mockResolvedValue(undefined);
    mockTaskStore = {
      on: mockOn,
      off: mockOff,
      getTask: vi.fn(),
      getDatabase: vi.fn().mockReturnValue({ runPluginSchemaInits: mockRunPluginSchemaInits }),
      runPluginSchemaInits: mockRunPluginSchemaInits,
      isBackendMode: vi.fn().mockReturnValue(false),
      recordRunAuditEvent: vi.fn(),
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
    __resetWorkflowExtensionRegistryForTests();
    vi.clearAllMocks();
  });

  describe("init()", () => {
    it("should load all plugins", async () => {
      await pluginRunner.init();
      expect(mockPluginLoader.loadAllPlugins).toHaveBeenCalled();
    });

    it("should execute schema init hooks after plugin load", async () => {
      const schemaHook = vi.fn();
      mockPluginLoader.getPluginSchemaInitHooks.mockReturnValue([
        { pluginId: "plugin-a", hook: schemaHook },
      ]);

      await pluginRunner.init();

      expect(mockPluginLoader.getPluginSchemaInitHooks).toHaveBeenCalledTimes(1);
      expect(mockTaskStore.getDatabase).not.toHaveBeenCalled();
      expect(mockTaskStore.runPluginSchemaInits).toHaveBeenCalledWith([
        { pluginId: "plugin-a", hook: schemaHook },
      ]);
    });

    it("should skip schema init execution when no hooks are registered", async () => {
      mockPluginLoader.getPluginSchemaInitHooks.mockReturnValue([]);

      await pluginRunner.init();

      expect(mockTaskStore.getDatabase).not.toHaveBeenCalled();
      expect(mockTaskStore.runPluginSchemaInits).not.toHaveBeenCalled();
    });

    /* FNXC:PluginPostgresSchema 2026-07-14-18:00: A plugin without a PostgreSQL schema contract must stop runner initialization after emitting the actionable error; continuing would start hooks against missing tables. */
    it("fails runner initialization when backend schema validation rejects a plugin", async () => {
      mockPluginLoader.getPluginSchemaInitHooks.mockReturnValue([
        { pluginId: "sqlite-only-plugin", hook: vi.fn() },
      ]);
      mockTaskStore.runPluginSchemaInits.mockRejectedValueOnce(
        new Error("sqlite-only-plugin has no registered PostgreSQL schema hook"),
      );

      await expect(pluginRunner.init()).rejects.toThrow("no registered PostgreSQL schema hook");
      expect(executorLog.log).toHaveBeenCalledWith(
        expect.stringContaining("onSchemaInit execution failed"),
      );
      expect(mockPluginStore.on).not.toHaveBeenCalled();
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

    it("should isolate hook invocation errors in invokeHookSafe", async () => {
      mockPluginLoader.invokeHook = vi.fn().mockRejectedValue(new Error("Hook failed"));
      await pluginRunner.init();

      await expect(pluginRunner.invokeHookSafe("onLoad")).resolves.toBeUndefined();
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

  describe("getPluginUiContributions()", () => {
    it("returns structured contributions from pluginLoader", () => {
      const contributions = [
        {
          pluginId: "plugin-a",
          contribution: {
            surface: "settings-config-section",
            contributionId: "cfg-a",
            sectionId: "openai",
            title: "OpenAI settings",
            pluginSettingKeys: ["openai.apiKey"],
          },
        },
      ];
      mockPluginLoader.getPluginUiContributions.mockReturnValue(contributions);

      const result = pluginRunner.getPluginUiContributions();

      expect(result).toEqual(contributions);
      expect(mockPluginLoader.getPluginUiContributions).toHaveBeenCalledTimes(1);
    });

    it("uses cached contributions until invalidated", () => {
      const contributions = [
        {
          pluginId: "plugin-a",
          contribution: {
            surface: "onboarding-provider-recommendation",
            contributionId: "rec-a",
            providerId: "openai",
            title: "OpenAI",
            reason: "default",
          },
        },
      ];
      mockPluginLoader.getPluginUiContributions.mockReturnValue(contributions);

      pluginRunner.getPluginUiContributions();
      pluginRunner.getPluginUiContributions();

      expect(mockPluginLoader.getPluginUiContributions).toHaveBeenCalledTimes(1);
    });
  });

  describe("getPluginRuntimes()", () => {
    it("should return empty array when no plugins have runtimes", async () => {
      mockPluginLoader.getPluginRuntimes.mockReturnValue([]);
      await pluginRunner.init();
      const runtimes = pluginRunner.getPluginRuntimes();
      expect(runtimes).toEqual([]);
    });

    it("should return cached runtimes after plugins load", async () => {
      const mockRuntimes = [
        {
          pluginId: "test-plugin",
          runtime: {
            metadata: {
              runtimeId: "code-interpreter",
              name: "Code Interpreter",
              description: "Executes code",
            },
            factory: async () => ({}),
          },
        },
      ];
      mockPluginLoader.getPluginRuntimes.mockReturnValue(mockRuntimes);
      
      await pluginRunner.init();
      const runtimes1 = pluginRunner.getPluginRuntimes();
      const runtimes2 = pluginRunner.getPluginRuntimes();
      
      expect(runtimes1).toEqual(mockRuntimes);
      expect(runtimes2).toBe(runtimes1); // Same reference (cached)
    });

    it("should invalidate cache on plugin:reloaded event", async () => {
      const mockRuntimes = [
        {
          pluginId: "test-plugin",
          runtime: {
            metadata: {
              runtimeId: "runtime-v1",
              name: "Runtime V1",
            },
            factory: async () => ({}),
          },
        },
      ];
      mockPluginLoader.getPluginRuntimes.mockReturnValue(mockRuntimes);
      
      await pluginRunner.init();
      const runtimes1 = pluginRunner.getPluginRuntimes();
      expect(runtimes1).toEqual(mockRuntimes);
      
      // Simulate plugin:reloaded event that invalidates cache
      const reloadHandler = mockPluginLoader.on.mock.calls.find(
        call => call[0] === "plugin:reloaded"
      )?.[1];
      if (reloadHandler) {
        reloadHandler({ pluginId: "test-plugin" });
      }
      
      // Next call should rebuild cache
      const newRuntimes = [
        {
          pluginId: "test-plugin",
          runtime: {
            metadata: {
              runtimeId: "runtime-v2",
              name: "Runtime V2",
            },
            factory: async () => ({}),
          },
        },
      ];
      mockPluginLoader.getPluginRuntimes.mockReturnValue(newRuntimes);
      
      const runtimes2 = pluginRunner.getPluginRuntimes();
      expect(runtimes2).toEqual(newRuntimes);
      expect(mockPluginLoader.getPluginRuntimes).toHaveBeenCalledTimes(2);
    });

    it("should invalidate cache on plugin:enabled event", async () => {
      mockPluginLoader.getPluginRuntimes.mockReturnValue([]);
      await pluginRunner.init();
      
      // Get initial runtimes
      pluginRunner.getPluginRuntimes();
      
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
      pluginRunner.getPluginRuntimes();
      expect(mockPluginLoader.getPluginRuntimes).toHaveBeenCalledTimes(2);
    });

    it("should invalidate cache on plugin:disabled event", async () => {
      mockPluginLoader.getPluginRuntimes.mockReturnValue([]);
      await pluginRunner.init();
      
      // Get initial runtimes
      pluginRunner.getPluginRuntimes();
      
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
      pluginRunner.getPluginRuntimes();
      expect(mockPluginLoader.getPluginRuntimes).toHaveBeenCalledTimes(2);
    });

    it("should invalidate cache on plugin:stateChanged event", async () => {
      mockPluginLoader.getPluginRuntimes.mockReturnValue([]);
      await pluginRunner.init();
      
      // Get initial runtimes
      pluginRunner.getPluginRuntimes();
      
      // Simulate plugin:stateChanged event
      const stateHandler = mockPluginStore.on.mock.calls.find(
        call => call[0] === "plugin:stateChanged"
      )?.[1];
      
      if (stateHandler) {
        stateHandler();
      }
      
      // Next call should rebuild cache
      pluginRunner.getPluginRuntimes();
      expect(mockPluginLoader.getPluginRuntimes).toHaveBeenCalledTimes(2);
    });

    it("should invalidate cache on plugin:updated event", async () => {
      mockPluginLoader.getPluginRuntimes.mockReturnValue([]);
      await pluginRunner.init();
      
      // Get initial runtimes
      pluginRunner.getPluginRuntimes();
      
      // Simulate plugin:updated event
      const updatedHandler = mockPluginStore.on.mock.calls.find(
        call => call[0] === "plugin:updated"
      )?.[1];
      
      if (updatedHandler) {
        updatedHandler();
      }
      
      // Next call should rebuild cache
      pluginRunner.getPluginRuntimes();
      expect(mockPluginLoader.getPluginRuntimes).toHaveBeenCalledTimes(2);
    });

    it("should invalidate cache on reloadPlugin()", async () => {
      mockPluginLoader.getPluginRuntimes.mockReturnValue([]);
      await pluginRunner.init();
      
      // Get initial runtimes
      pluginRunner.getPluginRuntimes();
      
      // Call reloadPlugin
      await pluginRunner.reloadPlugin("test-plugin");
      
      // Next call should rebuild cache
      pluginRunner.getPluginRuntimes();
      expect(mockPluginLoader.getPluginRuntimes).toHaveBeenCalledTimes(2);
    });

    it("should invalidate cache on plugin:loaded event", async () => {
      mockPluginLoader.getPluginRuntimes.mockReturnValue([]);
      await pluginRunner.init();
      
      // Get initial runtimes
      pluginRunner.getPluginRuntimes();
      
      // Simulate plugin:loaded event
      const loadedHandler = mockPluginLoader.on.mock.calls.find(
        call => call[0] === "plugin:loaded"
      )?.[1];
      
      if (loadedHandler) {
        loadedHandler({ pluginId: "test-plugin" });
      }
      
      // Next call should rebuild cache
      pluginRunner.getPluginRuntimes();
      expect(mockPluginLoader.getPluginRuntimes).toHaveBeenCalledTimes(2);
    });

    it("should invalidate cache on plugin:unloaded event", async () => {
      mockPluginLoader.getPluginRuntimes.mockReturnValue([]);
      await pluginRunner.init();
      
      // Get initial runtimes
      pluginRunner.getPluginRuntimes();
      
      // Simulate plugin:unloaded event
      const unloadedHandler = mockPluginLoader.on.mock.calls.find(
        call => call[0] === "plugin:unloaded"
      )?.[1];
      
      if (unloadedHandler) {
        unloadedHandler({ pluginId: "test-plugin" });
      }
      
      // Next call should rebuild cache
      pluginRunner.getPluginRuntimes();
      expect(mockPluginLoader.getPluginRuntimes).toHaveBeenCalledTimes(2);
    });
  });

  describe("new plugin contribution accessors", () => {
    it("getCliProviderContributions returns cached CLI-provider contributions", async () => {
      const contributions = [
        {
          pluginId: "cursor-plugin",
          contribution: {
            providerId: "cursor-cli",
            displayName: "Cursor CLI",
            binaryName: "cursor-agent",
            providerType: "cli",
            statusRoute: "/providers/cursor-cli/status",
            authRoute: "/auth/cursor-cli",
          },
        },
      ];
      mockPluginLoader.getCliProviderContributions.mockReturnValue(contributions);
      await pluginRunner.init();
      const first = pluginRunner.getCliProviderContributions();
      const second = pluginRunner.getCliProviderContributions();
      expect(first).toEqual(contributions);
      expect(second).toBe(first);
    });

    it("getPluginSkills returns empty array initially", async () => {
      await pluginRunner.init();
      expect(pluginRunner.getPluginSkills()).toEqual([]);
    });

    it("getPluginSkills returns cached skills after init", async () => {
      const skills = [{ pluginId: "test-plugin", pluginRoot: "/tmp/test-plugin", skill: { skillId: "s1", name: "Skill", description: "d", skillFiles: ["./skill.md"] } }];
      mockPluginLoader.getPluginSkills.mockReturnValue(skills);
      await pluginRunner.init();
      const first = pluginRunner.getPluginSkills();
      const second = pluginRunner.getPluginSkills();
      expect(first).toEqual(skills);
      expect(second).toBe(first);
    });

    it("returns workflow steps, workflow extensions, workflow step templates, prompt contributions, and setup info", async () => {
      const steps = [{ pluginId: "test-plugin", step: { stepId: "ws1", name: "Step", description: "d", mode: "prompt", prompt: "Run checks" } }];
      const extensions = [{ pluginId: "test-plugin", extension: { extensionId: "move-policy", name: "Move Policy", kind: "move-policy", schemaVersion: 1, fallback: "degradeToDefault" } }];
      const templates = [{ pluginId: "test-plugin", template: { id: "plugin:test-plugin:ws1", name: "Step", description: "d", prompt: "Run checks", category: "Plugin", icon: "puzzle" } }];
      const prompts = [{ pluginId: "test-plugin", contribution: { surface: "executor-system", content: "extra" }, config: { enabledByDefault: true, contributions: [] } }];
      const setups = [{ pluginId: "test-plugin", manifest: { binaryName: "agent-browser", description: "Do it" }, hooks: { checkSetup: vi.fn().mockResolvedValue({ status: "installed" }) } }];
      mockPluginLoader.getPluginWorkflowSteps.mockReturnValue(steps);
      mockPluginLoader.getPluginWorkflowExtensions.mockReturnValue(extensions);
      mockPluginLoader.getPluginWorkflowStepTemplates.mockReturnValue(templates);
      mockPluginLoader.getPluginPromptContributions.mockReturnValue(prompts);
      mockPluginLoader.getPluginSetupInfo.mockReturnValue(setups);
      await pluginRunner.init();
      expect(pluginRunner.getPluginWorkflowSteps()).toEqual(steps);
      expect(pluginRunner.getPluginWorkflowExtensions()).toEqual(extensions);
      expect(pluginRunner.getPluginWorkflowStepTemplates()).toEqual(templates);
      expect(pluginRunner.getPluginPromptContributions()).toEqual(prompts);
      expect(pluginRunner.getPluginSetupInfo()).toEqual(setups);
    });

    it("syncPluginWorkflowExtensions preserves force-degraded definitions across cache invalidation", async () => {
      const extensions = [{
        pluginId: "test-plugin",
        extension: {
          extensionId: "move-policy",
          name: "Move Policy",
          kind: "move-policy",
          schemaVersion: 1,
          fallback: "degradeToDefault",
        },
      }];
      mockPluginLoader.getPluginWorkflowExtensions.mockReturnValue(extensions);
      const id = workflowExtensionRegistryId("test-plugin", "move-policy");

      pluginRunner.syncPluginWorkflowExtensions();
      const degraded = pluginRunner.disablePluginWorkflowExtensions("test-plugin", { force: true });
      (pluginRunner as unknown as { invalidateWorkflowExtensionsCache: () => void }).invalidateWorkflowExtensionsCache();
      pluginRunner.syncPluginWorkflowExtensions();

      expect(degraded.degraded).toEqual([id]);
      expect(getWorkflowExtensionRegistry().get(id)?.degraded).toMatchObject({
        reason: "force-disabled",
      });
    });

    it("getPromptContributionsForSurface filters by surface", async () => {
      mockPluginLoader.getPluginPromptContributions.mockReturnValue([
        { pluginId: "test-plugin", contribution: { surface: "executor-system", content: "ok" }, config: { enabledByDefault: true, contributions: [] } },
        { pluginId: "test-plugin", contribution: { surface: "triage", content: "skip" }, config: { enabledByDefault: true, contributions: [] } },
      ]);
      mockPluginLoader.getPlugin.mockReturnValue(createMockPlugin({ state: "started" }));
      await pluginRunner.init();
      const filtered = await pluginRunner.getPromptContributionsForSurface("executor-system");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].contribution.content).toBe("ok");
    });

    it("getPromptContributionsForSurface returns empty when no matches", async () => {
      mockPluginLoader.getPluginPromptContributions.mockReturnValue([
        { pluginId: "test-plugin", contribution: { surface: "executor-system", content: "disabled" }, config: { enabledByDefault: false, contributions: [] } },
      ]);
      mockPluginLoader.getPlugin.mockReturnValue(createMockPlugin({ state: "started" }));
      await pluginRunner.init();
      await expect(pluginRunner.getPromptContributionsForSurface("reviewer")).resolves.toEqual([]);
      await expect(pluginRunner.getPromptContributionsForSurface("executor-system")).resolves.toEqual([]);
    });

    it("evaluates prompt contribution conditions against effective plugin settings", async () => {
      mockPluginLoader.getPluginPromptContributions.mockReturnValue([
        {
          pluginId: "test-plugin",
          contribution: { surface: "executor-system", content: "minimal API guidance", condition: 'settings["api-style"] === "minimal-apis"' },
          config: { enabledByDefault: true, contributions: [] },
        },
        {
          pluginId: "test-plugin",
          contribution: { surface: "executor-system", content: "always include" },
          config: { enabledByDefault: true, contributions: [] },
        },
      ]);
      mockPluginLoader.getPlugin.mockReturnValue(createMockPlugin({
        state: "started",
        manifest: {
          id: "test-plugin",
          name: "Test Plugin",
          version: "1.0.0",
          settingsSchema: {
            "api-style": { type: "enum", enumValues: ["controllers", "minimal-apis"], defaultValue: "controllers" },
          },
        },
      }));
      mockPluginStore.getPlugin.mockResolvedValue({
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        settings: {},
        settingsSchema: {
          "api-style": { type: "enum", enumValues: ["controllers", "minimal-apis"], defaultValue: "controllers" },
        },
      });

      await pluginRunner.init();
      await expect(pluginRunner.getPromptContributionsForSurface("executor-system")).resolves.toEqual([
        expect.objectContaining({ contribution: expect.objectContaining({ content: "always include" }) }),
      ]);

      mockPluginStore.getPlugin.mockResolvedValue({
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        settings: { "api-style": "controllers" },
        settingsSchema: {
          "api-style": { type: "enum", enumValues: ["controllers", "minimal-apis"], defaultValue: "controllers" },
        },
      });
      const controllerContributions = await pluginRunner.getPromptContributionsForSurface("executor-system");
      expect(controllerContributions.map((entry) => entry.contribution.content)).toEqual(["always include"]);

      mockPluginStore.getPlugin.mockResolvedValue({
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        settings: { "api-style": "minimal-apis" },
        settingsSchema: {
          "api-style": { type: "enum", enumValues: ["controllers", "minimal-apis"], defaultValue: "controllers" },
        },
      });
      const minimalContributions = await pluginRunner.getPromptContributionsForSurface("executor-system");
      expect(minimalContributions.map((entry) => entry.contribution.content)).toEqual(["minimal API guidance", "always include"]);
    });

    it("keeps plugin state, surface, and enabledByDefault filters before condition evaluation", async () => {
      mockPluginLoader.getPluginPromptContributions.mockReturnValue([
        {
          pluginId: "test-plugin",
          contribution: { surface: "executor-system", content: "wrong state", condition: 'settings["api-style"] !== "controllers"' },
          config: { enabledByDefault: true, contributions: [] },
        },
        {
          pluginId: "other-plugin",
          contribution: { surface: "reviewer", content: "wrong surface", condition: 'settings["api-style"] !== "controllers"' },
          config: { enabledByDefault: true, contributions: [] },
        },
        {
          pluginId: "disabled-plugin",
          contribution: { surface: "executor-system", content: "disabled", condition: 'settings["api-style"] !== "controllers"' },
          config: { enabledByDefault: false, contributions: [] },
        },
      ]);
      mockPluginLoader.getPlugin.mockImplementation((pluginId: string) => {
        if (pluginId === "test-plugin") return createMockPlugin({ state: "stopped" });
        return createMockPlugin({ manifest: { id: pluginId, name: pluginId, version: "1.0.0" }, state: "started" });
      });
      await pluginRunner.init();

      await expect(pluginRunner.getPromptContributionsForSurface("executor-system")).resolves.toEqual([]);
      expect(mockPluginStore.getPlugin).not.toHaveBeenCalled();
    });

    it("invalidates new contribution caches on state change and loader events", async () => {
      await pluginRunner.init();
      pluginRunner.getCliProviderContributions();
      pluginRunner.getPluginSkills();
      pluginRunner.getPluginWorkflowSteps();
      pluginRunner.getPluginWorkflowExtensions();
      pluginRunner.getPluginWorkflowStepTemplates();
      pluginRunner.getPluginPromptContributions();
      pluginRunner.getPluginSetupInfo();

      const stateChanged = mockPluginStore.on.mock.calls.find((call) => call[0] === "plugin:stateChanged")?.[1];
      stateChanged?.();
      pluginRunner.getCliProviderContributions();
      pluginRunner.getPluginSkills();
      pluginRunner.getPluginWorkflowSteps();
      pluginRunner.getPluginWorkflowExtensions();
      pluginRunner.getPluginWorkflowStepTemplates();
      pluginRunner.getPluginPromptContributions();
      pluginRunner.getPluginSetupInfo();

      const loaded = mockPluginLoader.on.mock.calls.find((call) => call[0] === "plugin:loaded")?.[1];
      loaded?.({ pluginId: "test-plugin" });
      pluginRunner.getCliProviderContributions();
      pluginRunner.getPluginSkills();
      pluginRunner.getPluginWorkflowSteps();
      pluginRunner.getPluginWorkflowExtensions();
      pluginRunner.getPluginWorkflowStepTemplates();
      pluginRunner.getPluginPromptContributions();
      pluginRunner.getPluginSetupInfo();

      expect(mockPluginLoader.getCliProviderContributions).toHaveBeenCalledTimes(3);
      expect(mockPluginLoader.getPluginSkills).toHaveBeenCalledTimes(3);
      expect(mockPluginLoader.getPluginWorkflowSteps).toHaveBeenCalledTimes(3);
      expect(mockPluginLoader.getPluginWorkflowExtensions).toHaveBeenCalledTimes(3);
      expect(mockPluginLoader.getPluginWorkflowStepTemplates).toHaveBeenCalledTimes(3);
      expect(mockPluginLoader.getPluginPromptContributions).toHaveBeenCalledTimes(3);
      expect(mockPluginLoader.getPluginSetupInfo).toHaveBeenCalledTimes(3);
    });

    it("checkPluginSetup delegates to loader and returns result", async () => {
      const result = { status: "installed" as const, version: "1.2.3" };
      mockPluginLoader.checkPluginSetup.mockResolvedValue(result);
      await expect(pluginRunner.checkPluginSetup("test-plugin")).resolves.toEqual(result);
      expect(mockPluginLoader.checkPluginSetup).toHaveBeenCalledWith("test-plugin");
    });

    it("checkPluginSetup returns error status when loader throws", async () => {
      mockPluginLoader.checkPluginSetup.mockRejectedValue(new Error("check failed"));
      await expect(pluginRunner.checkPluginSetup("test-plugin")).resolves.toEqual({ status: "error", error: "check failed" });
    });

    it("installPluginSetup returns success true on success", async () => {
      await expect(pluginRunner.installPluginSetup("test-plugin")).resolves.toEqual({ success: true });
      expect(mockPluginLoader.installPluginSetup).toHaveBeenCalledWith("test-plugin");
    });

    it("installPluginSetup returns success false on failure", async () => {
      mockPluginLoader.installPluginSetup.mockRejectedValue(new Error("install failed"));
      await expect(pluginRunner.installPluginSetup("test-plugin")).resolves.toEqual({ success: false, error: "install failed" });
    });

    it("uninstallPluginSetup returns success and failure results", async () => {
      await expect(pluginRunner.uninstallPluginSetup("test-plugin")).resolves.toEqual({ success: true });
      mockPluginLoader.uninstallPluginSetup.mockRejectedValueOnce(new Error("uninstall failed"));
      await expect(pluginRunner.uninstallPluginSetup("test-plugin")).resolves.toEqual({ success: false, error: "uninstall failed" });
    });

    it("getSetupStatuses returns statuses for all plugins with setup", async () => {
      mockPluginLoader.getPluginSetupInfo.mockReturnValue([
        { pluginId: "a", manifest: { binaryName: "a-bin", description: "A" }, hooks: { checkSetup: vi.fn() } },
        { pluginId: "b", manifest: { binaryName: "b-bin", description: "B" }, hooks: { checkSetup: vi.fn() } },
      ]);
      mockPluginLoader.checkPluginSetup
        .mockResolvedValueOnce({ status: "installed", version: "1.0.0" })
        .mockResolvedValueOnce({ status: "not-installed" });

      await expect(pluginRunner.getSetupStatuses()).resolves.toEqual([
        { pluginId: "a", manifest: { binaryName: "a-bin", description: "A" }, status: { status: "installed", version: "1.0.0" } },
        { pluginId: "b", manifest: { binaryName: "b-bin", description: "B" }, status: { status: "not-installed" } },
      ]);
    });

    it("getSetupStatuses handles setup check failures gracefully", async () => {
      mockPluginLoader.getPluginSetupInfo.mockReturnValue([
        { pluginId: "offline", manifest: { binaryName: "off-bin", description: "Offline" }, hooks: { checkSetup: vi.fn() } },
      ]);
      mockPluginLoader.checkPluginSetup.mockRejectedValue(new Error("Plugin \"offline\" is not loaded"));

      await expect(pluginRunner.getSetupStatuses()).resolves.toEqual([
        {
          pluginId: "offline",
          manifest: { binaryName: "off-bin", description: "Offline" },
          status: { status: "error", error: 'Plugin "offline" is not loaded' },
        },
      ]);
    });
  });

  describe("getRuntimeById()", () => {
    it("should return undefined when no runtimes exist", () => {
      mockPluginLoader.getPluginRuntimes.mockReturnValue([]);
      const result = pluginRunner.getRuntimeById("code-interpreter");
      expect(result).toBeUndefined();
    });

    it("should return the runtime when runtimeId matches", () => {
      const mockRuntime = {
        metadata: {
          runtimeId: "code-interpreter",
          name: "Code Interpreter",
        },
        factory: vi.fn(),
      };
      mockPluginLoader.getPluginRuntimes.mockReturnValue([
        { pluginId: "code-plugin", runtime: mockRuntime as any },
      ]);
      
      const result = pluginRunner.getRuntimeById("code-interpreter");
      expect(result).toEqual({ pluginId: "code-plugin", runtime: mockRuntime });
    });

    it("should return undefined when runtimeId does not match", () => {
      const mockRuntime = {
        metadata: {
          runtimeId: "web-search",
          name: "Web Search",
        },
        factory: vi.fn(),
      };
      mockPluginLoader.getPluginRuntimes.mockReturnValue([
        { pluginId: "search-plugin", runtime: mockRuntime as any },
      ]);
      
      const result = pluginRunner.getRuntimeById("code-interpreter");
      expect(result).toBeUndefined();
    });

    it("should return first matching runtime when multiple plugins have same runtimeId", () => {
      const mockRuntime1 = {
        metadata: {
          runtimeId: "shared-id",
          name: "First Runtime",
        },
        factory: vi.fn(),
      };
      const mockRuntime2 = {
        metadata: {
          runtimeId: "shared-id",
          name: "Second Runtime",
        },
        factory: vi.fn(),
      };
      mockPluginLoader.getPluginRuntimes.mockReturnValue([
        { pluginId: "plugin-1", runtime: mockRuntime1 as any },
        { pluginId: "plugin-2", runtime: mockRuntime2 as any },
      ]);
      
      const result = pluginRunner.getRuntimeById("shared-id");
      expect(result?.pluginId).toBe("plugin-1");
    });

    it("should find runtime even when cache is already built", () => {
      const mockRuntime = {
        metadata: {
          runtimeId: "cached-runtime",
          name: "Cached Runtime",
        },
        factory: vi.fn(),
      };
      mockPluginLoader.getPluginRuntimes.mockReturnValue([
        { pluginId: "cached-plugin", runtime: mockRuntime as any },
      ]);
      
      // First call builds cache
      pluginRunner.getRuntimeById("other-id");
      // Second call should find from cache
      const result = pluginRunner.getRuntimeById("cached-runtime");
      expect(result?.pluginId).toBe("cached-plugin");
      expect(mockPluginLoader.getPluginRuntimes).toHaveBeenCalledTimes(1);
    });
  });

  describe("Paperclip runtime compatibility", () => {
    /**
     * Verify that the paperclip runtime registration from
     * plugins/fusion-plugin-paperclip-runtime is correctly resolvable
     * through the engine's runtime resolution system.
     */

    it("should resolve paperclip runtime when registered", () => {
      const paperclipRuntime = {
        metadata: {
          runtimeId: "paperclip",
          name: "Paperclip Runtime",
          description: "Paperclip-backed AI session using the user's configured pi provider and model",
          version: "1.0.0",
        },
        factory: vi.fn().mockResolvedValue({}),
      };
      mockPluginLoader.getPluginRuntimes.mockReturnValue([
        { pluginId: "fusion-plugin-paperclip-runtime", runtime: paperclipRuntime as any },
      ]);

      const result = pluginRunner.getRuntimeById("paperclip");
      expect(result).toBeDefined();
      expect(result?.pluginId).toBe("fusion-plugin-paperclip-runtime");
      expect(result?.runtime.metadata.runtimeId).toBe("paperclip");
      expect(result?.runtime.metadata.name).toBe("Paperclip Runtime");
      expect(result?.runtime.metadata.description).toContain("Paperclip");
      expect(result?.runtime.metadata.version).toBe("1.0.0");
    });

    it("should expose paperclip runtime metadata correctly", () => {
      const paperclipRuntime = {
        metadata: {
          runtimeId: "paperclip",
          name: "Paperclip Runtime",
          description: "Paperclip-backed AI session using the user's configured pi provider and model",
          version: "1.0.0",
        },
        factory: vi.fn().mockResolvedValue({}),
      };
      mockPluginLoader.getPluginRuntimes.mockReturnValue([
        { pluginId: "fusion-plugin-paperclip-runtime", runtime: paperclipRuntime as any },
      ]);

      const runtimes = pluginRunner.getPluginRuntimes();
      const paperclip = runtimes.find(r => r.runtime.metadata.runtimeId === "paperclip");

      expect(paperclip).toBeDefined();
      expect(paperclip?.runtime.metadata).toEqual({
        runtimeId: "paperclip",
        name: "Paperclip Runtime",
        description: "Paperclip-backed AI session using the user's configured pi provider and model",
        version: "1.0.0",
      });
    });

    it("should allow factory invocation for paperclip runtime", async () => {
      const mockAdapter = {
        id: "paperclip",
        name: "Paperclip Runtime",
        createSession: vi.fn(),
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(),
        dispose: vi.fn(),
      };
      const paperclipRuntime = {
        metadata: {
          runtimeId: "paperclip",
          name: "Paperclip Runtime",
          description: "Paperclip-backed AI session using the user's configured pi provider and model",
          version: "1.0.0",
        },
        factory: vi.fn().mockResolvedValue(mockAdapter),
      };
      mockPluginLoader.getPluginRuntimes.mockReturnValue([
        { pluginId: "fusion-plugin-paperclip-runtime", runtime: paperclipRuntime as any },
      ]);

      const result = pluginRunner.getRuntimeById("paperclip");
      expect(result).toBeDefined();

      // Invoke the factory (simulating runtime instantiation)
      const context = { pluginId: "fusion-plugin-paperclip-runtime" };
      const runtime = (await result!.runtime.factory(context as any)) as typeof mockAdapter;

      expect(paperclipRuntime.factory).toHaveBeenCalledWith(context);
      expect(runtime).toBe(mockAdapter);
      expect(runtime.id).toBe("paperclip");
      expect(runtime.name).toBe("Paperclip Runtime");
    });
  });

  describe("Hermes runtime compatibility", () => {
    it("should resolve hermes runtime when registered", () => {
      const hermesRuntime = {
        metadata: {
          runtimeId: "hermes",
          name: "Hermes Runtime",
          description: "Hermes-backed AI session using the user's configured pi provider and model",
          version: "0.1.0",
        },
        factory: vi.fn().mockReturnValue({}),
      };
      mockPluginLoader.getPluginRuntimes.mockReturnValue([
        { pluginId: "fusion-plugin-hermes-runtime", runtime: hermesRuntime as any },
      ]);

      const result = pluginRunner.getRuntimeById("hermes");
      expect(result).toBeDefined();
      expect(result?.pluginId).toBe("fusion-plugin-hermes-runtime");
      expect(result?.runtime.metadata.runtimeId).toBe("hermes");
      expect(result?.runtime.metadata.name).toBe("Hermes Runtime");
      expect(result?.runtime.metadata.description).toContain("Hermes-backed AI session");
      expect(result?.runtime.metadata.version).toBe("0.1.0");
    });

    it("should expose hermes runtime metadata correctly", () => {
      const hermesRuntime = {
        metadata: {
          runtimeId: "hermes",
          name: "Hermes Runtime",
          description: "Hermes-backed AI session using the user's configured pi provider and model",
          version: "0.1.0",
        },
        factory: vi.fn().mockReturnValue({}),
      };
      mockPluginLoader.getPluginRuntimes.mockReturnValue([
        { pluginId: "fusion-plugin-hermes-runtime", runtime: hermesRuntime as any },
      ]);

      const runtimes = pluginRunner.getPluginRuntimes();
      const hermes = runtimes.find(r => r.runtime.metadata.runtimeId === "hermes");

      expect(hermes).toBeDefined();
      expect(hermes?.runtime.metadata).toEqual({
        runtimeId: "hermes",
        name: "Hermes Runtime",
        description: "Hermes-backed AI session using the user's configured pi provider and model",
        version: "0.1.0",
      });
    });

    it("should allow factory invocation for hermes runtime", async () => {
      const hermesAdapter = {
        id: "hermes",
        name: "Hermes Runtime",
        createSession: vi.fn(),
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(),
        dispose: vi.fn(),
      };
      const hermesRuntime = {
        metadata: {
          runtimeId: "hermes",
          name: "Hermes Runtime",
          description: "Hermes-backed AI session using the user's configured pi provider and model",
          version: "0.1.0",
        },
        factory: vi.fn().mockResolvedValue(hermesAdapter),
      };
      mockPluginLoader.getPluginRuntimes.mockReturnValue([
        { pluginId: "fusion-plugin-hermes-runtime", runtime: hermesRuntime as any },
      ]);

      const result = pluginRunner.getRuntimeById("hermes");
      expect(result).toBeDefined();

      const context = { pluginId: "fusion-plugin-hermes-runtime" };
      const runtime = (await result!.runtime.factory(context as any)) as typeof hermesAdapter;

      expect(hermesRuntime.factory).toHaveBeenCalledWith(context);
      expect(runtime).toBe(hermesAdapter);
      expect(runtime.id).toBe("hermes");
      expect(runtime.name).toBe("Hermes Runtime");
      expect(runtime.createSession).toBeTypeOf("function");
      expect(runtime.promptWithFallback).toBeTypeOf("function");
      expect(runtime.describeModel).toBeTypeOf("function");
    });
  });

  describe("OpenClaw runtime compatibility", () => {
    it("should resolve openclaw runtime when registered", () => {
      const openclawRuntime = {
        metadata: {
          runtimeId: "openclaw",
          name: "OpenClaw Runtime",
          description: "OpenClaw-backed AI session using the user's configured pi provider and model",
          version: "0.1.0",
        },
        factory: vi.fn().mockReturnValue({}),
      };
      mockPluginLoader.getPluginRuntimes.mockReturnValue([
        { pluginId: "fusion-plugin-openclaw-runtime", runtime: openclawRuntime as any },
      ]);

      const result = pluginRunner.getRuntimeById("openclaw");
      expect(result).toBeDefined();
      expect(result?.pluginId).toBe("fusion-plugin-openclaw-runtime");
      expect(result?.runtime.metadata.runtimeId).toBe("openclaw");
      expect(result?.runtime.metadata.name).toBe("OpenClaw Runtime");
      expect(result?.runtime.metadata.description).toBe(
        "OpenClaw-backed AI session using the user's configured pi provider and model",
      );
      expect(result?.runtime.metadata.version).toBe("0.1.0");
    });

    it("should expose openclaw runtime metadata correctly", () => {
      const openclawRuntime = {
        metadata: {
          runtimeId: "openclaw",
          name: "OpenClaw Runtime",
          description: "OpenClaw-backed AI session using the user's configured pi provider and model",
          version: "0.1.0",
        },
        factory: vi.fn().mockReturnValue({}),
      };
      mockPluginLoader.getPluginRuntimes.mockReturnValue([
        { pluginId: "fusion-plugin-openclaw-runtime", runtime: openclawRuntime as any },
      ]);

      const result = pluginRunner.getRuntimeById("openclaw");
      expect(result).toBeDefined();
      expect(result?.pluginId).toBe("fusion-plugin-openclaw-runtime");
      expect(result?.runtime.metadata).toEqual({
        runtimeId: "openclaw",
        name: "OpenClaw Runtime",
        description: "OpenClaw-backed AI session using the user's configured pi provider and model",
        version: "0.1.0",
      });
    });

    it("should allow factory invocation for openclaw runtime", async () => {
      const openclawAdapter = {
        id: "openclaw",
        name: "OpenClaw Runtime",
        createSession: vi.fn(),
        promptWithFallback: vi.fn(),
        describeModel: vi.fn(),
        dispose: vi.fn(),
      };
      const openclawRuntime = {
        metadata: {
          runtimeId: "openclaw",
          name: "OpenClaw Runtime",
          description: "OpenClaw-backed AI session using the user's configured pi provider and model",
          version: "0.1.0",
        },
        factory: vi.fn().mockResolvedValue(openclawAdapter),
      };
      mockPluginLoader.getPluginRuntimes.mockReturnValue([
        { pluginId: "fusion-plugin-openclaw-runtime", runtime: openclawRuntime as any },
      ]);

      const result = pluginRunner.getRuntimeById("openclaw");
      expect(result).toBeDefined();

      const context = { pluginId: "fusion-plugin-openclaw-runtime" };
      const runtime = (await result!.runtime.factory(context as any)) as typeof openclawAdapter;

      expect(openclawRuntime.factory).toHaveBeenCalledWith(context);
      expect(runtime).toBe(openclawAdapter);
      expect(runtime.id).toBe("openclaw");
      expect(runtime.name).toBe("OpenClaw Runtime");
      expect(runtime.createSession).toBeTypeOf("function");
      expect(runtime.promptWithFallback).toBeTypeOf("function");
      expect(runtime.describeModel).toBeTypeOf("function");
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
    /*
    FNXC:PluginRunnerTests 2026-07-02-17:20:
    PluginRunner lifecycle handlers intentionally fire-and-forget their hook dispatch, so tests must wait for the mocked invokeHook promise chain to settle before asserting.
    Use a bounded microtask flush instead of real wall-clock sleeps because FN-5048 forbids deterministic test settling through setTimeout delays when no production timer behavior is under test.
    */
    const flushMicrotasks = async (turns = 4): Promise<void> => {
      for (let turn = 0; turn < turns; turn += 1) {
        await Promise.resolve();
      }
    };

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

      // Let the fire-and-forget hook chain settle via microtasks (no real sleep).
      await flushMicrotasks();

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

      // Let the fire-and-forget hook chain settle via microtasks (no real sleep).
      await flushMicrotasks();

      expect(mockPluginLoader.invokeHook).toHaveBeenCalledWith(
        "onTaskMoved",
        mockTask,
        "todo",
        "in-progress"
      );
    });

    it("should invoke onTaskCompleted through the loader seam when task moves to done", async () => {
      const completedHook = vi.fn();
      const runtimeCtx = {
        pluginId: "test-plugin",
        taskStore: mockTaskStore,
        settings: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        emitEvent: vi.fn(),
      };
      mockPluginLoader.invokeHook = vi.fn(async (hookName: keyof FusionPlugin["hooks"], ...args: unknown[]) => {
        if (hookName === "onTaskCompleted") {
          completedHook(args[0], runtimeCtx);
        }
      });
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

      // Let the fire-and-forget hook chain settle via microtasks (no real sleep).
      await flushMicrotasks();

      expect(mockPluginLoader.invokeHook).toHaveBeenCalledWith(
        "onTaskCompleted",
        mockTask
      );
      expect(completedHook).toHaveBeenCalledWith(
        mockTask,
        expect.objectContaining({
          taskStore: mockTaskStore,
          settings: {},
          logger: expect.any(Object),
          emitEvent: expect.any(Function),
        })
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

      // Let the fire-and-forget hook chain settle via microtasks (no real sleep).
      await flushMicrotasks();

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

  describe("interactive AI session injection boundary", () => {
    it("does NOT expose createInteractiveAiSession on runtime contexts (parity with createAiSession)", async () => {
      // Register a factory the way the engine module-load block would.
      const core = await import("@fusion/core");
      core.setCreateInteractiveAiSessionFactory(
        async () => ({ session: {} as never }),
      );
      try {
        mockPluginLoader.getPlugin.mockReturnValue(createMockPlugin({ state: "started" }));
        const ctx = await pluginRunner.createRuntimeContext("test-plugin");
        expect(ctx).not.toBeNull();
        // Tool/runtime contexts must not receive the interactive factory,
        // exactly as they do not receive createAiSession.
        expect(ctx?.createAiSession).toBeUndefined();
        expect(ctx?.createInteractiveAiSession).toBeUndefined();
      } finally {
        core.setCreateInteractiveAiSessionFactory(undefined);
      }
    });
  });
});
