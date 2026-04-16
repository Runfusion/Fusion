/**
 * Route-level regression tests for plugin install mode.
 *
 * Covers:
 * - POST /api/plugins mode:"install" with package-root path (manifest.json present)
 * - POST /api/plugins mode:"install" with dist-folder path (manifest.json present)
 * - Negative: missing manifest.json
 * - Negative: invalid JSON manifest
 * - Negative: manifest missing required fields
 * - Negative: empty / missing path
 * - Negative: missing mode discriminator
 */

// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import type { TaskStore, PluginStore, PluginLoader, PluginInstallation } from "@fusion/core";
import { createApiRoutes } from "./routes.js";
import { get as performGet, request as performRequest } from "./test-request.js";
import * as projectStoreResolver from "./project-store-resolver.js";

// ── Mock @fusion/core ─────────────────────────────────────────────
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

// ── Mock node:fs (used by install mode) ──────────────────────────
const mockExistsSync = vi.fn<(p: string) => boolean>().mockReturnValue(false);
const mockStatSync = vi.fn<(p: string) => { isDirectory: () => boolean }>().mockReturnValue({ isDirectory: () => true });
const mockReadFile = vi.fn<(p: string, enc: string) => Promise<string>>().mockRejectedValue(new Error("not found"));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => mockExistsSync(args[0] as string),
    statSync: (...args: Parameters<typeof actual.statSync>) => mockStatSync(args[0] as string),
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) =>
      mockReadFile(args[0] as string, (args[1] ?? "utf-8") as string),
  };
});

// ── Mock project store resolver ──────────────────────────────────
const mockGetOrCreateProjectStore = vi.fn();
vi.spyOn(projectStoreResolver, "getOrCreateProjectStore").mockImplementation(mockGetOrCreateProjectStore);

// ── Helpers ──────────────────────────────────────────────────────

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

const VALID_MANIFEST = {
  id: "my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  description: "A valid plugin",
};

const INSTALLED_PLUGIN: PluginInstallation = {
  id: "my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  description: "A valid plugin",
  path: "/home/user/plugins/my-plugin",
  enabled: true,
  state: "installed",
  settings: {},
  dependencies: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

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

// ══════════════════════════════════════════════════════════════════
describe("POST /api/plugins mode:install — package root path", () => {
  let pluginStore: PluginStore;
  let pluginLoader: PluginLoader;
  let store: TaskStore;

  beforeEach(() => {
    vi.clearAllMocks();
    pluginStore = createMockPluginStore();
    pluginLoader = createMockPluginLoader();
    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { pluginStore, pluginLoader }));
    return app;
  }

  it("accepts a package root with valid manifest.json and returns 201", async () => {
    const pkgRoot = "/home/user/plugins/my-plugin";
    mockExistsSync.mockImplementation((p: string) => p === pkgRoot || p === `${pkgRoot}/manifest.json`);
    mockReadFile.mockResolvedValue(JSON.stringify(VALID_MANIFEST));
    (pluginStore.registerPlugin as ReturnType<typeof vi.fn>).mockResolvedValue(INSTALLED_PLUGIN);

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: pkgRoot,
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "my-plugin", name: "My Plugin" });
    expect(pluginStore.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ id: "my-plugin" }),
        path: pkgRoot,
      }),
    );
  });

  it("accepts a dist folder path with valid manifest.json and returns 201", async () => {
    const distPath = "/home/user/plugins/my-plugin/dist";
    mockExistsSync.mockImplementation((p: string) => p === distPath || p === `${distPath}/manifest.json`);
    mockReadFile.mockResolvedValue(JSON.stringify(VALID_MANIFEST));
    (pluginStore.registerPlugin as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...INSTALLED_PLUGIN,
      path: distPath,
    });

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: distPath,
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "my-plugin" });
    expect(pluginStore.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ path: distPath }),
    );
  });

  it("loads plugin after registration when enabled", async () => {
    const pkgRoot = "/some/path";
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify(VALID_MANIFEST));
    (pluginStore.registerPlugin as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...INSTALLED_PLUGIN,
      enabled: true,
    });

    await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: pkgRoot,
    });

    expect(pluginLoader.loadPlugin).toHaveBeenCalledWith("my-plugin");
  });
});

