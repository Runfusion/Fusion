// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { TaskStore } from "@fusion/core";
import type { PluginInstallation } from "@fusion/core";
import type { PluginStore } from "@fusion/core";
import type { PluginLoader } from "@fusion/core";
import { createApiRoutes } from "./routes.js";
import { get as performGet, request as performRequest } from "./test-request.js";
import * as projectStoreResolver from "./project-store-resolver.js";

// Mock @fusion/core
const mockCentralInit = vi.fn().mockResolvedValue(undefined);
const mockCentralClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: vi.fn().mockImplementation(() => ({
      init: mockCentralInit,
      close: mockCentralClose,
    })),
  };
});

// Mock project store resolver
const mockGetOrCreateProjectStore = vi.fn();
vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockImplementation(mockGetOrCreateProjectStore);

function createMockPluginStore(overrides: Partial<PluginStore> = {}): PluginStore {
  return {
    listPlugins: vi.fn().mockResolvedValue([]),
    getPlugin: vi.fn(),
    registerPlugin: vi.fn(),
    unregisterPlugin: vi.fn(),
    enablePlugin: vi.fn(),
    disablePlugin: vi.fn(),
    updatePluginSettings: vi.fn(),
    updatePluginState: vi.fn(),
    updatePlugin: vi.fn(),
    ...overrides,
  } as unknown as PluginStore;
}

function createMockPluginLoader(overrides: Partial<PluginLoader> = {}): PluginLoader {
  return {
    loadPlugin: vi.fn().mockResolvedValue(undefined),
    stopPlugin: vi.fn().mockResolvedValue(undefined),
    getPlugin: vi.fn(),
    getLoadedPlugins: vi.fn().mockReturnValue([]),
    getPluginTools: vi.fn().mockReturnValue([]),
    getPluginRoutes: vi.fn().mockReturnValue([]),
    loadAllPlugins: vi.fn().mockResolvedValue({ loaded: 0, errors: 0 }),
    stopAllPlugins: vi.fn().mockResolvedValue(undefined),
    invokeHook: vi.fn().mockResolvedValue(undefined),
    reloadPlugin: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PluginLoader;
}

function createMockTaskStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    searchTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn(),
    updateGlobalSettings: vi.fn(),
    getSettingsByScope: vi.fn().mockResolvedValue({ global: {}, project: {} }),
    getGlobalSettingsStore: vi.fn().mockReturnValue({
      getSettings: vi.fn().mockResolvedValue({}),
      updateSettings: vi.fn().mockResolvedValue({}),
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getAgentLogs: vi.fn().mockResolvedValue([]),
    getAgentLogsByTimeRange: vi.fn().mockResolvedValue([]),
    addSteeringComment: vi.fn(),
    addTaskComment: vi.fn(),
    updateTaskComment: vi.fn(),
    deleteTaskComment: vi.fn(),
    updatePrInfo: vi.fn().mockResolvedValue(undefined),
    updateIssueInfo: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/fake/root"),
    getFusionDir: vi.fn().mockReturnValue("/fake/root/.fusion"),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    createWorkflowStep: vi.fn(),
    getWorkflowStep: vi.fn(),
    updateWorkflowStep: vi.fn(),
    deleteWorkflowStep: vi.fn(),
    getMissionStore: vi.fn().mockReturnValue({
      listMissions: vi.fn().mockReturnValue([]),
      createMission: vi.fn(),
      getMissionWithHierarchy: vi.fn(),
      updateMission: vi.fn(),
      getMission: vi.fn(),
      deleteMission: vi.fn(),
      listMilestonesByMission: vi.fn().mockReturnValue([]),
      createMilestone: vi.fn(),
      updateMilestone: vi.fn(),
      getMilestone: vi.fn(),
      deleteMilestone: vi.fn(),
      listTasksByMilestone: vi.fn().mockReturnValue([]),
      createMissionTask: vi.fn(),
      updateMissionTask: vi.fn(),
      getMissionTask: vi.fn(),
      deleteMissionTask: vi.fn(),
    }),
    getPluginStore: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

const FAKE_PLUGIN: PluginInstallation = {
  id: "test-plugin",
  name: "Test Plugin",
  version: "1.0.0",
  description: "A test plugin",
  path: "/path/to/plugin",
  enabled: true,
  state: "installed",
  settings: {},
  dependencies: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

async function GET(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  const res = await performGet(app, path);
  return { status: res.status, body: res.body };
}

async function REQUEST(
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await performRequest(
    app,
    method,
    path,
    body ? JSON.stringify(body) : undefined,
    body ? { "content-type": "application/json" } : undefined,
  );
  return { status: res.status, body: res.body };
}

describe("GET /plugins", () => {
  let store: TaskStore;
  let pluginStore: PluginStore;

  beforeEach(() => {
    pluginStore = createMockPluginStore();
    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, {
      pluginStore,
      pluginLoader: createMockPluginLoader(),
    }));
    return app;
  }

  it("returns empty array when no plugins", async () => {
    const res = await GET(buildApp(), "/api/plugins");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(pluginStore.listPlugins).toHaveBeenCalledWith({});
  });

  it("returns list of plugins", async () => {
    (pluginStore.listPlugins as ReturnType<typeof vi.fn>).mockResolvedValueOnce([FAKE_PLUGIN]);

    const res = await GET(buildApp(), "/api/plugins");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: "test-plugin",
      name: "Test Plugin",
    });
  });

  it("filters plugins by enabled status", async () => {
    const res = await GET(buildApp(), "/api/plugins?enabled=true");

    expect(res.status).toBe(200);
    expect(pluginStore.listPlugins).toHaveBeenCalledWith({ enabled: true });
  });

  it("filters plugins by disabled status", async () => {
    const res = await GET(buildApp(), "/api/plugins?enabled=false");

    expect(res.status).toBe(200);
    expect(pluginStore.listPlugins).toHaveBeenCalledWith({ enabled: false });
  });
});

describe("GET /plugins/:id", () => {
  let store: TaskStore;
  let pluginStore: PluginStore;

  beforeEach(() => {
    pluginStore = createMockPluginStore();
    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, {
      pluginStore,
      pluginLoader: createMockPluginLoader(),
    }));
    return app;
  }

  it("returns plugin by id", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FAKE_PLUGIN);

    const res = await GET(buildApp(), "/api/plugins/test-plugin");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "test-plugin",
      name: "Test Plugin",
    });
  });

  it("returns 404 for non-existent plugin", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('Plugin "nonexistent" not found'), { code: "ENOENT" }),
    );

    const res = await GET(buildApp(), "/api/plugins/nonexistent");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("supports projectId query param scoping", async () => {
    // Set up mock for scoped store with projectId
    const scopedPluginStore = createMockPluginStore();
    (scopedPluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FAKE_PLUGIN);
    const scopedStore = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(scopedPluginStore),
    });
    mockGetOrCreateProjectStore.mockResolvedValue(scopedStore);

    const res = await GET(buildApp(), "/api/plugins/test-plugin?projectId=proj_123");

    expect(res.status).toBe(200);
    expect(mockGetOrCreateProjectStore).toHaveBeenCalledWith("proj_123");
  });
});

