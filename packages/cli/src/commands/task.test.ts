import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:readline/promises before importing the module under test
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(),
}));

// Mock node:fs for runTaskLogs tests
vi.mock("node:fs", () => ({
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
  statSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock @fusion/core before importing the module under test
vi.mock("@fusion/core", () => {
  const COLUMNS = ["triage", "specified", "in-progress", "review", "done"];
  const COLUMN_LABELS: Record<string, string> = {
    triage: "Triage",
    specified: "Specified",
    "in-progress": "In Progress",
    review: "Review",
    done: "Done",
  };

  return {
    TaskStore: vi.fn(),
    COLUMNS,
    COLUMN_LABELS,
    CentralCore: vi.fn().mockImplementation(function() {
      return {
        init: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        listProjects: vi.fn().mockResolvedValue([]),
        getProject: vi.fn().mockResolvedValue(undefined),
        getProjectByPath: vi.fn().mockResolvedValue(undefined),
        registerProject: vi.fn().mockResolvedValue({ id: "proj_test", name: "test", path: "/test" }),
      };
    }),
  };
});

// Mock @fusion/engine
vi.mock("@fusion/engine", () => ({ aiMergeTask: vi.fn() }));

// Mock @fusion/dashboard
vi.mock("@fusion/dashboard", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    createPr: vi.fn(),
  })),
}));

vi.mock("@fusion/dashboard/planning", () => ({
  createSession: vi.fn(),
  submitResponse: vi.fn(),
  RateLimitError: class RateLimitError extends Error {},
  SessionNotFoundError: class SessionNotFoundError extends Error {},
  InvalidSessionStateError: class InvalidSessionStateError extends Error {},
}));

// Mock @fusion/core/gh-cli
vi.mock("@fusion/core/gh-cli", () => ({
  isGhAvailable: vi.fn(),
  isGhAuthenticated: vi.fn(),
  getCurrentRepo: vi.fn(),
}));

// Mock project-context
vi.mock("../project-context.js", () => ({
  resolveProject: vi.fn().mockRejectedValue(new Error("No project context")),
  getStore: vi.fn().mockResolvedValue({}),
  getDefaultProject: vi.fn().mockResolvedValue(undefined),
  setDefaultProject: vi.fn().mockResolvedValue(undefined),
}));

import { createInterface } from "node:readline/promises";
import { TaskStore } from "@fusion/core";
import { watchFile, unwatchFile, statSync, existsSync, readFileSync } from "node:fs";
import { runTaskShow, runTaskCreate, runTaskList, runTaskDuplicate, runTaskRefine, runTaskDelete, runTaskRetry, runTaskLogs, runTaskComment, runTaskComments, runTaskPrCreate, runTaskPlan, runTaskMove, runTaskAttach, runTaskPause, runTaskUnpause, runTaskArchive, runTaskUnarchive, runTaskSteer, runTaskImportFromGitHub, runTaskImportGitHubInteractive, runTaskUpdate, runTaskLog, runTaskMerge, type LogsOptions } from "./task.js";
import { isGhAvailable, isGhAuthenticated, getCurrentRepo } from "@fusion/core/gh-cli";
import { GitHubClient } from "@fusion/dashboard";
import { createSession, submitResponse } from "@fusion/dashboard/planning";
import { resolveProject } from "../project-context.js";
import { aiMergeTask } from "@fusion/engine";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-001",
    description: "A short description",
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("runTaskShow", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("displays the full description without truncation when no title", async () => {
    const longDesc = "A".repeat(120); // well over 60 chars
    const task = makeTask({ description: longDesc });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(task),
    }));

    await runTaskShow("FN-001");

    const headerLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("FN-001:")
    );
    expect(headerLine).toBeDefined();
    expect(headerLine![0]).toContain(longDesc);
    // Ensure no truncation happened
    expect(headerLine![0]).not.toContain(longDesc.slice(0, 60) + "…");
    expect(headerLine![0].length).toBeGreaterThan(60 + "  FN-001: ".length);
  });

  it("displays the title when present instead of description", async () => {
    const task = makeTask({
      title: "My Task Title",
      description: "This is the full description that should not appear in the header",
    });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(task),
    }));

    await runTaskShow("FN-001");

    const headerLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("FN-001:")
    );
    expect(headerLine).toBeDefined();
    expect(headerLine![0]).toContain("My Task Title");
    expect(headerLine![0]).not.toContain("This is the full description");
  });
});

// Mock fs/promises for runTaskCreate attach tests
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

