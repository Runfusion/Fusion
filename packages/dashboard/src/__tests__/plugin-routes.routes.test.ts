// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore } from "@fusion/core";
import { PluginLoader, type PluginInstallation, type PluginStore } from "@fusion/core";
import { PluginRunner } from "@fusion/engine";
import { createApiRoutes } from "../routes.js";
import { createPluginRouter } from "../plugin-routes.js";
import { get as performGet, request as performRequest } from "../test-request.js";
import * as projectStoreResolver from "../project-store-resolver.js";

// Mock @fusion/core
const mockCentralInit = vi.fn().mockResolvedValue(undefined);
const mockCentralClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: vi.fn().mockImplementation(function () { return {
      init: mockCentralInit,
      close: mockCentralClose,
    }; }),
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
    getPluginUiSlots: vi.fn().mockReturnValue([]),
    getPluginUiContributions: vi.fn().mockReturnValue([]),
    getPluginRuntimes: vi.fn().mockReturnValue([]),
    getCliProviderContributions: vi.fn().mockReturnValue([]),
    getPluginSkills: vi.fn().mockReturnValue([]),
    getPluginWorkflowSteps: vi.fn().mockReturnValue([]),
    getPluginWorkflowExtensions: vi.fn().mockReturnValue([]),
    getPluginWorkflowStepTemplates: vi.fn().mockReturnValue([]),
    getPluginPromptContributions: vi.fn().mockReturnValue([]),
    loadAllPlugins: vi.fn().mockResolvedValue({ loaded: 0, errors: 0 }),
    stopAllPlugins: vi.fn().mockResolvedValue(undefined),
    invokeHook: vi.fn().mockResolvedValue(undefined),
    reloadPlugin: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    createRouteContext: vi.fn().mockImplementation(async (pluginId: string, ctx: Record<string, unknown>) => ({
      pluginId,
      taskStore: ctx.taskStore,
      settings: ctx.settings ?? {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
      createAiSession: (ctx as { createAiSession?: unknown }).createAiSession,
      resolveProjectTaskStore: ctx.resolveProjectTaskStore,
    })),
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
    /*
    FNXC:PluginMcpServers 2026-07-24-01:25:
    FN-8491 (3cd023fa4) binds a project-scoped plugin-MCP provider on every getProjectContext.
    Exposing getProjectScopedPluginMcpServers marks these mocks (host AND projectId-scoped
    stores) as runtime-owned so the binder short-circuits instead of building a fallback
    loader over the mocked PluginStore, whose missing init() 500'd every scoped route.
    */
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
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

  it("includes the Droid plugin in installed plugin listings", async () => {
    (pluginStore.listPlugins as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        ...FAKE_PLUGIN,
        id: "fusion-plugin-droid-runtime",
        name: "Droid Runtime Plugin",
        version: "0.1.0",
      },
    ]);

    const res = await GET(buildApp(), "/api/plugins");

    expect(res.status).toBe(200);
    expect(pluginStore.listPlugins).toHaveBeenCalledWith({});
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "fusion-plugin-droid-runtime",
        name: "Droid Runtime Plugin",
        version: "0.1.0",
      }),
    ]);
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

describe("GET /plugins/registry (route-shadowing regression)", () => {
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

  // Regression: the generic "GET /plugins/:id" route is registered before the
  // plugin sub-router that owns "GET /plugins/registry". Without the pass-through
  // guard, "/api/plugins/registry" matched ":id" (id === "registry"), called
  // pluginStore.getPlugin("registry") and failed with 'Plugin "registry" not found'.
  it("serves the registry listing instead of being shadowed by /plugins/:id", async () => {
    const res = await GET(buildApp(), "/api/plugins/registry");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("plugins");
    expect(Array.isArray(res.body.plugins)).toBe(true);
    // The ":id" handler must NOT have been consulted for the literal "registry".
    expect(pluginStore.getPlugin as ReturnType<typeof vi.fn>).not.toHaveBeenCalledWith("registry");
  });
});