describe("POST /plugins", () => {
  let store: TaskStore;
  let pluginStore: PluginStore;
  let pluginLoader: PluginLoader;

  beforeEach(() => {
    pluginStore = createMockPluginStore();
    pluginLoader = createMockPluginLoader();
    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, {
      pluginStore,
      pluginLoader,
    }));
    return app;
  }

  describe("mode: register", () => {
    it("registers a plugin with required fields", async () => {
      (pluginStore.registerPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FAKE_PLUGIN);

      const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
        mode: "register",
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        path: "/path/to/plugin",
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        id: "test-plugin",
        name: "Test Plugin",
      });
      expect(pluginStore.registerPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          manifest: expect.objectContaining({
            id: "test-plugin",
            name: "Test Plugin",
            version: "1.0.0",
          }),
          path: "/path/to/plugin",
        }),
      );
    });

    it("registers a plugin with optional fields", async () => {
      (pluginStore.registerPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ...FAKE_PLUGIN,
        description: "A test plugin",
        author: "Test Author",
      });

      const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
        mode: "register",
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        path: "/path/to/plugin",
        description: "A test plugin",
        author: "Test Author",
        settings: { apiKey: "secret" },
      });

      expect(res.status).toBe(201);
      expect(pluginStore.registerPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          manifest: expect.objectContaining({
            description: "A test plugin",
            author: "Test Author",
          }),
          settings: { apiKey: "secret" },
        }),
      );
    });

    it("loads plugin after registration when enabled", async () => {
      (pluginStore.registerPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FAKE_PLUGIN);

      await REQUEST(buildApp(), "POST", "/api/plugins", {
        mode: "register",
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        path: "/path/to/plugin",
        enabled: true,
      });

      // Plugin should be loaded after registration
      expect(pluginLoader.loadPlugin).toHaveBeenCalledWith("test-plugin");
    });

    it("returns 400 when mode is missing", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        path: "/path/to/plugin",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("mode");
    });

    it("returns 400 when id is missing", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
        mode: "register",
        name: "Test Plugin",
        version: "1.0.0",
        path: "/path/to/plugin",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("'id' is required");
    });

    it("returns 400 when name is missing", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
        mode: "register",
        id: "test-plugin",
        version: "1.0.0",
        path: "/path/to/plugin",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("'name' is required");
    });

    it("returns 400 when version is missing", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
        mode: "register",
        id: "test-plugin",
        name: "Test Plugin",
        path: "/path/to/plugin",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("'version' is required");
    });

    it("returns 400 when path is missing", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
        mode: "register",
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("'path' is required");
    });

    it("returns 409 when plugin is already registered", async () => {
      (pluginStore.registerPlugin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        Object.assign(new Error('Plugin "test-plugin" is already registered'), { code: "EEXISTS" }),
      );

      const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
        mode: "register",
        id: "test-plugin",
        name: "Test Plugin",
        version: "1.0.0",
        path: "/path/to/plugin",
      });

      expect(res.status).toBe(409);
    });
  });

  describe("mode: install", () => {
    it("returns 400 when plugin loader is not available", async () => {
      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(store, {
        pluginStore,
        // No pluginLoader
      }));

      const res = await REQUEST(app, "POST", "/api/plugins", {
        mode: "install",
        path: "/path/to/plugin",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("not supported");
    });
  });

  describe("invalid mode", () => {
    it("returns 400 for unknown mode", async () => {
      const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
        mode: "unknown",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid mode");
    });
  });
});