describe("project-aware task command behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runTaskList prints project header when project name is provided", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as (code?: number) => never);
    const mockListTasks = vi.fn().mockResolvedValue([
      makeTask({ id: "FN-001", column: "triage", description: "Task one" }),
    ]);

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { listTasks: mockListTasks } as unknown as TaskStore,
    });

    await expect(runTaskList("demo-project")).rejects.toThrow("process.exit");

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(mockListTasks).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("Tasks for project 'demo-project':"))).toBe(true);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("runTaskList without project flag uses shared resolution flow before local fallback", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as (code?: number) => never);
    const mockListTasks = vi.fn().mockResolvedValue([
      makeTask({ id: "FN-001", column: "triage", description: "Default task" }),
    ]);

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_default",
      projectPath: "/default/project",
      projectName: "default-project",
      isRegistered: true,
      store: { listTasks: mockListTasks } as unknown as TaskStore,
    });

    await expect(runTaskList()).rejects.toThrow("process.exit");

    expect(resolveProject).toHaveBeenCalledWith(undefined);
    expect(mockListTasks).toHaveBeenCalledOnce();
    exitSpy.mockRestore();
  });

  it("runTaskList without project flag falls back to TaskStore(process.cwd()) when shared resolution fails", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as (code?: number) => never);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/current/project");
    const mockListTasks = vi.fn().mockResolvedValue([
      makeTask({ id: "FN-009", column: "triage", description: "Detected local task" }),
    ]);
    const init = vi.fn();

    vi.mocked(resolveProject).mockRejectedValueOnce(
      new Error("No fusion project found in current directory. Use --project or run from a project directory.")
    );

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((projectPath: string) => ({
      init,
      listTasks: mockListTasks,
      projectPath,
    }));

    await expect(runTaskList()).rejects.toThrow("process.exit");

    expect(resolveProject).toHaveBeenCalledWith(undefined);
    expect(TaskStore).toHaveBeenCalledWith("/current/project");
    expect(init).toHaveBeenCalledOnce();
    expect(mockListTasks).toHaveBeenCalledOnce();
    cwdSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("runTaskCreate uses resolved project store and prints project context", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockCreateTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-002", description: "test task" }));
    const mockAddAttachment = vi.fn();

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { createTask: mockCreateTask, addAttachment: mockAddAttachment } as unknown as TaskStore,
    });

    await runTaskCreate("test task", undefined, undefined, "demo-project");

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(mockCreateTask).toHaveBeenCalledWith({ description: "test task", dependencies: undefined });
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("Project: demo-project"))).toBe(true);

    logSpy.mockRestore();
  });

  it("runTaskCreate without project flag uses shared resolution flow", async () => {
    const mockCreateTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-003", description: "default task" }));
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_default",
      projectPath: "/default/project",
      projectName: "default-project",
      isRegistered: true,
      store: { createTask: mockCreateTask, addAttachment: vi.fn() } as unknown as TaskStore,
    });

    await runTaskCreate("default task");

    expect(resolveProject).toHaveBeenCalledWith(undefined);
    expect(mockCreateTask).toHaveBeenCalledWith({ description: "default task", dependencies: undefined });
  });

  it("runTaskCreate without project flag falls back to TaskStore(process.cwd()) when resolution fails", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/current/project");
    const mockCreateTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-004", description: "local task" }));
    const init = vi.fn();

    vi.mocked(resolveProject).mockRejectedValueOnce(
      new Error("No kb project found in current directory. Use --project or run from a project directory.")
    );

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((projectPath: string) => ({
      init,
      createTask: mockCreateTask,
      addAttachment: vi.fn(),
      projectPath,
    }));

    await runTaskCreate("local task");

    expect(resolveProject).toHaveBeenCalledWith(undefined);
    expect(TaskStore).toHaveBeenCalledWith("/current/project");
    expect(init).toHaveBeenCalledOnce();
    expect(mockCreateTask).toHaveBeenCalledWith({ description: "local task", dependencies: undefined });
    cwdSpy.mockRestore();
  });

  it("runTaskLogs uses resolved project path in follow mode", async () => {
    const mockGetTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-001" }));
    const mockGetAgentLogs = vi.fn().mockResolvedValue([]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit"); }) as (code?: number) => never);
    const sigintHandlers: Array<() => void> = [];
    vi.spyOn(process, "on").mockImplementation((event: string, handler: () => void) => {
      if (event === "SIGINT") {
        sigintHandlers.push(handler);
      }
      return process;
    });

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/resolved/project",
      projectName: "demo-project",
      isRegistered: true,
      store: { getTask: mockGetTask, getAgentLogs: mockGetAgentLogs } as unknown as TaskStore,
    });

    vi.mocked(existsSync).mockReturnValue(false);
    const promise = runTaskLogs("FN-001", { follow: true }, "demo-project");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(watchFile)).toHaveBeenCalledWith(
      expect.stringContaining("/resolved/project/.fusion/tasks/FN-001/agent.log"),
      expect.objectContaining({ interval: 1000 }),
      expect.any(Function),
    );
    expect(sigintHandlers).toHaveLength(1);
    expect(() => sigintHandlers[0]()).toThrow("process.exit");
    promise.catch(() => {});

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("Logs for project 'demo-project':"))).toBe(true);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("runTaskPrCreate falls back to current working directory without project flag", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/local/project");
    const mockCreatePr = vi.fn().mockResolvedValue({ number: 123, url: "https://example.com/pr/123" });
    vi.mocked(isGhAvailable).mockReturnValue(true);
    vi.mocked(isGhAuthenticated).mockReturnValue(true);
    vi.mocked(getCurrentRepo).mockReturnValue({ owner: "acme", repo: "demo" });
    vi.mocked(GitHubClient).mockImplementation(() => ({ createPr: mockCreatePr }) as never);

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(makeTask({ id: "FN-001", column: "in-review", branchName: "fusion/fn-001" })),
      updatePrInfo: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
    }));

    await runTaskPrCreate("FN-001", {});

    expect(getCurrentRepo).toHaveBeenCalledWith("/local/project");
    expect(mockCreatePr).toHaveBeenCalledWith(expect.objectContaining({ head: "fusion/fn-001" }));
    cwdSpy.mockRestore();
  });

  it("runTaskPlan uses resolved project path only when project name is provided", async () => {
    const mockCreateTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-010", description: "planned task" }));
    const mockQuestion = {
      id: "scope",
      type: "confirm" as const,
      question: "Proceed?",
    };
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      createTask: mockCreateTask,
    }));
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: {
        createTask: mockCreateTask,
      } as unknown as TaskStore,
    });
    vi.mocked(createSession).mockResolvedValue({
      sessionId: "sess-1",
      firstQuestion: mockQuestion,
    } as never);
    vi.mocked(submitResponse).mockResolvedValue({
      type: "complete",
      data: {
        title: "planned task",
        description: "planned task",
        suggestedSize: "M",
        suggestedDependencies: [],
        keyDeliverables: [],
      },
    } as never);
    vi.mocked(createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue("y"),
      close: vi.fn(),
    } as never);

    await runTaskPlan("planned task", true, "demo-project");

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(createSession).toHaveBeenCalledWith("127.0.0.1", "planned task", expect.anything(), "/test");
  });

  it("runTaskShow uses resolved project store when project name is provided", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockGetTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-123", description: "from project store" }));

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { getTask: mockGetTask } as unknown as TaskStore,
    });

    await runTaskShow("FN-123", "demo-project");

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(mockGetTask).toHaveBeenCalledWith("FN-123");
    logSpy.mockRestore();
  });

  it("runTaskMove uses resolved project store when project name is provided", async () => {
    const mockMoveTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-123", column: "done" }));

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { moveTask: mockMoveTask } as unknown as TaskStore,
    });

    await runTaskMove("FN-123", "done", "demo-project");

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(mockMoveTask).toHaveBeenCalledWith("FN-123", "done");
  });

  it("runTaskAttach uses resolved project store when project name is provided", async () => {
    const mockAddAttachment = vi.fn().mockResolvedValue({
      originalName: "notes.txt",
      size: 10,
    });
    const readFileMock = vi.fn().mockResolvedValue(Buffer.from("hello"));
    vi.doMock("node:fs/promises", () => ({ readFile: readFileMock }));

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { addAttachment: mockAddAttachment } as unknown as TaskStore,
    });

    await runTaskAttach("FN-123", "/tmp/notes.txt", "demo-project");

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(mockAddAttachment).toHaveBeenCalled();
  });

  it("runTaskPause and runTaskUnpause use resolved project store", async () => {
    const pauseTask = vi.fn()
      .mockResolvedValueOnce(makeTask({ id: "FN-123", status: "paused" }))
      .mockResolvedValueOnce(makeTask({ id: "FN-123", status: undefined }));

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { pauseTask } as unknown as TaskStore,
    });

    await runTaskPause("FN-123", "demo-project");
    await runTaskUnpause("FN-123", "demo-project");

    expect(pauseTask).toHaveBeenNthCalledWith(1, "FN-123", true);
    expect(pauseTask).toHaveBeenNthCalledWith(2, "FN-123", false);
  });

  it("runTaskArchive and runTaskUnarchive use resolved project store", async () => {
    const archiveTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-123", column: "archived" }));
    const unarchiveTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-123", column: "done" }));

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { archiveTask, unarchiveTask } as unknown as TaskStore,
    });

    await runTaskArchive("FN-123", "demo-project");
    await runTaskUnarchive("FN-123", "demo-project");

    expect(archiveTask).toHaveBeenCalledWith("FN-123");
    expect(unarchiveTask).toHaveBeenCalledWith("FN-123");
  });

  it("runTaskRetry uses resolved project store", async () => {
    const getTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-123", status: "failed", column: "in-progress" }));
    const updateTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-123", status: undefined }));
    const moveTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-123", column: "todo" }));
    const logEntry = vi.fn().mockResolvedValue(undefined);

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { getTask, updateTask, moveTask, logEntry } as unknown as TaskStore,
    });

    await runTaskRetry("FN-123", "demo-project");

    expect(getTask).toHaveBeenCalledWith("FN-123");
    expect(updateTask).toHaveBeenCalled();
    expect(moveTask).toHaveBeenCalledWith("FN-123", "todo");
    expect(logEntry).toHaveBeenCalled();
  });

  it("runTaskDelete uses resolved project store", async () => {
    const getTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-123" }));
    const deleteTask = vi.fn().mockResolvedValue(undefined);

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { getTask, deleteTask } as unknown as TaskStore,
    });

    await runTaskDelete("FN-123", true, "demo-project");

    expect(getTask).toHaveBeenCalledWith("FN-123");
    expect(deleteTask).toHaveBeenCalledWith("FN-123");
  });

  it("runTaskComment, runTaskComments, and runTaskSteer use resolved project store", async () => {
    const addTaskComment = vi.fn().mockResolvedValue({ author: "user", message: "hello" });
    const getTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-123", steeringComments: [], comments: [{ author: "user", message: "hello", createdAt: new Date().toISOString() }] }));
    const addSteeringComment = vi.fn().mockResolvedValue(makeTask({ id: "FN-123" }));

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { addTaskComment, getTask, addSteeringComment } as unknown as TaskStore,
    });

    await runTaskComment("FN-123", "hello", "user", "demo-project");
    await runTaskComments("FN-123", "demo-project");
    await runTaskSteer("FN-123", "steer", "demo-project");

    expect(addTaskComment).toHaveBeenCalled();
    expect(getTask).toHaveBeenCalledWith("FN-123");
    expect(addSteeringComment).toHaveBeenCalled();
  });

  it("runTaskUpdate, runTaskLog, runTaskMerge, runTaskDuplicate, and runTaskRefine use resolved project context", async () => {
    const updateStep = vi.fn().mockResolvedValue({ ...makeTask({ id: "FN-123" }), steps: [{ name: "Step 1", status: "done" }] });
    const logEntry = vi.fn().mockResolvedValue(undefined);
    const getTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-123", column: "in-review" }));
    const duplicateTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-124" }));
    const refineTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-125" }));

    const resolvedStore = { updateStep, logEntry, getTask, duplicateTask, refineTask } as unknown as TaskStore;
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: resolvedStore,
    });
    vi.mocked(aiMergeTask).mockResolvedValue({
      merged: true,
      task: makeTask({ id: "FN-123" }),
      branch: "fusion/fn-123",
      worktreeRemoved: true,
      branchDeleted: true,
    } as never);

    await runTaskUpdate("FN-123", "0", "done", "demo-project");
    await runTaskLog("FN-123", "hello", undefined, "demo-project");
    await runTaskMerge("FN-123", "demo-project");
    await runTaskDuplicate("FN-123", "demo-project");
    await runTaskRefine("FN-123", "more tests", "demo-project");

    expect(updateStep).toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalled();
    expect(aiMergeTask).toHaveBeenCalledWith(resolvedStore, "/test", "FN-123", expect.any(Object));
    expect(duplicateTask).toHaveBeenCalledWith("FN-123");
    expect(refineTask).toHaveBeenCalledWith("FN-123", "more tests");
  });

  it("routes GitHub import commands through the resolved project store", async () => {
    const listTasks = vi.fn().mockResolvedValue([]);
    const createTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-200" }));

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { listTasks, createTask } as unknown as TaskStore,
    });

    const fetchSpy = vi.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: true,
      json: async () => ([{ number: 1, title: "Issue 1", body: "Body", html_url: "https://github.com/acme/demo/issues/1", labels: [] }]),
    } as Response);

    await runTaskImportFromGitHub("acme/demo", { limit: 1 }, "demo-project");
    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(listTasks).toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("routes interactive GitHub import through the resolved project store", async () => {
    const listTasks = vi.fn().mockResolvedValue([]);
    const createTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-201" }));
    const mockQuestion = vi.fn().mockResolvedValue("all");

    vi.mocked(createInterface).mockReturnValue({
      question: mockQuestion,
      close: vi.fn(),
    } as never);

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { listTasks, createTask } as unknown as TaskStore,
    });

    const fetchSpy = vi.spyOn(global, "fetch" as any).mockResolvedValue({
      ok: true,
      json: async () => ([{ number: 2, title: "Issue 2", body: "Body", html_url: "https://github.com/acme/demo/issues/2", labels: [] }]),
    } as Response);

    await runTaskImportGitHubInteractive("acme/demo", { limit: 1 }, "demo-project");

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(listTasks).toHaveBeenCalled();
    expect(createTask).toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("surfaces project resolution failures from shared context when project flag is explicit", async () => {
    vi.mocked(resolveProject).mockRejectedValueOnce(
      new Error("Project 'demo-project' not found. Run 'kb project list' to see registered projects.")
    );

    await expect(runTaskList("demo-project")).rejects.toThrow(
      "Project 'demo-project' not found. Run 'kb project list' to see registered projects."
    );
  });
});