describe("GET /plugins/:id/settings", () => {
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

  it("returns plugin settings by id", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FAKE_PLUGIN,
      settings: { apiKey: "secret", enabled: true },
    });

    const res = await GET(buildApp(), "/api/plugins/test-plugin/settings");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ apiKey: "secret", enabled: true });
  });

  it("returns 404 for non-existent non-bundled plugin", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('Plugin "nonexistent" not found'), { code: "ENOENT" }),
    );

    const res = await GET(buildApp(), "/api/plugins/nonexistent/settings");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns empty settings for bundled runtime plugin before first install", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('Plugin "fusion-plugin-hermes-runtime" not found'), { code: "ENOENT" }),
    );

    const res = await GET(buildApp(), "/api/plugins/fusion-plugin-hermes-runtime/settings");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it("supports projectId query param scoping", async () => {
    const scopedPluginStore = createMockPluginStore();
    (scopedPluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FAKE_PLUGIN,
      settings: { scoped: true },
    });
    const scopedStore = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(scopedPluginStore),
    });
    mockGetOrCreateProjectStore.mockResolvedValue(scopedStore);

    const res = await GET(buildApp(), "/api/plugins/test-plugin/settings?projectId=proj_123");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scoped: true });
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

  it("initializes one fallback loader before project-scoped introspection", async () => {
    const scopedPluginStore = createMockPluginStore({ listPlugins: vi.fn().mockResolvedValue([]) });
    const scopedStore = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(scopedPluginStore),
      on: vi.fn(),
      off: vi.fn(),
    });
    mockGetOrCreateProjectStore.mockResolvedValue(scopedStore);
    const loadAll = vi.spyOn(PluginLoader.prototype, "loadAllPlugins");
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { pluginStore, pluginLoader }));

    try {
      expect((await GET(app, "/api/plugins/ui-slots?projectId=project-p")).status).toBe(200);
      expect((await GET(app, "/api/plugins/ui-contributions?projectId=project-p")).status).toBe(200);
      expect(loadAll).toHaveBeenCalledTimes(1);
    } finally {
      loadAll.mockRestore();
    }
  });

  it("keeps the enable route and real engine startup reader scoped to the managed project", async () => {
    const hostLoader = pluginLoader;
    const pluginDir = await mkdtemp(join(tmpdir(), "fusion-plugin-scope-"));
    const entryPath = join(pluginDir, "plugin.mjs");
    await writeFile(entryPath, `
      const plugin = {
        manifest: { id: "test-plugin", name: "Test Plugin", version: "1.0.0" },
        hooks: {}, tools: [], routes: [],
      };
      export default plugin;
    `);
    const projectPlugin: PluginInstallation = {
      ...FAKE_PLUGIN,
      enabled: false,
      path: entryPath,
      state: "installed",
    };
    const projectPluginStore = createMockPluginStore({
      enablePlugin: vi.fn(async () => {
        projectPlugin.enabled = true;
        return { ...projectPlugin };
      }),
      getPlugin: vi.fn(async () => ({ ...projectPlugin })),
      listPlugins: vi.fn(async (filter?: { enabled?: boolean }) =>
        filter?.enabled === true && !projectPlugin.enabled ? [] : [{ ...projectPlugin }]),
      updatePluginState: vi.fn(async (_id, state) => {
        projectPlugin.state = state as PluginInstallation["state"];
        return { ...projectPlugin };
      }),
      on: vi.fn(),
      off: vi.fn(),
    });
    const projectStore = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(projectPluginStore),
      getRootDir: vi.fn().mockReturnValue("/managed/project-p"),
      preflightPluginSchema: vi.fn().mockReturnValue(null),
      runPluginSchemaInits: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      off: vi.fn(),
    });
    const projectLoader = new PluginLoader({
      pluginStore: projectPluginStore,
      taskStore: projectStore,
    });
    const warn = vi.spyOn((projectLoader as any).log, "warn");
    const projectRunner = new PluginRunner({
      pluginLoader: projectLoader,
      pluginStore: projectPluginStore,
      taskStore: projectStore,
      rootDir: "/managed/project-p",
    });
    const projectEngine = {
      getTaskStore: vi.fn().mockReturnValue(projectStore),
      getPluginRunner: vi.fn().mockReturnValue(projectRunner),
    };
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, {
      pluginStore,
      pluginLoader: hostLoader,
      engineManager: { getEngine: vi.fn().mockReturnValue(projectEngine) } as any,
    }));

    try {
      const enabled = await REQUEST(app, "POST", "/api/plugins/test-plugin/enable?projectId=project-p", {});
      const listed = await GET(app, "/api/plugins?projectId=project-p");
      await projectRunner.init();

      expect(enabled.status).toBe(200);
      expect(enabled.body).toMatchObject({ id: "test-plugin", enabled: true });
      expect(listed.body).toEqual([expect.objectContaining({ id: "test-plugin", enabled: true })]);
      expect(projectLoader.isPluginLoaded("test-plugin")).toBe(true);
      expect(warn).not.toHaveBeenCalledWith("Skipped disabled plugin during loadAllPlugins: test-plugin");
      expect(hostLoader.loadPlugin).not.toHaveBeenCalled();
      expect(hostLoader.loadAllPlugins).not.toHaveBeenCalled();
    } finally {
      await rm(pluginDir, { recursive: true, force: true });
    }
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