describe("POST /plugins/:id/enable", () => {
  let store: TaskStore;
  let pluginStore: PluginStore;
  let pluginLoader: PluginLoader;

  beforeEach(() => {
    pluginStore = createMockPluginStore();
    pluginLoader = createMockPluginLoader();
    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, {
      pluginStore,
      pluginLoader,
    }));
    return app;
  }

  it("enables a plugin and loads it", async () => {
    (pluginStore.enablePlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FAKE_PLUGIN);

    const res = await REQUEST(buildApp(), "POST", "/api/plugins/test-plugin/enable", {});

    expect(res.status).toBe(200);
    expect(pluginStore.enablePlugin).toHaveBeenCalledWith("test-plugin");
    expect(pluginLoader.loadPlugin).toHaveBeenCalledWith("test-plugin");
  });

  it("supports body-based projectId scoping", async () => {
    // Set up mock for scoped store with projectId
    const scopedPluginStore = createMockPluginStore();
    (scopedPluginStore.enablePlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FAKE_PLUGIN);
    const scopedStore = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(scopedPluginStore),
    });
    mockGetOrCreateProjectStore.mockResolvedValue(scopedStore);

    const res = await REQUEST(buildApp(), "POST", "/api/plugins/test-plugin/enable", {
      projectId: "proj_123",
    });

    expect(res.status).toBe(200);
    expect(mockGetOrCreateProjectStore).toHaveBeenCalledWith("proj_123");
  });
});

describe("POST /plugins/:id/disable", () => {
  let store: TaskStore;
  let pluginStore: PluginStore;
  let pluginLoader: PluginLoader;

  beforeEach(() => {
    pluginStore = createMockPluginStore();
    pluginLoader = createMockPluginLoader();
    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, {
      pluginStore,
      pluginLoader,
    }));
    return app;
  }

  it("disables a plugin and stops it", async () => {
    (pluginStore.disablePlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FAKE_PLUGIN,
      enabled: false,
    });

    const res = await REQUEST(buildApp(), "POST", "/api/plugins/test-plugin/disable", {});

    expect(res.status).toBe(200);
    expect(pluginStore.disablePlugin).toHaveBeenCalledWith("test-plugin");
    expect(pluginLoader.stopPlugin).toHaveBeenCalledWith("test-plugin");
  });

  it("supports body-based projectId scoping", async () => {
    // Set up mock for scoped store with projectId
    const scopedPluginStore = createMockPluginStore();
    (scopedPluginStore.disablePlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FAKE_PLUGIN,
      enabled: false,
    });
    const scopedStore = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(scopedPluginStore),
    });
    mockGetOrCreateProjectStore.mockResolvedValue(scopedStore);

    const res = await REQUEST(buildApp(), "POST", "/api/plugins/test-plugin/disable", {
      projectId: "proj_123",
    });

    expect(res.status).toBe(200);
    expect(mockGetOrCreateProjectStore).toHaveBeenCalledWith("proj_123");
  });
});