// ══════════════════════════════════════════════════════════════════
describe("POST /api/plugins mode:install — negative paths", () => {
  let pluginStore: PluginStore;
  let pluginLoader: PluginLoader;
  let store: TaskStore;

  beforeEach(() => {
    vi.clearAllMocks();
    pluginStore = createMockPluginStore();
    pluginLoader = createMockPluginLoader();
    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { pluginStore, pluginLoader }));
    return app;
  }

  it("returns 404 when path does not exist", async () => {
    mockExistsSync.mockReturnValue(false);

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "/nonexistent/dir",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("does not exist");
  });

  it("returns 404 when directory exists but manifest.json is missing", async () => {
    // Directory exists, but no manifest.json inside it
    mockExistsSync.mockImplementation((p: string) => p === "/empty/dir");

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "/empty/dir",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("manifest");
  });

  it("returns 400 when manifest.json is not valid JSON", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("not valid json {{{");

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "/bad/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid JSON");
  });

  it("returns 400 when manifest is missing required 'id' field", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ name: "No Id", version: "1.0.0" }),
    );

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "/missing/id",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid plugin manifest");
    expect(res.body.error).toMatch(/id/i);
  });

  it("returns 400 when manifest is missing required 'name' field", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ id: "no-name", version: "1.0.0" }),
    );

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "/missing/name",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid plugin manifest");
    expect(res.body.error).toMatch(/name/i);
  });

  it("returns 400 when manifest is missing required 'version' field", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ id: "no-ver", name: "No Version" }),
    );

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "/missing/version",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid plugin manifest");
    expect(res.body.error).toMatch(/version/i);
  });

  it("returns 400 when path is empty string", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "   ",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("path");
  });

  it("returns 400 when path is missing entirely", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("path");
  });

  it("returns 400 when mode is missing", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      path: "/some/path",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("mode");
  });

  it("returns 400 for unknown mode value", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "magic",
      path: "/some/path",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid mode");
  });

  it("returns 409 when plugin is already registered", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify(VALID_MANIFEST));
    (pluginStore.registerPlugin as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Plugin "my-plugin" is already registered'),
    );

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "/dup/plugin",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already registered");
  });

  it("returns 400 when plugin loader is not available (install mode)", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { pluginStore /* no pluginLoader */ }));

    const res = await REQUEST(app, "POST", "/api/plugins", {
      mode: "install",
      path: "/some/path",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("not supported");
  });
});

// ══════════════════════════════════════════════════════════════════
describe("POST /api/plugins mode:install — manifest validation edge cases", () => {
  let pluginStore: PluginStore;
  let pluginLoader: PluginLoader;
  let store: TaskStore;

  beforeEach(() => {
    vi.clearAllMocks();
    pluginStore = createMockPluginStore();
    pluginLoader = createMockPluginLoader();
    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { pluginStore, pluginLoader }));
    return app;
  }

  it("rejects manifest with invalid id format (uppercase)", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ id: "BadId", name: "Bad", version: "1.0.0" }),
    );

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "/bad/id-format",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid plugin manifest");
  });

  it("rejects manifest that is an array", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify([1, 2, 3]));

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "/array/manifest",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid plugin manifest");
  });

  it("accepts a fully valid manifest with optional fields", async () => {
    const fullManifest = {
      id: "full-plugin",
      name: "Full Plugin",
      version: "2.0.0",
      description: "Has everything",
      author: "Test",
      homepage: "https://example.com",
    };
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify(fullManifest));
    (pluginStore.registerPlugin as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...INSTALLED_PLUGIN,
      id: "full-plugin",
      name: "Full Plugin",
      version: "2.0.0",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "/full/plugin",
    });

    expect(res.status).toBe(201);
    expect(pluginStore.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({
          id: "full-plugin",
          description: "Has everything",
          author: "Test",
        }),
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════
describe("POST /api/plugins mode:install — dist-folder parent resolution", () => {
  let pluginStore: PluginStore;
  let pluginLoader: PluginLoader;
  let store: TaskStore;

  beforeEach(() => {
    vi.clearAllMocks();
    pluginStore = createMockPluginStore({
      registerPlugin: vi.fn().mockResolvedValue(INSTALLED_PLUGIN),
    });
    pluginLoader = createMockPluginLoader();
    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { pluginStore, pluginLoader }));
    return app;
  }

  it("resolves manifest from parent when dist/ folder is selected", async () => {
    const distPath = "/home/user/plugins/my-plugin/dist";
    const parentPath = "/home/user/plugins/my-plugin";
    // dist exists, no manifest in dist, but manifest in parent
    mockExistsSync.mockImplementation((p: string) =>
      p === distPath || p === `${parentPath}/manifest.json`,
    );
    mockReadFile.mockResolvedValue(JSON.stringify(VALID_MANIFEST));

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: distPath,
    });

    expect(res.status).toBe(201);
    expect(pluginStore.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ path: parentPath }),
    );
  });

  it("resolves manifest from parent when build/ folder is selected", async () => {
    const buildPath = "/home/user/plugins/my-plugin/build";
    const parentPath = "/home/user/plugins/my-plugin";
    mockExistsSync.mockImplementation((p: string) =>
      p === buildPath || p === `${parentPath}/manifest.json`,
    );
    mockReadFile.mockResolvedValue(JSON.stringify(VALID_MANIFEST));

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: buildPath,
    });

    expect(res.status).toBe(201);
    expect(pluginStore.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ path: parentPath }),
    );
  });

  it("resolves manifest from parent when lib/ folder is selected", async () => {
    const libPath = "/home/user/plugins/my-plugin/lib";
    const parentPath = "/home/user/plugins/my-plugin";
    mockExistsSync.mockImplementation((p: string) =>
      p === libPath || p === `${parentPath}/manifest.json`,
    );
    mockReadFile.mockResolvedValue(JSON.stringify(VALID_MANIFEST));

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: libPath,
    });

    expect(res.status).toBe(201);
    expect(pluginStore.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ path: parentPath }),
    );
  });

  it("does NOT look in parent for non-dist directories like src/", async () => {
    const srcPath = "/home/user/plugins/my-plugin/src";
    const parentPath = "/home/user/plugins/my-plugin";
    mockExistsSync.mockImplementation((p: string) =>
      p === srcPath || p === `${parentPath}/manifest.json`,
    );

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: srcPath,
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("manifest");
  });

  it("prefers manifest in selected dir over parent", async () => {
    const distPath = "/home/user/plugins/my-plugin/dist";
    const parentPath = "/home/user/plugins/my-plugin";
    // Both dist and parent have manifest.json
    mockExistsSync.mockImplementation((p: string) =>
      p === distPath || p === `${distPath}/manifest.json` || p === `${parentPath}/manifest.json`,
    );
    const distManifest = { ...VALID_MANIFEST, id: "dist-manifest" };
    mockReadFile.mockResolvedValue(JSON.stringify(distManifest));

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: distPath,
    });

    expect(res.status).toBe(201);
    // Should use the dist dir path since it has its own manifest
    expect(pluginStore.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ path: distPath }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════
