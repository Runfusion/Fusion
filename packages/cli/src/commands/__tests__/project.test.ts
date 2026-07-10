/**
 * Tests for project.ts commands
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
  const mock = vi.fn(function () {});
  const originalMockImplementation = mock.mockImplementation.bind(mock);
  const originalMockImplementationOnce = mock.mockImplementationOnce.bind(mock);
  const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
    return nextImpl(...args);
  };
  mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
  mock.mockImplementationOnce = ((nextImpl: T) => originalMockImplementationOnce(wrap(nextImpl))) as typeof mock.mockImplementationOnce;
  if (impl) {
    mock.mockImplementation(impl);
  }
  return mock;
}

const mockListProjects = vi.fn();
const mockRegisterProject = vi.fn();
const mockEnsureProjectForPath = vi.fn(async (...args: unknown[]) => ({
  outcome: "registered",
  project: await mockRegisterProject(...args),
}));
const mockUpdateProject = vi.fn().mockResolvedValue({});
const mockUnregisterProject = vi.fn();
const mockGetProject = vi.fn();
const mockGetProjectByPath = vi.fn();
const mockGetProjectHealth = vi.fn();
const mockInit = vi.fn();
const mockClose = vi.fn();
const mockQuestion = vi.fn();
const mockRlClose = vi.fn();
const mockSetDefaultProject = vi.fn();
const mockDetectProjectFromCwd = vi.fn();
const mockFormatProjectLine = vi.fn();
const mockGetSettings = vi.fn();
const mockGlobalInit = vi.fn();
const mockTaskStoreInit = vi.fn();
const mockTaskStoreListTasks = vi.fn();
const mockTaskStoreClose = vi.fn();
const mockEnsureMemoryFileWithBackend = vi.fn();

// Mock @fusion/core
vi.mock("@fusion/core", () => ({
  CentralCore: makeConstructibleMock(() => ({
    init: mockInit.mockResolvedValue(undefined),
    close: mockClose.mockResolvedValue(undefined),
    listProjects: mockListProjects,
    registerProject: mockRegisterProject,
    ensureProjectForPath: mockEnsureProjectForPath,
    updateProject: mockUpdateProject,
    unregisterProject: mockUnregisterProject,
    getProject: mockGetProject,
    getProjectByPath: mockGetProjectByPath,
    getProjectHealth: mockGetProjectHealth,
  })),
  GlobalSettingsStore: makeConstructibleMock(() => ({
    init: mockGlobalInit.mockResolvedValue(undefined),
    getSettings: mockGetSettings,
  })),
  TaskStore: makeConstructibleMock(() => ({
    init: mockTaskStoreInit,
    listTasks: mockTaskStoreListTasks,
    close: mockTaskStoreClose,
  })),
  // FNXC:PostgresCutover 2026-07-05-17:20: getTaskCounts/health now boot the
  // project store through the PostgreSQL startup factory; route the factory to
  // the same mocked listTasks so count/in-flight assertions exercise it.
  createTaskStoreForBackend: vi.fn(async () => ({
    taskStore: {
      init: mockTaskStoreInit,
      listTasks: mockTaskStoreListTasks,
    },
    shutdown: vi.fn(async () => {}),
  })),
  // FN-7740: `getTaskCounts`/`runProjectAdd`'s interactive-init store now
  // close via `store.close()` and `listTasks` is wrapped in `retryOnLock`
  // (which imports `isSqliteLockError` from @fusion/core) — stub it per
  // project memory's mocked-module pitfall.
  isSqliteLockError: vi.fn(() => false),
  countRunningAgentTasks: (tasks: Array<{ column: string; status?: string; paused?: boolean }>) => tasks.filter((task) => (
    task.column === "in-progress" ||
    (task.column === "triage" && task.status === "planning" && !task.paused) ||
    (task.column === "in-review" && ["merging", "merging-pr", "merging-fix", "reviewing", "fixing"].includes(String(task.status ?? "")) && !task.paused)
  )).length,
  ensureMemoryFileWithBackend: mockEnsureMemoryFileWithBackend,
  readProjectIdentity: vi.fn().mockReturnValue(undefined),
  writeProjectIdentity: vi.fn(),
  COLUMNS: ["triage", "todo", "in-progress", "in-review", "done", "archived"],
  COLUMN_LABELS: {
    triage: "Triage",
    todo: "To Do",
    "in-progress": "In Progress",
    "in-review": "In Review",
    done: "Done",
    archived: "Archived",
  },
}));

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockRlClose,
  })),
}));

vi.mock("../../project-context.js", () => ({
  formatProjectLine: mockFormatProjectLine,
  detectProjectFromCwd: mockDetectProjectFromCwd,
  setDefaultProject: mockSetDefaultProject,
  resolveProject: vi.fn(),
}));

describe("project commands", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    mockGetSettings.mockResolvedValue({});
    mockFormatProjectLine.mockImplementation((project, isDefault) => `${isDefault ? "* " : "  "}${project.name}`);
    mockQuestion.mockResolvedValue("y");
    mockGetProjectHealth.mockResolvedValue(undefined);
    mockTaskStoreInit.mockResolvedValue(undefined);
    mockTaskStoreListTasks.mockResolvedValue([]);
    mockTaskStoreClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("exports all project command functions", async () => {
    const project = await import("../project.js");
    expect(typeof project.runProjectList).toBe("function");
    expect(typeof project.runProjectAdd).toBe("function");
    expect(typeof project.runProjectRemove).toBe("function");
    expect(typeof project.runProjectShow).toBe("function");
    expect(typeof project.runProjectInfo).toBe("function");
    expect(typeof project.runProjectSetDefault).toBe("function");
    expect(typeof project.runProjectDetect).toBe("function");
  });

  it("runProjectList prints registered projects and summary", async () => {
    mockListProjects.mockResolvedValue([
      { id: "proj-1", name: "app-one", path: "/tmp/app-one", status: "active", isolationMode: "in-process" },
      { id: "proj-2", name: "app-two", path: "/tmp/app-two", status: "paused", isolationMode: "child-process" },
    ]);
    mockGetSettings.mockResolvedValue({ defaultProjectId: "proj-1" });
    mockGetProject.mockImplementation(async (id: string) => (
      id === "proj-1"
        ? { id: "proj-1", name: "app-one", path: "/tmp/app-one", status: "active", isolationMode: "in-process" }
        : undefined
    ));

    const { runProjectList } = await import("../project.js");
    await runProjectList();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("2 projects registered, 1 active"));
    // Check that projects are displayed in output
    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("app-one");
    expect(output).toContain("app-two");
  });

  it("runProjectList with --json flag outputs JSON", async () => {
    mockListProjects.mockResolvedValue([
      { id: "proj-1", name: "app-one", path: "/tmp/app-one", status: "active", isolationMode: "in-process" },
    ]);
    mockGetSettings.mockResolvedValue({});

    const { runProjectList } = await import("../project.js");
    await runProjectList({ json: true });

    // Should output JSON
    const jsonOutput = consoleSpy.mock.calls.map((call) => String(call[0])).join("");
    expect(() => JSON.parse(jsonOutput)).not.toThrow();
    const parsed = JSON.parse(jsonOutput);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe("app-one");
  });

  it("runProjectAdd registers project and prints sanitized path output", async () => {
    mockListProjects.mockResolvedValue([]);
    mockRegisterProject.mockResolvedValue({ id: "proj-1", name: "demo", path: "/tmp/demo", isolationMode: "in-process" });

    const { runProjectAdd } = await import("../project.js");
    await runProjectAdd("demo", ".", { force: true });

    expect(mockEnsureProjectForPath).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "demo",
        path: process.cwd(),
      }),
    );
    const lines = consoleSpy.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes("Registered project 'demo'"))).toBe(true);
    expect(lines.some((line) => line.includes("Location:"))).toBe(true);
    expect(lines.some((line) => line.includes("/tmp/demo"))).toBe(false);
  });

  it("runProjectRemove unregisters project after confirmation", async () => {
    mockGetProject.mockResolvedValue({ id: "proj-1", name: "demo", path: "/tmp/demo", status: "active", isolationMode: "in-process" });

    const { runProjectRemove } = await import("../project.js");
    await runProjectRemove("proj-1", { force: false });

    expect(mockUnregisterProject).toHaveBeenCalledWith("proj-1");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Unregistered project 'demo'"));
  });

  it("runProjectRemove with --force skips confirmation", async () => {
    mockGetProject.mockResolvedValue({ id: "proj-1", name: "demo", path: "/tmp/demo", status: "active", isolationMode: "in-process" });

    const { runProjectRemove } = await import("../project.js");
    await runProjectRemove("proj-1", { force: true });

    expect(mockUnregisterProject).toHaveBeenCalledWith("proj-1");
    // Question should not be called when force is true
    expect(mockQuestion).not.toHaveBeenCalled();
  });

  it("runProjectShow prints detailed project metadata without absolute path leakage", async () => {
    mockGetProject.mockResolvedValue({
      id: "proj-1",
      name: "demo",
      path: "/tmp/demo",
      status: "active",
      isolationMode: "child-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    mockGetSettings.mockResolvedValue({ defaultProjectId: "proj-1" });
    mockTaskStoreListTasks.mockResolvedValue([]);

    const { runProjectShow } = await import("../project.js");
    await runProjectShow("proj-1");

    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Project: demo (default)");
    expect(output).toContain("Isolation: child-process");
    expect(output).toContain("Created:");
    expect(output).not.toContain("/tmp/demo");
  });

  it("runProjectInfo is alias for runProjectShow", async () => {
    mockGetProject.mockResolvedValue({
      id: "proj-1",
      name: "demo",
      path: "/tmp/demo",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    mockGetSettings.mockResolvedValue({});
    mockTaskStoreListTasks.mockResolvedValue([]);

    const { runProjectInfo } = await import("../project.js");
    await runProjectInfo("proj-1");

    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Project: demo");
  });

  it("runProjectSetDefault sets default project", async () => {
    mockGetProject.mockResolvedValue({ id: "proj-1", name: "demo", path: "/tmp/demo", status: "active", isolationMode: "in-process" });

    const { runProjectSetDefault } = await import("../project.js");
    await runProjectSetDefault("proj-1");

    expect(mockSetDefaultProject).toHaveBeenCalledWith("proj-1");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Set 'demo' as default project"));
  });

  it("runProjectDetect prints detected project without absolute path leakage", async () => {
    mockDetectProjectFromCwd.mockResolvedValue({ id: "proj-1", name: "demo", path: "/tmp/demo" });

    const { runProjectDetect } = await import("../project.js");
    await runProjectDetect();

    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Detected: demo");
    expect(output).toContain("Location:");
    expect(output).not.toContain("/tmp/demo");
  });

  it("runProjectList shows task counts for projects", async () => {
    mockListProjects.mockResolvedValue([
      { id: "proj-1", name: "app-one", path: "/tmp/app-one", status: "active", isolationMode: "in-process" },
    ]);
    mockGetSettings.mockResolvedValue({});

    // Mock task store to return some tasks - return 3 tasks
    mockTaskStoreListTasks.mockResolvedValue([
      { id: "FN-001", column: "todo" },
      { id: "FN-002", column: "in-progress" },
      { id: "FN-003", column: "done" },
    ]);

    const { runProjectList } = await import("../project.js");
    await runProjectList();

    // Verify TaskStore.listTasks was called
    expect(mockTaskStoreListTasks).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("3"); // Total task count
  });

  it("runProjectShow shows task counts in output", async () => {
    mockGetProject.mockResolvedValue({
      id: "proj-1",
      name: "demo",
      path: "/tmp/demo",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    mockGetSettings.mockResolvedValue({});
    mockTaskStoreListTasks.mockResolvedValue([
      { id: "FN-001", column: "todo" },
      { id: "FN-002", column: "todo" },
      { id: "FN-003", column: "in-progress" },
    ]);

    const { runProjectShow } = await import("../project.js");
    await runProjectShow("proj-1");

    // Verify TaskStore.listTasks was called
    expect(mockTaskStoreListTasks).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Total: 3");
    expect(output).toContain("To Do: 2");
    expect(output).toContain("In Progress: 1");
  });

  it("runProjectShow shows health info when available", async () => {
    mockGetProject.mockResolvedValue({
      id: "proj-1",
      name: "demo",
      path: "/tmp/demo",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    mockGetSettings.mockResolvedValue({});
    mockGetProjectHealth.mockResolvedValue({
      projectId: "proj-1",
      status: "active",
      activeTaskCount: 2,
      inFlightAgentCount: 1,
      totalTasksCompleted: 10,
      totalTasksFailed: 1,
      lastActivityAt: new Date().toISOString(),
    });
    mockTaskStoreListTasks.mockResolvedValue([{ id: "FN-003", column: "in-progress" }]);

    const { runProjectShow } = await import("../project.js");
    await runProjectShow("proj-1");

    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Health:");
    expect(output).toContain("Active Tasks: 2");
    expect(output).toContain("In-Flight Agents: 1");
    expect(output).toContain("Completed: 10");
  });

  it("runProjectShow derives In-Flight Agents from live executors, triage planners, and in-review agents when central health is stale", async () => {
    mockGetProject.mockResolvedValue({
      id: "proj-1",
      name: "demo",
      path: "/tmp/demo",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    mockGetSettings.mockResolvedValue({});
    const staleHealth = {
      projectId: "proj-1",
      status: "active",
      activeTaskCount: 2,
      inFlightAgentCount: 0,
      totalTasksCompleted: 10,
      totalTasksFailed: 1,
      lastActivityAt: new Date().toISOString(),
    };
    mockGetProjectHealth.mockResolvedValue(staleHealth);
    mockTaskStoreListTasks.mockResolvedValue([
      { id: "FN-001", column: "todo" },
      { id: "FN-002", column: "in-progress" },
      { id: "FN-003", column: "in-progress" },
      { id: "FN-004", column: "triage", status: "planning", paused: false },
      { id: "FN-005", column: "triage", status: "planning", paused: true },
      { id: "FN-006", column: "triage", status: "awaiting-approval", paused: false },
      { id: "FN-007", column: "in-review", status: "reviewing", paused: false },
      { id: "FN-008", column: "in-review", status: "merging", paused: false },
      { id: "FN-009", column: "in-review", status: "merging-pr", paused: false },
      { id: "FN-010", column: "in-review", status: "merging-fix", paused: false },
      { id: "FN-011", column: "in-review", status: "fixing", paused: false },
      { id: "FN-012", column: "in-review", status: "reviewing", paused: true },
    ]);

    const { runProjectShow } = await import("../project.js");
    await runProjectShow("proj-1");

    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("In-Flight Agents: 8");
    expect(staleHealth.inFlightAgentCount).toBe(0);
  });

  it("runProjectList JSON derives health.inFlightAgentCount from live executors, triage planners, and in-review agents", async () => {
    mockListProjects.mockResolvedValue([
      { id: "proj-1", name: "app-one", path: "/tmp/app-one", status: "active", isolationMode: "in-process" },
    ]);
    mockGetSettings.mockResolvedValue({});
    mockGetProjectHealth.mockResolvedValue({
      projectId: "proj-1",
      status: "active",
      activeTaskCount: 1,
      inFlightAgentCount: 0,
      totalTasksCompleted: 4,
      totalTasksFailed: 0,
    });
    mockTaskStoreListTasks.mockResolvedValue([
      { id: "FN-001", column: "in-progress" },
      { id: "FN-002", column: "in-progress" },
      { id: "FN-003", column: "triage", status: "planning", paused: false },
      { id: "FN-004", column: "triage", status: "triaged", paused: false },
      { id: "FN-005", column: "in-review", status: "reviewing", paused: false },
      { id: "FN-006", column: "in-review", status: "merging", paused: false },
      { id: "FN-007", column: "in-review", status: "merging-pr", paused: false },
      { id: "FN-008", column: "in-review", status: "merging-fix", paused: false },
      { id: "FN-009", column: "in-review", status: "fixing", paused: false },
      { id: "FN-010", column: "in-review", status: "fixing", paused: true },
    ]);

    const { runProjectList } = await import("../project.js");
    await runProjectList({ json: true });

    const parsed = JSON.parse(consoleSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(parsed[0].health.inFlightAgentCount).toBe(8);
    expect(parsed[0].health.activeTaskCount).toBe(1);
    expect(mockGetProjectHealth.mock.results[0]).toBeDefined();
  });

  it("runProjectList JSON keeps per-project running-agent counts isolated", async () => {
    mockListProjects.mockResolvedValue([
      { id: "proj-1", name: "app-one", path: "/tmp/app-one", status: "active", isolationMode: "in-process" },
      { id: "proj-2", name: "app-two", path: "/tmp/app-two", status: "active", isolationMode: "in-process" },
    ]);
    mockGetSettings.mockResolvedValue({});
    mockGetProjectHealth.mockResolvedValue({
      projectId: "stale",
      status: "active",
      activeTaskCount: 0,
      inFlightAgentCount: 99,
      totalTasksCompleted: 0,
      totalTasksFailed: 0,
    });
    mockTaskStoreListTasks
      .mockResolvedValueOnce([
        { id: "FN-001", column: "triage", status: "planning", paused: false },
        { id: "FN-002", column: "triage", status: "planning", paused: true },
        { id: "FN-003", column: "in-review", status: "reviewing", paused: false },
      ])
      .mockResolvedValueOnce([
        { id: "FN-010", column: "in-progress" },
        { id: "FN-011", column: "triage", status: "planning", paused: false },
        { id: "FN-012", column: "triage", status: "awaiting-approval", paused: false },
        { id: "FN-013", column: "in-review", status: "fixing", paused: false },
        { id: "FN-014", column: "in-review", status: "merging-fix", paused: false },
      ]);

    const { runProjectList } = await import("../project.js");
    await runProjectList({ json: true });

    const parsed = JSON.parse(consoleSpy.mock.calls.map((call) => String(call[0])).join(""));
    expect(parsed.map((project: { health: { inFlightAgentCount: number } }) => project.health.inFlightAgentCount)).toEqual([2, 4]);
  });

  it("runProjectList table prints the live In-Flight column", async () => {
    mockListProjects.mockResolvedValue([
      { id: "proj-1", name: "app-one", path: "/tmp/app-one", status: "active", isolationMode: "in-process" },
    ]);
    mockGetSettings.mockResolvedValue({});
    mockGetProjectHealth.mockResolvedValue({
      projectId: "proj-1",
      status: "active",
      activeTaskCount: 1,
      inFlightAgentCount: 0,
      totalTasksCompleted: 0,
      totalTasksFailed: 0,
    });
    mockTaskStoreListTasks.mockResolvedValue([
      { id: "FN-001", column: "todo" },
      { id: "FN-002", column: "in-progress" },
      { id: "FN-003", column: "triage", status: "planning", paused: false },
      { id: "FN-004", column: "in-review", status: "merging-pr", paused: false },
    ]);

    const { runProjectList } = await import("../project.js");
    await runProjectList();

    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
    const projectLine = output.split("\n").find((line) => line.includes("app-one"));
    expect(output).toContain("In-Flight");
    expect(projectLine).toContain("        3");
  });

  it("runProjectShow reports zero live In-Flight Agents when no tasks hold agent slots", async () => {
    mockGetProject.mockResolvedValue({
      id: "proj-1",
      name: "demo",
      path: "/tmp/demo",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    mockGetSettings.mockResolvedValue({});
    mockGetProjectHealth.mockResolvedValue({
      projectId: "proj-1",
      status: "active",
      activeTaskCount: 2,
      inFlightAgentCount: 9,
      totalTasksCompleted: 0,
      totalTasksFailed: 0,
    });
    mockTaskStoreListTasks.mockResolvedValue([
      { id: "FN-001", column: "todo" },
      { id: "FN-002", column: "done" },
      { id: "FN-003", column: "triage", status: "planning", paused: true },
      { id: "FN-004", column: "triage", status: "waiting", paused: false },
      { id: "FN-005", column: "in-review", status: "reviewing", paused: true },
      { id: "FN-006", column: "in-review", status: "pending", paused: false },
    ]);

    const { runProjectShow } = await import("../project.js");
    await runProjectShow("proj-1");

    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("In-Flight Agents: 0");
  });

  it("runProjectShow renders live In-Flight Agents even without a central health row", async () => {
    mockGetProject.mockResolvedValue({
      id: "proj-1",
      name: "demo",
      path: "/tmp/demo",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    mockGetSettings.mockResolvedValue({});
    mockGetProjectHealth.mockResolvedValue(undefined);
    mockTaskStoreListTasks.mockResolvedValue([
      { id: "FN-001", column: "in-progress" },
      { id: "FN-002", column: "triage", status: "planning", paused: false },
      { id: "FN-003", column: "in-review", status: "reviewing", paused: false },
    ]);

    const { runProjectShow } = await import("../project.js");
    await runProjectShow("proj-1");

    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Health:");
    expect(output).toContain("In-Flight Agents: 3");
  });

  it("runProjectShow falls back to zero In-Flight Agents when the task store is unreadable", async () => {
    mockGetProject.mockResolvedValue({
      id: "proj-1",
      name: "demo",
      path: "/tmp/demo",
      status: "active",
      isolationMode: "in-process",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    mockGetSettings.mockResolvedValue({});
    mockGetProjectHealth.mockResolvedValue({
      projectId: "proj-1",
      status: "active",
      activeTaskCount: 2,
      inFlightAgentCount: 3,
      totalTasksCompleted: 0,
      totalTasksFailed: 0,
    });
    mockTaskStoreListTasks.mockRejectedValue(new Error("cannot read tasks"));

    const { runProjectShow } = await import("../project.js");
    await expect(runProjectShow("proj-1")).resolves.toBeUndefined();

    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("In-Flight Agents: 0");
  });

  it("validation exits on invalid project name for runProjectAdd", async () => {
    const { runProjectAdd } = await import("../project.js");
    await expect(runProjectAdd("bad name", "/tmp")).rejects.toThrow("process.exit:1");
  });

  it("prompts for a missing project name in interactive add mode", async () => {
    mockListProjects.mockResolvedValue([]);
    mockRegisterProject.mockResolvedValue({
      id: "proj-1",
      name: "demo",
      path: ".",
      isolationMode: "in-process",
    });
    mockQuestion.mockResolvedValueOnce("demo");

    const { runProjectAdd } = await import("../project.js");
    await expect(runProjectAdd("", ".", { force: true })).resolves.toBeUndefined();

    expect(mockQuestion).toHaveBeenCalledWith(expect.stringContaining("Project name"));
    expect(mockRegisterProject).toHaveBeenCalledWith(
      expect.objectContaining({ name: "demo" }),
    );
  });

  it("validation exits on missing required args for runProjectRemove", async () => {
    const { runProjectRemove } = await import("../project.js");
    await expect(runProjectRemove("")).rejects.toThrow("process.exit:1");
  });

  it("validation exits on missing required args for runProjectSetDefault", async () => {
    const { runProjectSetDefault } = await import("../project.js");
    await expect(runProjectSetDefault("")).rejects.toThrow("process.exit:1");
  });

  describe("runProjectAdd memory bootstrap", () => {
    // Use "." as path like the existing runProjectAdd test - it resolves to cwd which exists
    const testPath = ".";

    beforeEach(() => {
      mockEnsureMemoryFileWithBackend.mockReset();
      mockEnsureMemoryFileWithBackend.mockResolvedValue(true);
    });

    it("calls ensureMemoryFileWithBackend after project registration", async () => {
      mockListProjects.mockResolvedValue([]);
      mockRegisterProject.mockResolvedValue({
        id: "proj-1",
        name: "demo",
        path: "/fake/demo",
        isolationMode: "in-process",
      });

      const { runProjectAdd } = await import("../project.js");
      await runProjectAdd("demo", testPath, { force: true });

      expect(mockEnsureMemoryFileWithBackend).toHaveBeenCalled();
      // Verify it was called with an absolute path
      const callArg = mockEnsureMemoryFileWithBackend.mock.calls[0][0];
      expect(callArg).toBe(process.cwd());
    });

    it("shows memory initialized message when memory files are created", async () => {
      mockListProjects.mockResolvedValue([]);
      mockRegisterProject.mockResolvedValue({
        id: "proj-1",
        name: "demo",
        path: "/fake/demo",
        isolationMode: "in-process",
      });
      mockEnsureMemoryFileWithBackend.mockResolvedValue(true);

      const { runProjectAdd } = await import("../project.js");
      await runProjectAdd("demo", testPath, { force: true });

      const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("Memory: initialized");
    });

    it("shows git initialized message when shared registration creates a git repository", async () => {
      mockListProjects.mockResolvedValue([]);
      mockRegisterProject.mockResolvedValue({
        id: "proj-1",
        name: "demo",
        path: "/fake/demo",
        isolationMode: "in-process",
      });
      mockEnsureProjectForPath.mockResolvedValueOnce({
        outcome: "registered",
        gitRepository: "initialized",
        project: {
          id: "proj-1",
          name: "demo",
          path: "/fake/demo",
          isolationMode: "in-process",
        },
      });

      const { runProjectAdd } = await import("../project.js");
      await runProjectAdd("demo", testPath, { force: true });

      const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("Git: initialized");
    });

    it("does not show memory message when memory files already exist", async () => {
      mockListProjects.mockResolvedValue([]);
      mockRegisterProject.mockResolvedValue({
        id: "proj-1",
        name: "demo",
        path: "/fake/demo",
        isolationMode: "in-process",
      });
      mockEnsureMemoryFileWithBackend.mockResolvedValue(false); // Files already exist

      const { runProjectAdd } = await import("../project.js");
      await runProjectAdd("demo", testPath, { force: true });

      const output = consoleSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).not.toContain("Memory: initialized");
    });

    it("does not block project registration when memory bootstrap fails", async () => {
      mockListProjects.mockResolvedValue([]);
      mockRegisterProject.mockResolvedValue({
        id: "proj-1",
        name: "demo",
        path: "/fake/demo",
        isolationMode: "in-process",
      });
      mockEnsureMemoryFileWithBackend.mockRejectedValue(new Error("disk full"));

      const { runProjectAdd } = await import("../project.js");
      await runProjectAdd("demo", testPath, { force: true });

      // Project should still be registered
      expect(mockRegisterProject).toHaveBeenCalled();
      expect(mockUpdateProject).toHaveBeenCalledWith("proj-1", { status: "active" });

      // Should show warning about memory failure on console.warn
      const warnOutput = consoleWarnSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(warnOutput).toContain("Could not initialize project memory");
    });
  });
});