describe("POST /plugins/:id/reload", () => {
  let store: TaskStore;
  let pluginStore: PluginStore;
  let pluginLoader: PluginLoader;
  let pluginRunner: {
    getPluginRoutes: ReturnType<typeof vi.fn>;
    reloadPlugin: ReturnType<typeof vi.fn>;
    checkPluginSetup: ReturnType<typeof vi.fn>;
    installPluginSetup: ReturnType<typeof vi.fn>;
    uninstallPluginSetup: ReturnType<typeof vi.fn>;
    getPluginSetupInfo: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    pluginStore = createMockPluginStore();
    pluginLoader = createMockPluginLoader();
    pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([]),
      reloadPlugin: vi.fn().mockResolvedValue(undefined),
      checkPluginSetup: vi.fn().mockResolvedValue({ status: "installed" }),
      installPluginSetup: vi.fn().mockResolvedValue({ success: true }),
      uninstallPluginSetup: vi.fn().mockResolvedValue({ success: true }),
      getPluginSetupInfo: vi.fn().mockReturnValue([]),
    };
    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
  });

  function buildApp(includeRunner = true) {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, {
      pluginStore,
      pluginLoader,
      pluginRunner: includeRunner ? pluginRunner : undefined,
    }));
    return app;
  }

  it("reloads a started plugin", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...FAKE_PLUGIN, state: "started" })
      .mockResolvedValueOnce({ ...FAKE_PLUGIN, state: "started", updatedAt: "2026-02-01T00:00:00.000Z" });

    const res = await REQUEST(buildApp(), "POST", "/api/plugins/test-plugin/reload", {});

    expect(res.status).toBe(200);
    expect(pluginLoader.reloadPlugin).toHaveBeenCalledWith("test-plugin");
    expect(res.body.id).toBe("test-plugin");
  });

  it("returns 404 when plugin is not found", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('Plugin "nonexistent" not found'), { code: "ENOENT" }),
    );

    const res = await REQUEST(buildApp(), "POST", "/api/plugins/nonexistent/reload", {});

    expect(res.status).toBe(404);
  });

  it("returns 400 when plugin is not started", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FAKE_PLUGIN,
      state: "installed",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/plugins/test-plugin/reload", {});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Use enable instead");
  });

  it("uses the scoped loader when the host runner is unavailable", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FAKE_PLUGIN,
      state: "started",
    });

    const res = await REQUEST(buildApp(false), "POST", "/api/plugins/test-plugin/reload", {});

    expect(res.status).toBe(200);
    expect(pluginLoader.reloadPlugin).toHaveBeenCalledWith("test-plugin");
  });

  it("returns 500 when reload operation fails", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FAKE_PLUGIN,
      state: "started",
    });
    (pluginLoader.reloadPlugin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));

    const res = await REQUEST(buildApp(), "POST", "/api/plugins/test-plugin/reload", {});

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Reload failed: boom");
  });
});

