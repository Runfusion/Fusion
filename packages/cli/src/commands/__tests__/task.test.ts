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

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFn = vi.fn((cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    if (typeof callback === "function") callback(null, "", "");
  }) as any;
  execFn[promisify.custom] = (cmd: string, opts?: any) =>
    new Promise((resolve) => {
      execFn(cmd, opts, (_err: any, stdout: string, stderr: string) => resolve({ stdout, stderr }));
    });
  const execFileFn = vi.fn((_file: string, _args: any, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    if (typeof callback === "function") callback(null, "", "");
  }) as any;
  execFileFn[promisify.custom] = (file: string, args?: any, opts?: any) =>
    new Promise((resolve) => {
      execFileFn(file, args, opts, (_err: any, stdout: string, stderr: string) => resolve({ stdout, stderr }));
    });
  return { exec: execFn, execFile: execFileFn };
});

// Mock @fusion/core before importing the module under test
vi.mock("@fusion/core", async (importActual) => {
  const actual = await importActual<typeof import("@fusion/core")>();
  const COLUMNS = ["triage", "specified", "in-progress", "review", "done"];
  const COLUMN_LABELS: Record<string, string> = {
    triage: "Triage",
    specified: "Specified",
    "in-progress": "In Progress",
    review: "Review",
    done: "Done",
  };

  const TaskStoreMock = vi.fn(function () {});
  const taskStoreMockImplementation = TaskStoreMock.mockImplementation.bind(TaskStoreMock);
  TaskStoreMock.mockImplementation = ((impl: (...args: any[]) => unknown) =>
    taskStoreMockImplementation(function (this: unknown, ...args: any[]) {
      return impl(...args);
    })) as typeof TaskStoreMock.mockImplementation;

  const CentralCoreMock = vi.fn(function () {});
  const centralCoreMockImplementation = CentralCoreMock.mockImplementation.bind(CentralCoreMock);
  CentralCoreMock.mockImplementation = ((impl: (...args: any[]) => unknown) =>
    centralCoreMockImplementation(function (this: unknown, ...args: any[]) {
      return impl(...args);
    })) as typeof CentralCoreMock.mockImplementation;
  CentralCoreMock.mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listProjects: vi.fn().mockResolvedValue([]),
    getProject: vi.fn().mockResolvedValue(undefined),
    getProjectByPath: vi.fn().mockResolvedValue(undefined),
    registerProject: vi.fn().mockResolvedValue({ id: "proj_test", name: "test", path: "/test" }),
    getNode: vi.fn().mockResolvedValue(undefined),
    getNodeByName: vi.fn().mockResolvedValue(undefined),
  }));

  return {
    ...actual,
    TaskStore: TaskStoreMock,
    COLUMNS,
    COLUMN_LABELS,
    runDeterministicDuplicateGuard: vi.fn(),
    reconcileDeterministicDuplicate: vi.fn(),
    extractIntentSignature: vi.fn(),
    findNearDuplicates: vi.fn(),
    getTaskDuplicateLineage: vi.fn((task: { sourceType?: string; sourceParentTaskId?: string; sourceMetadata?: any }) => {
      const ids: string[] = [];
      if (task.sourceType === "task_duplicate" && task.sourceParentTaskId) ids.push(task.sourceParentTaskId);
      const metadata = task.sourceMetadata?.duplicateOfTaskIds;
      if (Array.isArray(metadata)) {
        for (const id of metadata) {
          if (typeof id === "string" && !ids.includes(id)) ids.push(id);
        }
      }
      return ids;
    }),
    CentralCore: CentralCoreMock,
  };
});

// Mock @fusion/engine
vi.mock("@fusion/engine", () => ({
  aiMergeTask: vi.fn(),
  runAiMerge: vi.fn(),
  landWorkspaceTask: vi.fn(),
}));

// Mock @fusion/dashboard
vi.mock("@fusion/dashboard", () => ({
  GitHubClient: vi.fn().mockImplementation(function () {
    return {
      createPr: vi.fn(),
    };
  }),
  generatePrMetadata: vi.fn(),
  loadTlsCredentialsFromEnv: vi.fn().mockReturnValue(undefined),
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
  runGhJsonAsync: vi.fn(),
  getGhErrorMessage: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))),
  classifyGhError: vi.fn((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("rate limit")) {
      return { code: "rate-limited", message: "GitHub API rate limit exceeded. Please try again later.", retryable: true, action: { kind: "retry" } };
    }
    return { code: "unknown", message, retryable: true, action: { kind: "retry" } };
  }),
}));

// Mock project-context
vi.mock("../../project-context.js", () => ({
  resolveProject: vi.fn().mockRejectedValue(new Error("No project context")),
  getStore: vi.fn().mockResolvedValue({}),
  getDefaultProject: vi.fn().mockResolvedValue(undefined),
  setDefaultProject: vi.fn().mockResolvedValue(undefined),
  // FNXC:CliBoardMutation 2026-07-09-00:00: FN-7731's runTaskShow/runTaskMove
  // close the resolved store via closeProjectStore on every exit path; the
  // real implementation is best-effort/tolerant of a store without a usable
  // close(), so the mock mirrors that here rather than throwing.
  closeProjectStore: vi.fn().mockImplementation(async (context: { store?: { close?: () => unknown } }) => {
    try {
      await context?.store?.close?.();
    } catch {
      // best-effort, matches real closeProjectStore
    }
  }),
  // FNXC:CliBoardMutation 2026-07-09-00:00: FN-7738's runTaskPrCreate routes
  // through pr.ts's getPrContext, whose CWD-fallback branch wraps an uncached
  // store via asLocalProjectContext. Stub it so the whole-module mock covers
  // every project-context export task.ts/pr.ts import.
  asLocalProjectContext: vi.fn((store: unknown) => ({
    projectId: process.cwd(),
    projectPath: process.cwd(),
    projectName: "current-project",
    isRegistered: false,
    store,
  })),
}));

import { createInterface } from "node:readline/promises";
import { TaskStore, CentralCore, extractIntentSignature, findNearDuplicates, runDeterministicDuplicateGuard, reconcileDeterministicDuplicate } from "@fusion/core";
import { watchFile, unwatchFile, statSync, existsSync, readFileSync } from "node:fs";
import { exec } from "node:child_process";
import { runTaskShow, runTaskCreate, runTaskList, runTaskDuplicate, runTaskRefine, runTaskDelete, runTaskRetry, runTaskLogs, runTaskComment, runTaskComments, runTaskPrCreate, runTaskPlan, runTaskMove, runTaskAttach, runTaskPause, runTaskUnpause, runTaskArchive, runTaskUnarchive, runTaskSteer, runTaskSetNode, runTaskClearNode, runTaskImportFromGitHub, runTaskImportGitHubInteractive, runTaskUpdate, runTaskLog, runTaskMerge, type LogsOptions } from "../task.js";
import {
  getCurrentRepo,
  isGhAuthenticated,
  isGhAvailable,
  runGhJsonAsync,
} from "@fusion/core/gh-cli";
import { GitHubClient, generatePrMetadata } from "@fusion/dashboard";
import { createSession, submitResponse } from "@fusion/dashboard/planning";
import { resolveProject } from "../../project-context.js";
import { aiMergeTask, runAiMerge, landWorkspaceTask } from "@fusion/engine";

