/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * Regression coverage for FN-7740's `project.ts` fix: `getTaskCounts`
 * builds an UNCACHED `new TaskStore(projectPath)` per call and previously
 * never closed it — `runProjectList` calls it once per registered project
 * in a `Promise.all` map, so an N-project registry leaked N never-closed
 * stores. Proves (1) every constructed `getTaskCounts` store is closed,
 * including across MULTIPLE registered projects in one `runProjectList`
 * call, (2) the `runProjectAdd` interactive-init store is closed, and (3)
 * `listTasks` retries a momentary `database is locked` instead of silently
 * masquerading as "zero tasks" via the outer soft-catch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
  const mock = vi.fn(function () {});
  const originalMockImplementation = mock.mockImplementation.bind(mock);
  const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
    return nextImpl(...args);
  };
  mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
  if (impl) {
    mock.mockImplementation(impl);
  }
  return mock;
}

const { taskStoreInstances, mockListProjects, mockGetProjectHealth, mockGetSettings, isSqliteLockErrorMock } = vi.hoisted(() => ({
  taskStoreInstances: [] as Array<{ path: string; init: ReturnType<typeof import("vitest").vi.fn>; listTasks: ReturnType<typeof import("vitest").vi.fn>; close: ReturnType<typeof import("vitest").vi.fn> }>,
  mockListProjects: vi.fn(),
  mockGetProjectHealth: vi.fn(),
  mockGetSettings: vi.fn(),
  isSqliteLockErrorMock: vi.fn((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return /database is locked|SQLITE_BUSY/i.test(message);
  }),
}));

vi.mock("@fusion/core", () => ({
  CentralCore: makeConstructibleMock(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listProjects: mockListProjects,
    getProjectHealth: mockGetProjectHealth,
    getProject: vi.fn(),
  })),
  GlobalSettingsStore: makeConstructibleMock(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    getSettings: mockGetSettings,
  })),
  TaskStore: makeConstructibleMock((path: string) => {
    const instance = {
      path,
      init: vi.fn().mockResolvedValue(undefined),
      listTasks: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
    };
    taskStoreInstances.push(instance);
    return instance;
  }),
  countRunningAgentTasks: () => 0,
  ensureMemoryFileWithBackend: vi.fn(),
  readProjectIdentity: vi.fn().mockReturnValue(undefined),
  writeProjectIdentity: vi.fn(),
  isSqliteLockError: isSqliteLockErrorMock,
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
    question: vi.fn().mockResolvedValue("y"),
    close: vi.fn(),
  })),
}));

vi.mock("../../project-context.js", () => ({
  formatProjectLine: vi.fn((project: { name: string }, isDefault: boolean) => `${isDefault ? "* " : "  "}${project.name}`),
  detectProjectFromCwd: vi.fn(),
  setDefaultProject: vi.fn(),
}));

import { runProjectList } from "../project.js";

describe("fn project — store-leak reproduction (FN-7740)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskStoreInstances.length = 0;
    mockGetSettings.mockResolvedValue({});
    mockGetProjectHealth.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes zero stores when no projects are registered", async () => {
    mockListProjects.mockResolvedValue([]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProjectList({ json: true });

    expect(taskStoreInstances).toHaveLength(0);
    logSpy.mockRestore();
  });

  it("closes EVERY per-project TaskStore getTaskCounts constructs, across multiple registered projects", async () => {
    mockListProjects.mockResolvedValue([
      { id: "proj-a", name: "alpha", path: "/projects/alpha", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" },
      { id: "proj-b", name: "beta", path: "/projects/beta", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" },
      { id: "proj-c", name: "gamma", path: "/projects/gamma", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" },
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProjectList({ json: true });

    // getTaskCounts constructs an uncached TaskStore per project
    expect(taskStoreInstances).toHaveLength(3);
    for (const instance of taskStoreInstances) {
      expect(instance.close).toHaveBeenCalled();
    }
    logSpy.mockRestore();
  });

  it("closes the store even when a project's listTasks throws (outer soft-catch still fires, but the store is not leaked)", async () => {
    mockListProjects.mockResolvedValue([
      { id: "proj-bad", name: "unreadable", path: "/projects/unreadable", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" },
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runProjectList({ json: true });

    expect(taskStoreInstances).toHaveLength(1);
    // Simulate the failure via the instance itself: reconfigure listTasks to
    // reject on next call and re-run to prove close still fires.
    taskStoreInstances[0]!.listTasks.mockRejectedValueOnce(new Error("not-a-project"));
    await runProjectList({ json: true });
    const secondInstance = taskStoreInstances[1]!;
    expect(secondInstance.close).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("retries listTasks through a transient database-is-locked error instead of silently reporting zero tasks", async () => {
    mockListProjects.mockResolvedValue([
      { id: "proj-a", name: "alpha", path: "/projects/alpha", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" },
    ]);

    const lockError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const realTasks = [{ id: "FN-1", column: "todo" }, { id: "FN-2", column: "in-progress" }];

    // Configure the FIRST constructed store's listTasks to fail twice with a
    // lock error, then succeed — proving retryOnLock rides out the lock
    // instead of the outer soft-catch silently reporting empty counts.
    const originalPush = taskStoreInstances.push.bind(taskStoreInstances);
    taskStoreInstances.push = ((instance: (typeof taskStoreInstances)[number]) => {
      instance.listTasks
        .mockRejectedValueOnce(lockError)
        .mockRejectedValueOnce(lockError)
        .mockResolvedValueOnce(realTasks);
      return originalPush(instance);
    }) as typeof taskStoreInstances.push;

    process.env.FUSION_CLI_LOCK_RETRY_MS = "5000";
    vi.useFakeTimers();
    let jsonOutput = "";
    const logSpy = vi.spyOn(console, "log").mockImplementation((msg: string) => {
      jsonOutput += msg;
    });
    try {
      const promise = runProjectList({ json: true });
      for (let i = 0; i < 10 && taskStoreInstances[0]?.listTasks.mock.calls.length !== 3; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await promise;
    } finally {
      vi.useRealTimers();
      delete process.env.FUSION_CLI_LOCK_RETRY_MS;
    }

    expect(taskStoreInstances[0]!.listTasks).toHaveBeenCalledTimes(3);
    expect(taskStoreInstances[0]!.close).toHaveBeenCalled();
    // The real (non-empty) task counts made it through — proving the retry
    // succeeded rather than the outer catch masking the lock as zero tasks.
    expect(jsonOutput).toContain('"todo": 1');
    expect(jsonOutput).toContain('"in-progress": 1');
    logSpy.mockRestore();
  }, 20_000);
});