describe("plugin setup routes", () => {
  let store: TaskStore;
  let pluginStore: PluginStore;
  let pluginRunner: {
    getPluginRoutes: ReturnType<typeof vi.fn>;
    checkPluginSetup: ReturnType<typeof vi.fn>;
    installPluginSetup: ReturnType<typeof vi.fn>;
    uninstallPluginSetup: ReturnType<typeof vi.fn>;
    getPluginSetupInfo: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    pluginStore = createMockPluginStore();
    pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([]),
      checkPluginSetup: vi.fn().mockResolvedValue({ status: "installed", version: "1.0.0" }),
      installPluginSetup: vi.fn().mockResolvedValue({ success: true }),
      uninstallPluginSetup: vi.fn().mockResolvedValue({ success: true }),
      getPluginSetupInfo: vi.fn().mockReturnValue([]),
    };
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
      pluginRunner,
    }));
    return app;
  }

  it("GET /plugins/:id/setup-status returns hasSetup true result", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...FAKE_PLUGIN, state: "started" });
    pluginRunner.getPluginSetupInfo.mockReturnValueOnce([
      {
        pluginId: "test-plugin",
        manifest: { binaryName: "agent-browser", description: "Binary" },
        hooks: { checkSetup: vi.fn() },
      },
    ]);

    const res = await REQUEST(buildApp(), "GET", "/api/plugins/test-plugin/setup-status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasSetup: true, status: "installed", version: "1.0.0" });
  });

  it("GET /plugins/:id/setup-status returns hasSetup false when no setup", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...FAKE_PLUGIN, state: "started" });
    pluginRunner.getPluginSetupInfo.mockReturnValueOnce([]);

    const res = await REQUEST(buildApp(), "GET", "/api/plugins/test-plugin/setup-status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasSetup: false });
  });

  it("GET /plugins/:id/setup-status returns deferred status when plugin is not started", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...FAKE_PLUGIN, state: "installed" });
    pluginRunner.getPluginSetupInfo.mockReturnValueOnce([
      {
        pluginId: "test-plugin",
        manifest: { binaryName: "agent-browser", description: "Binary" },
        hooks: { checkSetup: vi.fn() },
      },
    ]);

    const res = await REQUEST(buildApp(), "GET", "/api/plugins/test-plugin/setup-status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hasSetup: true,
      setupCheckDeferred: true,
      deferredReason: "plugin-not-started",
      pluginState: "installed",
    });
    expect(pluginRunner.checkPluginSetup).not.toHaveBeenCalled();
  });

  it("GET /plugins/:id/setup-status returns 404 for nonexistent plugin", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Plugin "missing" not found'));

    const res = await REQUEST(buildApp(), "GET", "/api/plugins/missing/setup-status");
    expect(res.status).toBe(404);
  });

  it("POST /plugins/:id/setup/install returns success true", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...FAKE_PLUGIN, enabled: true });
    pluginRunner.getPluginSetupInfo.mockReturnValueOnce([
      {
        pluginId: "test-plugin",
        manifest: { binaryName: "agent-browser", description: "Binary" },
        hooks: { checkSetup: vi.fn(), install: vi.fn() },
      },
    ]);

    const res = await REQUEST(buildApp(), "POST", "/api/plugins/test-plugin/setup/install", {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it("POST /plugins/:id/setup/install returns setup failure result", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...FAKE_PLUGIN, enabled: true });
    pluginRunner.getPluginSetupInfo.mockReturnValueOnce([
      {
        pluginId: "test-plugin",
        manifest: { binaryName: "agent-browser", description: "Binary" },
        hooks: { checkSetup: vi.fn(), install: vi.fn() },
      },
    ]);
    pluginRunner.installPluginSetup.mockResolvedValueOnce({ success: false, error: "install failed" });

    const res = await REQUEST(buildApp(), "POST", "/api/plugins/test-plugin/setup/install", {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: false, error: "install failed" });
  });

  it("POST /plugins/:id/setup/install returns 400 when no install hook", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...FAKE_PLUGIN, enabled: true });
    pluginRunner.getPluginSetupInfo.mockReturnValueOnce([
      {
        pluginId: "test-plugin",
        manifest: { binaryName: "agent-browser", description: "Binary" },
        hooks: { checkSetup: vi.fn() },
      },
    ]);

    const res = await REQUEST(buildApp(), "POST", "/api/plugins/test-plugin/setup/install", {});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no install hook");
  });

  it("POST /plugins/:id/setup/uninstall returns success and failure results", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValue({ ...FAKE_PLUGIN, enabled: true });
    pluginRunner.getPluginSetupInfo.mockReturnValue([
      {
        pluginId: "test-plugin",
        manifest: { binaryName: "agent-browser", description: "Binary" },
        hooks: { checkSetup: vi.fn(), uninstall: vi.fn() },
      },
    ]);

    const successRes = await REQUEST(buildApp(), "POST", "/api/plugins/test-plugin/setup/uninstall", {});
    expect(successRes.status).toBe(200);
    expect(successRes.body).toEqual({ success: true });

    pluginRunner.uninstallPluginSetup.mockResolvedValueOnce({ success: false, error: "uninstall failed" });
    const failureRes = await REQUEST(buildApp(), "POST", "/api/plugins/test-plugin/setup/uninstall", {});
    expect(failureRes.status).toBe(200);
    expect(failureRes.body).toEqual({ success: false, error: "uninstall failed" });
  });
});