const mockedExec = vi.mocked(exec);

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveProject).mockRejectedValue(new Error("No project context"));
  vi.mocked(runDeterministicDuplicateGuard).mockResolvedValue({
    action: "proceed",
    fingerprint: null,
    releaseLock: vi.fn(),
  });
  vi.mocked(reconcileDeterministicDuplicate).mockImplementation(async (_store, args) => ({
    outcome: "kept",
    canonical: args.createdTask,
  }));
  vi.mocked(extractIntentSignature).mockReturnValue({
    routePaths: [],
    filePaths: [],
    identifiers: [],
    titleTokens: [],
  });
  vi.mocked(findNearDuplicates).mockReturnValue([]);
});

describe("runTaskShow", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  const mockTaskStoreGetTask = (task: Record<string, unknown>) => {
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(task),
    }));
  };

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("displays the full description without truncation when no title", async () => {
    const longDesc = "A".repeat(120); // well over 60 chars
    const task = makeTask({ description: longDesc });

    mockTaskStoreGetTask(task);

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

    mockTaskStoreGetTask(task);

    await runTaskShow("FN-001");

    const headerLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("FN-001:")
    );
    expect(headerLine).toBeDefined();
    expect(headerLine![0]).toContain("My Task Title");
    expect(headerLine![0]).not.toContain("This is the full description");
  });

  it.each([
    [{ sourceType: "dashboard_ui" }, "Source: Dashboard"],
    [{ sourceType: "agent_heartbeat", sourceAgentId: "agent-123" }, "Source: Agent (agent-123)"],
    [{ sourceType: "task_refine", sourceParentTaskId: "FN-2904" }, "Source: Refinement of FN-2904"],
    [{ sourceType: "task_duplicate", sourceParentTaskId: "FN-2905" }, "Source: Duplicate of FN-2905"],
    [
      { sourceType: "github_import", sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/42", issueNumber: 42 } },
      "Source: GitHub Import (https://github.com/owner/repo/issues/42)",
    ],
    [
      { sourceType: "research", sourceMetadata: { runId: "RR-001", findingLabel: "Latency hotspot" } },
      "Source: Research (Latency hotspot)",
    ],
    [{ sourceType: "research", sourceMetadata: { runId: "RR-002" } }, "Source: Research (RR-002)"],
  ] as const)("prints provenance line for %o", async (overrides, expectedLine) => {
    mockTaskStoreGetTask(makeTask(overrides));

    await runTaskShow("FN-001");

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain(expectedLine);
  });

  it.each([{ sourceType: "unknown" }, {}])("omits provenance line for %o", async (overrides) => {
    mockTaskStoreGetTask(makeTask(overrides));

    await runTaskShow("FN-001");

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).not.toContain("Source:");
  });

  it("prints duplicate lineage from metadata and task_duplicate parent", async () => {
    mockTaskStoreGetTask(makeTask({
      sourceType: "task_duplicate",
      sourceParentTaskId: "FN-2905",
      sourceMetadata: { duplicateOfTaskIds: ["FN-9"] },
    }));

    await runTaskShow("FN-001");

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Duplicate of: FN-2905, FN-9");
  });

  it("prints duplicate lineage from metadata list", async () => {
    mockTaskStoreGetTask(makeTask({ sourceMetadata: { duplicateOfTaskIds: ["FN-1", "FN-2"] } }));

    await runTaskShow("FN-001");

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Duplicate of: FN-1, FN-2");
  });
});

