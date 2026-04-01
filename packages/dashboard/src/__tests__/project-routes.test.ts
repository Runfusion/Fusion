import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock CentralCore before importing routes
const mockListProjects = vi.fn().mockResolvedValue([]);
const mockGetProject = vi.fn().mockResolvedValue(null);
const mockRegisterProject = vi.fn().mockResolvedValue({
  id: "proj_test123",
  name: "Test Project",
  path: "/test/path",
  status: "active",
  isolationMode: "in-process",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const mockUpdateProject = vi.fn().mockResolvedValue({
  id: "proj_test123",
  name: "Updated Project",
  path: "/test/path",
  status: "active",
  isolationMode: "in-process",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const mockUnregisterProject = vi.fn().mockResolvedValue(undefined);
const mockGetProjectHealth = vi.fn().mockResolvedValue({
  projectId: "proj_test123",
  status: "active",
  activeTaskCount: 5,
  inFlightAgentCount: 2,
  totalTasksCompleted: 10,
  totalTasksFailed: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const mockGetRecentActivity = vi.fn().mockResolvedValue([]);
const mockGetGlobalConcurrencyState = vi.fn().mockResolvedValue({
  globalMaxConcurrent: 4,
  currentlyActive: 2,
  queuedCount: 0,
  projectsActive: { proj_test123: 2 },
});
const mockInit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

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
    })),
  };
});

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
  fetchProjectTasks,
  fetchTasks,
  type ProjectInfo,
  type DetectedProject,
} from "../../app/api";

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