describe("runTaskCreate with --attach", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockAddAttachment: ReturnType<typeof vi.fn>;
  let mockReadFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockAddAttachment = vi.fn().mockResolvedValue({
      filename: "abc123-test.png",
      originalName: "test.png",
      mimeType: "image/png",
      size: 2048,
      createdAt: new Date().toISOString(),
    });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      createTask: vi.fn().mockResolvedValue({
        id: "FN-002",
        description: "test task",
        column: "triage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      addAttachment: mockAddAttachment,
    }));

    const fsMod = await import("node:fs/promises");
    mockReadFile = vi.mocked(fsMod.readFile);
    mockReadFile.mockResolvedValue(Buffer.from("file content"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates task and attaches files when attachFiles provided", async () => {
    await runTaskCreate("test task", ["/tmp/test.png"]);

    expect(mockAddAttachment).toHaveBeenCalledOnce();
    expect(mockAddAttachment).toHaveBeenCalledWith(
      "FN-002",
      "test.png",
      expect.any(Buffer),
      "image/png",
    );

    const attachLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Attached"),
    );
    expect(attachLine).toBeDefined();
  });

  it("attaches multiple files", async () => {
    mockAddAttachment.mockResolvedValueOnce({
      filename: "abc-screenshot.png",
      originalName: "screenshot.png",
      mimeType: "image/png",
      size: 1024,
      createdAt: new Date().toISOString(),
    }).mockResolvedValueOnce({
      filename: "def-crash.log",
      originalName: "crash.log",
      mimeType: "text/plain",
      size: 512,
      createdAt: new Date().toISOString(),
    });

    await runTaskCreate("test task", ["/tmp/screenshot.png", "/tmp/crash.log"]);

    expect(mockAddAttachment).toHaveBeenCalledTimes(2);
  });

  it("skips files with unsupported extensions", async () => {
    await runTaskCreate("test task", ["/tmp/file.exe"]);

    expect(mockAddAttachment).not.toHaveBeenCalled();
    const errLine = errorSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Unsupported"),
    );
    expect(errLine).toBeDefined();
  });

  it("skips unreadable files", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));

    await runTaskCreate("test task", ["/tmp/missing.png"]);

    expect(mockAddAttachment).not.toHaveBeenCalled();
    const errLine = errorSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Cannot read"),
    );
    expect(errLine).toBeDefined();
  });

  it("creates task without attachments when attachFiles is undefined", async () => {
    await runTaskCreate("test task");

    expect(mockAddAttachment).not.toHaveBeenCalled();
  });
});

describe("runTaskCreate with --depends", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let mockCreateTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockCreateTask = vi.fn().mockImplementation((input: { description: string; dependencies?: string[] }) => ({
      id: "FN-003",
      description: input.description,
      column: "triage",
      dependencies: input.dependencies || [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      createTask: mockCreateTask,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes dependencies to store.createTask when depends provided", async () => {
    await runTaskCreate("test task", undefined, ["FN-124"]);

    expect(mockCreateTask).toHaveBeenCalledWith({
      description: "test task",
      dependencies: ["FN-124"],
    });
  });

  it("passes multiple dependencies correctly", async () => {
    await runTaskCreate("test task", undefined, ["FN-124", "FN-100"]);

    expect(mockCreateTask).toHaveBeenCalledWith({
      description: "test task",
      dependencies: ["FN-124", "FN-100"],
    });

    const depsLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Dependencies:"),
    );
    expect(depsLine).toBeDefined();
    expect(depsLine![0]).toContain("FN-124");
    expect(depsLine![0]).toContain("FN-100");
  });

  it("works without dependencies (backward compatible)", async () => {
    await runTaskCreate("test task");

    expect(mockCreateTask).toHaveBeenCalledWith({
      description: "test task",
      dependencies: undefined,
    });
  });
});

import { runTaskImportGitHubInteractive } from "./task.js";