describe("PUT /plugins/:id/settings", () => {
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

    const res = await REQUEST(buildApp(), "PUT", "/api/plugins/test-plugin/settings", {
      settings: { apiKey: "new-secret" },
    });

    expect(res.status).toBe(200);
    expect(pluginStore.updatePluginSettings).toHaveBeenCalledWith("test-plugin", { apiKey: "new-secret" });
  });

  it("returns 400 when settings is missing", async () => {
    const res = await REQUEST(buildApp(), "PUT", "/api/plugins/test-plugin/settings", {});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("'settings'");
  });

  it("returns 404 when plugin not found", async () => {
    (pluginStore.updatePluginSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('Plugin "nonexistent" not found'), { code: "ENOENT" }),
    );

    const res = await REQUEST(buildApp(), "PUT", "/api/plugins/nonexistent/settings", {
      settings: { key: "value" },
    });

    expect(res.status).toBe(404);
  });

  it("returns 400 when settings validation fails", async () => {
    (pluginStore.updatePluginSettings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Settings validation failed: setting 'apiKey' is required"),
    );

    const res = await REQUEST(buildApp(), "PUT", "/api/plugins/test-plugin/settings", {
      settings: {},
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("validation failed");
  });
});

describe("PUT /plugins/:id/settings auto-install for bundled runtime plugins", () => {
  let store: TaskStore;
  let pluginStore: PluginStore;

  beforeEach(() => {
    pluginStore = createMockPluginStore();
    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
  });

  function buildAppWithBundleHook(
    ensureBundledPluginInstalled: (id: string) => Promise<boolean>,
  ) {
    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      createApiRoutes(store, {
        pluginStore,
        pluginLoader: createMockPluginLoader(),
        ensureBundledPluginInstalled,
      }),
    );
    return app;
  }

  it("auto-installs a bundled runtime plugin on first save", async () => {
    // Plugin not yet registered → first getPlugin throws.
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Plugin not found"),
    );
    (pluginStore.updatePluginSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...FAKE_PLUGIN,
      id: "fusion-plugin-hermes-runtime",
      settings: { apiKey: "k" },
    });
    const ensure = vi.fn().mockResolvedValue(true);

    const res = await REQUEST(
      buildAppWithBundleHook(ensure),
      "PUT",
      "/api/plugins/fusion-plugin-hermes-runtime/settings",
      { settings: { apiKey: "k" } },
    );

    expect(res.status).toBe(200);
    expect(ensure).toHaveBeenCalledWith("fusion-plugin-hermes-runtime");
    expect(pluginStore.updatePluginSettings).toHaveBeenCalled();
  });

  it("skips auto-install when the plugin is already registered", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FAKE_PLUGIN);
    (pluginStore.updatePluginSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FAKE_PLUGIN);
    const ensure = vi.fn().mockResolvedValue(true);

    const res = await REQUEST(
      buildAppWithBundleHook(ensure),
      "PUT",
      "/api/plugins/fusion-plugin-hermes-runtime/settings",
      { settings: { apiKey: "k" } },
    );

    expect(res.status).toBe(200);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("does not invoke auto-install for non-bundled plugin ids", async () => {
    (pluginStore.updatePluginSettings as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FAKE_PLUGIN);
    const ensure = vi.fn().mockResolvedValue(true);

    const res = await REQUEST(
      buildAppWithBundleHook(ensure),
      "PUT",
      "/api/plugins/some-third-party-plugin/settings",
      { settings: { apiKey: "k" } },
    );

    expect(res.status).toBe(200);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("returns 500 with intentional message when bundled auto-install reports missing bundle", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Plugin not found"),
    );
    const ensure = vi.fn().mockResolvedValue(false);

    const res = await REQUEST(
      buildAppWithBundleHook(ensure),
      "PUT",
      "/api/plugins/fusion-plugin-hermes-runtime/settings",
      { settings: { apiKey: "k" } },
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("is unavailable in this build");
  });

  it("returns 500 when auto-install throws", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Plugin not found"),
    );
    const ensure = vi.fn().mockRejectedValue(new Error("bundle missing"));

    const res = await REQUEST(
      buildAppWithBundleHook(ensure),
      "PUT",
      "/api/plugins/fusion-plugin-hermes-runtime/settings",
      { settings: { apiKey: "k" } },
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Failed to auto-install");
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

describe("plugin-defined route dispatch", () => {
  it("dispatches PATCH routes from plugins", async () => {
    // FNXC:PluginRoutes 2026-07-22-20:30: plugin routes are dispatched dynamically per
    // request now, so assert observable dispatch behavior instead of inspecting the
    // boot-time Express router stack (which no longer contains plugin routes).
    const patchHandler = vi.fn().mockResolvedValue({ patched: true });
    const pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([
        { pluginId: "fusion-plugin-roadmap", route: { method: "PATCH", path: "/roadmaps/x", handler: patchHandler } },
      ]),
    };

    const pluginStore = createMockPluginStore();
    const router = createPluginRouter(pluginStore, createMockPluginLoader({
      createRouteContext: vi.fn().mockResolvedValue({
        pluginId: "fusion-plugin-roadmap",
        taskStore: createMockTaskStore(),
        settings: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        emitEvent: vi.fn(),
      }),
      getPlugin: vi.fn().mockReturnValue({ manifest: { id: "fusion-plugin-roadmap" } }),
    } as any), pluginRunner as any, createMockTaskStore());

    const app = express();
    app.use(express.json());
    app.use("/api/plugins", router);

    const res = await REQUEST(app, "PATCH", "/api/plugins/fusion-plugin-roadmap/roadmaps/x", {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ patched: true });
    expect(patchHandler).toHaveBeenCalled();
  });

  it("passes scoped taskStore and createAiSession through pluginLoader.createRouteContext", async () => {
    const routeHandler = vi.fn().mockResolvedValue({ ok: true });
    const pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([
        { pluginId: "fusion-plugin-roadmap", route: { method: "POST", path: "/ctx-check", handler: routeHandler } },
      ]),
    };
    const scopedPluginStore = createMockPluginStore();
    const scopedTaskStore = createMockTaskStore({ getPluginStore: vi.fn().mockReturnValue(scopedPluginStore) });
    mockGetOrCreateProjectStore.mockResolvedValue(scopedTaskStore);
    const createRouteContext = vi.fn().mockImplementation(async (_pluginId: string, overrides: any) => ({
      pluginId: "fusion-plugin-roadmap",
      taskStore: overrides.taskStore,
      settings: overrides.settings,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent: vi.fn(),
      createAiSession: vi.fn(),
      resolveProjectTaskStore: overrides.resolveProjectTaskStore,
    }));
    const pluginLoader = createMockPluginLoader({
      createRouteContext,
      getPlugin: vi.fn().mockReturnValue({ manifest: { id: "fusion-plugin-roadmap" } }),
    } as any);
    const pluginStore = createMockPluginStore();

    const app = express();
    app.use(express.json());
    app.use("/api/plugins", createPluginRouter(pluginStore, pluginLoader, pluginRunner as any, createMockTaskStore()));

    const res = await REQUEST(app, "POST", "/api/plugins/fusion-plugin-roadmap/ctx-check", { projectId: "proj_123" });
    expect(res.status).toBe(200);
    expect(createRouteContext).toHaveBeenCalledWith("fusion-plugin-roadmap", expect.objectContaining({
      taskStore: scopedTaskStore,
      resolveProjectTaskStore: projectStoreResolver.getOrCreateProjectStore,
    }));
    expect(routeHandler).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskStore: scopedTaskStore, createAiSession: expect.any(Function) }),
    );
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
