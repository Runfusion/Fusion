import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@fusion/core";
import { request } from "../test-request.js";
import { createServer } from "../server.js";

// Use vi.hoisted() for mock functions that need to be accessible in hoisted vi.mock calls
const {
  mockFsAccess,
  mockFsStat,
  mockFsReaddir,
  mockFsMkdir,
  mockFsRm,
  mockExecFile,
  mockListProjects,
  mockGetProject,
  mockRegisterProject,
  mockUpdateProject,
  mockUnregisterProject,
  mockGetProjectHealth,
  mockGetRecentActivity,
  mockGetGlobalConcurrencyState,
  mockUpdateGlobalConcurrency,
  mockInit,
  mockClose,
  mockReconcileProjectStatuses,
  mockGetOrCreateProjectStore,
  mockListNodes,
  mockGetNode,
  mockEnsureMemoryFileWithBackend,
} = vi.hoisted(() => ({
  mockFsAccess: vi.fn().mockResolvedValue(undefined),
  mockFsStat: vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" })),
  mockFsReaddir: vi.fn().mockResolvedValue([]),
  mockFsMkdir: vi.fn().mockResolvedValue(undefined),
  mockFsRm: vi.fn().mockResolvedValue(undefined),
  mockExecFile: vi.fn((_file, _args, optsOrCallback, maybeCallback) => {
    const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;
    callback?.(null, "", "");
  }),
  mockListProjects: vi.fn().mockResolvedValue([]),
  mockGetProject: vi.fn().mockResolvedValue(null),
  mockRegisterProject: vi.fn().mockResolvedValue({
    id: "proj_test123",
    name: "Test Project",
    path: "/test/path",
    status: "initializing",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }),
  mockUpdateProject: vi.fn().mockResolvedValue({
    id: "proj_test123",
    name: "Test Project",
    path: "/test/path",
    status: "active",
    isolationMode: "in-process",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }),
  mockUnregisterProject: vi.fn().mockResolvedValue(undefined),
  mockGetProjectHealth: vi.fn().mockResolvedValue({
    projectId: "proj_test123",
    status: "active",
    activeTaskCount: 5,
    inFlightAgentCount: 2,
    totalTasksCompleted: 10,
    totalTasksFailed: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  }),
  mockGetRecentActivity: vi.fn().mockResolvedValue([]),
  mockGetGlobalConcurrencyState: vi.fn().mockResolvedValue({
    globalMaxConcurrent: 4,
    currentlyActive: 2,
    queuedCount: 0,
    projectsActive: { proj_test123: 2 },
  }),
  mockUpdateGlobalConcurrency: vi.fn().mockResolvedValue({
    globalMaxConcurrent: 10,
    currentlyActive: 2,
    queuedCount: 0,
    projectsActive: { proj_test123: 2 },
  }),
  mockInit: vi.fn().mockResolvedValue(undefined),
  mockClose: vi.fn().mockResolvedValue(undefined),
  mockReconcileProjectStatuses: vi.fn().mockResolvedValue([]),
  // Mock store registry - can be configured per-test to return specific stores per project ID
  mockGetOrCreateProjectStore: vi.fn(),
  mockListNodes: vi.fn().mockResolvedValue([]),
  mockGetNode: vi.fn().mockResolvedValue(null),
  mockEnsureMemoryFileWithBackend: vi.fn().mockResolvedValue(true),
}));

// Mock node:fs for route handler tests that check path existence
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
  };
});

// Mock node:fs/promises for path validation and clone behavior checks
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    access: mockFsAccess,
    stat: mockFsStat,
    readdir: mockFsReaddir,
    mkdir: mockFsMkdir,
    rm: mockFsRm,
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: mockExecFile,
  };
});

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    CentralCore: vi.fn().mockImplementation(() => ({
      init: mockInit,
      close: mockClose,
      listProjects: mockListProjects,
      getProject: mockGetProject,
      registerProject: mockRegisterProject,
      updateProject: mockUpdateProject,
      unregisterProject: mockUnregisterProject,
      getProjectHealth: mockGetProjectHealth,
      getRecentActivity: mockGetRecentActivity,
      getGlobalConcurrencyState: mockGetGlobalConcurrencyState,
      updateGlobalConcurrency: mockUpdateGlobalConcurrency,
      reconcileProjectStatuses: mockReconcileProjectStatuses,
      listNodes: mockListNodes,
      getNode: mockGetNode,
    })),
    ensureMemoryFileWithBackend: mockEnsureMemoryFileWithBackend,
  };
});