describe("runTaskImportGitHubInteractive", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockCreateTask: ReturnType<typeof vi.fn>;
  let mockListTasks: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    mockCreateTask = vi.fn().mockImplementation((input: { description: string; title?: string }) => ({
      id: `KB-${String(mockCreateTask.mock.calls.length).padStart(3, "0")}`,
      title: input.title,
      description: input.description,
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    mockListTasks = vi.fn().mockResolvedValue([]);

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      createTask: mockCreateTask,
      listTasks: mockListTasks,
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const mockIssue = (num: number, title: string, body: string | null): GitHubIssue => ({
    number: num,
    title,
    body,
    html_url: `https://github.com/owner/repo/issues/${num}`,
    labels: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  });

  it("imports selected issues via interactive mode", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        mockIssue(1, "First Issue", "Description 1"),
        mockIssue(2, "Second Issue", "Description 2"),
        mockIssue(3, "Third Issue", "Description 3"),
      ]),
    } as Response);

    // Mock readline to select issues 1 and 3
    const mockReadline = {
      question: vi.fn().mockResolvedValueOnce("1,3"),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValueOnce(mockReadline as any);

    await runTaskImportGitHubInteractive("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledTimes(2);
    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "First Issue",
      description: "Description 1\n\nSource: https://github.com/owner/repo/issues/1",
      column: "triage",
      dependencies: [],
    });
    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "Third Issue",
      description: "Description 3\n\nSource: https://github.com/owner/repo/issues/3",
      column: "triage",
      dependencies: [],
    });
  });

  it('imports all issues when "all" is selected', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        mockIssue(1, "First Issue", "Description 1"),
        mockIssue(2, "Second Issue", "Description 2"),
      ]),
    } as Response);

    // Mock readline to select "all"
    const mockReadline = {
      question: vi.fn().mockResolvedValueOnce("all"),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValueOnce(mockReadline as any);

    await runTaskImportGitHubInteractive("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledTimes(2);
  });

  it("skips already imported issues", async () => {
    // Setup existing task with source URL
    mockListTasks.mockResolvedValueOnce([
      {
        id: "FN-001",
        description: "Existing\n\nSource: https://github.com/owner/repo/issues/1",
        column: "triage",
      },
    ]);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        mockIssue(1, "First Issue", "Description 1"),
        mockIssue(2, "Second Issue", "Description 2"),
      ]),
    } as Response);

    const mockReadline = {
      question: vi.fn().mockResolvedValueOnce("all"),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValueOnce(mockReadline as any);

    await runTaskImportGitHubInteractive("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "Second Issue",
      description: "Description 2\n\nSource: https://github.com/owner/repo/issues/2",
      column: "triage",
      dependencies: [],
    });

    const skipLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Skipping #1"),
    );
    expect(skipLine).toBeDefined();
  });

  it("handles empty issues list", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    } as Response);

    await runTaskImportGitHubInteractive("owner/repo");

    expect(mockCreateTask).not.toHaveBeenCalled();
    const noIssuesLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("No open issues"),
    );
    expect(noIssuesLine).toBeDefined();
  });

  it("exits on invalid owner/repo format", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(runTaskImportGitHubInteractive("invalid-format")).rejects.toThrow("process.exit");
    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("handles API errors gracefully", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as Response);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(runTaskImportGitHubInteractive("owner/repo")).rejects.toThrow("process.exit");
    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("re-prompts on invalid input", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        mockIssue(1, "First Issue", "Description 1"),
      ]),
    } as Response);

    // First invalid input, then valid
    const mockReadline = {
      question: vi.fn()
        .mockResolvedValueOnce("invalid")
        .mockResolvedValueOnce("1"),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValueOnce(mockReadline as any);

    await runTaskImportGitHubInteractive("owner/repo");

    expect(mockReadline.question).toHaveBeenCalledTimes(2);
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });

  it("re-prompts on out of range selection", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        mockIssue(1, "First Issue", "Description 1"),
      ]),
    } as Response);

    // First out of range, then valid
    const mockReadline = {
      question: vi.fn()
        .mockResolvedValueOnce("99")
        .mockResolvedValueOnce("1"),
      close: vi.fn(),
    };
    vi.mocked(createInterface).mockReturnValueOnce(mockReadline as any);

    await runTaskImportGitHubInteractive("owner/repo");

    expect(mockReadline.question).toHaveBeenCalledTimes(2);
    expect(mockCreateTask).toHaveBeenCalledTimes(1);
  });
});

// GitHub Import Tests
import { fetchGitHubIssues, runTaskImportFromGitHub, type GitHubIssue } from "./task.js";

describe("fetchGitHubIssues", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.GITHUB_TOKEN = originalEnv;
    vi.restoreAllMocks();
  });

  const mockIssue: GitHubIssue = {
    number: 1,
    title: "Test Issue",
    body: "Test body",
    html_url: "https://github.com/owner/repo/issues/1",
    labels: [{ name: "bug" }],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  };

  it("fetches issues successfully", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([mockIssue]),
    } as Response);

    const issues = await fetchGitHubIssues("owner", "repo");

    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(1);
    expect(issues[0].title).toBe("Test Issue");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("https://api.github.com/repos/owner/repo/issues");
    expect(url).toContain("state=open");
  });

  it("includes Authorization header when GITHUB_TOKEN is set", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([mockIssue]),
    } as Response);

    await fetchGitHubIssues("owner", "repo");

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
  });

  it("respects limit option", async () => {
    const manyIssues = Array.from({ length: 50 }, (_, i) => ({
      ...mockIssue,
      number: i + 1,
    }));
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(manyIssues),
    } as Response);

    const issues = await fetchGitHubIssues("owner", "repo", { limit: 10 });

    expect(issues).toHaveLength(10);
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("per_page=10");
  });

  it("respects labels option", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([mockIssue]),
    } as Response);

    await fetchGitHubIssues("owner", "repo", { labels: ["bug", "enhancement"] });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("labels=bug%2Cenhancement");
  });

  it("filters out pull requests", async () => {
    const pr = { ...mockIssue, pull_request: {} };
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([mockIssue, pr]),
    } as Response);

    const issues = await fetchGitHubIssues("owner", "repo");

    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(1);
  });

  it("throws error for 404", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as Response);

    await expect(fetchGitHubIssues("owner", "repo")).rejects.toThrow("Repository not found");
  });

  it("throws error for 401/403", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    } as Response);

    await expect(fetchGitHubIssues("owner", "repo")).rejects.toThrow("Authentication failed");
  });

  it("throws generic error for other status codes", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Server Error",
    } as Response);

    await expect(fetchGitHubIssues("owner", "repo")).rejects.toThrow("GitHub API error: 500");
  });
});

