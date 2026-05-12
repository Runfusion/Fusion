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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database, CentralDatabase, type TaskStore, type PluginStore, type PluginLoader, type PluginInstallation } from "@fusion/core";
import * as fusionCore from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { createPluginRouter } from "../plugin-routes.js";
import { get as performGet, request as performRequest } from "../test-request.js";
import * as projectStoreResolver from "../project-store-resolver.js";

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
const mockAccess = vi.fn<(p: string) => Promise<void>>().mockRejectedValue(new Error("not found"));
const mockStat = vi.fn<(p: string) => Promise<{ isDirectory: () => boolean }>>().mockResolvedValue({ isDirectory: () => true });
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
    access: (...args: Parameters<typeof actual.access>) => mockAccess(args[0] as string),
    stat: (...args: Parameters<typeof actual.stat>) => mockStat(args[0] as string),
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
    getPluginUiContributions: vi.fn().mockReturnValue([]),
    getPluginRuntimes: vi.fn().mockReturnValue([]),
    getPluginDashboardViews: vi.fn().mockReturnValue([]),
    createRouteContext: vi.fn(async (pluginId: string, overrides?: { taskStore?: TaskStore; settings?: Record<string, unknown>; resolveProjectTaskStore?: (projectId: string) => Promise<TaskStore> }) => ({
      pluginId,
      taskStore: overrides?.taskStore ?? createMockTaskStore(),
      settings: overrides?.settings ?? {},
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      emitEvent: vi.fn(),
      createAiSession: await fusionCore.getCreateAiSessionFactory(),
      resolveProjectTaskStore: overrides?.resolveProjectTaskStore,
    })),
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
describe("PATCH/POST plugin scan config routes", () => {
  let pluginStore: PluginStore;
  let pluginLoader: PluginLoader;
  let store: TaskStore;

  beforeEach(() => {
    vi.clearAllMocks();
    pluginStore = createMockPluginStore({
      getPlugin: vi.fn().mockResolvedValue({ ...INSTALLED_PLUGIN, id: "my-plugin", enabled: true, state: "started" }),
      updatePlugin: vi.fn().mockResolvedValue({ ...INSTALLED_PLUGIN, id: "my-plugin", aiScanOnLoad: true }),
    });
    pluginLoader = createMockPluginLoader({ loadPlugin: vi.fn().mockResolvedValue(undefined) });
    store = createMockTaskStore({ getPluginStore: vi.fn().mockReturnValue(pluginStore) });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { pluginStore, pluginLoader }));
    return app;
  }

  it("PATCH /api/plugins/:id updates aiScanOnLoad", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/plugins/my-plugin", { aiScanOnLoad: true });
    expect(res.status).toBe(200);
    expect(pluginStore.updatePlugin).toHaveBeenCalledWith("my-plugin", { aiScanOnLoad: true });
  });

  it("PATCH /api/plugins/:id returns 400 for invalid body", async () => {
    const res = await REQUEST(buildApp(), "PATCH", "/api/plugins/my-plugin", { aiScanOnLoad: "yes" });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/plugins/:id returns 404 for unknown plugin", async () => {
    (pluginStore.updatePlugin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("not found"));
    const res = await REQUEST(buildApp(), "PATCH", "/api/plugins/unknown", { aiScanOnLoad: true });
    expect(res.status).toBe(404);
  });

  it("POST /api/plugins/:id/rescan returns plugin payload", async () => {
    const res = await REQUEST(buildApp(), "POST", "/api/plugins/my-plugin/rescan", {});
    expect(res.status).toBe(200);
    expect(pluginLoader.loadPlugin).toHaveBeenCalledWith("my-plugin");
  });

  it("POST /api/plugins/:id/rescan returns 404 for unknown plugin", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("not found"));
    const res = await REQUEST(buildApp(), "POST", "/api/plugins/unknown/rescan", {});
    expect(res.status).toBe(404);
  });
});

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
    mockAccess.mockImplementation((p: string) => {
      if (p === pkgRoot || p === `${pkgRoot}/manifest.json`) return Promise.resolve();
      return Promise.reject(new Error("not found"));
    });
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
    mockAccess.mockImplementation((p: string) => {
      if (p === distPath || p === `${distPath}/manifest.json`) return Promise.resolve();
      return Promise.reject(new Error("not found"));
    });
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
    mockAccess.mockReturnValue(Promise.resolve());
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
describe("POST /api/plugins central persistence integration", () => {
  let projectDir: string;
  let centralDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "plugin-route-project-"));
    centralDir = mkdtempSync(join(tmpdir(), "plugin-route-central-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(centralDir, { recursive: true, force: true });
  });

  function buildRealApp(pluginStore: PluginStore) {
    const pluginLoader = createMockPluginLoader();
    const store = createMockTaskStore({
      getRootDir: vi.fn().mockReturnValue(projectDir),
      getPluginStore: vi.fn().mockReturnValue(pluginStore),
    });
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { pluginStore, pluginLoader }));
    return app;
  }

  it("writes register mode installs to central tables and not project-local plugins", async () => {
    const pluginStore = new fusionCore.PluginStore(projectDir, { centralGlobalDir: centralDir });
    await pluginStore.init();

    const app = buildRealApp(pluginStore);
    const res = await REQUEST(app, "POST", "/api/plugins", {
      mode: "register",
      id: "central-register",
      name: "Central Register",
      version: "1.0.0",
      path: "/tmp/central-register.js",
    });

    expect(res.status).toBe(201);

    const centralDb = new CentralDatabase(centralDir);
    centralDb.init();
    const installCount = centralDb
      .prepare("SELECT COUNT(*) as count FROM plugin_installs WHERE id = ?")
      .get("central-register") as { count: number };
    const stateCount = centralDb
      .prepare("SELECT COUNT(*) as count FROM project_plugin_states WHERE pluginId = ?")
      .get("central-register") as { count: number };

    const localDb = new Database(join(projectDir, ".fusion"));
    localDb.init();
    const legacyCount = localDb
      .prepare("SELECT COUNT(*) as count FROM plugins WHERE id = ?")
      .get("central-register") as { count: number };

    expect(installCount.count).toBe(1);
    expect(stateCount.count).toBe(1);
    expect(legacyCount.count).toBe(0);

    centralDb.close();
    localDb.close();
  });

  it("writes install mode installs to central tables and not project-local plugins", async () => {
    const pluginStore = new fusionCore.PluginStore(projectDir, { centralGlobalDir: centralDir });
    await pluginStore.init();

    const pluginPath = "/tmp/my-plugin";
    mockAccess.mockImplementation((p: string) => {
      if (p === pluginPath || p === `${pluginPath}/manifest.json`) return Promise.resolve();
      return Promise.reject(new Error("not found"));
    });
    mockReadFile.mockResolvedValueOnce(JSON.stringify(VALID_MANIFEST));

    const app = buildRealApp(pluginStore);
    const res = await REQUEST(app, "POST", "/api/plugins", {
      mode: "install",
      path: pluginPath,
    });

    expect(res.status).toBe(201);

    const centralDb = new CentralDatabase(centralDir);
    centralDb.init();
    const installCount = centralDb
      .prepare("SELECT COUNT(*) as count FROM plugin_installs WHERE id = ?")
      .get("my-plugin") as { count: number };

    const localDb = new Database(join(projectDir, ".fusion"));
    localDb.init();
    const legacyCount = localDb
      .prepare("SELECT COUNT(*) as count FROM plugins WHERE id = ?")
      .get("my-plugin") as { count: number };

    expect(installCount.count).toBe(1);
    expect(legacyCount.count).toBe(0);

    centralDb.close();
    localDb.close();
  });
});