describe("task node overrides", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runTaskSetNode resolves node name and updates task", async () => {
    const updateTask = vi.fn().mockResolvedValue(makeTask({ nodeId: "node-123" }));
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(makeTask({ column: "todo" })),
      updateTask,
    }));

    const getNodeByName = vi.fn().mockResolvedValue({ id: "node-123", name: "my-remote" });
    const getNode = vi.fn().mockResolvedValue(undefined);
    (CentralCore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getNode,
      getNodeByName,
    }));

    await runTaskSetNode("FN-001", "my-remote");
    expect(updateTask).toHaveBeenCalledWith("FN-001", { nodeId: "node-123" });
  });

  it("runTaskSetNode accepts raw node id", async () => {
    const updateTask = vi.fn().mockResolvedValue(makeTask({ nodeId: "12345678-1234-1234-1234-123456789012" }));
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(makeTask({ column: "todo" })),
      updateTask,
    }));

    const getNode = vi.fn().mockResolvedValue({ id: "12345678-1234-1234-1234-123456789012", name: "raw" });
    (CentralCore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getNode,
      getNodeByName: vi.fn().mockResolvedValue(undefined),
    }));

    await runTaskSetNode("FN-001", "12345678-1234-1234-1234-123456789012");
    expect(updateTask).toHaveBeenCalledWith("FN-001", { nodeId: "12345678-1234-1234-1234-123456789012" });
  });

  it("runTaskSetNode blocks in-progress tasks", async () => {
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(makeTask({ column: "in-progress" })),
    }));

    await expect(runTaskSetNode("FN-001", "my-remote")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Cannot change node override: task FN-001 is in progress");
  });

  it("runTaskSetNode errors when node is unknown", async () => {
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(makeTask({ column: "todo" })),
      updateTask: vi.fn(),
    }));

    (CentralCore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getNode: vi.fn().mockResolvedValue(undefined),
      getNodeByName: vi.fn().mockResolvedValue(undefined),
    }));

    await expect(runTaskSetNode("FN-001", "missing-node")).rejects.toThrow("process.exit:1");
  });

  it("runTaskClearNode clears override", async () => {
    const updateTask = vi.fn().mockResolvedValue(makeTask({ nodeId: undefined }));
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(makeTask({ column: "todo", nodeId: "node-123" })),
      updateTask,
    }));

    await runTaskClearNode("FN-001");
    expect(updateTask).toHaveBeenCalledWith("FN-001", { nodeId: null });
  });

  it("runTaskClearNode blocks in-progress tasks", async () => {
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(makeTask({ column: "in-progress" })),
    }));

    await expect(runTaskClearNode("FN-001")).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith("Cannot change node override: task FN-001 is in progress");
  });

  it("runTaskShow displays node routing info", async () => {
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(makeTask({ nodeId: "node-123", column: "todo" })),
      getSettings: vi.fn().mockResolvedValue({ unavailableNodePolicy: "block" }),
    }));
    (CentralCore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getNode: vi.fn().mockResolvedValue({ id: "node-123", name: "remote-a" }),
      getNodeByName: vi.fn().mockResolvedValue(undefined),
    }));

    await runTaskShow("FN-001");
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Node:");
    expect(output).toContain("Unavailable Node Policy");
  });

  it("runTaskCreate with node resolves and applies override", async () => {
    const updateTask = vi.fn().mockResolvedValue(makeTask({ nodeId: "node-123" }));
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      createTask: vi.fn().mockResolvedValue(makeTask({ id: "FN-900", column: "triage" })),
      updateTask,
    }));
    (CentralCore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      getNode: vi.fn().mockResolvedValue(undefined),
      getNodeByName: vi.fn().mockResolvedValue({ id: "node-123", name: "remote-a" }),
    }));

    await runTaskCreate("new task", undefined, undefined, undefined, "remote-a");
    expect(updateTask).toHaveBeenCalledWith("FN-900", { nodeId: "node-123" });
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

    vi.mocked(runDeterministicDuplicateGuard).mockResolvedValue({
      action: "proceed",
      fingerprint: "fp-1",
      releaseLock: vi.fn(),
    });
    vi.mocked(reconcileDeterministicDuplicate).mockResolvedValue({ outcome: "kept", canonical: makeTask({ id: "FN-002", description: "test task" }) });

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { createTask: mockCreateTask, addAttachment: mockAddAttachment, getRootDir: vi.fn().mockReturnValue("/test") } as unknown as TaskStore,
    });

    await runTaskCreate("test task", undefined, undefined, "demo-project");

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(mockCreateTask).toHaveBeenCalledWith({
      description: "test task",
      dependencies: undefined,
      source: { sourceType: "cli", sourceMetadata: { contentFingerprint: "fp-1" } },
    });
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("Project: demo-project"))).toBe(true);

    logSpy.mockRestore();
  });

  it("runTaskCreate without project flag uses shared resolution flow", async () => {
    const mockCreateTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-003", description: "default task" }));
    vi.mocked(runDeterministicDuplicateGuard).mockResolvedValue({ action: "proceed", fingerprint: null, releaseLock: vi.fn() });
    vi.mocked(reconcileDeterministicDuplicate).mockResolvedValue({ outcome: "kept", canonical: makeTask({ id: "FN-003", description: "default task" }) });

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_default",
      projectPath: "/default/project",
      projectName: "default-project",
      isRegistered: true,
      store: { createTask: mockCreateTask, addAttachment: vi.fn(), getRootDir: vi.fn().mockReturnValue("/default/project") } as unknown as TaskStore,
    });

    await runTaskCreate("default task");

    expect(resolveProject).toHaveBeenCalledWith(undefined);
    expect(mockCreateTask).toHaveBeenCalledWith({ description: "default task", dependencies: undefined, source: { sourceType: "cli", sourceMetadata: undefined } });
  });

  it("runTaskCreate without project flag falls back to TaskStore(process.cwd()) when resolution fails", async () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/current/project");
    const mockCreateTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-004", description: "local task" }));
    const init = vi.fn();

    vi.mocked(runDeterministicDuplicateGuard).mockResolvedValue({ action: "proceed", fingerprint: "fp-local", releaseLock: vi.fn() });
    vi.mocked(reconcileDeterministicDuplicate).mockResolvedValue({ outcome: "kept", canonical: makeTask({ id: "FN-004", description: "local task" }) });

    vi.mocked(resolveProject).mockRejectedValueOnce(
      new Error("No fn project found in current directory. Use --project or run from a project directory.")
    );

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((projectPath: string) => ({
      init,
      createTask: mockCreateTask,
      addAttachment: vi.fn(),
      getRootDir: vi.fn().mockReturnValue(projectPath),
      projectPath,
    }));

    await runTaskCreate("local task");

    expect(resolveProject).toHaveBeenCalledWith(undefined);
    expect(TaskStore).toHaveBeenCalledWith("/current/project");
    expect(init).toHaveBeenCalledOnce();
    expect(mockCreateTask).toHaveBeenCalledWith({ description: "local task", dependencies: undefined, source: { sourceType: "cli", sourceMetadata: { contentFingerprint: "fp-local" } } });
    cwdSpy.mockRestore();
  });

  it("runTaskCreate links existing task on deterministic duplicate", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const existing = makeTask({ id: "FN-777", description: "same task", column: "todo" });
    const mockCreateTask = vi.fn();

    vi.mocked(runDeterministicDuplicateGuard).mockResolvedValue({
      action: "duplicate",
      fingerprint: "fp-dupe",
      existing,
      releaseLock: vi.fn(),
    });

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { createTask: mockCreateTask, addAttachment: vi.fn(), getRootDir: vi.fn().mockReturnValue("/test") } as unknown as TaskStore,
    });

    await runTaskCreate("same task");

    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("Linked existing FN-777"))).toBe(true);
    logSpy.mockRestore();
  });

  it("runTaskCreate proceeds when no high-signal tokens are present", async () => {
    const mockCreateTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-007", description: "plain task" }));
    const listTasks = vi.fn();

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { createTask: mockCreateTask, listTasks, addAttachment: vi.fn(), getRootDir: vi.fn().mockReturnValue("/test") } as unknown as TaskStore,
    });

    await runTaskCreate("plain task");

    expect(findNearDuplicates).not.toHaveBeenCalled();
    expect(listTasks).not.toHaveBeenCalled();
    expect(mockCreateTask).toHaveBeenCalledOnce();
  });

  it("runTaskCreate blocks near-duplicates in non-interactive mode", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as unknown) as (code?: string | number | null | undefined) => never);
    const originalInTTY = process.stdin.isTTY;
    const originalOutTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });

    const mockCreateTask = vi.fn();
    const listTasks = vi.fn().mockResolvedValue([
      makeTask({ id: "FN-9001", title: "Add /pr/options preflight flow", description: "touch /pr/options and /pr/preflight", column: "todo" }),
    ]);
    vi.mocked(extractIntentSignature).mockReturnValue({
      routePaths: ["/pr/options", "/pr/preflight"],
      filePaths: [],
      identifiers: [],
      titleTokens: [],
    });
    vi.mocked(findNearDuplicates).mockReturnValue([
      { id: "FN-9001", score: 0.7, sharedTokens: ["/pr/options", "/pr/preflight"], titleScore: 0.5, reason: "near-duplicate-intent" },
    ]);

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { createTask: mockCreateTask, listTasks, addAttachment: vi.fn(), getRootDir: vi.fn().mockReturnValue("/test") } as unknown as TaskStore,
    });

    await expect(runTaskCreate("Investigate /pr/options /pr/preflight flow")).rejects.toThrow("exit:1");

    expect(mockCreateTask).not.toHaveBeenCalled();
    const errorOutput = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(errorOutput).toContain("FN-9001");
    expect(errorOutput).toContain("/pr/options");
    expect(errorOutput).toContain("--no-dedup");

    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalInTTY });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalOutTTY });
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("runTaskCreate proceeds on TTY when user confirms near-duplicate creation", async () => {
    const originalInTTY = process.stdin.isTTY;
    const originalOutTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });

    const mockCreateTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-008", description: "same task" }));
    const listTasks = vi.fn().mockResolvedValue([
      makeTask({ id: "FN-9001", title: "Add /pr/options preflight flow", description: "touch /pr/options and /pr/preflight", column: "todo" }),
    ]);
    const close = vi.fn();
    vi.mocked(createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue("y"),
      close,
    } as never);
    vi.mocked(extractIntentSignature).mockReturnValue({
      routePaths: ["/pr/options", "/pr/preflight"],
      filePaths: [],
      identifiers: [],
      titleTokens: [],
    });
    vi.mocked(findNearDuplicates).mockReturnValue([
      { id: "FN-9001", score: 0.7, sharedTokens: ["/pr/options", "/pr/preflight"], titleScore: 0.5, reason: "near-duplicate-intent" },
    ]);
    vi.mocked(reconcileDeterministicDuplicate).mockResolvedValue({ outcome: "kept", canonical: makeTask({ id: "FN-008", description: "same task" }) });

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { createTask: mockCreateTask, listTasks, addAttachment: vi.fn(), getRootDir: vi.fn().mockReturnValue("/test") } as unknown as TaskStore,
    });

    await runTaskCreate("Investigate /pr/options /pr/preflight flow");

    expect(mockCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({
        sourceMetadata: expect.objectContaining({
          intentSignature: expect.objectContaining({ routePaths: ["/pr/options", "/pr/preflight"] }),
        }),
      }),
    }));
    expect(close).toHaveBeenCalled();

    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalInTTY });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalOutTTY });
  });

  it("runTaskCreate cancels on TTY when user declines near-duplicate creation", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as unknown) as (code?: string | number | null | undefined) => never);
    const originalInTTY = process.stdin.isTTY;
    const originalOutTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });

    const mockCreateTask = vi.fn();
    const listTasks = vi.fn().mockResolvedValue([
      makeTask({ id: "FN-9001", title: "Add /pr/options preflight flow", description: "touch /pr/options and /pr/preflight", column: "todo" }),
    ]);
    vi.mocked(createInterface).mockReturnValue({
      question: vi.fn().mockResolvedValue(""),
      close: vi.fn(),
    } as never);
    vi.mocked(extractIntentSignature).mockReturnValue({
      routePaths: ["/pr/options", "/pr/preflight"],
      filePaths: [],
      identifiers: [],
      titleTokens: [],
    });
    vi.mocked(findNearDuplicates).mockReturnValue([
      { id: "FN-9001", score: 0.7, sharedTokens: ["/pr/options", "/pr/preflight"], titleScore: 0.5, reason: "near-duplicate-intent" },
    ]);

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { createTask: mockCreateTask, listTasks, addAttachment: vi.fn(), getRootDir: vi.fn().mockReturnValue("/test") } as unknown as TaskStore,
    });

    await expect(runTaskCreate("Investigate /pr/options /pr/preflight flow")).rejects.toThrow("exit:0");
    expect(mockCreateTask).not.toHaveBeenCalled();

    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: originalInTTY });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalOutTTY });
    exitSpy.mockRestore();
  });

  it("runTaskCreate --no-dedup bypasses deterministic and near-duplicate guards but still stamps signature", async () => {
    const mockCreateTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-008", description: "same task" }));

    vi.mocked(runDeterministicDuplicateGuard).mockResolvedValue({
      action: "proceed",
      fingerprint: "fp-no-dedup",
      releaseLock: vi.fn(),
    });
    vi.mocked(extractIntentSignature).mockReturnValue({
      routePaths: ["/pr/options", "/pr/preflight"],
      filePaths: [],
      identifiers: [],
      titleTokens: [],
    });
    vi.mocked(reconcileDeterministicDuplicate).mockResolvedValue({ outcome: "kept", canonical: makeTask({ id: "FN-008", description: "same task" }) });

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { createTask: mockCreateTask, listTasks: vi.fn(), addAttachment: vi.fn(), getRootDir: vi.fn().mockReturnValue("/test") } as unknown as TaskStore,
    });

    await runTaskCreate("same task", undefined, undefined, undefined, undefined, true);

    expect(runDeterministicDuplicateGuard).toHaveBeenCalledWith(expect.anything(), { description: "same task" }, expect.objectContaining({ bypass: true }));
    expect(findNearDuplicates).not.toHaveBeenCalled();
    expect(extractIntentSignature).toHaveBeenCalledWith({ description: "same task" });
    expect(mockCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({
        sourceMetadata: expect.objectContaining({
          contentFingerprint: "fp-no-dedup",
          intentSignature: expect.objectContaining({ routePaths: ["/pr/options", "/pr/preflight"] }),
        }),
      }),
    }));
  });

  it("runTaskCreate fails open when listTasks throws during near-duplicate checking", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockCreateTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-008", description: "same task" }));
    vi.mocked(extractIntentSignature).mockReturnValue({
      routePaths: ["/pr/options", "/pr/preflight"],
      filePaths: [],
      identifiers: [],
      titleTokens: [],
    });

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { createTask: mockCreateTask, listTasks: vi.fn().mockRejectedValue(new Error("list boom")), addAttachment: vi.fn(), getRootDir: vi.fn().mockReturnValue("/test") } as unknown as TaskStore,
    });

    await runTaskCreate("Investigate /pr/options /pr/preflight flow");

    expect(errorSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("near-duplicate check failed (list boom)");
    expect(mockCreateTask).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it("runTaskCreate fails open when intent extraction throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mockCreateTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-008", description: "same task" }));
    vi.mocked(extractIntentSignature).mockImplementation(() => {
      throw new Error("extract boom");
    });

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { createTask: mockCreateTask, listTasks: vi.fn(), addAttachment: vi.fn(), getRootDir: vi.fn().mockReturnValue("/test") } as unknown as TaskStore,
    });

    await runTaskCreate("Investigate /pr/options /pr/preflight flow");

    expect(errorSpy.mock.calls.map((call) => call.join(" ")).join("\n")).toContain("near-duplicate check failed (extract boom)");
    expect(mockCreateTask).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it("runTaskCreate keeps deterministic duplicate short-circuit ahead of near-duplicate checks", async () => {
    const existing = makeTask({ id: "FN-777", description: "same task", column: "todo" });

    vi.mocked(runDeterministicDuplicateGuard).mockResolvedValue({
      action: "duplicate",
      fingerprint: "fp-dupe",
      existing,
      releaseLock: vi.fn(),
    });

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { createTask: vi.fn(), listTasks: vi.fn(), addAttachment: vi.fn(), getRootDir: vi.fn().mockReturnValue("/test") } as unknown as TaskStore,
    });

    await runTaskCreate("same task");

    expect(extractIntentSignature).not.toHaveBeenCalled();
    expect(findNearDuplicates).not.toHaveBeenCalled();
  });

  it("runTaskCreate creates separate tasks when description differs", async () => {
    const mockCreateTask = vi
      .fn()
      .mockResolvedValueOnce(makeTask({ id: "FN-010", description: "task a" }))
      .mockResolvedValueOnce(makeTask({ id: "FN-011", description: "task b" }));

    vi.mocked(runDeterministicDuplicateGuard)
      .mockResolvedValueOnce({ action: "proceed", fingerprint: "fp-a", releaseLock: vi.fn() })
      .mockResolvedValueOnce({ action: "proceed", fingerprint: "fp-b", releaseLock: vi.fn() });
    vi.mocked(reconcileDeterministicDuplicate)
      .mockResolvedValueOnce({ outcome: "kept", canonical: makeTask({ id: "FN-010", description: "task a" }) })
      .mockResolvedValueOnce({ outcome: "kept", canonical: makeTask({ id: "FN-011", description: "task b" }) });

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: { createTask: mockCreateTask, addAttachment: vi.fn(), getRootDir: vi.fn().mockReturnValue("/test") } as unknown as TaskStore,
    });

    await runTaskCreate("task a");
    await runTaskCreate("task b");

    expect(mockCreateTask).toHaveBeenCalledTimes(2);
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
    // FNXC:CliBoardMutation 2026-07-09-00:00 (FN-7734): the SIGINT handler
    // now closes the resolved board store BEFORE exiting (previously it
    // called `process.exit(0)` synchronously with no teardown), so invoking
    // it no longer throws synchronously — it fires the close and exits once
    // that settles. Await a tick and assert `process.exit(0)` was reached.
    sigintHandlers[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exitSpy).toHaveBeenCalledWith(0);
    promise.catch(() => {});

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(logSpy.mock.calls.some((call) => String(call[0]).includes("Logs for project 'demo-project':"))).toBe(true);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("runTaskPrCreate falls back to current working directory without project flag", async () => {
    const originalGitHubRepo = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/local/project");
    const mockCreatePr = vi.fn().mockResolvedValue({ number: 123, url: "https://example.com/pr/123" });
    vi.mocked(isGhAvailable).mockReturnValue(true);
    vi.mocked(isGhAuthenticated).mockReturnValue(true);
    vi.mocked(getCurrentRepo).mockReturnValue({ owner: "acme", repo: "demo" });
    vi.mocked(GitHubClient).mockImplementation(function () {
      return { createPr: mockCreatePr } as never;
    });

    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      getTask: vi.fn().mockResolvedValue(makeTask({ id: "FN-001", column: "in-review", branchName: "fusion/fn-001" })),
      updatePrInfo: vi.fn().mockResolvedValue(undefined),
      ensurePrEntityForSource: vi.fn(() => ({ id: "pr-entity-1" })),
      updatePrEntity: vi.fn(),
      logEntry: vi.fn().mockResolvedValue(undefined),
    }));

    await runTaskPrCreate("FN-001", {});

    expect(getCurrentRepo).toHaveBeenCalledWith("/local/project");
    expect(mockCreatePr).toHaveBeenCalledWith(expect.objectContaining({ head: "fusion/fn-001" }));
    cwdSpy.mockRestore();
    if (originalGitHubRepo !== undefined) process.env.GITHUB_REPOSITORY = originalGitHubRepo;
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
    expect(deleteTask).toHaveBeenCalledWith("FN-123", expect.objectContaining({
      auditContext: expect.objectContaining({
        agentId: "cli",
        runId: expect.stringMatching(/^synthetic-cli-delete-FN-123-/),
      }),
    }));
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
    // FNXC:MergerUnification 2026-06-24-22:58: CLI `fn task merge` normal-task tests must exercise the unified runAiMerge entrypoint; aiMergeTask remains deprecated and should not mask stale mocks.
    vi.mocked(runAiMerge).mockResolvedValue({
      merged: true,
      task: makeTask({ id: "FN-123" }),
      branch: "fusion/fn-123",
      worktreeRemoved: true,
      branchDeleted: true,
    } as never);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as unknown) as (code?: string | number | null | undefined) => never);

    try {
      await runTaskUpdate("FN-123", "0", "done", "demo-project");
      await runTaskLog("FN-123", "hello", undefined, "demo-project");
      await runTaskMerge("FN-123", "demo-project");
      await runTaskDuplicate("FN-123", "demo-project");
      await runTaskRefine("FN-123", "more tests", "demo-project");
    } finally {
      exitSpy.mockRestore();
    }

    expect(updateStep).toHaveBeenCalled();
    expect(logEntry).toHaveBeenCalled();
    expect(runAiMerge).toHaveBeenCalledWith(resolvedStore, "/test", "FN-123", expect.any(Object));
    expect(landWorkspaceTask).not.toHaveBeenCalled();
    expect(aiMergeTask).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(duplicateTask).toHaveBeenCalledWith("FN-123");
    expect(refineTask).toHaveBeenCalledWith("FN-123", "more tests");
  });

  it("routes GitHub import commands through the resolved project store", async () => {
    const listTasks = vi.fn().mockResolvedValue([]);
    const createTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-200" }));
    vi.mocked(isGhAvailable).mockReturnValue(true);
    vi.mocked(isGhAuthenticated).mockReturnValue(true);

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: {
        listTasks,
        createTask,
        getSettings: vi.fn().mockResolvedValue({}),
        getGlobalSettingsStore: vi.fn().mockReturnValue({ getSettings: vi.fn().mockResolvedValue({}) }),
      } as unknown as TaskStore,
    });

    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
      { number: 1, title: "Issue 1", body: "Body", html_url: "https://github.com/acme/demo/issues/1", labels: [] },
    ] as never);

    await runTaskImportFromGitHub("acme/demo", { limit: 1 }, "demo-project");
    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(listTasks).toHaveBeenCalled();
  });

  it("routes interactive GitHub import through the resolved project store", async () => {
    const listTasks = vi.fn().mockResolvedValue([]);
    const createTask = vi.fn().mockResolvedValue(makeTask({ id: "FN-201" }));
    const mockQuestion = vi.fn().mockResolvedValue("all");
    vi.mocked(isGhAvailable).mockReturnValue(true);
    vi.mocked(isGhAuthenticated).mockReturnValue(true);

    vi.mocked(createInterface).mockReturnValue({
      question: mockQuestion,
      close: vi.fn(),
    } as never);

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "demo-project",
      isRegistered: true,
      store: {
        listTasks,
        createTask,
        getSettings: vi.fn().mockResolvedValue({}),
        getGlobalSettingsStore: vi.fn().mockReturnValue({ getSettings: vi.fn().mockResolvedValue({}) }),
      } as unknown as TaskStore,
    });

    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
      { number: 2, title: "Issue 2", body: "Body", html_url: "https://github.com/acme/demo/issues/2", labels: [] },
    ] as never);

    await runTaskImportGitHubInteractive("acme/demo", { limit: 1 }, "demo-project");

    expect(resolveProject).toHaveBeenCalledWith("demo-project");
    expect(listTasks).toHaveBeenCalled();
    expect(createTask).toHaveBeenCalled();
  });

  it("surfaces project resolution failures from shared context when project flag is explicit", async () => {
    vi.mocked(resolveProject).mockRejectedValueOnce(
      new Error("Project 'demo-project' not found. Run 'fn project list' to see registered projects.")
    );

    await expect(runTaskList("demo-project")).rejects.toThrow(
      "Project 'demo-project' not found. Run 'fn project list' to see registered projects."
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
      source: { sourceType: "cli" },
    });
  });

  it("passes multiple dependencies correctly", async () => {
    await runTaskCreate("test task", undefined, ["FN-124", "FN-100"]);

    expect(mockCreateTask).toHaveBeenCalledWith({
      description: "test task",
      dependencies: ["FN-124", "FN-100"],
      source: { sourceType: "cli" },
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
      source: { sourceType: "cli" },
    });
  });
});