describe("runTaskImportFromGitHub", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockCreateTask: ReturnType<typeof vi.fn>;
  let mockListTasks: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    mockCreateTask = vi.fn().mockImplementation((input: { description: string; title?: string }) => ({
      id: `KB-${String(mockCreateTask.mock.calls.length).padStart(3, "0")}`,
      title: input.title,
      description: input.description,
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    mockListTasks = vi.fn().mockResolvedValue([]);

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      createTask: mockCreateTask,
      listTasks: mockListTasks,
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const mockIssue = (num: number, title: string, body: string | null): GitHubIssue => ({
    number: num,
    title,
    body,
    html_url: `https://github.com/owner/repo/issues/${num}`,
    labels: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  });

  it("imports issues and creates tasks", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        mockIssue(1, "First Issue", "Description 1"),
        mockIssue(2, "Second Issue", "Description 2"),
      ]),
    } as Response);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledTimes(2);
    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "First Issue",
      description: "Description 1\n\nSource: https://github.com/owner/repo/issues/1",
      column: "triage",
      dependencies: [],
    });

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Imported 2 tasks"),
    );
    expect(successLine).toBeDefined();
  });

  it("skips already imported issues", async () => {
    // Setup existing task with source URL
    mockListTasks.mockResolvedValueOnce([
      {
        id: "FN-001",
        description: "Existing\n\nSource: https://github.com/owner/repo/issues/1",
        column: "triage",
      },
    ]);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([
        mockIssue(1, "First Issue", "Description 1"),
        mockIssue(2, "Second Issue", "Description 2"),
      ]),
    } as Response);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    const skipLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Skipping #1"),
    );
    expect(skipLine).toBeDefined();
  });

  it("handles empty issues list", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    } as Response);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).not.toHaveBeenCalled();
    const noIssuesLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("No open issues"),
    );
    expect(noIssuesLine).toBeDefined();
  });

  it("exits on invalid owner/repo format", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(runTaskImportFromGitHub("invalid-format")).rejects.toThrow("process.exit");
    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("handles API errors gracefully", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as Response);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(runTaskImportFromGitHub("owner/repo")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("uses (no description) for empty body", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([mockIssue(1, "No Body Issue", null)]),
    } as Response);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "No Body Issue",
      description: "(no description)\n\nSource: https://github.com/owner/repo/issues/1",
      column: "triage",
      dependencies: [],
    });
  });

  it("truncates long titles to 200 chars", async () => {
    const longTitle = "A".repeat(250);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([mockIssue(1, longTitle, "Body")]),
    } as Response);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "A".repeat(200),
      description: expect.stringContaining("Body"),
      column: "triage",
      dependencies: [],
    });
  });
});

// --- Duplicate Tests ---

describe("runTaskDuplicate", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockDuplicateTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockDuplicateTask = vi.fn().mockResolvedValue({
      id: "FN-002",
      description: "Duplicated task",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      duplicateTask: mockDuplicateTask,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("duplicates task and prints success", async () => {
    await runTaskDuplicate("FN-001");

    expect(mockDuplicateTask).toHaveBeenCalledOnce();
    expect(mockDuplicateTask).toHaveBeenCalledWith("FN-001");

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Duplicated"),
    );
    expect(successLine).toBeDefined();
    expect(successLine![0]).toContain("FN-001");
    expect(successLine![0]).toContain("FN-002");
  });

  it("throws when task not found", async () => {
    mockDuplicateTask.mockRejectedValueOnce(new Error("Task KB-999 not found"));

    await expect(runTaskDuplicate("KB-999")).rejects.toThrow("Task KB-999 not found");
  });
});

// --- Refine Tests ---

describe("runTaskRefine", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockRefineTask: ReturnType<typeof vi.fn>;
  let mockRlQuestion: ReturnType<typeof vi.fn>;
  let mockRlClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockRlQuestion = vi.fn();
    mockRlClose = vi.fn();

    (createInterface as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      question: mockRlQuestion,
      close: mockRlClose,
    });

    mockRefineTask = vi.fn().mockResolvedValue({
      id: "FN-002",
      description: "Refinement of FN-001",
      column: "triage",
      dependencies: ["FN-001"],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      refineTask: mockRefineTask,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refines task with interactive feedback and prints success", async () => {
    mockRlQuestion.mockResolvedValue("Need to add more tests");

    await runTaskRefine("FN-001");

    expect(mockRlQuestion).toHaveBeenCalledWith("What needs to be refined? ");
    expect(mockRlClose).toHaveBeenCalled();
    expect(mockRefineTask).toHaveBeenCalledOnce();
    expect(mockRefineTask).toHaveBeenCalledWith("FN-001", "Need to add more tests");

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Created refinement"),
    );
    expect(successLine).toBeDefined();
    expect(successLine![0]).toContain("FN-002");
    expect(successLine![0]).toContain("FN-001");

    // Check that dependency is printed
    const depLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Dependency:"),
    );
    expect(depLine).toBeDefined();
    expect(depLine![0]).toContain("FN-001");
  });

  it("refines task with provided feedback (non-interactive)", async () => {
    await runTaskRefine("FN-001", "Fix the error handling");

    expect(mockRlQuestion).not.toHaveBeenCalled();
    expect(mockRefineTask).toHaveBeenCalledOnce();
    expect(mockRefineTask).toHaveBeenCalledWith("FN-001", "Fix the error handling");
  });

  it("exits when interactive feedback is empty", async () => {
    mockRlQuestion.mockResolvedValue("  ");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskRefine("FN-001");

    expect(mockRlClose).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("Feedback is required");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it("exits when provided feedback is empty", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskRefine("FN-001", "   ");

    expect(errorSpy).toHaveBeenCalledWith("Feedback is required");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it("exits when feedback exceeds 2000 characters", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskRefine("FN-001", "A".repeat(2001));

    expect(errorSpy).toHaveBeenCalledWith("Feedback must be 2000 characters or less");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it("allows feedback at exactly 2000 characters", async () => {
    const longFeedback = "A".repeat(2000);

    await runTaskRefine("FN-001", longFeedback);

    expect(mockRefineTask).toHaveBeenCalledOnce();
    expect(mockRefineTask).toHaveBeenCalledWith("FN-001", longFeedback);
  });

  it("throws when task not in done or in-review", async () => {
    mockRefineTask.mockRejectedValueOnce(new Error("Task must be in 'done' or 'in-review' column to refine"));

    await expect(runTaskRefine("FN-001", "Some feedback")).rejects.toThrow("done' or 'in-review'");
  });

  it("throws when task not found", async () => {
    mockRefineTask.mockRejectedValueOnce(new Error("Task KB-999 not found"));

    await expect(runTaskRefine("KB-999", "Some feedback")).rejects.toThrow("Task KB-999 not found");
  });
});

// --- Delete Tests ---

describe("runTaskDelete", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockGetTask: ReturnType<typeof vi.fn>;
  let mockDeleteTask: ReturnType<typeof vi.fn>;
  let mockRlQuestion: ReturnType<typeof vi.fn>;
  let mockRlClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockRlQuestion = vi.fn();
    mockRlClose = vi.fn();

    (createInterface as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      question: mockRlQuestion,
      close: mockRlClose,
    });

    mockGetTask = vi.fn().mockResolvedValue({
      id: "FN-001",
      description: "Test task",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    mockDeleteTask = vi.fn().mockResolvedValue({
      id: "FN-001",
      description: "Test task",
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: mockGetTask,
      deleteTask: mockDeleteTask,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes task successfully with force=true (no prompt)", async () => {
    await runTaskDelete("FN-001", true);

    expect(mockGetTask).toHaveBeenCalledOnce();
    expect(mockGetTask).toHaveBeenCalledWith("FN-001");
    expect(mockRlQuestion).not.toHaveBeenCalled();
    expect(mockDeleteTask).toHaveBeenCalledOnce();
    expect(mockDeleteTask).toHaveBeenCalledWith("FN-001");

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Deleted"),
    );
    expect(successLine).toBeDefined();
    expect(successLine![0]).toContain("FN-001");
  });

  it("deletes task after confirmation prompt with 'y'", async () => {
    mockRlQuestion.mockResolvedValue("y");

    await runTaskDelete("FN-001", false);

    expect(mockRlQuestion).toHaveBeenCalledOnce();
    expect(mockRlQuestion).toHaveBeenCalledWith("Are you sure you want to delete FN-001? [y/N] ");
    expect(mockRlClose).toHaveBeenCalled();
    expect(mockDeleteTask).toHaveBeenCalledOnce();
    expect(mockDeleteTask).toHaveBeenCalledWith("FN-001");

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Deleted"),
    );
    expect(successLine).toBeDefined();
  });

  it("deletes task after confirmation prompt with 'yes'", async () => {
    mockRlQuestion.mockResolvedValue("yes");

    await runTaskDelete("FN-001", false);

    expect(mockDeleteTask).toHaveBeenCalledOnce();
  });

  it("cancels deletion on 'n' response", async () => {
    mockRlQuestion.mockResolvedValue("n");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskDelete("FN-001", false);

    expect(mockRlQuestion).toHaveBeenCalledOnce();
    expect(mockRlClose).toHaveBeenCalled();
    expect(mockDeleteTask).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("cancels deletion on empty response", async () => {
    mockRlQuestion.mockResolvedValue("");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskDelete("FN-001", false);

    expect(mockRlQuestion).toHaveBeenCalledOnce();
    expect(mockDeleteTask).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("exits with error when task not found", async () => {
    mockGetTask.mockRejectedValueOnce(new Error("Task KB-999 not found"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskDelete("KB-999", true);

    expect(errorSpy).toHaveBeenCalledWith("✗ Task KB-999 not found");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockDeleteTask).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it("exits with error when deleteTask fails", async () => {
    mockDeleteTask.mockRejectedValueOnce(new Error("Task has dependencies"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskDelete("FN-001", true);

    expect(errorSpy).toHaveBeenCalledWith("✗ Failed to delete FN-001: Task has dependencies");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });
});

// --- Retry Tests ---

describe("runTaskComment", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds a task comment with explicit author", async () => {
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      addTaskComment: vi.fn().mockResolvedValue(makeTask({ comments: [{ id: "c1", text: "Hello", author: "alice", createdAt: new Date().toISOString() }] })),
    }));

    await runTaskComment("FN-001", "Hello", "alice");

    const store = (TaskStore as unknown as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
    expect(store.addTaskComment).toHaveBeenCalledWith("FN-001", "Hello", "alice");
    expect(logSpy).toHaveBeenCalledWith("  ✓ Comment added to FN-001");
  });

  it("lists task comments", async () => {
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(makeTask({ comments: [{ id: "c1", text: "Hello", author: "alice", createdAt: "2026-01-01T00:00:00.000Z" }] })),
    }));

    await runTaskComments("FN-001");

    expect(logSpy).toHaveBeenCalledWith("  Comments for FN-001:");
  });
});

describe("runTaskRetry", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let mockGetTask: ReturnType<typeof vi.fn>;
  let mockUpdateTask: ReturnType<typeof vi.fn>;
  let mockMoveTask: ReturnType<typeof vi.fn>;
  let mockLogEntry: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    mockGetTask = vi.fn();
    mockUpdateTask = vi.fn();
    mockMoveTask = vi.fn();
    mockLogEntry = vi.fn();

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: mockGetTask,
      updateTask: mockUpdateTask,
      moveTask: mockMoveTask,
      logEntry: mockLogEntry,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries failed task successfully", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ 
      id: "FN-001", 
      status: "failed",
      error: "Some error",
      column: "in-progress"
    }));
    mockUpdateTask.mockResolvedValueOnce(makeTask({ id: "FN-001", status: undefined, error: undefined }));
    mockMoveTask.mockResolvedValueOnce(makeTask({ id: "FN-001", column: "todo" }));
    mockLogEntry.mockResolvedValueOnce(makeTask({ id: "FN-001" }));

    await runTaskRetry("FN-001");

    expect(mockGetTask).toHaveBeenCalledWith("FN-001");
    expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", { status: null, error: null });
    expect(mockMoveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(mockLogEntry).toHaveBeenCalledWith("FN-001", "Retry requested from CLI", "Task reset to todo for retry");

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Retried"),
    );
    expect(successLine).toBeDefined();
    expect(successLine![0]).toContain("FN-001");
    expect(successLine![0]).toContain("todo");
  });

  it("throws error when task not found", async () => {
    mockGetTask.mockRejectedValueOnce(new Error("Task not found"));

    await expect(runTaskRetry("KB-999")).rejects.toThrow("Task KB-999 not found");
  });

  it("throws error when task is not failed", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ 
      id: "FN-001", 
      status: undefined,
      column: "in-progress"
    }));

    await expect(runTaskRetry("FN-001")).rejects.toThrow("Task FN-001 is not in a retryable state (status: none)");
  });

  it("throws error with correct status when task has different status", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ 
      id: "FN-001", 
      status: "paused",
      column: "in-progress"
    }));

    await expect(runTaskRetry("FN-001")).rejects.toThrow("Task FN-001 is not in a retryable state (status: paused)");
  });

  it("retries stuck-killed task successfully", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ 
      id: "FN-001", 
      status: "stuck-killed",
      column: "in-progress"
    }));
    mockUpdateTask.mockResolvedValueOnce(makeTask({ id: "FN-001", status: undefined, error: undefined }));
    mockMoveTask.mockResolvedValueOnce(makeTask({ id: "FN-001", column: "todo" }));
    mockLogEntry.mockResolvedValueOnce(makeTask({ id: "FN-001" }));

    await runTaskRetry("FN-001");

    expect(mockGetTask).toHaveBeenCalledWith("FN-001");
    expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", { status: null, error: null });
    expect(mockMoveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(mockLogEntry).toHaveBeenCalledWith("FN-001", "Retry requested from CLI", "Task reset to todo for retry");

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Retried"),
    );
    expect(successLine).toBeDefined();
    expect(successLine![0]).toContain("FN-001");
    expect(successLine![0]).toContain("todo");
  });
});