describe("POST /api/plugins mode:install — bundled plugin path fallback", () => {
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

  it("installs bundled dependency graph plugin when relative path misses cwd", async () => {
    const bundledManifest = {
      ...VALID_MANIFEST,
      id: "fusion-plugin-dependency-graph",
      name: "Dependency Graph",
    };
    mockExistsSync.mockImplementation((p: string) => p.includes("fusion-plugin-dependency-graph/manifest.json"));
    mockAccess.mockImplementation((p: string) => {
      if (p.includes("fusion-plugin-dependency-graph")) return Promise.resolve();
      return Promise.reject(new Error("not found"));
    });
    mockReadFile.mockResolvedValue(JSON.stringify(bundledManifest));
    (pluginStore.registerPlugin as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...INSTALLED_PLUGIN,
      id: "fusion-plugin-dependency-graph",
      name: "Dependency Graph",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "./plugins/fusion-plugin-dependency-graph",
    });

    expect(res.status).toBe(201);
    expect(pluginStore.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ id: "fusion-plugin-dependency-graph" }),
        path: expect.stringContaining("fusion-plugin-dependency-graph"),
      }),
    );
  });

  it("installs bundled reports plugin when relative path misses cwd", async () => {
    const bundledManifest = {
      ...VALID_MANIFEST,
      id: "fusion-plugin-reports",
      name: "Reports",
    };
    mockExistsSync.mockImplementation((p: string) => p.includes("fusion-plugin-reports/manifest.json"));
    mockAccess.mockImplementation((p: string) => {
      if (p.includes("fusion-plugin-reports")) return Promise.resolve();
      return Promise.reject(new Error("not found"));
    });
    mockReadFile.mockResolvedValue(JSON.stringify(bundledManifest));
    (pluginStore.registerPlugin as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...INSTALLED_PLUGIN,
      id: "fusion-plugin-reports",
      name: "Reports",
    });

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "./plugins/fusion-plugin-reports",
    });

    expect(res.status).toBe(201);
    expect(pluginStore.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: expect.objectContaining({ id: "fusion-plugin-reports" }),
        path: expect.stringContaining("fusion-plugin-reports"),
      }),
    );
  });

  it("returns 404 with helpful message when local and bundled paths are unresolved", async () => {
    mockExistsSync.mockReturnValue(false);
    mockAccess.mockRejectedValue(new Error("not found"));

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "./plugins/fusion-plugin-dependency-graph",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Checked resolved local path and bundled plugin locations");
  });

  it("keeps register mode behavior unchanged", async () => {
    (pluginStore.registerPlugin as ReturnType<typeof vi.fn>).mockResolvedValue(INSTALLED_PLUGIN);

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "register",
      id: "my-plugin",
      name: "My Plugin",
      version: "1.0.0",
      path: "./plugins/fusion-plugin-dependency-graph",
    });

    expect(res.status).toBe(201);
    expect(pluginStore.registerPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ path: "./plugins/fusion-plugin-dependency-graph" }),
    );
  });
});

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
    mockAccess.mockRejectedValue(new Error("not found"));

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "/nonexistent/dir",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("does not exist");
  });

  it("returns 404 when directory exists but manifest.json is missing", async () => {
    // Directory exists, but no manifest.json inside it
    mockAccess.mockImplementation((p: string) => {
      if (p === "/empty/dir") return Promise.resolve();
      return Promise.reject(new Error("not found"));
    });

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "/empty/dir",
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("manifest");
  });

  it("returns 400 when manifest.json is not valid JSON", async () => {
    mockAccess.mockReturnValue(Promise.resolve());
    mockReadFile.mockResolvedValue("not valid json {{{");

    const res = await REQUEST(buildApp(), "POST", "/api/plugins", {
      mode: "install",
      path: "/bad/json",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid JSON");
  });

  it("returns 400 when manifest is missing required 'id' field", async () => {
    mockAccess.mockReturnValue(Promise.resolve());
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
    mockAccess.mockReturnValue(Promise.resolve());
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
    mockAccess.mockReturnValue(Promise.resolve());
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
    mockAccess.mockReturnValue(Promise.resolve());
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
    mockAccess.mockReturnValue(Promise.resolve());
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
    mockAccess.mockReturnValue(Promise.resolve());
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
    mockAccess.mockReturnValue(Promise.resolve());
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
    mockAccess.mockImplementation((p: string) => {
      if (p === distPath || p === `${parentPath}/manifest.json`) return Promise.resolve();
      return Promise.reject(new Error("not found"));
    });
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
    mockAccess.mockImplementation((p: string) => {
      if (p === buildPath || p === `${parentPath}/manifest.json`) return Promise.resolve();
      return Promise.reject(new Error("not found"));
    });
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
    mockAccess.mockImplementation((p: string) => {
      if (p === libPath || p === `${parentPath}/manifest.json`) return Promise.resolve();
      return Promise.reject(new Error("not found"));
    });
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
    mockAccess.mockImplementation((p: string) => {
      if (p === srcPath || p === `${parentPath}/manifest.json`) return Promise.resolve();
      return Promise.reject(new Error("not found"));
    });

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
    mockAccess.mockImplementation((p: string) => {
      if (p === distPath || p === `${distPath}/manifest.json` || p === `${parentPath}/manifest.json`) return Promise.resolve();
      return Promise.reject(new Error("not found"));
    });
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


describe("GET /api/plugins/dashboard-views", () => {
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

  it("returns empty array when pluginLoader is not available", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { pluginStore }));

    const res = await performGet(app, "/api/plugins/dashboard-views");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 200 with empty array when no plugins have dashboard views", async () => {
    (pluginLoader.getPluginDashboardViews as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const res = await performGet(buildApp(), "/api/plugins/dashboard-views");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns aggregated dashboard views with pluginId and view", async () => {
    const mockViews = [
      {
        pluginId: "dep-graph",
        view: {
          viewId: "graph",
          label: "Graph",
          componentPath: "./views/Graph.js",
          icon: "Network",
          placement: "more",
          order: 40,
          description: "Dependency graph",
        },
      },
    ];
    (pluginLoader.getPluginDashboardViews as ReturnType<typeof vi.fn>).mockReturnValue(mockViews);

    const res = await performGet(buildApp(), "/api/plugins/dashboard-views");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockViews);
  });

  it("returns exactly pluginLoader dashboard-view entries (no synthesized plugin rows)", async () => {
    (pluginLoader.getPluginDashboardViews as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        pluginId: "with-view",
        view: {
          viewId: "graph",
          label: "Graph",
          componentPath: "./Graph.js",
        },
      },
    ]);

    const res = await performGet(buildApp(), "/api/plugins/dashboard-views");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      pluginId: "with-view",
      view: { viewId: "graph", label: "Graph", componentPath: "./Graph.js" },
    });
  });

  it("keeps dashboard-views payload separate from ui-slots payload", async () => {
    (pluginLoader.getPluginDashboardViews as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        pluginId: "fusion-plugin-roadmap",
        view: {
          viewId: "roadmaps",
          label: "Roadmaps",
          componentPath: "./dashboard-view",
        },
      },
    ]);
    (pluginLoader.getPluginUiSlots as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        pluginId: "fusion-plugin-roadmap",
        slot: {
          slotId: "task-detail-tab",
          label: "Roadmap Details",
          componentPath: "./task-detail.js",
        },
      },
    ]);

    const viewsRes = await performGet(buildApp(), "/api/plugins/dashboard-views");
    const slotsRes = await performGet(buildApp(), "/api/plugins/ui-slots");

    expect(viewsRes.status).toBe(200);
    expect(slotsRes.status).toBe(200);
    expect(viewsRes.body[0]).toHaveProperty("view");
    expect(viewsRes.body[0]).not.toHaveProperty("slot");
    expect(slotsRes.body[0]).toHaveProperty("slot");
    expect(slotsRes.body[0]).not.toHaveProperty("view");
  });
});

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
          order: 10,
        },
      },
      {
        pluginId: "test-plugin",
        slot: {
          slotId: "header-action",
          label: "Header Action",
          icon: "Plus",
          componentPath: "./components/HeaderAction.js",
          order: 1,
        },
      },
    ];
    (pluginLoader.getPluginUiSlots as ReturnType<typeof vi.fn>).mockReturnValue(mockSlots);

    const res = await performGet(buildApp(), "/api/plugins/ui-slots");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].pluginId).toBe("test-plugin");
    expect(res.body[0].slot.slotId).toBe("header-action");
    expect(res.body[0].slot.surface).toBe("header-action");
    expect(res.body[1].slot.slotId).toBe("task-detail-tab");
    expect(res.body[1].slot.surface).toBe("task-detail-tab");
    expect(res.body[1].slot.order).toBe(10);
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
    expect(res.body[0].slot).toHaveProperty("surface");
    expect(res.body[0].slot).toHaveProperty("order");
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

  it("surfaces Droid plugin slot registrations through standard loader aggregation", async () => {
    const droidSlots = [
      {
        pluginId: "fusion-plugin-droid-runtime",
        slot: {
          slotId: "settings-provider-card",
          label: "Droid CLI Provider",
          componentPath: "./components/settings-provider-card.js",
          order: 5,
        },
      },
      {
        pluginId: "fusion-plugin-droid-runtime",
        slot: {
          slotId: "onboarding-provider-card",
          label: "Droid CLI Provider",
          componentPath: "./components/onboarding-provider-card.js",
          placement: "after-default",
        },
      },
    ];
    (pluginLoader.getPluginUiSlots as ReturnType<typeof vi.fn>).mockReturnValue(droidSlots);

    const res = await performGet(buildApp(), "/api/plugins/ui-slots");

    expect(res.status).toBe(200);
    expect(pluginLoader.getPluginUiSlots).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual([
      {
        pluginId: "fusion-plugin-droid-runtime",
        slot: {
          slotId: "settings-provider-card",
          surface: "settings-provider-card",
          label: "Droid CLI Provider",
          componentPath: "./components/settings-provider-card.js",
          order: 5,
        },
      },
      {
        pluginId: "fusion-plugin-droid-runtime",
        slot: {
          slotId: "onboarding-provider-card",
          surface: "onboarding-provider-card",
          label: "Droid CLI Provider",
          componentPath: "./components/onboarding-provider-card.js",
          placement: "after-default",
          order: null,
        },
      },
    ]);
  });
});

