import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListProjects = vi.fn();
const mockGetProject = vi.fn();
const mockGetProjectByPath = vi.fn();
const mockRegisterProject = vi.fn();
const mockUnregisterProject = vi.fn();
const mockGetProjectHealth = vi.fn();
const mockGetRuntime = vi.fn();
const mockRemoveRuntime = vi.fn();
const mockTaskStoreInit = vi.fn();
const mockTaskStoreListTasks = vi.fn();
const mockFindKbDir = vi.fn();
const mockIsKbProject = vi.fn();
const mockSuggestProjectName = vi.fn();
const mockFormatLastActivity = vi.fn();

vi.mock("../project-resolver.js", () => ({
  getCentralCore: vi.fn(async () => ({
    listProjects: mockListProjects,
    getProject: mockGetProject,
    getProjectByPath: mockGetProjectByPath,
    registerProject: mockRegisterProject,
    unregisterProject: mockUnregisterProject,
    getProjectHealth: mockGetProjectHealth,
  })),
  getProjectManager: vi.fn(async () => ({
    getRuntime: mockGetRuntime,
    removeProject: mockRemoveRuntime,
  })),
  findKbDir: vi.fn((path: string) => mockFindKbDir(path)),
  isKbProject: vi.fn((path: string) => mockIsKbProject(path)),
  suggestProjectName: vi.fn((path: string) => mockSuggestProjectName(path)),
  formatLastActivity: vi.fn((timestamp?: string) => mockFormatLastActivity(timestamp)),
  resolveProject: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  return {
    ...actual,
    TaskStore: vi.fn().mockImplementation(() => ({
      init: mockTaskStoreInit,
      listTasks: mockTaskStoreListTasks,
    })),
  };
});

const { runProjectList, runProjectAdd, runProjectRemove, runProjectInfo } = await import("./project.js");

describe("project commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockListProjects.mockResolvedValue([]);
    mockGetProject.mockResolvedValue(undefined);
    mockGetProjectByPath.mockResolvedValue(undefined);
    mockRegisterProject.mockImplementation(async (config: { name: string; path: string; isolationMode: string }) => ({
      id: "proj_new",
      name: config.name,
      path: config.path,
      status: "initializing",
      isolationMode: config.isolationMode,
      createdAt: "2026-03-31T00:00:00.000Z",
      updatedAt: "2026-03-31T00:00:00.000Z",
    }));
    mockUnregisterProject.mockResolvedValue(undefined);
    mockGetProjectHealth.mockResolvedValue(undefined);
    mockGetRuntime.mockReturnValue(undefined);
    mockRemoveRuntime.mockResolvedValue(undefined);
    mockTaskStoreInit.mockResolvedValue(undefined);
    mockTaskStoreListTasks.mockResolvedValue([]);
    mockFindKbDir.mockReturnValue(null);
    mockIsKbProject.mockReturnValue(true);
    mockSuggestProjectName.mockReturnValue("test-project");
    mockFormatLastActivity.mockReturnValue("just now");
  });

  it("prints empty state when no projects are registered", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProjectList();

    expect(logSpy).toHaveBeenCalledWith("\n  No projects registered.");
  });

  it("emits json output for project list", async () => {
    mockListProjects.mockResolvedValue([
      {
        id: "proj_123",
        name: "alpha",
        path: "/tmp/alpha",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-03-31T00:00:00.000Z",
        updatedAt: "2026-03-31T00:00:00.000Z",
      },
    ]);
    mockGetProjectHealth.mockResolvedValue({ inFlightAgentCount: 1, lastActivityAt: "2026-03-31T00:00:00.000Z" });
    mockTaskStoreListTasks.mockResolvedValue([{ column: "todo" }, { column: "done" }]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProjectList({ json: true });

    const payload = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(payload).toEqual([
      expect.objectContaining({
        id: "proj_123",
        name: "alpha",
        totalTasks: 2,
        activeAgents: 1,
      }),
    ]);
  });

  it("registers a project with explicit path and name", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProjectAdd("/tmp/my-project", {
      name: "my-project",
      isolation: "child-process",
      interactive: false,
    });

    expect(mockRegisterProject).toHaveBeenCalledWith({
      name: "my-project",
      path: "/tmp/my-project",
      isolationMode: "child-process",
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Registered project 'my-project'"));
  });

  it("rejects invalid isolation modes", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await runProjectAdd("/tmp/my-project", {
      name: "my-project",
      isolation: "invalid-mode" as never,
      interactive: false,
    });

    expect(errorSpy).toHaveBeenCalledWith("Error: Invalid isolation mode 'invalid-mode'");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("errors when directory is not a kb project", async () => {
    mockIsKbProject.mockReturnValue(false);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await runProjectAdd("/tmp/not-kb", { interactive: false });

    expect(errorSpy).toHaveBeenCalledWith("Error: No kb project found at /tmp/not-kb");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("errors when registering a duplicate project name", async () => {
    mockListProjects.mockResolvedValue([
      {
        id: "proj_existing",
        name: "my-project",
        path: "/tmp/existing",
        status: "active",
        isolationMode: "in-process",
        createdAt: "2026-03-31T00:00:00.000Z",
        updatedAt: "2026-03-31T00:00:00.000Z",
      },
    ]);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await runProjectAdd("/tmp/my-project", { name: "my-project", interactive: false });

    expect(errorSpy).toHaveBeenCalledWith("Error: Project 'my-project' already registered.");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("unregisters a project and stops runtime first", async () => {
    mockGetProject.mockResolvedValue({
      id: "proj_123",
      name: "alpha",
      path: "/tmp/alpha",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-03-31T00:00:00.000Z",
      updatedAt: "2026-03-31T00:00:00.000Z",
    });
    mockGetRuntime.mockReturnValue({ getStatus: () => "active" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProjectRemove("proj_123", { force: true, interactive: false });

    expect(mockRemoveRuntime).toHaveBeenCalledWith("proj_123");
    expect(mockUnregisterProject).toHaveBeenCalledWith("proj_123");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Unregistered project 'alpha'"));
  });

  it("does not stop runtime when removal is cancelled", async () => {
    mockGetProject.mockResolvedValue({
      id: "proj_123",
      name: "alpha",
      path: "/tmp/alpha",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-03-31T00:00:00.000Z",
      updatedAt: "2026-03-31T00:00:00.000Z",
    });
    mockGetRuntime.mockReturnValue({ getStatus: () => "active" });

    const readline = await import("node:readline/promises");
    const rlClose = vi.fn();
    vi.spyOn(readline, "createInterface").mockReturnValue({
      question: vi.fn().mockResolvedValue("n"),
      close: rlClose,
    } as never);

    await runProjectRemove("proj_123", { force: false, interactive: true });

    expect(mockRemoveRuntime).not.toHaveBeenCalled();
    expect(mockUnregisterProject).not.toHaveBeenCalled();
  });

  it("shows info for auto-detected cwd project", async () => {
    mockGetProject.mockResolvedValue({
      id: "proj_123",
      name: "detected-project",
      path: "/workspace/app",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-03-31T00:00:00.000Z",
      updatedAt: "2026-03-31T00:00:00.000Z",
    });
    mockGetProjectHealth.mockResolvedValue({
      activeTaskCount: 2,
      inFlightAgentCount: 1,
      totalTasksCompleted: 10,
      totalTasksFailed: 1,
      lastActivityAt: "2026-03-31T00:00:00.000Z",
    });
    mockGetRuntime.mockReturnValue({ getStatus: () => "active" });
    mockTaskStoreListTasks.mockResolvedValue([{ column: "todo" }, { column: "todo" }, { column: "done" }]);

    const resolver = await import("../project-resolver.js");
    vi.mocked(resolver.resolveProject).mockResolvedValue({
      projectId: "proj_123",
      name: "detected-project",
      directory: "/workspace/app",
      status: "active",
      isolationMode: "in-process",
      store: {} as never,
    } as never);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProjectInfo(undefined, { interactive: false });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Project: detected-project"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Active tasks: 2"));
  });

  it("errors when explicit project name is missing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await runProjectInfo("missing-project", { interactive: false });

    expect(errorSpy).toHaveBeenCalledWith("Error: Project 'missing-project' not found.");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("Project command helpers", () => {
  it("should export all required functions", () => {
    expect(runProjectList).toBeDefined();
    expect(runProjectAdd).toBeDefined();
    expect(runProjectRemove).toBeDefined();
    expect(runProjectInfo).toBeDefined();
  });
});