// --- Logs Tests ---

describe("runTaskLogs", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockGetTask: ReturnType<typeof vi.fn>;
  let mockGetAgentLogs: ReturnType<typeof vi.fn>;
  let mockWatchFile: ReturnType<typeof vi.fn>;
  let mockUnwatchFile: ReturnType<typeof vi.fn>;
  let mockStatSync: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReadFileSync: ReturnType<typeof vi.fn>;
  let sigintHandlers: Array<() => void> = [];

  function makeAgentLogEntry(overrides: Record<string, unknown> = {}): import("@fusion/core").AgentLogEntry {
    return {
      timestamp: new Date().toISOString(),
      taskId: "FN-001",
      text: "Test message",
      type: "text" as const,
      ...overrides,
    };
  }

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sigintHandlers = [];

    mockGetTask = vi.fn();
    mockGetAgentLogs = vi.fn().mockResolvedValue([]);

    // Mock resolveProject for follow mode tests
    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "test",
      isRegistered: true,
      store: {
        getTask: mockGetTask,
        getAgentLogs: mockGetAgentLogs,
      } as unknown as TaskStore,
    });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: mockGetTask,
      getAgentLogs: mockGetAgentLogs,
    }));

    // Mock fs functions
    mockWatchFile = vi.mocked(watchFile);
    mockUnwatchFile = vi.mocked(unwatchFile);
    mockStatSync = vi.mocked(statSync);
    mockExistsSync = vi.mocked(existsSync);
    mockReadFileSync = vi.mocked(readFileSync);

    mockWatchFile.mockReturnValue(undefined);
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockReturnValue({ size: 0 });

    // Mock process.on for SIGINT
    vi.spyOn(process, "on").mockImplementation((event: string, handler: () => void) => {
      if (event === "SIGINT") {
        sigintHandlers.push(handler);
      }
      return process;
    });

    // Mock process.exit
    vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("displays logs with various entry types", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "FN-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([
      makeAgentLogEntry({ type: "text", text: "Analyzing code" }),
      makeAgentLogEntry({ type: "thinking", text: "Let me think" }),
      makeAgentLogEntry({ type: "tool", text: "read", detail: "path/to/file.ts" }),
      makeAgentLogEntry({ type: "tool_result", text: "read", detail: "success" }),
      makeAgentLogEntry({ type: "tool_error", text: "read", detail: "File not found" }),
    ]);

    await runTaskLogs("FN-001");

    expect(mockGetTask).toHaveBeenCalledWith("FN-001");
    expect(mockGetAgentLogs).toHaveBeenCalledWith("FN-001");
    expect(logSpy).toHaveBeenCalledTimes(5);

    // Check that each type is formatted
    const calls = logSpy.mock.calls.map((call) => call[0] as string);
    expect(calls[0]).toContain("Analyzing code");
    expect(calls[1]).toContain("[THINK]");
    expect(calls[2]).toContain("[TOOL]");
    expect(calls[2]).toContain("path/to/file.ts");
    expect(calls[3]).toContain("[RESULT]");
    expect(calls[4]).toContain("[ERROR]");
  });

  it("displays agent role when present", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "FN-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([
      makeAgentLogEntry({ type: "text", text: "Starting execution", agent: "executor" }),
      makeAgentLogEntry({ type: "text", text: "Reviewing code", agent: "reviewer" }),
    ]);

    await runTaskLogs("FN-001");

    const calls = logSpy.mock.calls.map((call) => call[0] as string);
    expect(calls[0]).toContain("[EXECUTOR]");
    expect(calls[1]).toContain("[REVIEWER]");
  });

  it("shows 'no logs found' message when logs are empty", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "FN-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([]);

    await runTaskLogs("FN-001");

    expect(logSpy).toHaveBeenCalledWith("No agent logs found for FN-001");
  });

  it("exits with error when task not found", async () => {
    mockGetTask.mockRejectedValueOnce(new Error("Task not found"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    await runTaskLogs("KB-999");

    expect(errorSpy).toHaveBeenCalledWith("Task KB-999 not found");
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });

  it("respects --limit flag", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "FN-001" }));
    mockGetAgentLogs.mockResolvedValueOnce(
      Array.from({ length: 200 }, (_, i) => makeAgentLogEntry({ text: `Line ${i + 1}` }))
    );

    await runTaskLogs("FN-001", { limit: 50 });

    // Should only show 50 entries (default is 100, we specified 50)
    expect(logSpy).toHaveBeenCalledTimes(50);
    
    // Check that we got the last 50 entries
    const calls = logSpy.mock.calls.map((call) => call[0] as string);
    expect(calls[0]).toContain("Line 151");
    expect(calls[49]).toContain("Line 200");
  });

  it("enforces max limit of 1000", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "FN-001" }));
    mockGetAgentLogs.mockResolvedValueOnce(
      Array.from({ length: 1500 }, (_, i) => makeAgentLogEntry({ text: `Line ${i + 1}` }))
    );

    await runTaskLogs("FN-001", { limit: 2000 });  // Request 2000, should be capped at 1000

    expect(logSpy).toHaveBeenCalledTimes(1000);
  });

  it("filters by --type flag", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "FN-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([
      makeAgentLogEntry({ type: "text", text: "Text 1" }),
      makeAgentLogEntry({ type: "tool", text: "tool1" }),
      makeAgentLogEntry({ type: "text", text: "Text 2" }),
      makeAgentLogEntry({ type: "tool", text: "tool2" }),
      makeAgentLogEntry({ type: "thinking", text: "Think 1" }),
    ]);

    await runTaskLogs("FN-001", { type: "text" });

    // Should only show 2 text entries
    expect(logSpy).toHaveBeenCalledTimes(2);
    const calls = logSpy.mock.calls.map((call) => call[0] as string);
    expect(calls[0]).toContain("Text 1");
    expect(calls[1]).toContain("Text 2");
  });

  it("filters by type with --limit combined", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "FN-001" }));
    // Create 50 tool entries interspersed with text entries
    const entries: import("@fusion/core").AgentLogEntry[] = [];
    for (let i = 0; i < 100; i++) {
      entries.push(makeAgentLogEntry({ 
        type: i % 2 === 0 ? "tool" : "text", 
        text: `Entry ${i + 1}` 
      }));
    }
    mockGetAgentLogs.mockResolvedValueOnce(entries);

    await runTaskLogs("FN-001", { type: "tool", limit: 10 });

    // Should show 10 tool entries (the last 10 tool entries: #50, #52, #54, #56, #58, #60, #62, #64, #66, #68... wait, that's not right)
    // Actually it's #50, #52, #54, #56, #58, #60, #62, #64, #66, #68... no wait, tool entries are at indices 0, 2, 4...
    // So last 10 tool entries would be indices 80, 82, 84, 86, 88, 90, 92, 94, 96, 98
    // Which correspond to Entry 81, 83, 85, 87, 89, 91, 93, 95, 97, 99
    expect(logSpy).toHaveBeenCalledTimes(10);
  });

  it("calls watchFile when --follow is set", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "FN-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([
      makeAgentLogEntry({ type: "text", text: "Existing log" }),
    ]);

    // Don't await - follow mode keeps the promise pending
    const logsPromise = runTaskLogs("FN-001", { follow: true });

    // Give a tick for the async operations to start
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockWatchFile).toHaveBeenCalled();
    expect(process.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));

    // Trigger SIGINT to clean up
    sigintHandlers.forEach((handler) => handler());
  });

  it("calls unwatchFile in SIGINT handler", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "FN-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([]);

    // Start follow mode
    runTaskLogs("FN-001", { follow: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Trigger SIGINT
    sigintHandlers.forEach((handler) => handler());

    expect(mockUnwatchFile).toHaveBeenCalled();
  });

  it("prints waiting message in follow mode when no log file exists", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "FN-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([]);
    mockExistsSync.mockReturnValue(false);

    runTaskLogs("FN-001", { follow: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const waitingMessage = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Waiting for log file")
    );
    expect(waitingMessage).toBeDefined();

    // Clean up
    sigintHandlers.forEach((handler) => handler());
  });

  it("reads and prints new entries in follow mode", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "FN-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([
      makeAgentLogEntry({ type: "text", text: "Initial" }),
    ]);

    // Mock file to exist with size 0 initially (no content read yet)
    mockStatSync.mockReturnValue({ size: 0 });
    
    runTaskLogs("FN-001", { follow: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Get the watchFile callback
    const watchCallback = mockWatchFile.mock.calls[0][2] as () => void;
    
    // Simulate file growing with new content
    mockStatSync.mockReturnValueOnce({ size: 100 });
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(makeAgentLogEntry({ type: "text", text: "New entry" })) + "\n");
    
    // Trigger the watch callback
    watchCallback();

    // Check that new entry was printed
    const newEntry = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("New entry")
    );
    expect(newEntry).toBeDefined();

    // Clean up
    sigintHandlers.forEach((handler) => handler());
  });

  it("applies type filter in follow mode", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({ id: "FN-001" }));
    mockGetAgentLogs.mockResolvedValueOnce([]);

    mockStatSync.mockReturnValue({ size: 0 });
    
    runTaskLogs("FN-001", { follow: true, type: "tool" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const watchCallback = mockWatchFile.mock.calls[0][2] as () => void;
    
    // Simulate new content
    mockStatSync.mockReturnValueOnce({ size: 200 });
    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify(makeAgentLogEntry({ type: "text", text: "Text entry" })) + "\n" +
      JSON.stringify(makeAgentLogEntry({ type: "tool", text: "Tool entry" })) + "\n"
    );
    
    watchCallback();

    // Should only print the tool entry
    const toolEntry = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Tool entry")
    );
    expect(toolEntry).toBeDefined();

    const textEntry = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Text entry")
    );
    expect(textEntry).toBeUndefined();

    // Clean up
    sigintHandlers.forEach((handler) => handler());
  });
});