// Mock project-store-resolver for multi-project health tests
vi.mock("../project-store-resolver.js", () => ({
  getOrCreateProjectStore: mockGetOrCreateProjectStore,
  invalidateAllGlobalSettingsCaches: vi.fn(),
}));

// Import after mocking - just import the types and verify the routes exist
import { 
  fetchProjects,
  registerProject,
  unregisterProject,
  fetchProject,
  updateProject,
  detectProjects,
  fetchProjectHealth,
  fetchActivityFeed,
  fetchFirstRunStatus,
  fetchGlobalConcurrency,
  updateGlobalConcurrency,
  fetchProjectTasks,
  fetchTasks,
  type ProjectInfo,
  type DetectedProject,
} from "../../app/api.js";

function mockFetchResponse(
  ok: boolean,
  body: unknown,
  status = ok ? 200 : 500,
  contentType = "application/json"
) {
  const bodyText = JSON.stringify(body);
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyText),
  } as unknown as Response);
}

describe("Project Routes API Functions", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  describe("fetchProjects", () => {
    it("returns empty array when CentralCore unavailable", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

      const result = await fetchProjects();

      expect(result).toEqual([]);
    });

    it("returns projects list when available", async () => {
      const mockProjects: ProjectInfo[] = [
        {
          id: "proj_123",
          name: "Test Project",
          path: "/test/path",
          status: "active",
          isolationMode: "in-process",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockProjects));

      const result = await fetchProjects();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("proj_123");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/projects",
        expect.any(Object)
      );
    });
  });

  describe("registerProject", () => {
    it("registers a new project with valid input", async () => {
      const mockProject: ProjectInfo = {
        id: "proj_new",
        name: "New Project",
        path: "/absolute/path",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockProject));

      const result = await registerProject({
        name: "New Project",
        path: "/absolute/path",
        isolationMode: "in-process",
      });

      expect(result.id).toBe("proj_new");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/projects",
        expect.objectContaining({
          method: "POST",
          body: expect.any(String),
        })
      );
    });
  });

  describe("fetchProject", () => {
    it("fetches a specific project by ID", async () => {
      const mockProject: ProjectInfo = {
        id: "proj_123",
        name: "Test Project",
        path: "/test/path",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockProject));

      const result = await fetchProject("proj_123");

      expect(result.id).toBe("proj_123");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/projects/proj_123",
        expect.any(Object)
      );
    });
  });

  describe("updateProject", () => {
    it("updates project metadata", async () => {
      const mockProject: ProjectInfo = {
        id: "proj_123",
        name: "Updated Name",
        path: "/test/path",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockProject));

      const result = await updateProject("proj_123", { name: "Updated Name" });

      expect(result.name).toBe("Updated Name");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/projects/proj_123",
        expect.objectContaining({
          method: "PATCH",
          body: expect.any(String),
        })
      );
    });
  });

  describe("unregisterProject", () => {
    it("unregisters a project", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {}));

      await unregisterProject("proj_test123");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/projects/proj_test123",
        expect.objectContaining({
          method: "DELETE",
        })
      );
    });
  });

  describe("detectProjects", () => {
    it("auto-detects projects in a base path", async () => {
      const mockDetected: { projects: DetectedProject[] } = {
        projects: [
          { path: "/home/user/project1", suggestedName: "project1", existing: false },
          { path: "/home/user/project2", suggestedName: "project2", existing: true },
        ],
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockDetected));

      const result = await detectProjects("/home/user");

      expect(result.projects).toHaveLength(2);
      expect(result.projects[0].suggestedName).toBe("project1");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/projects/detect",
        expect.objectContaining({
          method: "POST",
          body: expect.any(String),
        })
      );
    });
  });

  describe("fetchProjectHealth", () => {
    it("returns health metrics for a project", async () => {
      const mockHealth = {
        projectId: "proj_test123",
        status: "active",
        activeTaskCount: 5,
        inFlightAgentCount: 2,
        totalTasksCompleted: 10,
        totalTasksFailed: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockHealth));

      const result = await fetchProjectHealth("proj_test123");

      expect(result.projectId).toBe("proj_test123");
      expect(result.activeTaskCount).toBe(5);
    });
  });

  describe("fetchActivityFeed", () => {
    it("returns activity feed entries", async () => {
      const mockEntries = [
        {
          id: "entry_1",
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "task:created",
          projectId: "proj_123",
          projectName: "Test Project",
          details: "Task created",
        },
      ];
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockEntries));

      const result = await fetchActivityFeed();

      expect(result).toHaveLength(1);
      expect(result[0].projectName).toBe("Test Project");
    });

    it("supports projectId filter", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

      await fetchActivityFeed({ projectId: "proj_123" });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("projectId=proj_123"),
        expect.any(Object)
      );
    });
  });

  describe("fetchFirstRunStatus", () => {
    it("returns first run status", async () => {
      const mockStatus = {
        hasProjects: false,
        singleProjectPath: null,
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockStatus));

      const result = await fetchFirstRunStatus();

      expect(result.hasProjects).toBe(false);
      expect(result.singleProjectPath).toBeNull();
    });
  });

  describe("fetchGlobalConcurrency", () => {
    it("returns global concurrency state", async () => {
      const mockState = {
        globalMaxConcurrent: 4,
        currentlyActive: 2,
        queuedCount: 0,
        projectsActive: { proj_123: 2 },
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockState));

      const result = await fetchGlobalConcurrency();

      expect(result.globalMaxConcurrent).toBe(4);
      expect(result.currentlyActive).toBe(2);
    });

    it("updates global concurrency state", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, {
        globalMaxConcurrent: 10,
        currentlyActive: 2,
        queuedCount: 0,
        projectsActive: {},
      }));

      const result = await updateGlobalConcurrency({ globalMaxConcurrent: 10 });

      expect(result.globalMaxConcurrent).toBe(10);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/global-concurrency",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ globalMaxConcurrent: 10 }),
        }),
      );
    });
  });

  describe("fetchProjectTasks", () => {
    it("sends projectId as query parameter to /api/tasks", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

      await fetchProjectTasks("proj_abc");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/tasks"),
        expect.any(Object)
      );
      const url: string = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(url).toContain("projectId=proj_abc");
    });

    it("returns tasks from the project's store when projectId is provided", async () => {
      const mockTasks = [
        {
          id: "FN-001",
          description: "Fix the bug",
          column: "todo",
          dependencies: [],
          steps: [],
          log: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockTasks));

      const result = await fetchProjectTasks("proj_abc");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("FN-001");
    });

    it("returns 404 when project is not found", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(
        mockFetchResponse(false, { error: "Project not found" }, 404)
      );

      await expect(fetchProjectTasks("nonexistent_proj")).rejects.toThrow();
    });

    it("returns empty array on graceful degradation when backend error occurs", async () => {
      // Backend returns 200 with [] for CentralCore unavailability
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

      const result = await fetchProjectTasks("proj_abc");

      expect(result).toEqual([]);
    });

    it("supports limit and offset parameters alongside projectId", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

      await fetchProjectTasks("proj_abc", 10, 20);

      const url: string = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(url).toContain("projectId=proj_abc");
      expect(url).toContain("limit=10");
      expect(url).toContain("offset=20");
    });
  });

  describe("fetchTasks (default store - no projectId)", () => {
    it("fetches from /api/tasks without projectId when no project is specified", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

      await fetchTasks();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/tasks",
        expect.any(Object)
      );
    });

    it("does not include projectId parameter in default fetchTasks call", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

      await fetchTasks();

      const url: string = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(url).not.toContain("projectId");
    });
  });
});