import { runTaskImportGitHubInteractive } from "../task.js";

describe("runTaskImportGitHubInteractive", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockCreateTask: ReturnType<typeof vi.fn>;
  let mockListTasks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(isGhAvailable).mockReturnValue(true);
    vi.mocked(isGhAuthenticated).mockReturnValue(true);
    vi.mocked(runGhJsonAsync).mockReset();

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
      getSettings: vi.fn().mockResolvedValue({}),
      getGlobalSettingsStore: vi.fn().mockReturnValue({ getSettings: vi.fn().mockResolvedValue({}) }),
    }));
  });

  afterEach(() => {
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
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
      mockIssue(1, "First Issue", "Description 1"),
      mockIssue(2, "Second Issue", "Description 2"),
      mockIssue(3, "Third Issue", "Description 3"),
    ] as never);

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
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "1",
        issueNumber: 1,
        url: "https://github.com/owner/repo/issues/1",
      },
      source: { sourceType: "github_import", sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/1", issueNumber: 1 } },
    });
    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "Third Issue",
      description: "Description 3\n\nSource: https://github.com/owner/repo/issues/3",
      column: "triage",
      dependencies: [],
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "3",
        issueNumber: 3,
        url: "https://github.com/owner/repo/issues/3",
      },
      source: { sourceType: "github_import", sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/3", issueNumber: 3 } },
    });
  });

  it("marks interactive imports as tracked when tracking defaults are on", async () => {
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      createTask: mockCreateTask,
      listTasks: mockListTasks,
      getSettings: vi.fn().mockResolvedValue({ githubTrackingEnabledByDefault: true }),
      getGlobalSettingsStore: vi.fn().mockReturnValue({ getSettings: vi.fn().mockResolvedValue({}) }),
    }));
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
      mockIssue(1, "Tracked Issue", "Description 1"),
    ] as never);
    vi.mocked(createInterface).mockReturnValueOnce({
      question: vi.fn().mockResolvedValueOnce("all"),
      close: vi.fn(),
    } as any);

    await runTaskImportGitHubInteractive("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      githubTracking: { enabled: true },
      sourceIssue: expect.objectContaining({ provider: "github", repository: "owner/repo", issueNumber: 1 }),
    }));
  });

  it("marks interactive imports as tracked when import linking is on and new-task defaults are off", async () => {
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      createTask: mockCreateTask,
      listTasks: mockListTasks,
      getSettings: vi.fn().mockResolvedValue({
        githubTrackingEnabledByDefault: false,
        githubLinkImportedIssuesToTracking: true,
      }),
      getGlobalSettingsStore: vi.fn().mockReturnValue({ getSettings: vi.fn().mockResolvedValue({}) }),
    }));
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
      mockIssue(1, "Import-linked Issue", null),
    ] as never);
    vi.mocked(createInterface).mockReturnValueOnce({
      question: vi.fn().mockResolvedValueOnce("all"),
      close: vi.fn(),
    } as any);

    await runTaskImportGitHubInteractive("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      description: "(no description)\n\nSource: https://github.com/owner/repo/issues/1",
      githubTracking: { enabled: true },
      sourceIssue: expect.objectContaining({ provider: "github", repository: "owner/repo", issueNumber: 1 }),
    }));
  });

  it('imports all issues when "all" is selected', async () => {
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
      mockIssue(1, "First Issue", "Description 1"),
      mockIssue(2, "Second Issue", "Description 2"),
    ] as never);

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

    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
      mockIssue(1, "First Issue", "Description 1"),
      mockIssue(2, "Second Issue", "Description 2"),
    ] as never);

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
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "2",
        issueNumber: 2,
        url: "https://github.com/owner/repo/issues/2",
      },
      source: { sourceType: "github_import", sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/2", issueNumber: 2 } },
    });

    const skipLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Skipping #1"),
    );
    expect(skipLine).toBeDefined();
  });

  it("handles empty issues list", async () => {
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([] as never);

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
    vi.mocked(runGhJsonAsync).mockRejectedValueOnce(new Error("Repository not found"));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(runTaskImportGitHubInteractive("owner/repo")).rejects.toThrow("process.exit");
    expect(mockCreateTask).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("re-prompts on invalid input", async () => {
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
      mockIssue(1, "First Issue", "Description 1"),
    ] as never);

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
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
      mockIssue(1, "First Issue", "Description 1"),
    ] as never);

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
import { fetchGitHubIssues, runTaskImportFromGitHub, type GitHubIssue } from "../task.js";