describe("GET /api/plugins/ui-slots", () => {
  let pluginStore: PluginStore;
  let pluginLoader: PluginLoader;
  let store: TaskStore;

  beforeEach(() => {
    vi.clearAllMocks();
    pluginStore = createMockPluginStore();
    pluginLoader = createMockPluginLoader();
    store = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { pluginStore, pluginLoader }));
    return app;
  }

  it("returns 200 with empty array when no plugins have uiSlots", async () => {
    (pluginLoader.getPluginUiSlots as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const res = await performGet(buildApp(), "/api/plugins/ui-slots");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 200 with aggregated slots when plugins have uiSlots", async () => {
    const mockSlots = [
      {
        pluginId: "test-plugin",
        slot: {
          slotId: "task-detail-tab",
          label: "Task Details",
          componentPath: "./components/TaskDetailTab.js",
        },
      },
      {
        pluginId: "test-plugin",
        slot: {
          slotId: "header-action",
          label: "Header Action",
          icon: "Plus",
          componentPath: "./components/HeaderAction.js",
        },
      },
    ];
    (pluginLoader.getPluginUiSlots as ReturnType<typeof vi.fn>).mockReturnValue(mockSlots);

    const res = await performGet(buildApp(), "/api/plugins/ui-slots");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockSlots);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].pluginId).toBe("test-plugin");
    expect(res.body[0].slot.slotId).toBe("task-detail-tab");
    expect(res.body[1].slot.icon).toBe("Plus");
  });

  it("response shape is Array<{ pluginId: string; slot: PluginUiSlotDefinition }>", async () => {
    const mockSlots = [
      {
        pluginId: "plugin-a",
        slot: {
          slotId: "custom-slot",
          label: "Custom Slot",
          componentPath: "./components/CustomSlot.js",
        },
      },
    ];
    (pluginLoader.getPluginUiSlots as ReturnType<typeof vi.fn>).mockReturnValue(mockSlots);

    const res = await performGet(buildApp(), "/api/plugins/ui-slots");

    expect(res.status).toBe(200);
    // Verify response shape
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty("pluginId");
    expect(typeof res.body[0].pluginId).toBe("string");
    expect(res.body[0]).toHaveProperty("slot");
    expect(res.body[0].slot).toHaveProperty("slotId");
    expect(res.body[0].slot).toHaveProperty("label");
    expect(res.body[0].slot).toHaveProperty("componentPath");
  });

  it("returns empty array when pluginLoader is not available", async () => {
    // Build app without pluginLoader
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { pluginStore }));
    const res = await performGet(app, "/api/plugins/ui-slots");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("does not conflict with /plugins/:id route", async () => {
    // Verify that /plugins/ui-slots doesn't get matched by /plugins/:id
    (pluginLoader.getPluginUiSlots as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const res = await performGet(buildApp(), "/api/plugins/ui-slots");

    // Should return 200, not 404 (which would happen if :id = "ui-slots" matched)
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