// ── PR Create Tests ───────────────────────────────────────────────────────────

import type { PrInfo } from "@fusion/core";

describe("runTaskPrCreate", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockGetTask: ReturnType<typeof vi.fn>;
  let mockUpdatePrInfo: ReturnType<typeof vi.fn>;
  let mockLogEntry: ReturnType<typeof vi.fn>;
  let mockCreatePr: ReturnType<typeof vi.fn>;
  const originalEnv = { ...process.env };

  function makeInReviewTask(overrides: Record<string, unknown> = {}) {
    return {
      id: "FN-001",
      title: "Test Task Title",
      description: "Test task description for PR creation",
      column: "in-review",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prInfo: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  function makePrInfo(overrides: Partial<PrInfo> = {}): PrInfo {
    return {
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      status: "open" as const,
      title: "Test Task Title",
      headBranch: "fusion/fn-001",
      baseBranch: "main",
      commentCount: 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    // Reset process.env
    process.env = { ...originalEnv };
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_TOKEN;

    // Setup GitHubClient mock
    mockCreatePr = vi.fn();
    vi.mocked(GitHubClient).mockImplementation(() => ({
      createPr: mockCreatePr,
    } as unknown as GitHubClient));

    // Setup gh-cli mocks
    vi.mocked(isGhAvailable).mockReturnValue(true);
    vi.mocked(isGhAuthenticated).mockReturnValue(true);
    vi.mocked(getCurrentRepo).mockReturnValue({ owner: "owner", repo: "repo" });

    // Setup TaskStore mocks
    mockGetTask = vi.fn();
    mockUpdatePrInfo = vi.fn();
    mockLogEntry = vi.fn();

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: mockGetTask,
      updatePrInfo: mockUpdatePrInfo,
      logEntry: mockLogEntry,
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("creates PR successfully with all options", async () => {
    const task = makeInReviewTask();
    mockGetTask.mockResolvedValueOnce(task);
    mockCreatePr.mockResolvedValueOnce(makePrInfo({
      title: "Custom PR Title",
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
    }));

    await runTaskPrCreate("FN-001", { 
      title: "Custom PR Title", 
      base: "develop", 
      body: "PR description body" 
    });

    expect(mockGetTask).toHaveBeenCalledWith("FN-001");
    expect(mockCreatePr).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repo",
      title: "Custom PR Title",
      body: "PR description body",
      head: "fusion/fn-001",
      base: "develop",
    });
    expect(mockUpdatePrInfo).toHaveBeenCalledWith("FN-001", expect.objectContaining({
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
    }));
    expect(mockLogEntry).toHaveBeenCalledWith("FN-001", "Created PR", "PR #42: https://github.com/owner/repo/pull/42");
    
    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Created PR")
    );
    expect(successLine).toBeDefined();
  });

  it("creates PR with minimal options using task title", async () => {
    const task = makeInReviewTask({ title: "My Task Title" });
    mockGetTask.mockResolvedValueOnce(task);
    mockCreatePr.mockResolvedValueOnce(makePrInfo({ title: "My Task Title" }));

    await runTaskPrCreate("FN-001", {});

    expect(mockCreatePr).toHaveBeenCalledWith(expect.objectContaining({
      title: "My Task Title",
      head: "fusion/fn-001",
    }));
  });

  it("generates title from description when task has no title", async () => {
    const task = makeInReviewTask({ title: undefined, description: "this is a very long description that will be truncated for the pr title" });
    mockGetTask.mockResolvedValueOnce(task);
    mockCreatePr.mockResolvedValueOnce(makePrInfo());

    await runTaskPrCreate("FN-001", {});

    // Title should be first 50 chars of description, sentence-cased, with ellipsis if truncated
    expect(mockCreatePr).toHaveBeenCalledWith(expect.objectContaining({
      title: "This is a very long description that will be trunc…",
    }));
  });

  it("exits with error when task not found", async () => {
    const err = new Error("Task not found") as Error & { code: string };
    err.code = "ENOENT";
    mockGetTask.mockRejectedValueOnce(err);
    
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as (code?: number) => never);

    await expect(runTaskPrCreate("KB-999", {})).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith("Error: Task KB-999 not found");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits with error when task not in in-review column", async () => {
    const task = makeInReviewTask({ column: "todo" });
    mockGetTask.mockResolvedValueOnce(task);
    
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as (code?: number) => never);

    await expect(runTaskPrCreate("FN-001", {})).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("must be in 'in-review' column"));
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits with error when task already has PR", async () => {
    const task = makeInReviewTask({
      prInfo: {
        url: "https://github.com/owner/repo/pull/10",
        number: 10,
        status: "open",
        title: "Existing PR",
        headBranch: "fusion/fn-001",
        baseBranch: "main",
        commentCount: 0,
      },
    });
    mockGetTask.mockResolvedValueOnce(task);
    
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as (code?: number) => never);

    await expect(runTaskPrCreate("FN-001", {})).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("already has PR #10"));
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits with error when no GitHub auth available", async () => {
    const task = makeInReviewTask();
    mockGetTask.mockResolvedValueOnce(task);
    
    vi.mocked(isGhAvailable).mockReturnValue(false);
    vi.mocked(isGhAuthenticated).mockReturnValue(false);
    
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as (code?: number) => never);

    await expect(runTaskPrCreate("FN-001", {})).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Not authenticated with GitHub"));
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("uses GITHUB_TOKEN when gh CLI not available", async () => {
    const task = makeInReviewTask();
    mockGetTask.mockResolvedValueOnce(task);
    
    vi.mocked(isGhAvailable).mockReturnValue(false);
    vi.mocked(isGhAuthenticated).mockReturnValue(false);
    process.env.GITHUB_TOKEN = "test-token";
    
    mockCreatePr.mockResolvedValueOnce(makePrInfo());

    await runTaskPrCreate("FN-001", {});

    expect(GitHubClient).toHaveBeenCalledWith("test-token");
    expect(mockUpdatePrInfo).toHaveBeenCalled();
  });

  it("exits with error when no repository detected", async () => {
    const task = makeInReviewTask();
    mockGetTask.mockResolvedValueOnce(task);
    
    vi.mocked(getCurrentRepo).mockReturnValue(null);
    delete process.env.GITHUB_REPOSITORY;
    
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as (code?: number) => never);

    await expect(runTaskPrCreate("FN-001", {})).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Could not determine GitHub repository"));
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("uses GITHUB_REPOSITORY env var when available", async () => {
    process.env.GITHUB_REPOSITORY = "custom-owner/custom-repo";
    
    const task = makeInReviewTask();
    mockGetTask.mockResolvedValueOnce(task);
    mockCreatePr.mockResolvedValueOnce(makePrInfo());

    await runTaskPrCreate("FN-001", {});

    expect(mockCreatePr).toHaveBeenCalledWith(expect.objectContaining({
      owner: "custom-owner",
      repo: "custom-repo",
    }));
  });

  it("exits with error for invalid GITHUB_REPOSITORY format", async () => {
    process.env.GITHUB_REPOSITORY = "invalid-format";
    
    const task = makeInReviewTask();
    mockGetTask.mockResolvedValueOnce(task);
    
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as (code?: number) => never);

    await expect(runTaskPrCreate("FN-001", {})).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("GITHUB_REPOSITORY format is invalid"));
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits with error when PR already exists for branch", async () => {
    const task = makeInReviewTask();
    mockGetTask.mockResolvedValueOnce(task);
    mockCreatePr.mockRejectedValueOnce(new Error("A pull request already exists for owner/repo:fusion/fn-001"));
    
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as (code?: number) => never);

    await expect(runTaskPrCreate("FN-001", {})).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("already exists for owner/repo:fusion/fn-001"));
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits with error when branch has no commits", async () => {
    const task = makeInReviewTask();
    mockGetTask.mockResolvedValueOnce(task);
    mockCreatePr.mockRejectedValueOnce(new Error("No commits between main and fusion/fn-001"));
    
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as (code?: number) => never);

    await expect(runTaskPrCreate("FN-001", {})).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No commits between"));
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits with generic error for unexpected failures", async () => {
    const task = makeInReviewTask();
    mockGetTask.mockResolvedValueOnce(task);
    mockCreatePr.mockRejectedValueOnce(new Error("Network error"));
    
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as (code?: number) => never);

    await expect(runTaskPrCreate("FN-001", {})).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Network error"));
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