describe("GET /api/plugins/ui-contributions", () => {
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

  it("returns normalized and sorted structured contributions", async () => {
    (pluginLoader.getPluginUiContributions as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        pluginId: "b-plugin",
        contribution: {
          surface: "onboarding-provider-recommendation",
          contributionId: "rec-b",
          providerId: "openai",
          title: "OpenAI",
          reason: "default",
          order: 10,
        },
      },
      {
        pluginId: "a-plugin",
        contribution: {
          surface: "settings-config-section",
          contributionId: "cfg-a",
          sectionId: "openai",
          title: "OpenAI settings",
          pluginSettingKeys: ["openai.apiKey"],
          order: 1,
        },
      },
    ]);

    const res = await performGet(buildApp(), "/api/plugins/ui-contributions");

    expect(res.status).toBe(200);
    expect(res.body.map((entry: { pluginId: string }) => entry.pluginId)).toEqual(["a-plugin", "b-plugin"]);
    expect(res.body[0].contribution.surface).toBe("settings-config-section");
  });

  it("returns empty array when pluginLoader is missing", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, { pluginStore }));

    const res = await performGet(app, "/api/plugins/ui-contributions");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("createPluginRouter plugin setup routes", () => {
  let pluginStore: PluginStore;
  let pluginLoader: PluginLoader;
  let pluginRunner: {
    getPluginRoutes: ReturnType<typeof vi.fn>;
    checkPluginSetup: ReturnType<typeof vi.fn>;
    installPluginSetup: ReturnType<typeof vi.fn>;
    getPluginSetupInfo: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    pluginStore = createMockPluginStore();
    pluginLoader = createMockPluginLoader();
    pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([]),
      checkPluginSetup: vi.fn().mockResolvedValue({ status: "installed", version: "1.0.0" }),
      installPluginSetup: vi.fn().mockResolvedValue({ success: true }),
      getPluginSetupInfo: vi.fn().mockReturnValue([]),
    };
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/plugins", createPluginRouter(pluginStore, pluginLoader, pluginRunner));
    return app;
  }

  it("returns 404 for missing plugin setup status", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Plugin \"missing\" not found"));

    const res = await REQUEST(buildApp(), "GET", "/plugins/missing/setup-status");

    expect(res.status).toBe(404);
  });

  it("returns hasSetup false when plugin has no setup metadata", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...INSTALLED_PLUGIN, state: "started" });
    pluginRunner.getPluginSetupInfo.mockReturnValueOnce([]);

    const res = await REQUEST(buildApp(), "GET", "/plugins/my-plugin/setup-status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasSetup: false });
  });

  it("returns deferred setup status when setup metadata exists but plugin is not started", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...INSTALLED_PLUGIN, state: "installed" });
    pluginRunner.getPluginSetupInfo.mockReturnValueOnce([
      {
        pluginId: "my-plugin",
        manifest: { binaryName: "tool", description: "desc" },
        hooks: { checkSetup: vi.fn() },
      },
    ]);

    const res = await REQUEST(buildApp(), "GET", "/plugins/my-plugin/setup-status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      hasSetup: true,
      setupCheckDeferred: true,
      deferredReason: "plugin-not-started",
      pluginState: "installed",
    });
    expect(pluginRunner.checkPluginSetup).not.toHaveBeenCalled();
  });

  it("returns setup status when setup metadata exists and plugin is started", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...INSTALLED_PLUGIN, state: "started" });
    pluginRunner.getPluginSetupInfo.mockReturnValueOnce([
      {
        pluginId: "my-plugin",
        manifest: { binaryName: "tool", description: "desc" },
        hooks: { checkSetup: vi.fn() },
      },
    ]);

    const res = await REQUEST(buildApp(), "GET", "/plugins/my-plugin/setup-status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasSetup: true, status: "installed", version: "1.0.0" });
  });

  it("rejects setup install when plugin has no install hook", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...INSTALLED_PLUGIN, enabled: true });
    pluginRunner.getPluginSetupInfo.mockReturnValueOnce([
      {
        pluginId: "my-plugin",
        manifest: { binaryName: "tool", description: "desc" },
        hooks: { checkSetup: vi.fn() },
      },
    ]);

    const res = await REQUEST(buildApp(), "POST", "/plugins/my-plugin/setup/install", {});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no install hook");
  });

  it("returns setup install result payload", async () => {
    (pluginStore.getPlugin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...INSTALLED_PLUGIN, enabled: true });
    pluginRunner.getPluginSetupInfo.mockReturnValueOnce([
      {
        pluginId: "my-plugin",
        manifest: { binaryName: "tool", description: "desc" },
        hooks: { checkSetup: vi.fn(), install: vi.fn() },
      },
    ]);
    pluginRunner.installPluginSetup.mockResolvedValueOnce({ success: false, error: "install failed" });

    const res = await REQUEST(buildApp(), "POST", "/plugins/my-plugin/setup/install", {});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: false, error: "install failed" });
  });
});

