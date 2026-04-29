import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, statSync } from "node:fs";
import { TaskStore } from "@fusion/core";

const { mockIsValidSqliteDatabaseFile } = vi.hoisted(() => ({
  mockIsValidSqliteDatabaseFile: vi.fn(),
}));

// Mock fs module
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

// Mock @fusion/core
vi.mock("@fusion/core", async () => {
  return {
    CentralCore: class MockCentralCore {
      init = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
      listProjects = vi.fn().mockResolvedValue([]);
      getProject = vi.fn().mockResolvedValue(undefined);
      getProjectByPath = vi.fn().mockResolvedValue(undefined);
      registerProject = vi.fn();
      updateProject = vi.fn().mockResolvedValue({});
      unregisterProject = vi.fn().mockResolvedValue(undefined);
      getProjectHealth = vi.fn().mockResolvedValue(undefined);
      isInitialized = vi.fn().mockReturnValue(true);
    },
    isValidSqliteDatabaseFile: (...args: Parameters<typeof mockIsValidSqliteDatabaseFile>) =>
      mockIsValidSqliteDatabaseFile(...args),
    TaskStore: vi.fn().mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue([]),
    })),
  };
});

// Mock @fusion/engine
vi.mock("@fusion/engine", async () => {
  return {
    ProjectManager: class MockProjectManager {
      getRuntime = vi.fn().mockReturnValue(undefined);
      removeProject = vi.fn().mockResolvedValue(undefined);
      stopAll = vi.fn().mockResolvedValue(undefined);
    },
  };
});

// Import after mocks are set up
const projectResolver = await import("../project-resolver.js");
const {
  getCentralCore,
  getProjectManager,
  findKbDir,
  resolveProject,
  getResolvedProject,
  formatResolutionError,
  findProjectByPath,
  isProjectNameTaken,
  listRegisteredProjects,
  getProjectByName,
  getProjectSummary,
  isCentralCoreInitialized,
  cleanupProjectResolution,
  ProjectResolutionError,
  isKbProject,
  suggestProjectName,
  resolveAbsolutePath,
  formatLastActivity,
  resetProjectResolution,
} = projectResolver;

