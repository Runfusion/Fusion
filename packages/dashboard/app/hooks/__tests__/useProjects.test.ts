import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchProjects,
  registerProject,
  unregisterProject,
  fetchProject,
  updateProject,
  detectProjects,
  fetchProjectHealth,
  fetchActivityFeed,
  pauseProject,
  resumeProject,
  fetchFirstRunStatus,
  fetchGlobalConcurrency,
  fetchProjectTasks,
  fetchProjectConfig,
  type ProjectInfo,
  type ProjectHealth,
  type ActivityFeedEntry,
  type FirstRunStatus,
  type GlobalConcurrencyState,
  type DetectedProject,
} from "../../api";

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

describe("Project Management API", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  describe("fetchProjects", () => {
    it("returns empty array when no projects", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

      const result = await fetchProjects();

      expect(result).toEqual([]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/projects",
        expect.any(Object)
      );
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
      expect(result[0].name).toBe("Test Project");
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
      expect(result.name).toBe("New Project");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/projects",
        expect.objectContaining({
          method: "POST",
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

  describe("fetchProjectHealth", () => {
    it("returns health metrics for a project", async () => {
      const mockHealth: ProjectHealth = {
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
      expect(result.totalTasksCompleted).toBe(10);
    });
  });

  describe("fetchActivityFeed", () => {
    it("returns activity feed entries", async () => {
      const mockEntries: ActivityFeedEntry[] = [
        {
          id: "entry_1",
          timestamp: "2026-01-01T00:00:00.000Z",
          type: "task:created",
          projectId: "proj_123",
          projectName: "Test Project",
          taskId: "FN-001",
          taskTitle: "Test Task",
          details: "Task created",
        },
      ];
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockEntries));

      const result = await fetchActivityFeed();

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("task:created");
      expect(result[0].projectName).toBe("Test Project");
    });

    it("supports limit parameter", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

      await fetchActivityFeed({ limit: 10 });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("limit=10"),
        expect.any(Object)
      );
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
      const mockStatus: FirstRunStatus = {
        hasProjects: false,
        singleProjectPath: null,
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockStatus));

      const result = await fetchFirstRunStatus();

      expect(result.hasProjects).toBe(false);
      expect(result.singleProjectPath).toBeNull();
    });

    it("returns single project path when only one project", async () => {
      const mockStatus: FirstRunStatus = {
        hasProjects: true,
        singleProjectPath: "/projects/my-project",
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockStatus));

      const result = await fetchFirstRunStatus();

      expect(result.hasProjects).toBe(true);
      expect(result.singleProjectPath).toBe("/projects/my-project");
    });
  });

  describe("fetchGlobalConcurrency", () => {
    it("returns global concurrency state", async () => {
      const mockState: GlobalConcurrencyState = {
        globalMaxConcurrent: 4,
        currentlyActive: 2,
        queuedCount: 0,
        projectsActive: { "proj_123": 2 },
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockState));

      const result = await fetchGlobalConcurrency();

      expect(result.globalMaxConcurrent).toBe(4);
      expect(result.currentlyActive).toBe(2);
      expect(result.projectsActive["proj_123"]).toBe(2);
    });
  });

  describe("pauseProject", () => {
    it("pauses a project", async () => {
      const mockProject: ProjectInfo = {
        id: "proj_123",
        name: "Test Project",
        path: "/test/path",
        status: "paused",
        isolationMode: "in-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockProject));

      const result = await pauseProject("proj_123");

      expect(result.status).toBe("paused");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/projects/proj_123/pause",
        expect.objectContaining({
          method: "POST",
        })
      );
    });
  });

  describe("resumeProject", () => {
    it("resumes a paused project", async () => {
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

      const result = await resumeProject("proj_123");

      expect(result.status).toBe("active");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/projects/proj_123/resume",
        expect.objectContaining({
          method: "POST",
        })
      );
    });
  });

  describe("fetchProjectTasks", () => {
    it("fetches tasks for a specific project", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

      await fetchProjectTasks("proj_123");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("projectId=proj_123"),
        expect.any(Object)
      );
    });

    it("supports pagination", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

      await fetchProjectTasks("proj_123", 10, 20);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("limit=10"),
        expect.any(Object)
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining("offset=20"),
        expect.any(Object)
      );
    });
  });

  describe("fetchProjectConfig", () => {
    it("fetches project config", async () => {
      const mockConfig = { maxConcurrent: 4, rootDir: "/projects/test" };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockConfig));

      const result = await fetchProjectConfig("proj_123");

      expect(result.maxConcurrent).toBe(4);
      expect(result.rootDir).toBe("/projects/test");
    });
  });

  describe("fetchProject (single)", () => {
    it("fetches a specific project by ID", async () => {
      const mockProject: ProjectInfo = {
        id: "proj_123",
        name: "Specific Project",
        path: "/specific/path",
        status: "active",
        isolationMode: "child-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockProject));

      const result = await fetchProject("proj_123");

      expect(result.id).toBe("proj_123");
      expect(result.name).toBe("Specific Project");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/projects/proj_123",
        expect.any(Object)
      );
    });
  });

  describe("updateProject", () => {
    it("updates project with valid data", async () => {
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

    it("updates project isolationMode", async () => {
      const mockProject: ProjectInfo = {
        id: "proj_123",
        name: "Test Project",
        path: "/test/path",
        status: "active",
        isolationMode: "child-process",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockProject));

      const result = await updateProject("proj_123", { isolationMode: "child-process" });

      expect(result.isolationMode).toBe("child-process");
    });
  });

  describe("detectProjects", () => {
    it("auto-detects projects in a base path", async () => {
      const mockDetected = {
        projects: [
          { path: "/home/user/project1", suggestedName: "project1", existing: false },
          { path: "/home/user/project2", suggestedName: "project2", existing: true },
        ],
      };
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, mockDetected));

      const result = await detectProjects("/home/user");

      expect(result.projects).toHaveLength(2);
      expect(result.projects[0].path).toBe("/home/user/project1");
      expect(result.projects[0].suggestedName).toBe("project1");
      expect(result.projects[1].existing).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/projects/detect",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ basePath: "/home/user" }),
        })
      );
    });

    it("uses home directory when basePath not provided", async () => {
      globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, { projects: [] }));

      await detectProjects();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/projects/detect",
        expect.objectContaining({
          body: JSON.stringify({ basePath: undefined }),
        })
      );
    });
  });
});