describe("createPluginRouter plugin-defined route responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fusionCore, "getCreateAiSessionFactory").mockResolvedValue(undefined);
  });

  it("injects request-scoped taskStore and scoped plugin settings", async () => {
    const defaultTaskStore = createMockTaskStore();
    const scopedPluginStore = createMockPluginStore({
      getPlugin: vi.fn().mockResolvedValue({ ...INSTALLED_PLUGIN, id: "demo", settings: { mode: "scoped" } }),
    });
    const scopedTaskStore = createMockTaskStore({
      getRootDir: vi.fn().mockReturnValue("/scoped"),
      getPluginStore: vi.fn().mockReturnValue(scopedPluginStore),
    });
    mockGetOrCreateProjectStore.mockResolvedValue(scopedTaskStore);

    const pluginStore = createMockPluginStore({
      getPlugin: vi.fn().mockResolvedValue({ ...INSTALLED_PLUGIN, id: "demo", settings: { mode: "global" } }),
    });
    const pluginLoader = createMockPluginLoader({
      getPlugin: vi.fn().mockReturnValue({ manifest: { id: "demo" } }),
    });
    const pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([
        {
          pluginId: "demo",
          route: {
            method: "POST",
            path: "/status",
            handler: vi.fn(async (_req: unknown, ctx: import("@fusion/core").PluginContext) => ({
              status: 201,
              body: { scoped: ctx.taskStore.getRootDir(), mode: ctx.settings.mode },
            })),
          },
        },
      ]),
    };

    const app = express();
    app.use(express.json());
    app.use("/plugins", createPluginRouter(pluginStore, pluginLoader, pluginRunner, defaultTaskStore));

    const res = await REQUEST(app, "POST", "/plugins/demo/status?projectId=p1", { projectId: "p1" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ scoped: "/scoped", mode: "scoped" });
  });

  it("falls back to global plugin settings when scoped plugin record is unavailable", async () => {
    const scopedPluginStore = createMockPluginStore({
      getPlugin: vi.fn().mockRejectedValue(new Error("missing")),
    });
    const scopedTaskStore = createMockTaskStore({
      getPluginStore: vi.fn().mockReturnValue(scopedPluginStore),
    });
    mockGetOrCreateProjectStore.mockResolvedValue(scopedTaskStore);

    const pluginStore = createMockPluginStore({
      getPlugin: vi.fn().mockResolvedValue({ ...INSTALLED_PLUGIN, id: "demo", settings: { mode: "global" } }),
    });
    const pluginLoader = createMockPluginLoader({
      getPlugin: vi.fn().mockReturnValue({ manifest: { id: "demo" } }),
    });
    const pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([
        {
          pluginId: "demo",
          route: {
            method: "GET",
            path: "/settings",
            handler: vi.fn(async (_req: unknown, ctx: import("@fusion/core").PluginContext) => ({ mode: ctx.settings.mode })),
          },
        },
      ]),
    };

    const app = express();
    app.use(express.json());
    app.use("/plugins", createPluginRouter(pluginStore, pluginLoader, pluginRunner));

    const res = await REQUEST(app, "GET", "/plugins/demo/settings?projectId=p1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "global" });
  });

  it("includes createAiSession in plugin route context when engine has registered a factory", async () => {
    const createAiSession = vi.fn();
    vi.spyOn(fusionCore, "getCreateAiSessionFactory").mockResolvedValue(createAiSession as unknown as import("@fusion/core").CreateAiSessionFactory);

    const pluginStore = createMockPluginStore();
    const pluginLoader = createMockPluginLoader({
      getPlugin: vi.fn().mockReturnValue({ manifest: { id: "demo" } }),
    });
    const pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([
        {
          pluginId: "demo",
          route: {
            method: "GET",
            path: "/ai",
            handler: vi.fn(async (_req: unknown, ctx: import("@fusion/core").PluginContext) => ({ hasFactory: Boolean(ctx.createAiSession) })),
          },
        },
      ]),
    };

    const app = express();
    app.use(express.json());
    app.use("/plugins", createPluginRouter(pluginStore, pluginLoader, pluginRunner));

    const res = await REQUEST(app, "GET", "/plugins/demo/ai");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasFactory: true });
  });

  it("leaves createAiSession undefined when engine factory is unavailable", async () => {
    vi.spyOn(fusionCore, "getCreateAiSessionFactory").mockResolvedValue(undefined);

    const pluginStore = createMockPluginStore();
    const pluginLoader = createMockPluginLoader({
      getPlugin: vi.fn().mockReturnValue({ manifest: { id: "demo" } }),
    });
    const pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([
        {
          pluginId: "demo",
          route: {
            method: "GET",
            path: "/ai-none",
            handler: vi.fn(async (_req: unknown, ctx: import("@fusion/core").PluginContext) => ({ hasFactory: Boolean(ctx.createAiSession) })),
          },
        },
      ]),
    };

    const app = express();
    app.use(express.json());
    app.use("/plugins", createPluginRouter(pluginStore, pluginLoader, pluginRunner));

    const res = await REQUEST(app, "GET", "/plugins/demo/ai-none");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasFactory: false });
  });

  it("maps plugin-defined non-2xx status responses", async () => {
    const pluginStore = createMockPluginStore();
    const pluginLoader = createMockPluginLoader({
      getPlugin: vi.fn().mockReturnValue({ manifest: { id: "demo" } }),
    });
    const pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([
        {
          pluginId: "demo",
          route: {
            method: "GET",
            path: "/error",
            handler: vi.fn(async () => ({ status: 422, body: { error: "invalid" } })),
          },
        },
      ]),
    };

    const app = express();
    app.use(express.json());
    app.use("/plugins", createPluginRouter(pluginStore, pluginLoader, pluginRunner));

    const res = await REQUEST(app, "GET", "/plugins/demo/error");
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "invalid" });
  });

  it("propagates thrown handler errors via catchHandler", async () => {
    const pluginStore = createMockPluginStore();
    const pluginLoader = createMockPluginLoader({
      getPlugin: vi.fn().mockReturnValue({ manifest: { id: "demo" } }),
    });
    const pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([
        {
          pluginId: "demo",
          route: {
            method: "GET",
            path: "/throws",
            handler: vi.fn(async () => {
              throw new Error("boom");
            }),
          },
        },
      ]),
    };

    const app = express();
    app.use(express.json());
    app.use("/plugins", createPluginRouter(pluginStore, pluginLoader, pluginRunner));

    const res = await REQUEST(app, "GET", "/plugins/demo/throws");
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("boom");
  });

  it("supports 204 empty responses for plugin routes", async () => {
    const pluginStore = createMockPluginStore();
    const pluginLoader = createMockPluginLoader({
      getPlugin: vi.fn().mockReturnValue({ manifest: { id: "demo" } }),
    });
    const pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([
        {
          pluginId: "demo",
          route: {
            method: "DELETE",
            path: "/resource",
            handler: vi.fn(async () => ({ status: 204 })),
          },
        },
      ]),
    };

    const app = express();
    app.use(express.json());
    app.use("/plugins", createPluginRouter(pluginStore, pluginLoader, pluginRunner));

    const res = await REQUEST(app, "DELETE", "/plugins/demo/resource");
    expect(res.status).toBe(204);
  });

  it("returns JSON by default for object bodies", async () => {
    const pluginStore = createMockPluginStore();
    const pluginLoader = createMockPluginLoader({
      getPlugin: vi.fn().mockReturnValue({ manifest: { id: "demo" } }),
    });
    const pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([
        {
          pluginId: "demo",
          route: {
            method: "GET",
            path: "/json",
            handler: vi.fn(async () => ({ status: 200, body: { ok: true } })),
          },
        },
      ]),
    };

    const app = express();
    app.use(express.json());
    app.use("/plugins", createPluginRouter(pluginStore, pluginLoader, pluginRunner));

    const res = await performGet(app, "/plugins/demo/json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual({ ok: true });
  });

  it("sends raw html body when contentType is provided", async () => {
    const pluginStore = createMockPluginStore();
    const pluginLoader = createMockPluginLoader({
      getPlugin: vi.fn().mockReturnValue({ manifest: { id: "demo" } }),
    });
    const pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([
        {
          pluginId: "demo",
          route: {
            method: "GET",
            path: "/html",
            handler: vi.fn(async () => ({
              status: 200,
              body: "<html><body>Hello</body></html>",
              contentType: "text/html; charset=utf-8",
            })),
          },
        },
      ]),
    };

    const app = express();
    app.use(express.json());
    app.use("/plugins", createPluginRouter(pluginStore, pluginLoader, pluginRunner));

    const res = await performGet(app, "/plugins/demo/html");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const html = typeof res.text === "string" ? res.text : String(res.body ?? "");
    expect(html).toContain("<html><body>Hello</body></html>");
  });

  it("propagates custom response headers", async () => {
    const pluginStore = createMockPluginStore();
    const pluginLoader = createMockPluginLoader({
      getPlugin: vi.fn().mockReturnValue({ manifest: { id: "demo" } }),
    });
    const pluginRunner = {
      getPluginRoutes: vi.fn().mockReturnValue([
        {
          pluginId: "demo",
          route: {
            method: "GET",
            path: "/download",
            handler: vi.fn(async () => ({
              status: 200,
              body: "<html></html>",
              contentType: "text/html",
              headers: {
                "Content-Disposition": "attachment; filename=\"x.html\"",
              },
            })),
          },
        },
      ]),
    };

    const app = express();
    app.use(express.json());
    app.use("/plugins", createPluginRouter(pluginStore, pluginLoader, pluginRunner));

    const res = await performGet(app, "/plugins/demo/download");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe("attachment; filename=\"x.html\"");
  });
});

describe("GET /api/plugins/runtimes", () => {
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

  it("includes Droid runtime metadata from plugin loader aggregation", async () => {
    (pluginLoader.getPluginRuntimes as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        pluginId: "fusion-plugin-droid-runtime",
        runtime: {
          metadata: {
            runtimeId: "droid",
            name: "Droid Runtime",
            description: "Drives the Droid CLI for Fusion agents",
            version: "0.1.0",
          },
          factory: vi.fn(),
        },
      },
    ]);

    const res = await performGet(buildApp(), "/api/plugins/runtimes");

    expect(res.status).toBe(200);
    expect(pluginLoader.getPluginRuntimes).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "fusion-plugin-droid-runtime",
          runtimeId: "droid",
          name: "Droid Runtime",
          description: "Drives the Droid CLI for Fusion agents",
          version: "0.1.0",
        }),
      ]),
    );
  });
});