describe("Project Resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectResolution();
    mockIsValidSqliteDatabaseFile.mockReturnValue(false);
    vi.mocked(TaskStore).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue([]),
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("findKbDir", () => {
    it("should find .fusion directory in current path", () => {
      mockIsValidSqliteDatabaseFile.mockImplementation((path) => String(path) === "/project/.fusion/fusion.db");

      const result = findKbDir("/project");
      expect(result).toBe("/project");
    });

    it("should walk up parent directories to find .fusion", () => {
      mockIsValidSqliteDatabaseFile.mockImplementation((path) => String(path) === "/a/b/.fusion/fusion.db");

      const result = findKbDir("/a/b/c");
      expect(result).toBe("/a/b");
    });

    it("should return null if no .fusion found", () => {
      const result = findKbDir("/some/path");
      expect(result).toBeNull();
    });

    it("should return null if fusion.db is not a valid SQLite database", () => {
      mockIsValidSqliteDatabaseFile.mockReturnValue(false);
      const result = findKbDir("/project");
      expect(result).toBeNull();
    });
  });

  describe("isKbProject", () => {
    it("should return true if fusion.db is a valid SQLite database", () => {
      mockIsValidSqliteDatabaseFile.mockImplementation((path) => String(path) === "/project/.fusion/fusion.db");
      expect(isKbProject("/project")).toBe(true);
    });

    it("should return false if fusion.db is invalid or missing", () => {
      expect(isKbProject("/project")).toBe(false);
    });
  });

  describe("suggestProjectName", () => {
    it("should return last path segment as project name", () => {
      expect(suggestProjectName("/path/to/my-project")).toBe("my-project");
    });

    it("should handle paths without separators", () => {
      expect(suggestProjectName("project")).toBe("project");
    });

    it("should return 'unnamed' for empty path", () => {
      expect(suggestProjectName("")).toBe("unnamed");
    });
  });

  describe("resolveAbsolutePath", () => {
    it("should resolve and validate existing directory", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);
      const result = resolveAbsolutePath("/existing/path");
      expect(result).toBeDefined();
    });

    it("should throw ProjectResolutionError for non-existent path", () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(() => resolveAbsolutePath("/nonexistent")).toThrow(ProjectResolutionError);
    });

    it("should throw ProjectResolutionError for non-directory path", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as any);
      expect(() => resolveAbsolutePath("/file.txt")).toThrow(ProjectResolutionError);
    });
  });

  describe("resolveProject", () => {
    it("should resolve by explicit --project flag", async () => {
      const mockProject = {
        id: "proj_123",
        name: "alpha",
        path: "/workspace/alpha",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };

      vi.mocked(existsSync).mockImplementation((path) => path === "/workspace/alpha");
      vi.mocked(TaskStore).mockImplementation(() => ({
        init: vi.fn().mockResolvedValue(undefined),
        listTasks: vi.fn().mockResolvedValue([]),
      }) as any);

      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([mockProject]);

      const resolved = await resolveProject({ project: "alpha", interactive: false });
      expect(resolved.projectId).toBe("proj_123");
      expect(resolved.name).toBe("alpha");
      expect(resolved.directory).toBe("/workspace/alpha");
      expect(resolved.store.init).toHaveBeenCalledOnce();
    });

    it("should throw NOT_FOUND if --project project not found", async () => {
      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([]);

      await expect(resolveProject({ project: "nonexistent", interactive: false })).rejects.toThrow(
        ProjectResolutionError,
      );
    });

    it("should throw NOT_REGISTERED if .fusion exists but project not registered", async () => {
      mockIsValidSqliteDatabaseFile.mockImplementation((path) => String(path) === "/unregistered/.fusion/fusion.db");

      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([]);
      core.getProjectByPath.mockResolvedValue(undefined);

      await expect(resolveProject({ cwd: "/unregistered", interactive: false })).rejects.toThrow(
        ProjectResolutionError,
      );
    });

    it("should throw NO_PROJECTS when no projects registered and no .fusion found", async () => {
      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([]);

      await expect(resolveProject({ interactive: false })).rejects.toThrow(ProjectResolutionError);
    });

    it("should throw MULTIPLE_MATCHES when multiple projects and no match", async () => {
      const projects = [
        {
          id: "proj_1",
          name: "project1",
          path: "/path1",
          status: "active",
          isolationMode: "in-process",
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "proj_2",
          name: "project2",
          path: "/path2",
          status: "active",
          isolationMode: "in-process",
          createdAt: "",
          updatedAt: "",
        },
      ];

      vi.mocked(existsSync).mockReturnValue(false);

      const core = await getCentralCore();
      core.listProjects.mockResolvedValue(projects);

      await expect(resolveProject({ interactive: false })).rejects.toThrow(ProjectResolutionError);
    });

    it("should throw PATH_MISMATCH if registered project directory moved", async () => {
      const mockProject = {
        id: "proj_123",
        name: "moved-project",
        path: "/old/path",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      };

      vi.mocked(existsSync).mockReturnValue(false);

      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([mockProject]);

      await expect(
        resolveProject({ project: "moved-project", interactive: false }),
      ).rejects.toThrow(ProjectResolutionError);
    });

    it("should resolve project from CWD when .fusion path matches registered project", async () => {
      const mockProject = {
        id: "proj_456",
        name: "cwd-match",
        path: "/workspace/cwd-match",
        status: "active",
        isolationMode: "in-process",
        createdAt: "",
        updatedAt: "",
      };

      mockIsValidSqliteDatabaseFile.mockImplementation((path) => String(path) === "/workspace/cwd-match/.fusion/fusion.db");
      vi.mocked(existsSync).mockImplementation((path) => String(path) === "/workspace/cwd-match");

      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([mockProject]);

      const resolved = await resolveProject({ cwd: "/workspace/cwd-match", interactive: false });
      expect(resolved.projectId).toBe("proj_456");
      expect(resolved.directory).toBe("/workspace/cwd-match");
    });

    it("should use the only registered project when no .fusion directory is found", async () => {
      const onlyProject = {
        id: "proj_single",
        name: "solo",
        path: "/workspace/solo",
        status: "active",
        isolationMode: "in-process",
        createdAt: "",
        updatedAt: "",
      };

      vi.mocked(existsSync).mockImplementation((path) => String(path) === "/workspace/solo");

      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([onlyProject]);

      const resolved = await resolveProject({ cwd: "/nowhere/here", interactive: false });
      expect(resolved.projectId).toBe("proj_single");
      expect(resolved.name).toBe("solo");
    });

    it("should throw PATH_MISMATCH for CWD-matched project whose path no longer exists", async () => {
      const match = {
        id: "proj_missing",
        name: "missing-cwd",
        path: "/workspace/missing-cwd",
        status: "active",
        isolationMode: "in-process",
        createdAt: "",
        updatedAt: "",
      };

      mockIsValidSqliteDatabaseFile.mockImplementation((path) => String(path) === "/workspace/missing-cwd/.fusion/fusion.db");
      vi.mocked(existsSync).mockReturnValue(false);

      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([match]);

      await expect(
        resolveProject({ cwd: "/workspace/missing-cwd", interactive: false }),
      ).rejects.toMatchObject({ code: "PATH_MISMATCH" });
    });

    it("should throw PATH_MISMATCH when the only fallback project path is missing", async () => {
      const project = {
        id: "proj_ghost",
        name: "ghost",
        path: "/workspace/ghost",
        status: "active",
        isolationMode: "in-process",
        createdAt: "",
        updatedAt: "",
      };

      vi.mocked(existsSync).mockReturnValue(false);

      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([project]);

      await expect(resolveProject({ cwd: "/not-a-project", interactive: false })).rejects.toMatchObject({
        code: "PATH_MISMATCH",
      });
    });

    it("should include similar project names in NOT_FOUND suggestions", async () => {
      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([
        {
          id: "proj_alpha",
          name: "alpha",
          path: "/workspace/alpha",
          status: "active",
          isolationMode: "in-process",
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "proj_beta",
          name: "beta",
          path: "/workspace/beta",
          status: "active",
          isolationMode: "in-process",
          createdAt: "",
          updatedAt: "",
        },
      ]);

      await expect(resolveProject({ project: "alp", interactive: false })).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: expect.stringContaining("Did you mean: alpha"),
      });
    });

    it("getResolvedProject should return the same resolution result", async () => {
      const explicit = {
        id: "proj_get",
        name: "get-proj",
        path: "/workspace/get-proj",
        status: "active",
        isolationMode: "in-process",
        createdAt: "",
        updatedAt: "",
      };

      vi.mocked(existsSync).mockImplementation((path) => String(path) === "/workspace/get-proj");

      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([explicit]);

      const resolved = await getResolvedProject({ project: "get-proj", interactive: false });
      expect(resolved.projectId).toBe("proj_get");
      expect(resolved.name).toBe("get-proj");
    });
  });

  describe("ProjectResolutionError", () => {
    it("should create error with code and context", () => {
      const error = new ProjectResolutionError("Test error", "NOT_FOUND", { id: "123" });
      expect(error.message).toBe("Test error");
      expect(error.code).toBe("NOT_FOUND");
      expect(error.context).toEqual({ id: "123" });
      expect(error.name).toBe("ProjectResolutionError");
    });

    it("should include all error codes", () => {
      const codes = [
        "NOT_FOUND",
        "NOT_REGISTERED",
        "MULTIPLE_MATCHES",
        "NO_PROJECTS",
        "PATH_MISMATCH",
        "NOT_INITIALIZED",
        "CANCELLED",
      ];

      for (const code of codes) {
        const error = new ProjectResolutionError("test", code as any);
        expect(error.code).toBe(code);
      }
    });
  });

  describe("formatResolutionError", () => {
    it("formats NOT_FOUND errors with available project names", () => {
      const error = new ProjectResolutionError("Missing project", "NOT_FOUND", {
        availableProjects: ["alpha", "beta"],
      });

      const formatted = formatResolutionError(error);
      expect(formatted).toContain("✗ Missing project");
      expect(formatted).toContain("Available projects:");
      expect(formatted).toContain("- alpha");
      expect(formatted).toContain("- beta");
    });

    it("formats MULTIPLE_MATCHES without duplicating embedded project list", () => {
      const error = new ProjectResolutionError(
        "Multiple projects registered. Use --project <name> to specify one.",
        "MULTIPLE_MATCHES",
        { availableProjects: [{ name: "alpha", path: "/a" }] },
      );

      const formatted = formatResolutionError(error);
      expect(formatted).toContain("✗ Multiple projects registered");
      expect(formatted).not.toContain("Available projects:\n\n  Available projects");
    });

    it("formats NO_PROJECTS errors using the embedded guidance", () => {
      const error = new ProjectResolutionError("No projects registered.", "NO_PROJECTS");
      const formatted = formatResolutionError(error);
      expect(formatted).toContain("✗ No projects registered.");
    });
  });

  describe("utility delegation helpers", () => {
    it("findProjectByPath supports explicit central parameter", async () => {
      const central = {
        listProjects: vi.fn().mockResolvedValue([
          { id: "p1", name: "one", path: "/work/one", status: "active", isolationMode: "in-process" },
        ]),
      } as any;

      const found = await findProjectByPath("/work/one", central);
      expect(found?.id).toBe("p1");
      expect(central.listProjects).toHaveBeenCalledOnce();
    });

    it("findProjectByPath uses singleton central when not provided", async () => {
      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([
        { id: "p2", name: "two", path: "/work/two", status: "active", isolationMode: "in-process" },
      ]);

      const found = await findProjectByPath("/work/two");
      expect(found?.name).toBe("two");
    });

    it("isProjectNameTaken performs case-insensitive matching", async () => {
      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([
        { id: "p3", name: "AlphaProject", path: "/work/alpha", status: "active", isolationMode: "in-process" },
      ]);

      await expect(isProjectNameTaken("alphaproject")).resolves.toBe(true);
      await expect(isProjectNameTaken("ALPHAPROJECT")).resolves.toBe(true);
      await expect(isProjectNameTaken("beta")).resolves.toBe(false);
    });

    it("listRegisteredProjects delegates to central.listProjects", async () => {
      const projects = [
        { id: "p4", name: "listed", path: "/work/listed", status: "active", isolationMode: "in-process" },
      ];
      const core = await getCentralCore();
      core.listProjects.mockResolvedValue(projects);

      await expect(listRegisteredProjects()).resolves.toEqual(projects);
      expect(core.listProjects).toHaveBeenCalled();
    });

    it("getProjectByName returns found and undefined when missing", async () => {
      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([
        { id: "p5", name: "found", path: "/work/found", status: "active", isolationMode: "in-process" },
      ]);

      await expect(getProjectByName("found")).resolves.toMatchObject({ id: "p5" });
      await expect(getProjectByName("missing")).resolves.toBeUndefined();
    });

    it("getProjectSummary returns only name/path/status", async () => {
      const core = await getCentralCore();
      core.listProjects.mockResolvedValue([
        {
          id: "p6",
          name: "summary",
          path: "/work/summary",
          status: "paused",
          isolationMode: "in-process",
          createdAt: "",
          updatedAt: "",
        },
      ]);

      await expect(getProjectSummary()).resolves.toEqual([
        { name: "summary", path: "/work/summary", status: "paused" },
      ]);
    });

    it("tracks central initialization state before/after getCentralCore", async () => {
      expect(isCentralCoreInitialized()).toBe(false);
      await getCentralCore();
      expect(isCentralCoreInitialized()).toBe(true);
    });

    it("cleanupProjectResolution closes central and resets singleton state", async () => {
      const core = await getCentralCore();
      await getProjectManager();

      await cleanupProjectResolution();

      expect(core.close).toHaveBeenCalledOnce();
      expect(isCentralCoreInitialized()).toBe(false);
    });
  });

  describe("formatLastActivity", () => {
    it("should format 'just now' for recent timestamps", () => {
      const now = new Date().toISOString();
      expect(formatLastActivity(now)).toBe("just now");
    });

    it("should format minutes ago", () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60000).toISOString();
      expect(formatLastActivity(fiveMinutesAgo)).toBe("5m ago");
    });

    it("should format hours ago", () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
      expect(formatLastActivity(twoHoursAgo)).toBe("2h ago");
    });

    it("should format days ago", () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
      expect(formatLastActivity(threeDaysAgo)).toBe("3d ago");
    });

    it("should honor branch boundaries at 59m, 23h, and 6d", () => {
      const fiftyNineMinutesAgo = new Date(Date.now() - 59 * 60000).toISOString();
      const twentyThreeHoursAgo = new Date(Date.now() - 23 * 3600000).toISOString();
      const sixDaysAgo = new Date(Date.now() - 6 * 86400000).toISOString();

      expect(formatLastActivity(fiftyNineMinutesAgo)).toBe("59m ago");
      expect(formatLastActivity(twentyThreeHoursAgo)).toBe("23h ago");
      expect(formatLastActivity(sixDaysAgo)).toBe("6d ago");
    });

    it("returns locale date string for activity older than seven days", () => {
      const oldDate = new Date(Date.now() - 8 * 86400000);
      expect(formatLastActivity(oldDate.toISOString())).toBe(oldDate.toLocaleDateString());
    });

    it("should return 'never' for undefined timestamp", () => {
      expect(formatLastActivity(undefined)).toBe("never");
    });
  });

  describe("resetProjectResolution", () => {
    it("should reset singleton instances", async () => {
      const core1 = await getCentralCore();

      resetProjectResolution();

      const core2 = await getCentralCore();

      expect(core1).not.toBe(core2);
      expect(core2.init).toHaveBeenCalled();
    });
  });
});

describe("getCentralCore singleton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectResolution();
  });

  it("should return same instance on multiple calls", async () => {
    const core1 = await getCentralCore();
    const core2 = await getCentralCore();
    expect(core1).toBe(core2);
  });
});

describe("getProjectManager singleton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProjectResolution();
  });

  it("should return same instance on multiple calls", async () => {
    const pm1 = await getProjectManager();
    const pm2 = await getProjectManager();
    expect(pm1).toBe(pm2);
  });
});