describe("fetchGitHubIssues", () => {
  const mockIssue: GitHubIssue = {
    number: 1,
    title: "Test Issue",
    body: "Test body",
    html_url: "https://github.com/owner/repo/issues/1",
    labels: [{ name: "bug" }],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  };

  beforeEach(() => {
    vi.mocked(isGhAvailable).mockReturnValue(true);
    vi.mocked(isGhAuthenticated).mockReturnValue(true);
    vi.mocked(runGhJsonAsync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches issues successfully", async () => {
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([mockIssue] as never);

    const issues = await fetchGitHubIssues("owner", "repo");

    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(1);
    expect(issues[0].title).toBe("Test Issue");
    expect(runGhJsonAsync).toHaveBeenCalledWith([
      "api",
      "repos/owner/repo/issues?state=open&per_page=30",
    ]);
  });

  it("respects limit option", async () => {
    const manyIssues = Array.from({ length: 50 }, (_, i) => ({
      ...mockIssue,
      number: i + 1,
    }));
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce(manyIssues as never);

    const issues = await fetchGitHubIssues("owner", "repo", { limit: 10 });

    expect(issues).toHaveLength(10);
    expect(runGhJsonAsync).toHaveBeenCalledWith([
      "api",
      "repos/owner/repo/issues?state=open&per_page=10",
    ]);
  });

  it("respects labels option", async () => {
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([mockIssue] as never);

    await fetchGitHubIssues("owner", "repo", { labels: ["bug", "enhancement"] });

    expect(runGhJsonAsync).toHaveBeenCalledWith([
      "api",
      "repos/owner/repo/issues?state=open&per_page=30&labels=bug%2Cenhancement",
    ]);
  });

  it("filters out pull requests", async () => {
    const pr = { ...mockIssue, number: 2, pull_request: {} };
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([mockIssue, pr] as never);

    const issues = await fetchGitHubIssues("owner", "repo");

    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(1);
  });

  it("throws error when gh CLI is unavailable", async () => {
    vi.mocked(isGhAvailable).mockReturnValue(false);

    await expect(fetchGitHubIssues("owner", "repo")).rejects.toThrow(
      "GitHub CLI (gh) is not available or not authenticated. Run 'gh auth login'.",
    );
    expect(runGhJsonAsync).not.toHaveBeenCalled();
  });

  it("throws error when gh CLI is not authenticated", async () => {
    vi.mocked(isGhAuthenticated).mockReturnValue(false);

    await expect(fetchGitHubIssues("owner", "repo")).rejects.toThrow(
      "GitHub CLI (gh) is not available or not authenticated. Run 'gh auth login'.",
    );
    expect(runGhJsonAsync).not.toHaveBeenCalled();
  });

  it("surfaces gh api errors", async () => {
    vi.mocked(runGhJsonAsync).mockRejectedValueOnce(new Error("Repository not found"));

    await expect(fetchGitHubIssues("owner", "repo")).rejects.toThrow("Repository not found");
  });
});

describe("runTaskImportFromGitHub", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let mockCreateTask: ReturnType<typeof vi.fn>;
  let mockListTasks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(isGhAvailable).mockReturnValue(true);
    vi.mocked(isGhAuthenticated).mockReturnValue(true);
    vi.mocked(runGhJsonAsync).mockReset();

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
      getSettings: vi.fn().mockResolvedValue({}),
      getGlobalSettingsStore: vi.fn().mockReturnValue({ getSettings: vi.fn().mockResolvedValue({}) }),
    }));
  });

  afterEach(() => {
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
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
      mockIssue(1, "First Issue", "Description 1"),
      mockIssue(2, "Second Issue", "Description 2"),
    ] as never);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledTimes(2);
    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "First Issue",
      description: "Description 1\n\nSource: https://github.com/owner/repo/issues/1",
      column: "triage",
      dependencies: [],
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "1",
        issueNumber: 1,
        url: "https://github.com/owner/repo/issues/1",
      },
      source: { sourceType: "github_import", sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/1", issueNumber: 1 } },
    });

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Imported 2 tasks"),
    );
    expect(successLine).toBeDefined();
  });

  it("marks non-interactive imports as tracked when tracking defaults are on", async () => {
    (TaskStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      init: vi.fn(),
      createTask: mockCreateTask,
      listTasks: mockListTasks,
      getSettings: vi.fn().mockResolvedValue({}),
      getGlobalSettingsStore: vi.fn().mockReturnValue({
        getSettings: vi.fn().mockResolvedValue({ githubTrackingDefaultEnabledForNewTasks: true }),
      }),
    }));
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
      mockIssue(1, "Tracked Issue", "Description 1"),
    ] as never);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledWith(expect.objectContaining({
      githubTracking: { enabled: true },
      sourceIssue: expect.objectContaining({ provider: "github", repository: "owner/repo", issueNumber: 1 }),
    }));
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

    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([
      mockIssue(1, "First Issue", "Description 1"),
      mockIssue(2, "Second Issue", "Description 2"),
    ] as never);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    const skipLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Skipping #1"),
    );
    expect(skipLine).toBeDefined();
  });

  it("handles empty issues list", async () => {
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([] as never);

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
    vi.mocked(runGhJsonAsync).mockRejectedValueOnce(new Error("Repository not found"));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(runTaskImportFromGitHub("owner/repo")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("uses (no description) for empty body", async () => {
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([mockIssue(1, "No Body Issue", null)] as never);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "No Body Issue",
      description: "(no description)\n\nSource: https://github.com/owner/repo/issues/1",
      column: "triage",
      dependencies: [],
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "1",
        issueNumber: 1,
        url: "https://github.com/owner/repo/issues/1",
      },
      source: { sourceType: "github_import", sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/1", issueNumber: 1 } },
    });
  });

  it("truncates long titles to 200 chars", async () => {
    const longTitle = "A".repeat(250);
    vi.mocked(runGhJsonAsync).mockResolvedValueOnce([mockIssue(1, longTitle, "Body")] as never);

    await runTaskImportFromGitHub("owner/repo");

    expect(mockCreateTask).toHaveBeenCalledWith({
      title: "A".repeat(200),
      description: expect.stringContaining("Body"),
      column: "triage",
      dependencies: [],
      sourceIssue: {
        provider: "github",
        repository: "owner/repo",
        externalIssueId: "1",
        issueNumber: 1,
        url: "https://github.com/owner/repo/issues/1",
      },
      source: { sourceType: "github_import", sourceMetadata: { issueUrl: "https://github.com/owner/repo/issues/1", issueNumber: 1 } },
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
    expect(mockDeleteTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({
      auditContext: expect.objectContaining({
        agentId: "cli",
        runId: expect.stringMatching(/^synthetic-cli-delete-FN-001-/),
      }),
    }));

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
    expect(mockDeleteTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({
      auditContext: expect.objectContaining({
        agentId: "cli",
        runId: expect.stringMatching(/^synthetic-cli-delete-FN-001-/),
      }),
    }));

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

    vi.mocked(resolveProject).mockResolvedValue({
      projectId: "proj_test",
      projectPath: "/test",
      projectName: "test",
      isRegistered: true,
      store: {
        getTask: mockGetTask,
        updateTask: mockUpdateTask,
        moveTask: mockMoveTask,
        logEntry: mockLogEntry,
      } as unknown as TaskStore,
    });
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
    expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", {
      status: null,
      error: null,
      worktree: null,
      branch: null,
      baseBranch: null,
      baseCommitSha: null,
      nextRecoveryAt: null,
      stuckKillCount: 0,
      recoveryRetryCount: 0,
      taskDoneRetryCount: 0,
      worktreeSessionRetryCount: 0,
      workflowStepRetries: 0,
      verificationFailureCount: 0,
      postReviewFixCount: 0,
      mergeConflictBounceCount: 0,
      branchConflictRecoveryCount: 0,
      reviewerContextRetryCount: 0,
      reviewerFallbackRetryCount: 0,
      completionHandoffLimboRecoveryCount: 0,
      graphResumeRetryCount: 0,
      mergeAuditBounceCount: 0,
      mergeRetries: 0,
      resumeLimboCount: 0,
    });
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
    expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", {
      status: null,
      error: null,
      worktree: null,
      branch: null,
      baseBranch: null,
      baseCommitSha: null,
      nextRecoveryAt: null,
      stuckKillCount: 0,
      recoveryRetryCount: 0,
      taskDoneRetryCount: 0,
      worktreeSessionRetryCount: 0,
      workflowStepRetries: 0,
      verificationFailureCount: 0,
      postReviewFixCount: 0,
      mergeConflictBounceCount: 0,
      branchConflictRecoveryCount: 0,
      reviewerContextRetryCount: 0,
      reviewerFallbackRetryCount: 0,
      completionHandoffLimboRecoveryCount: 0,
      graphResumeRetryCount: 0,
      mergeAuditBounceCount: 0,
      mergeRetries: 0,
      resumeLimboCount: 0,
    });
    expect(mockMoveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(mockLogEntry).toHaveBeenCalledWith("FN-001", "Retry requested from CLI", "Task reset to todo for retry");

    const successLine = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("✓ Retried"),
    );
    expect(successLine).toBeDefined();
    expect(successLine![0]).toContain("FN-001");
    expect(successLine![0]).toContain("todo");
  });

  it("retries stranded in-review task with status none and incomplete steps to todo preserving progress", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({
      id: "FN-001",
      status: null,
      column: "in-review",
      mergeRetries: 4,
      steps: [
        { name: "Step 0", status: "done" },
        { name: "Step 1", status: "in-progress" },
        { name: "Step 2", status: "pending" },
      ],
    }));
    mockUpdateTask.mockResolvedValueOnce(makeTask({ id: "FN-001", status: undefined, error: undefined }));
    mockMoveTask.mockResolvedValueOnce(makeTask({ id: "FN-001", column: "todo" }));
    mockLogEntry.mockResolvedValueOnce(makeTask({ id: "FN-001" }));

    await runTaskRetry("FN-001");

    expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({
      status: null,
      error: null,
    }));
    expect(mockUpdateTask.mock.calls[0][1]).not.toHaveProperty("mergeRetries");
    expect(mockMoveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveProgress: true });
    expect(mockLogEntry).toHaveBeenCalledWith(
      "FN-001",
      "Retry requested from CLI (stranded in-review execution retry → todo, preserving progress)",
    );
  });

  it("retries stranded zero-step in-review task with no merge attempts to todo", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({
      id: "FN-001",
      status: null,
      column: "in-review",
      mergeRetries: 0,
      steps: [],
    }));
    mockUpdateTask.mockResolvedValueOnce(makeTask({ id: "FN-001", status: undefined, error: undefined }));
    mockMoveTask.mockResolvedValueOnce(makeTask({ id: "FN-001", column: "todo" }));
    mockLogEntry.mockResolvedValueOnce(makeTask({ id: "FN-001" }));

    await runTaskRetry("FN-001");

    expect(mockMoveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveProgress: true });
    expect(mockLogEntry).toHaveBeenCalledWith(
      "FN-001",
      "Retry requested from CLI (stranded in-review execution retry → todo, preserving progress)",
    );
  });

  it("retries stranded in-review task with status none and prior merge attempts as merge retry", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({
      id: "FN-001",
      status: null,
      column: "in-review",
      mergeRetries: 2,
      steps: [
        { name: "Step 0", status: "done" },
        { name: "Step 1", status: "done" },
      ],
    }));
    mockUpdateTask.mockResolvedValueOnce(makeTask({ id: "FN-001", status: undefined, error: undefined }));
    mockLogEntry.mockResolvedValueOnce(makeTask({ id: "FN-001" }));

    await runTaskRetry("FN-001");

    expect(mockUpdateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({
      status: null,
      error: null,
      mergeRetries: 0,
    }));
    expect(mockMoveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(mockLogEntry).toHaveBeenCalledWith(
      "FN-001",
      "Retry requested from CLI (merge retry → todo, mergeRetries reset)",
    );
  });

  it("rejects stranded in-review task with status none, completed steps, and no merge attempts", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({
      id: "FN-001",
      status: null,
      column: "in-review",
      mergeRetries: 0,
      steps: [
        { name: "Step 0", status: "done" },
        { name: "Step 1", status: "done" },
      ],
    }));

    await expect(runTaskRetry("FN-001")).rejects.toThrow("Task FN-001 is not in a retryable state (status: none)");
    expect(mockUpdateTask).not.toHaveBeenCalled();
    expect(mockMoveTask).not.toHaveBeenCalled();
  });

  it("rejects non-review task with status none", async () => {
    mockGetTask.mockResolvedValueOnce(makeTask({
      id: "FN-001",
      status: null,
      column: "todo",
      steps: [{ name: "Step 0", status: "pending" }],
    }));

    await expect(runTaskRetry("FN-001")).rejects.toThrow("Task FN-001 is not in a retryable state (status: none)");
    expect(mockUpdateTask).not.toHaveBeenCalled();
    expect(mockMoveTask).not.toHaveBeenCalled();
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
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
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
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // Reset process.env
    process.env = { ...originalEnv };
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_TOKEN;

    // Setup GitHubClient mock
    mockCreatePr = vi.fn();
    vi.mocked(GitHubClient).mockImplementation(function () {
      return {
        createPr: mockCreatePr,
      } as unknown as GitHubClient;
    });
    vi.mocked(generatePrMetadata).mockResolvedValue({ title: "AI Generated Title", body: "AI Generated Body", templateUsed: false });

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
      ensurePrEntityForSource: vi.fn(() => ({ id: "pr-entity-1" })),
      updatePrEntity: vi.fn(),
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

    await runTaskPrCreate("FN-001", { ai: false });

    expect(mockCreatePr).toHaveBeenCalledWith(expect.objectContaining({
      title: "My Task Title",
      head: "fusion/fn-001",
    }));
  });

  it("generates title from description when task has no title", async () => {
    const task = makeInReviewTask({ title: undefined, description: "this is a very long description that will be truncated for the pr title" });
    mockGetTask.mockResolvedValueOnce(task);
    mockCreatePr.mockResolvedValueOnce(makePrInfo());

    await runTaskPrCreate("FN-001", { ai: false });

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

    expect(errorSpy).toHaveBeenCalledWith(
      "Error: GitHub CLI (gh) is not available or not authenticated. Run 'gh auth login'.",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits with error when gh CLI is unavailable even if GITHUB_TOKEN is set", async () => {
    const task = makeInReviewTask();
    mockGetTask.mockResolvedValueOnce(task);

    vi.mocked(isGhAvailable).mockReturnValue(false);
    vi.mocked(isGhAuthenticated).mockReturnValue(false);
    process.env.GITHUB_TOKEN = "test-token";

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as (code?: number) => never);

    await expect(runTaskPrCreate("FN-001", {})).rejects.toThrow("process.exit");

    expect(GitHubClient).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "Error: GitHub CLI (gh) is not available or not authenticated. Run 'gh auth login'.",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
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

  it("formats retryable GitHub errors for CLI output", async () => {
    const task = makeInReviewTask();
    mockGetTask.mockResolvedValueOnce(task);
    mockCreatePr.mockRejectedValueOnce({ message: "403 API rate limit exceeded", stderr: "Retry-After: 5" });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as (code?: number) => never);

    await expect(runTaskPrCreate("FN-001", {})).rejects.toThrow("process.exit");

    const output = stderrWriteSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("GitHub error:");
    expect(output).toContain("retryable");
    expect(output).toContain("fn pr create <task-id>");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  describe("flag coverage", () => {
    it.each([
      { draft: true, reviewers: ["alice", "bob"] },
      { draft: false, reviewers: undefined },
    ])("forwards draft/reviewers %#", async ({ draft, reviewers }) => {
      const task = makeInReviewTask();
      mockGetTask.mockResolvedValueOnce(task);
      mockCreatePr.mockResolvedValueOnce(makePrInfo());

      await runTaskPrCreate("FN-001", { draft, reviewers, ai: false });

      expect(mockCreatePr).toHaveBeenCalledWith(expect.objectContaining({
        draft,
        reviewers,
      }));
    });
  });

  describe("AI metadata parity", () => {
    it("uses generated metadata when title/body are not provided", async () => {
      const task = makeInReviewTask();
      mockGetTask.mockResolvedValueOnce(task);
      vi.mocked(generatePrMetadata).mockResolvedValueOnce({ title: "AI Title", body: "AI Body", templateUsed: false });
      mockCreatePr.mockResolvedValueOnce(makePrInfo());

      await runTaskPrCreate("FN-001", {});

      expect(generatePrMetadata).toHaveBeenCalledTimes(1);
      expect(mockCreatePr).toHaveBeenCalledWith(expect.objectContaining({ title: "AI Title", body: "AI Body" }));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Using AI-generated title/body"));
    });

    it("uses user title + AI body when only title is provided", async () => {
      const task = makeInReviewTask();
      mockGetTask.mockResolvedValueOnce(task);
      vi.mocked(generatePrMetadata).mockResolvedValueOnce({ title: "AI Title", body: "AI Body", templateUsed: false });
      mockCreatePr.mockResolvedValueOnce(makePrInfo());

      await runTaskPrCreate("FN-001", { title: "User Title" });

      expect(mockCreatePr).toHaveBeenCalledWith(expect.objectContaining({ title: "User Title", body: "AI Body" }));
    });

    it("uses AI title + user body when only body is provided", async () => {
      const task = makeInReviewTask();
      mockGetTask.mockResolvedValueOnce(task);
      vi.mocked(generatePrMetadata).mockResolvedValueOnce({ title: "AI Title", body: "AI Body", templateUsed: false });
      mockCreatePr.mockResolvedValueOnce(makePrInfo());

      await runTaskPrCreate("FN-001", { body: "User Body" });

      expect(mockCreatePr).toHaveBeenCalledWith(expect.objectContaining({ title: "AI Title", body: "User Body" }));
    });

    it("does not call AI when both title and body are provided", async () => {
      const task = makeInReviewTask();
      mockGetTask.mockResolvedValueOnce(task);
      mockCreatePr.mockResolvedValueOnce(makePrInfo());

      await runTaskPrCreate("FN-001", { title: "User Title", body: "User Body" });

      expect(generatePrMetadata).not.toHaveBeenCalled();
    });

    it("falls back when AI metadata generation fails", async () => {
      const task = makeInReviewTask({ title: undefined, description: "fallback description value for title" });
      mockGetTask.mockResolvedValueOnce(task);
      vi.mocked(generatePrMetadata).mockRejectedValueOnce(new Error("ai failed"));
      mockCreatePr.mockResolvedValueOnce(makePrInfo());

      await runTaskPrCreate("FN-001", {});

      expect(mockCreatePr).toHaveBeenCalledWith(expect.objectContaining({ title: "Fallback description value for title".slice(0, 50) }));
      expect(stderrWriteSpy).toHaveBeenCalledWith(expect.stringContaining("AI metadata generation failed"));
    });

    it("skips AI metadata when --no-ai is set", async () => {
      const task = makeInReviewTask();
      mockGetTask.mockResolvedValueOnce(task);
      mockCreatePr.mockResolvedValueOnce(makePrInfo());

      await runTaskPrCreate("FN-001", { ai: false });

      expect(generatePrMetadata).not.toHaveBeenCalled();
    });
  });
});