// ── Route Handler Tests ──────────────────────────────────────────────────────
// These test the actual route handler (POST /api/projects) to verify that
// projects are activated after registration.

class MockStoreForRoutes extends EventEmitter {
  getRootDir(): string {
    return "/tmp/fn-944";
  }

  getFusionDir(): string {
    return "/tmp/fn-944/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
    };
  }

  getMissionStore() {
    return {
      listMissions: vi.fn().mockResolvedValue([]),
      createMission: vi.fn(),
      getMission: vi.fn(),
      updateMission: vi.fn(),
      deleteMission: vi.fn(),
      listTemplates: vi.fn().mockResolvedValue([]),
      createTemplate: vi.fn(),
      getTemplate: vi.fn(),
      updateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
      instantiateMission: vi.fn(),
    };
  }

  async listTasks(): Promise<Task[]> {
    return [];
  }
}

describe("POST /api/projects route handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFsAccess.mockResolvedValue(undefined);
    mockFsStat.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    mockFsReaddir.mockResolvedValue([]);
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsRm.mockResolvedValue(undefined);
    mockExecFile.mockImplementation((_file, _args, optsOrCallback, maybeCallback) => {
      const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;
      callback?.(null, "", "");
    });

    // Reset mocks to default values for route handler tests
    mockRegisterProject.mockResolvedValue({
      id: "proj_test123",
      name: "Test Project",
      path: "/test/path",
      status: "initializing",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockUpdateProject.mockResolvedValue({
      id: "proj_test123",
      name: "Test Project",
      path: "/test/path",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockEnsureMemoryFileWithBackend.mockResolvedValue(true);
  });

  it("calls updateProject with status 'active' after registration", async () => {
    const store = new MockStoreForRoutes();
    const app = createServer(store as any);

    const res = await request(
      app,
      "POST",
      "/api/projects",
      JSON.stringify({ name: "Test Project", path: "/tmp" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(mockRegisterProject).toHaveBeenCalledWith({
      name: "Test Project",
      path: "/tmp",
      isolationMode: "in-process",
    });
    expect(mockUpdateProject).toHaveBeenCalledWith("proj_test123", { status: "active" });
    expect((res.body as any).status).toBe("active");
  });

  it("passes nodeId to registerProject when provided", async () => {
    const store = new MockStoreForRoutes();
    const app = createServer(store as any);

    const res = await request(
      app,
      "POST",
      "/api/projects",
      JSON.stringify({
        name: "Remote Project",
        path: "/tmp",
        nodeId: "node-remote-1",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    expect(mockRegisterProject).toHaveBeenCalledWith({
      name: "Remote Project",
      path: "/tmp",
      isolationMode: "in-process",
      nodeId: "node-remote-1",
    });
  });

  it("calls ensureMemoryFileWithBackend after project activation", async () => {
    const store = new MockStoreForRoutes();
    const app = createServer(store as any);
    mockEnsureMemoryFileWithBackend.mockResolvedValue(true);

    const res = await request(
      app,
      "POST",
      "/api/projects",
      JSON.stringify({ name: "Test Project", path: "/tmp" }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(201);
    // Allow fire-and-forget promise to complete
    await new Promise(resolve => setImmediate(resolve));
    expect(mockEnsureMemoryFileWithBackend).toHaveBeenCalledWith("/tmp");
  });

  it("returns 201 even when memory bootstrap fails", async () => {
    const store = new MockStoreForRoutes();
    const app = createServer(store as any);
    mockEnsureMemoryFileWithBackend.mockRejectedValue(new Error("disk full"));

    const res = await request(
      app,
      "POST",
      "/api/projects",
      JSON.stringify({ name: "Test Project", path: "/tmp" }),
      { "Content-Type": "application/json" },
    );

    // Project registration should still succeed
    expect(res.status).toBe(201);
    expect((res.body as any).status).toBe("active");
  });

  it("clones and registers when cloneUrl is provided", async () => {
    const store = new MockStoreForRoutes();
    const app = createServer(store as any);

    const tempRoot = mkdtempSync(join(tmpdir(), "fn-2310-clone-"));
    const bareRepo = join(tempRoot, "remote.git");
    const cloneDestination = join(tempRoot, "cloned-project");

    try {
      execFileSync("git", ["init", "--bare", bareRepo]);

      const res = await request(
        app,
        "POST",
        "/api/projects",
        JSON.stringify({
          name: "Cloned Project",
          path: cloneDestination,
          cloneUrl: bareRepo,
        }),
        { "Content-Type": "application/json" },
      );

      expect(res.status).toBe(201);
      expect(mockRegisterProject).toHaveBeenCalledWith({
        name: "Cloned Project",
        path: cloneDestination,
        isolationMode: "in-process",
        nodeId: undefined,
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("returns clone failure and skips registration when git clone fails", async () => {
    const store = new MockStoreForRoutes();
    const app = createServer(store as any);

    mockExecFile.mockImplementation((_file, _args, optsOrCallback, maybeCallback) => {
      const callback = typeof optsOrCallback === "function" ? optsOrCallback : maybeCallback;
      const cloneError = Object.assign(new Error("git exited with code 128"), { stderr: "fatal: repository not found" });
      callback?.(cloneError, "", "fatal: repository not found");
    });

    const res = await request(
      app,
      "POST",
      "/api/projects",
      JSON.stringify({
        name: "Broken Clone",
        path: "/tmp/broken-clone",
        cloneUrl: "https://github.com/runfusion/missing.git",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toContain("Git clone failed");
    expect(mockRegisterProject).not.toHaveBeenCalled();
    expect(mockFsRm).toHaveBeenCalledWith("/tmp/broken-clone", { recursive: true, force: true });
  }, 15_000);

  it("rejects clone mode when destination directory is non-empty", async () => {
    const store = new MockStoreForRoutes();
    const app = createServer(store as any);

    mockFsStat.mockResolvedValue({ isDirectory: () => true } as import("node:fs").Stats);
    mockFsReaddir.mockResolvedValue(["README.md"]);

    const res = await request(
      app,
      "POST",
      "/api/projects",
      JSON.stringify({
        name: "Existing Destination",
        path: "/tmp/existing-destination",
        cloneUrl: "https://github.com/runfusion/fusion.git",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toContain("Clone destination must be empty");
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockRegisterProject).not.toHaveBeenCalled();
  });

  it("rejects clone mode when cloneUrl is blank", async () => {
    const store = new MockStoreForRoutes();
    const app = createServer(store as any);

    const res = await request(
      app,
      "POST",
      "/api/projects",
      JSON.stringify({
        name: "Blank Clone Url",
        path: "/tmp/blank-clone-url",
        cloneUrl: "   ",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toContain("cloneUrl must be a non-empty string");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("rejects clone mode destination path with null-byte input", async () => {
    const store = new MockStoreForRoutes();
    const app = createServer(store as any);

    const res = await request(
      app,
      "POST",
      "/api/projects",
      JSON.stringify({
        name: "Invalid Destination",
        path: "/tmp/bad\u0000path",
        cloneUrl: "https://github.com/runfusion/fusion.git",
      }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect((res.body as { error?: string }).error).toContain("path cannot contain null bytes");
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects route handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls reconcileProjectStatuses before listing projects", async () => {
    const store = new MockStoreForRoutes();
    const app = createServer(store as any);

    mockReconcileProjectStatuses.mockResolvedValue([]);
    mockListProjects.mockResolvedValue([
      {
        id: "proj_abc",
        name: "Healed Project",
        path: "/test/path",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const res = await request(app, "GET", "/api/projects");

    expect(res.status).toBe(200);
    expect(mockReconcileProjectStatuses).toHaveBeenCalledBefore(mockListProjects);
    expect(mockListProjects).toHaveBeenCalled();
    expect((res.body as any[])).toHaveLength(1);
    expect((res.body as any[])[0].status).toBe("active");
  });

  it("returns healed status after reconciliation promotes stale projects", async () => {
    const store = new MockStoreForRoutes();
    const app = createServer(store as any);

    // Simulate reconciliation promoting one stale project
    mockReconcileProjectStatuses.mockResolvedValue([
      { projectId: "proj_stale", previousStatus: "initializing" },
    ]);
    mockListProjects.mockResolvedValue([
      {
        id: "proj_stale",
        name: "Formerly Stale",
        path: "/test/stale",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const res = await request(app, "GET", "/api/projects");

    expect(res.status).toBe(200);
    expect(mockReconcileProjectStatuses).toHaveBeenCalledTimes(1);
    expect((res.body as any[])[0].status).toBe("active");
  });
});

describe("PUT /api/global-concurrency route handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates the central global concurrency limit", async () => {
    const store = new MockStoreForRoutes();
    const app = createServer(store as any);

    const res = await request(
      app,
      "PUT",
      "/api/global-concurrency",
      JSON.stringify({ globalMaxConcurrent: 10 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    expect(mockUpdateGlobalConcurrency).toHaveBeenCalledWith({ globalMaxConcurrent: 10 });
    expect((res.body as any).globalMaxConcurrent).toBe(10);
  });

  it("rejects globalMaxConcurrent above 10000", async () => {
    const store = new MockStoreForRoutes();
    const app = createServer(store as any);

    const res = await request(
      app,
      "PUT",
      "/api/global-concurrency",
      JSON.stringify({ globalMaxConcurrent: 10001 }),
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(mockUpdateGlobalConcurrency).not.toHaveBeenCalled();
  });
});

// ── GET /api/projects/:id/health Route Tests ─────────────────────────────────
// Regression tests for multi-project health resolution (FN-1662)

describe("GET /api/projects/:id/health route handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock to default behavior - returns new MockStoreForRoutes by default
    mockGetOrCreateProjectStore.mockReset();
    mockGetOrCreateProjectStore.mockImplementation(async () => new MockStoreForRoutes());
  });

  // Helper to create a mock store with specific tasks
  function createMockStoreWithTasks(tasks: Array<{ id: string; column: string }>): MockStoreForRoutes & { listTasks: ReturnType<typeof vi.fn> } {
    const mockStore = new MockStoreForRoutes() as MockStoreForRoutes & { listTasks: ReturnType<typeof vi.fn> };
    mockStore.listTasks = vi.fn().mockResolvedValue(tasks);
    return mockStore;
  }

  it("returns project-specific task counts when using project-scoped store", async () => {
    // Create a store with specific tasks
    const projectATasks = [
      { id: "FN-1", column: "triage" },
      { id: "FN-2", column: "todo" },
      { id: "FN-3", column: "in-progress" },
      { id: "FN-4", column: "in-review" },
      { id: "FN-5", column: "done" },
      { id: "FN-6", column: "archived" },
    ];

    const storeA = createMockStoreWithTasks(projectATasks);
    mockGetOrCreateProjectStore.mockResolvedValue(storeA);

    // Setup: Project A
    mockGetProject.mockResolvedValue({
      id: "proj_a",
      name: "Project A",
      path: "/projects/a",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    
    // Central health returns stale data (common scenario)
    mockGetProjectHealth.mockResolvedValue({
      projectId: "proj_a",
      status: "active",
      activeTaskCount: 999, // Stale value
      inFlightAgentCount: 999, // Stale value
      totalTasksCompleted: 999, // Stale value
      totalTasksFailed: 0,
      updatedAt: "2020-01-01T00:00:00.000Z", // Very old timestamp
    });

    const defaultStore = new MockStoreForRoutes();
    const app = createServer(defaultStore as any);

    const res = await request(app, "GET", "/api/projects/proj_a/health");

    expect(res.status).toBe(200);
    const health = res.body as Record<string, unknown>;
    
    // Should have computed counts from project-scoped store, not stale central data
    expect(health.projectId).toBe("proj_a");
    expect(health.activeTaskCount).toBe(4); // triage + todo + in-progress + in-review
    expect(health.inFlightAgentCount).toBe(1); // only in-progress
    expect(health.totalTasksCompleted).toBe(2); // done + archived
    expect(health.status).toBe("active");
  });

  it("does not bleed counts between different projects", async () => {
    // Project A has 3 tasks
    const projectATasks = [
      { id: "FN-1", column: "triage" },
      { id: "FN-2", column: "in-progress" },
      { id: "FN-3", column: "done" },
    ];
    // Project B has 5 tasks
    const projectBTasks = [
      { id: "FN-10", column: "todo" },
      { id: "FN-11", column: "todo" },
      { id: "FN-12", column: "in-progress" },
      { id: "FN-13", column: "in-review" },
      { id: "FN-14", column: "archived" },
    ];

    const storeA = createMockStoreWithTasks(projectATasks);
    const storeB = createMockStoreWithTasks(projectBTasks);

    // Configure mock to return different stores per project
    mockGetOrCreateProjectStore.mockImplementation(async (projectId: string) => {
      if (projectId === "proj_a") return storeA;
      if (projectId === "proj_b") return storeB;
      return new MockStoreForRoutes();
    });

    const defaultStore = new MockStoreForRoutes();
    const app = createServer(defaultStore as any);

    // Request health for project A
    mockGetProject.mockResolvedValue({
      id: "proj_a",
      name: "Project A",
      path: "/projects/a",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    mockGetProjectHealth.mockResolvedValue({
      projectId: "proj_a",
      status: "active",
      activeTaskCount: 100,
      inFlightAgentCount: 50,
      totalTasksCompleted: 25,
      totalTasksFailed: 0,
      updatedAt: "2020-01-01T00:00:00.000Z",
    });

    const resA = await request(app, "GET", "/api/projects/proj_a/health");

    expect(resA.status).toBe(200);
    const healthA = resA.body as Record<string, unknown>;
    
    // Project A: 1 triage + 1 in-progress + 1 done = 3 tasks total, 2 active, 1 in-flight
    expect(healthA.activeTaskCount).toBe(2); // triage + in-progress
    expect(healthA.inFlightAgentCount).toBe(1); // in-progress
    expect(healthA.totalTasksCompleted).toBe(1); // done

    // Request health for project B
    mockGetProject.mockResolvedValue({
      id: "proj_b",
      name: "Project B",
      path: "/projects/b",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    mockGetProjectHealth.mockResolvedValue({
      projectId: "proj_b",
      status: "active",
      activeTaskCount: 200,
      inFlightAgentCount: 100,
      totalTasksCompleted: 50,
      totalTasksFailed: 0,
      updatedAt: "2020-01-01T00:00:00.000Z",
    });

    const resB = await request(app, "GET", "/api/projects/proj_b/health");

    expect(resB.status).toBe(200);
    const healthB = resB.body as Record<string, unknown>;
    
    // Project B: 2 todo + 1 in-progress + 1 in-review = 4 active, 1 in-flight
    expect(healthB.activeTaskCount).toBe(4); // 2 todo + 1 in-progress + 1 in-review
    expect(healthB.inFlightAgentCount).toBe(1); // in-progress
    expect(healthB.totalTasksCompleted).toBe(1); // archived

    // Verify no bleed-through: project A counts should not equal project B counts
    expect(healthA.activeTaskCount).not.toBe(healthB.activeTaskCount);
  });

  it("returns valid health response when central health row is missing but project exists", async () => {
    // No central health row for this project
    mockGetProjectHealth.mockResolvedValue(null);

    const tasks = [
      { id: "FN-1", column: "todo" },
      { id: "FN-2", column: "in-progress" },
      { id: "FN-3", column: "in-progress" },
      { id: "FN-4", column: "done" },
    ];

    const mockStore = createMockStoreWithTasks(tasks);
    mockGetOrCreateProjectStore.mockResolvedValue(mockStore);

    mockGetProject.mockResolvedValue({
      id: "proj_new",
      name: "New Project",
      path: "/projects/new",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const defaultStore = new MockStoreForRoutes();
    const app = createServer(defaultStore as any);

    // Should NOT return 404 - should synthesize valid health from project store
    const res = await request(app, "GET", "/api/projects/proj_new/health");

    expect(res.status).toBe(200);
    const health = res.body as Record<string, unknown>;
    
    // Should have computed counts from project store
    expect(health.projectId).toBe("proj_new");
    expect(health.activeTaskCount).toBe(3); // todo + 2 in-progress
    expect(health.inFlightAgentCount).toBe(2); // 2 in-progress
    expect(health.totalTasksCompleted).toBe(1); // done
    expect(health.status).toBe("active");
  });

  it("uses slim tasks when computing counts", async () => {
    const mockStore = createMockStoreWithTasks([
      { id: "FN-1", column: "todo" },
      { id: "FN-2", column: "in-progress" },
    ]);
    mockGetOrCreateProjectStore.mockResolvedValue(mockStore);

    mockGetProject.mockResolvedValue({
      id: "proj_test",
      name: "Test",
      path: "/test",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    mockGetProjectHealth.mockResolvedValue({
      projectId: "proj_test",
      status: "active",
      activeTaskCount: 100,
      inFlightAgentCount: 50,
      totalTasksCompleted: 25,
      totalTasksFailed: 0,
      updatedAt: "2020-01-01T00:00:00.000Z",
    });

    const defaultStore = new MockStoreForRoutes();
    const app = createServer(defaultStore as any);

    const res = await request(app, "GET", "/api/projects/proj_test/health");

    expect(res.status).toBe(200);
    
    // Verify that listTasks was called with { slim: true }
    expect(mockStore.listTasks).toHaveBeenCalledWith({ slim: true });
  });
});