describe("PATCH /plugins/:id/settings", () => {
  let store: TaskStore;
  let pluginStore: PluginStore;

  beforeEach(() => {
    pluginStore = createMockPluginStore();
    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, {
      pluginStore,
      pluginLoader: createMockPluginLoader(),
    }));
    return app;
  }

  it("updates plugin settings", async () => {
    (pluginStore.updatePluginSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FAKE_PLUGIN,
      settings: { apiKey: "new-secret" },
    });

    const res = await REQUEST(buildApp(), "PATCH", "/api/plugins/test-plugin/settings", {
      settings: { apiKey: "new-secret" },
    });

    expect(res.status).toBe(200);
    expect(pluginStore.updatePluginSettings).toHaveBeenCalledWith("test-plugin", { apiKey: "new-secret" });
  });

  it("returns 400 when settings is missing", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/plugins/test-plugin/settings", {});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("'settings'");
  });

  it("returns 404 when plugin not found", async () => {
    (pluginStore.updatePluginSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('Plugin "nonexistent" not found'), { code: "ENOENT" }),
    );

    const res = await REQUEST(buildApp(), "PATCH", "/api/plugins/nonexistent/settings", {
      settings: { key: "value" },
    });

    expect(res.status).toBe(404);
  });

  it("returns 400 when settings validation fails", async () => {
    (pluginStore.updatePluginSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Settings validation failed: setting 'apiKey' is required"),
    );

    const res = await REQUEST(buildApp(), "PATCH", "/api/plugins/test-plugin/settings", {
      settings: {},
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("validation failed");
  });
});

describe("DELETE /plugins/:id", () => {
  let store: TaskStore;
  let pluginStore: PluginStore;
  let pluginLoader: PluginLoader;

  beforeEach(() => {
    pluginStore = createMockPluginStore();
    pluginLoader = createMockPluginLoader();
    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, {
      pluginStore,
      pluginLoader,
    }));
    return app;
  }

  it("unregisters a plugin", async () => {
    (pluginStore.unregisterPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FAKE_PLUGIN);

    const res = await REQUEST(buildApp(), "DELETE", "/api/plugins/test-plugin");

    expect(res.status).toBe(204);
    expect(pluginStore.unregisterPlugin).toHaveBeenCalledWith("test-plugin");
  });

  it("stops plugin before unregistering", async () => {
    (pluginStore.unregisterPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FAKE_PLUGIN);

    await REQUEST(buildApp(), "DELETE", "/api/plugins/test-plugin");

    // Should stop first, then unregister
    expect(pluginLoader.stopPlugin).toHaveBeenCalledWith("test-plugin");
    expect(pluginStore.unregisterPlugin).toHaveBeenCalledWith("test-plugin");
  });

  it("supports query-based projectId scoping", async () => {
    // Set up mock for scoped store with projectId
    const scopedPluginStore = createMockPluginStore();
    (scopedPluginStore.unregisterPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FAKE_PLUGIN);
    const scopedStore = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(scopedPluginStore),
    });
    mockGetOrCreateProjectStore.mockResolvedValue(scopedStore);

    const res = await REQUEST(buildApp(), "DELETE", "/api/plugins/test-plugin?projectId=proj_123");

    expect(res.status).toBe(204);
    expect(mockGetOrCreateProjectStore).toHaveBeenCalledWith("proj_123");
  });
});

describe("Project scoping", () => {
  let defaultPluginStore: PluginStore;
  let scopedPluginStore: PluginStore;
  let store: TaskStore;
  let scopedStore: TaskStore;

  beforeEach(() => {
    defaultPluginStore = createMockPluginStore({
      listPlugins: vi.fn().mockResolvedValue([{ ...FAKE_PLUGIN, id: "default-plugin" }]),
    });
    scopedPluginStore = createMockPluginStore({
      listPlugins: vi.fn().mockResolvedValue([{ ...FAKE_PLUGIN, id: "scoped-plugin" }]),
    });

    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(defaultPluginStore),
    });

    scopedStore = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(scopedPluginStore),
    });

    // Reset the mock
    mockGetOrCreateProjectStore.mockReset();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, {
      pluginStore: defaultPluginStore,
      pluginLoader: createMockPluginLoader(),
    }));
    return app;
  }

  it("uses default store without projectId", async () => {
    mockGetOrCreateProjectStore.mockResolvedValue(store);

    const res = await GET(buildApp(), "/api/plugins");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("default-plugin");
  });

  it("uses scoped store with projectId query param", async () => {
    mockGetOrCreateProjectStore.mockResolvedValue(scopedStore);

    const res = await GET(buildApp(), "/api/plugins?projectId=proj_123");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("scoped-plugin");
  });

  it("uses scoped store with projectId in request body", async () => {
    mockGetOrCreateProjectStore.mockResolvedValue(scopedStore);

    const res = await REQUEST(buildApp(), "POST", "/api/plugins/test-plugin/disable", {
      projectId: "proj_123",
    });

    expect(res.status).toBe(200);
    expect(mockGetOrCreateProjectStore).toHaveBeenCalledWith("proj_123");
  });
});
