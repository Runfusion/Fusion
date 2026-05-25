import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrMonitor } from "../pr-monitor.js";
import {
  Scheduler,
  pathsOverlap,
  filterPathsByIgnoreList,
  formatConcurrencyLimitMemoKey,
  findHigherPriorityQueuedOverlap,
} from "../scheduler.js";
import { AgentSemaphore } from "../concurrency.js";
import type { TaskStore, Task, TaskDetail } from "@fusion/core";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { schedulerLog } from "../logger.js";

const staleReporterReportMock = vi.fn();
const backlogPressureReporterReportMock = vi.fn();

// Mock fs modules
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(),
  };
});

vi.mock("../logger.js", () => ({
  schedulerLog: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../stale-task-reporter.js", () => ({
  StaleTaskReporter: vi.fn().mockImplementation(() => ({
    report: staleReporterReportMock,
  })),
}));

vi.mock("../backlog-pressure-reporter.js", () => ({
  BacklogPressureReporter: vi.fn().mockImplementation(() => ({
    report: backlogPressureReporterReportMock,
  })),
}));

// Helper to create mock tasks
function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    description: "Test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    prompt: "",
    ...overrides,
  } as Task;
}

// Mock store factory
function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    listTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({}),
    getTask: vi.fn().mockResolvedValue(createMockTask()),
    updateTask: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/test/project"),
    getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("pathsOverlap", () => {
  it("returns false for empty arrays", () => {
    expect(pathsOverlap([], [])).toBe(false);
    expect(pathsOverlap(["src/index.ts"], [])).toBe(false);
    expect(pathsOverlap([], ["src/index.ts"])).toBe(false);
  });

  it("detects exact file path matches", () => {
    expect(pathsOverlap(["src/index.ts"], ["src/index.ts"])).toBe(true);
    expect(pathsOverlap(["a.ts", "b.ts"], ["b.ts", "c.ts"])).toBe(true);
  });

  it("detects directory prefix overlaps with /* globs", () => {
    // Directory glob overlaps with file in that directory
    expect(pathsOverlap(["src/*"], ["src/index.ts"])).toBe(true);
    expect(pathsOverlap(["src/*"], ["src/utils/helpers.ts"])).toBe(true);
    
    // File overlaps with directory glob containing it
    expect(pathsOverlap(["src/index.ts"], ["src/*"])).toBe(true);
  });

  it("detects nested directory overlaps", () => {
    expect(pathsOverlap(["src/components/*"], ["src/components/Button.tsx"])).toBe(true);
    expect(pathsOverlap(["src/*"], ["src/components/Button.tsx"])).toBe(true);
  });

  it("returns false for non-overlapping paths", () => {
    expect(pathsOverlap(["src/*"], ["test/*"])).toBe(false);
    expect(pathsOverlap(["src/index.ts"], ["test/index.ts"])).toBe(false);
    expect(pathsOverlap(["a.ts", "b.ts"], ["c.ts", "d.ts"])).toBe(false);
  });

  it("handles multiple paths in each array", () => {
    const a = ["src/*", "test/*"];
    const b = ["src/components/Button.tsx"];
    expect(pathsOverlap(a, b)).toBe(true);

    const c = ["docs/*", "examples/*"];
    const d = ["src/index.ts"];
    expect(pathsOverlap(c, d)).toBe(false);
  });

  it("handles mixed globs and exact paths", () => {
    expect(pathsOverlap(["src/*", "package.json"], ["package.json"])).toBe(true);
    expect(pathsOverlap(["src/*", "package.json"], ["README.md"])).toBe(false);
  });

  it("handles both having globs with overlapping prefixes", () => {
    expect(pathsOverlap(["src/*"], ["src/components/*"])).toBe(true);
    expect(pathsOverlap(["src/components/*"], ["src/*"])).toBe(true);
  });
});

describe("filterPathsByIgnoreList", () => {
  it("filters exact ignored file paths", () => {
    expect(filterPathsByIgnoreList(["docs/README.md", "src/index.ts"], ["docs/README.md"]))
      .toEqual(["src/index.ts"]);
  });

  it("filters ignored directories with and without trailing slash", () => {
    expect(filterPathsByIgnoreList(["docs/guide.md", "docs/api/types.md", "src/index.ts"], ["docs"]))
      .toEqual(["src/index.ts"]);
    expect(filterPathsByIgnoreList(["docs/guide.md", "src/index.ts"], ["docs/"]))
      .toEqual(["src/index.ts"]);
  });

  it("filters ignored glob-style directories", () => {
    expect(filterPathsByIgnoreList(["generated/*", "generated/client.ts", "src/index.ts"], ["generated/*"]))
      .toEqual(["src/index.ts"]);
  });
});

describe("findHigherPriorityQueuedOverlap", () => {
  const overlap = (a: string[], b: string[]) => pathsOverlap(a, b);

  it("returns higher-priority queued overlap", () => {
    const result = findHigherPriorityQueuedOverlap(
      { id: "FN-2", priority: "normal", createdAt: "2026-01-02T00:00:00Z", scope: ["src/a.ts"] },
      [{ id: "FN-1", priority: "urgent", createdAt: "2026-01-03T00:00:00Z", scope: ["src/a.ts"] }],
      overlap,
    );
    expect(result?.id).toBe("FN-1");
  });

  it("uses age tiebreaker at equal priority", () => {
    const result = findHigherPriorityQueuedOverlap(
      { id: "FN-2", priority: "normal", createdAt: "2026-01-02T00:00:00Z", scope: ["src/a.ts"] },
      [{ id: "FN-1", priority: "normal", createdAt: "2026-01-01T00:00:00Z", scope: ["src/a.ts"] }],
      overlap,
    );
    expect(result?.id).toBe("FN-1");
  });

  it("uses task id tiebreaker when priority and age match", () => {
    const result = findHigherPriorityQueuedOverlap(
      { id: "FN-10", priority: "normal", createdAt: "2026-01-01T00:00:00Z", scope: ["src/a.ts"] },
      [{ id: "FN-2", priority: "normal", createdAt: "2026-01-01T00:00:00Z", scope: ["src/a.ts"] }],
      overlap,
    );
    expect(result?.id).toBe("FN-2");
  });

  it("returns null when scopes do not overlap", () => {
    const result = findHigherPriorityQueuedOverlap(
      { id: "FN-2", priority: "normal", createdAt: "2026-01-02T00:00:00Z", scope: ["src/a.ts"] },
      [{ id: "FN-1", priority: "urgent", createdAt: "2026-01-01T00:00:00Z", scope: ["src/b.ts"] }],
      overlap,
    );
    expect(result).toBeNull();
  });

  it("returns null when candidate or queued scopes are empty", () => {
    expect(
      findHigherPriorityQueuedOverlap(
        { id: "FN-2", priority: "normal", createdAt: "2026-01-02T00:00:00Z", scope: [] },
        [{ id: "FN-1", priority: "urgent", createdAt: "2026-01-01T00:00:00Z", scope: ["src/a.ts"] }],
        overlap,
      ),
    ).toBeNull();

    expect(
      findHigherPriorityQueuedOverlap(
        { id: "FN-2", priority: "normal", createdAt: "2026-01-02T00:00:00Z", scope: ["src/a.ts"] },
        [{ id: "FN-1", priority: "urgent", createdAt: "2026-01-01T00:00:00Z", scope: [] }],
        overlap,
      ),
    ).toBeNull();
  });
});

describe("Scheduler", () => {
  beforeEach(() => {
    staleReporterReportMock.mockReset().mockResolvedValue({ surfaced: 0 });
    backlogPressureReporterReportMock.mockReset().mockResolvedValue({ alerted: false });
  });
  // Helper to create mock MissionStore (shared across mission-related test suites)
  function createMockMissionStore(overrides = {}) {
    return {
      getFeatureByTaskId: vi.fn(),
      updateFeatureStatus: vi.fn().mockResolvedValue(undefined),
      getSlice: vi.fn(),
      getMilestone: vi.fn(),
      computeSliceStatus: vi.fn(),
      getMission: vi.fn(),
      getMissionWithHierarchy: vi.fn(),
      findNextPendingSlice: vi.fn(),
      activateSlice: vi.fn(),
      listFeatures: vi.fn().mockReturnValue([]),
      linkFeatureToTask: vi.fn((featureId: string, taskId: string) => ({
        id: featureId,
        taskId,
        sliceId: "SL-001",
        title: "Linked feature",
        status: "triaged",
      })),
      ...overrides,
    };
  }

  describe("stale task reporter integration", () => {
    it("invokes reporter from schedule", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([createMockTask({ id: "FN-STALE", column: "todo", dependencies: [] })]),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          staleInProgressWarningMs: 1000,
          staleInReviewWarningMs: 2000,
        }),
      });
      const scheduler = new Scheduler(store);
      (scheduler as unknown as { running: boolean }).running = true;
      await scheduler.schedule();
      expect(staleReporterReportMock).toHaveBeenCalledTimes(1);
    });

    it("does not throw when reporter errors", async () => {
      staleReporterReportMock.mockRejectedValueOnce(new Error("boom"));
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([createMockTask({ id: "FN-STALE", column: "todo", dependencies: [] })]),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          staleInProgressWarningMs: 1000,
          staleInReviewWarningMs: 2000,
        }),
      });
      const scheduler = new Scheduler(store);
      (scheduler as unknown as { running: boolean }).running = true;
      await expect(scheduler.schedule()).resolves.toBeUndefined();
      expect(schedulerLog.warn).toHaveBeenCalledWith("Stale task reporter failed", expect.any(Error));
    });

    it("rate-limits back-to-back reporter runs", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFile).mockResolvedValue("# Task\nDo something");
        const store = createMockStore({
          listTasks: vi.fn().mockResolvedValue([createMockTask({ id: "FN-STALE", column: "todo", dependencies: [] })]),
          getSettings: vi.fn().mockResolvedValue({
            maxConcurrent: 2,
            maxWorktrees: 4,
            staleInProgressWarningMs: 5000,
            staleInReviewWarningMs: 10000,
          }),
        });
        const scheduler = new Scheduler(store);
        (scheduler as unknown as { running: boolean }).running = true;
        await scheduler.schedule();
        await scheduler.schedule();
        expect(staleReporterReportMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("backlog pressure reporter integration", () => {
    it("invokes reporter from schedule when enabled", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-05-18T12:00:00.000Z"));
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFile).mockResolvedValue("# Task\nDo something");
        const store = createMockStore({
          listTasks: vi.fn().mockResolvedValue([createMockTask({ id: "FN-BACKLOG", column: "todo", dependencies: [] })]),
          getSettings: vi.fn().mockResolvedValue({
            maxConcurrent: 2,
            maxWorktrees: 4,
            staleInProgressWarningMs: 0,
            staleInReviewWarningMs: 0,
          }),
        });
        const scheduler = new Scheduler(store);
        (scheduler as unknown as { running: boolean }).running = true;
        await scheduler.schedule();
        expect(backlogPressureReporterReportMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not invoke reporter when disabled", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-05-18T12:00:00.000Z"));
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFile).mockResolvedValue("# Task\nDo something");
        const store = createMockStore({
          listTasks: vi.fn().mockResolvedValue([createMockTask({ id: "FN-BACKLOG", column: "todo", dependencies: [] })]),
          getSettings: vi.fn().mockResolvedValue({
            maxConcurrent: 2,
            maxWorktrees: 4,
            backlogPressureAlertEnabled: false,
            staleInProgressWarningMs: 0,
            staleInReviewWarningMs: 0,
          }),
        });
        const scheduler = new Scheduler(store);
        (scheduler as unknown as { running: boolean }).running = true;
        await scheduler.schedule();
        expect(backlogPressureReporterReportMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("constructor", () => {
    it("initializes with default options", () => {
      const store = createMockStore();
      const scheduler = new Scheduler(store);
      expect(scheduler).toBeDefined();
    });

    it("registers settings update handlers", () => {
      const store = createMockStore();
      const scheduler = new Scheduler(store);
      expect(store.on).toHaveBeenCalledWith("settings:updated", expect.any(Function));
    });

    it("accepts custom options", () => {
      const store = createMockStore();
      const onSchedule = vi.fn();
      const onBlocked = vi.fn();
      const scheduler = new Scheduler(store, {
        maxConcurrent: 3,
        maxWorktrees: 6,
        pollIntervalMs: 5000,
        onSchedule,
        onBlocked,
      });
      expect(scheduler).toBeDefined();
    });
  });

  describe("event-driven scheduling", () => {
    it("registers task:created event listener", () => {
      const store = createMockStore();
      new Scheduler(store);
      // Verify task:created listener is registered
      expect(store.on).toHaveBeenCalledWith("task:created", expect.any(Function));
    });

    it("triggers scheduling immediately when task:created event fires", async () => {
      // Mock filesystem validation so schedule() can proceed
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      // First call (from start()) returns empty todo, second call (from event) returns the new task
      const listTasksMock = vi.fn()
        .mockResolvedValueOnce([]) // Initial schedule from start() sees no tasks
        .mockResolvedValue([
          createMockTask({ id: "FN-001", column: "todo", dependencies: [] }),
        ]);

      const store = createMockStore({
        listTasks: listTasksMock,
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      scheduler.start();

      // Wait for initial schedule pass to complete
      await flushAsyncWork();

      // Find and call the task:created handler
      const onCalls = (store.on as any).mock.calls;
      const createdHandler = onCalls.find((call: any) => call[0] === "task:created")?.[1];
      expect(createdHandler).toBeDefined();

      // Simulate task:created event — triggers schedule() which now sees FN-001
      const newTask = createMockTask({ id: "FN-001", column: "todo" });
      await createdHandler(newTask);

      // Wait for async schedule to complete
      await flushAsyncWork();

      // Verify schedule() was called (moveTask should be called since task can start)
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });

    it("resets mergeRetries when dispatching a task to in-progress", async () => {
      // Regression: a task whose previous run exhausted its merge budget
      // (mergeRetries = MAX) would, after status was cleared, land back in
      // in-review with the merger refusing it (canMergeTask false) and the
      // ghost-review fallback bouncing it back every taskStuckTimeoutMs —
      // infinite loop. Each fresh execution must get a fresh merge budget.
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const listTasksMock = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([
          createMockTask({ id: "FN-001", column: "todo", dependencies: [], mergeRetries: 3 }),
        ]);

      const store = createMockStore({
        listTasks: listTasksMock,
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      scheduler.start();
      await flushAsyncWork();

      const onCalls = (store.on as any).mock.calls;
      const createdHandler = onCalls.find((call: any) => call[0] === "task:created")?.[1];
      await createdHandler(createMockTask({ id: "FN-001", column: "todo", mergeRetries: 3 }));
      await flushAsyncWork();

      expect(store.updateTask).toHaveBeenCalledWith(
        "FN-001",
        expect.objectContaining({ mergeRetries: 0 }),
      );
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });

    it("registers task:moved event listener", () => {
      const store = createMockStore();
      new Scheduler(store);
      // Verify task:moved listener is registered
      expect(store.on).toHaveBeenCalledWith("task:moved", expect.any(Function));
    });

    it("FN-5496: task:deleted immediately unblocks dependents in same tick", async () => {
      const deleted = createMockTask({ id: "FN-DEL", column: "todo" });
      const dependent = createMockTask({ id: "FN-DEP", column: "todo", blockedBy: "FN-DEL", dependencies: ["FN-DEL"] });
      const tasks = [dependent];
      const listTasks = vi.fn(async (options?: { column?: string; includeArchived?: boolean }) => {
        if (options?.column === "todo") return tasks.filter((task) => task.column === "todo");
        if (options?.column === "in-progress") return tasks.filter((task) => task.column === "in-progress");
        return tasks;
      });

      const store = createMockStore({
        listTasks,
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, globalPause: false, enginePaused: false }),
      });

      new Scheduler(store);
      const deletedHandler = (store.on as any).mock.calls.find((call: any) => call[0] === "task:deleted")?.[1];
      deletedHandler(deleted);
      await flushAsyncWork();

      expect(store.updateTask).toHaveBeenCalledWith("FN-DEP", { blockedBy: null, status: null });
      expect(store.logEntry).toHaveBeenCalledWith("FN-DEP", "Auto-unblocked (FN-5496): blocker FN-DEL was soft-deleted");
    });

    it("FN-5496: task:deleted clears blockedBy but preserves status for in-progress dependents", async () => {
      const deleted = createMockTask({ id: "FN-DEL", column: "todo" });
      const dependent = createMockTask({
        id: "FN-DEP",
        column: "in-progress",
        blockedBy: "FN-DEL",
        status: "running",
        dependencies: ["FN-DEL"],
      });
      const tasks = [dependent];
      const listTasks = vi.fn(async (options?: { column?: string; includeArchived?: boolean }) => {
        if (options?.column === "todo") return tasks.filter((task) => task.column === "todo");
        if (options?.column === "in-progress") return tasks.filter((task) => task.column === "in-progress");
        return tasks;
      });

      const store = createMockStore({
        listTasks,
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, globalPause: false, enginePaused: false }),
      });

      new Scheduler(store);
      const deletedHandler = (store.on as any).mock.calls.find((call: any) => call[0] === "task:deleted")?.[1];
      deletedHandler(deleted);
      await flushAsyncWork();

      expect(store.updateTask).toHaveBeenCalledWith("FN-DEP", { blockedBy: null });
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-DEP", expect.objectContaining({ status: null }));
      expect(store.logEntry).toHaveBeenCalledWith("FN-DEP", "Auto-unblocked (FN-5496): blocker FN-DEL was soft-deleted");
    });

    it("FN-5496: task:deleted repoints blockedBy when another dependency remains unresolved", async () => {
      const deleted = createMockTask({ id: "FN-DEL", column: "todo" });
      const live = createMockTask({ id: "FN-LIVE", column: "in-progress" });
      const dependent = createMockTask({
        id: "FN-DEP",
        column: "todo",
        status: "queued",
        blockedBy: "FN-DEL",
        dependencies: ["FN-DEL", "FN-LIVE"],
      });
      const tasks = [dependent, live];
      const listTasks = vi.fn(async (options?: { column?: string; includeArchived?: boolean }) => {
        if (options?.column === "todo") return tasks.filter((task) => task.column === "todo");
        if (options?.column === "in-progress") return tasks.filter((task) => task.column === "in-progress");
        return tasks;
      });

      const store = createMockStore({
        listTasks,
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, globalPause: false, enginePaused: false }),
      });

      new Scheduler(store);
      const deletedHandler = (store.on as any).mock.calls.find((call: any) => call[0] === "task:deleted")?.[1];
      deletedHandler(deleted);
      await flushAsyncWork();

      expect(store.updateTask).toHaveBeenCalledWith("FN-DEP", { blockedBy: "FN-LIVE", status: "queued" });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-DEP",
        "Auto-reblocked (FN-5496): unresolved dependency FN-LIVE remains after blocker FN-DEL was soft-deleted",
      );
    });

    it("FN-5496: task:deleted reconciliation is skipped when engine is paused", async () => {
      const deleted = createMockTask({ id: "FN-DEL", column: "todo" });
      const dependent = createMockTask({ id: "FN-DEP", column: "todo", blockedBy: "FN-DEL", dependencies: ["FN-DEL"] });
      const tasks = [dependent];
      const listTasks = vi.fn(async (options?: { column?: string; includeArchived?: boolean }) => {
        if (options?.column === "todo") return tasks.filter((task) => task.column === "todo");
        if (options?.column === "in-progress") return tasks.filter((task) => task.column === "in-progress");
        return tasks;
      });

      const store = createMockStore({
        listTasks,
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, globalPause: false, enginePaused: true }),
      });

      new Scheduler(store);
      const deletedHandler = (store.on as any).mock.calls.find((call: any) => call[0] === "task:deleted")?.[1];
      deletedHandler(deleted);
      await flushAsyncWork();

      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.logEntry).not.toHaveBeenCalled();
    });

    it("triggers scheduling immediately when task:moved to done event fires", async () => {
      // Mock filesystem validation so schedule() can proceed
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      // Initially return only FN-001 in-progress so start() doesn't schedule FN-002
      const listTasksMock = vi.fn()
        .mockResolvedValueOnce([
          createMockTask({ id: "FN-001", column: "in-progress", dependencies: [] }),
          createMockTask({ id: "FN-002", column: "todo", dependencies: ["FN-001"] }),
        ])
        // After event fires, FN-001 is done so FN-002's deps are satisfied
        .mockResolvedValue([
          createMockTask({ id: "FN-001", column: "done", dependencies: [] }),
          createMockTask({ id: "FN-002", column: "todo", dependencies: ["FN-001"] }),
        ]);

      const store = createMockStore({
        listTasks: listTasksMock,
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      scheduler.start();

      // Wait for initial schedule pass to complete
      await flushAsyncWork();

      // Find and call the task:moved handler
      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];
      expect(movedHandler).toBeDefined();

      // Simulate task:moved to done event
      const doneTask = createMockTask({ id: "FN-001", column: "in-progress" });
      await movedHandler({ task: doneTask, from: "in-progress", to: "done" });

      // Wait for async schedule to complete
      await flushAsyncWork();

      // Verify schedule() was called - FN-002 should now be able to start
      expect(store.moveTask).toHaveBeenCalledWith("FN-002", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });

    it.each(["done", "archived"] as const)("FN-3895: clears blockedBy when blocker moves to %s", async (to) => {
      const dependent = createMockTask({ id: "FN-3799", column: "todo", blockedBy: "FN-3885" });
      const blocker = createMockTask({ id: "FN-3885", column: to });
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([dependent]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
      });

      new Scheduler(store);
      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      await movedHandler({ task: blocker, from: "in-review", to });

      expect(store.updateTask).toHaveBeenCalledWith("FN-3799", { blockedBy: null, status: null });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-3799",
        `Auto-unblocked: blocker FN-3885 reached ${to}`,
      );
    });

    it("FN-3895: does not clear blockedBy for non-terminal transitions", async () => {
      const dependent = createMockTask({ id: "FN-3799", column: "todo", blockedBy: "FN-3885" });
      const blocker = createMockTask({ id: "FN-3885", column: "in-review" });
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([dependent]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
      });

      new Scheduler(store);
      const movedHandler = (store.on as any).mock.calls.find((call: any) => call[0] === "task:moved")?.[1];
      await movedHandler({ task: blocker, from: "in-progress", to: "in-review" });

      expect(store.updateTask).not.toHaveBeenCalledWith("FN-3799", { blockedBy: null, status: null });
    });

    it("FN-3895: does not clear blockedBy for tasks blocked by a different task", async () => {
      const dependent = createMockTask({ id: "FN-3799", column: "todo", blockedBy: "FN-4000" });
      const blocker = createMockTask({ id: "FN-3885", column: "done" });
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([dependent]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
      });

      new Scheduler(store);
      const movedHandler = (store.on as any).mock.calls.find((call: any) => call[0] === "task:moved")?.[1];
      await movedHandler({ task: blocker, from: "in-review", to: "done" });

      expect(store.updateTask).not.toHaveBeenCalledWith("FN-3799", { blockedBy: null, status: null });
    });

    it("FN-3895: skips event-driven unblock when enginePaused is true", async () => {
      const dependent = createMockTask({ id: "FN-3799", column: "todo", blockedBy: "FN-3885" });
      const blocker = createMockTask({ id: "FN-3885", column: "done" });
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([dependent]),
        getSettings: vi.fn().mockResolvedValue({ enginePaused: true, globalPause: false }),
      });

      new Scheduler(store);
      const movedHandler = (store.on as any).mock.calls.find((call: any) => call[0] === "task:moved")?.[1];
      await movedHandler({ task: blocker, from: "in-review", to: "done" });

      expect(store.updateTask).not.toHaveBeenCalledWith("FN-3799", { blockedBy: null, status: null });
    });

    it("FN-3895: unblocks FN-3799 and FN-3811 once FN-3885 reaches done", async () => {
      const dependentA = createMockTask({ id: "FN-3799", column: "todo", blockedBy: "FN-3885" });
      const dependentB = createMockTask({ id: "FN-3811", column: "todo", blockedBy: "FN-3885" });
      const blocker = createMockTask({ id: "FN-3885", column: "done" });
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([dependentA, dependentB]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
      });

      new Scheduler(store);
      const movedHandler = (store.on as any).mock.calls.find((call: any) => call[0] === "task:moved")?.[1];
      await movedHandler({ task: blocker, from: "in-review", to: "done" });

      expect(store.updateTask).toHaveBeenCalledWith("FN-3799", { blockedBy: null, status: null });
      expect(store.updateTask).toHaveBeenCalledWith("FN-3811", { blockedBy: null, status: null });
    });

    it("FN-3908: unblocks queued multi-dependency task when moved blocker archives and remaining deps are satisfied", async () => {
      const dependent = createMockTask({
        id: "FN-3170",
        column: "todo",
        status: "queued",
        blockedBy: undefined,
        dependencies: ["FN-3168", "FN-3169"],
      });
      const blockerA = createMockTask({ id: "FN-3168", column: "archived" });
      const blockerB = createMockTask({ id: "FN-3169", column: "done" });
      const allTasks = [dependent, blockerA, blockerB];
      const store = createMockStore({
        listTasks: vi.fn(async (options?: { column?: string }) =>
          options?.column === "todo" ? [dependent] : allTasks,
        ),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
      });

      new Scheduler(store);
      const movedHandler = (store.on as any).mock.calls.find((call: any) => call[0] === "task:moved")?.[1];
      await movedHandler({ task: blockerA, from: "in-review", to: "archived" });

      expect(store.updateTask).toHaveBeenCalledWith("FN-3170", { blockedBy: null, status: null });
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-3170",
        "Auto-unblocked: blocker FN-3168 reached archived — all dependencies satisfied",
      );
    });

    it("FN-3908: repoints blockedBy when moved blocker is done but another dependency remains unresolved", async () => {
      const dependent = createMockTask({
        id: "FN-3170",
        column: "todo",
        status: "queued",
        blockedBy: "FN-3168",
        dependencies: ["FN-3168", "FN-3169"],
      });
      const blockerA = createMockTask({ id: "FN-3168", column: "done" });
      const blockerB = createMockTask({ id: "FN-3169", column: "in-progress" });
      const allTasks = [dependent, blockerA, blockerB];
      const store = createMockStore({
        listTasks: vi.fn(async (options?: { column?: string }) =>
          options?.column === "todo" ? [dependent] : allTasks,
        ),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
      });

      new Scheduler(store);
      const movedHandler = (store.on as any).mock.calls.find((call: any) => call[0] === "task:moved")?.[1];
      await movedHandler({ task: blockerA, from: "in-progress", to: "done" });

      expect(store.updateTask).toHaveBeenCalledWith("FN-3170", { status: "queued", blockedBy: "FN-3169" });
      expect(store.updateTask).not.toHaveBeenCalledWith("FN-3170", { blockedBy: null, status: null });
    });

    it.each([
      { globalPause: true, enginePaused: false },
      { globalPause: false, enginePaused: true },
    ])("FN-3908: skips event-driven dependency reconciliation when pauses are active", async (settings) => {
      const dependent = createMockTask({
        id: "FN-3170",
        column: "todo",
        status: "queued",
        blockedBy: undefined,
        dependencies: ["FN-3168"],
      });
      const blocker = createMockTask({ id: "FN-3168", column: "archived" });
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([dependent, blocker]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, ...settings }),
      });

      new Scheduler(store);
      const movedHandler = (store.on as any).mock.calls.find((call: any) => call[0] === "task:moved")?.[1];
      await movedHandler({ task: blocker, from: "in-review", to: "archived" });

      expect(store.updateTask).not.toHaveBeenCalledWith("FN-3170", { blockedBy: null, status: null });
    });

    it("FN-3924: does not repoint cleared dependency blocker to unrelated overlap task", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const dep = createMockTask({ id: "FN-DEP", column: "done" });
      const unrelated = createMockTask({
        id: "FN-3170",
        column: "in-review",
        worktree: "/test/project/.worktrees/fn-3170",
      });
      const dependent = createMockTask({
        id: "FN-3919",
        column: "todo",
        status: "queued",
        blockedBy: "FN-DEP",
        dependencies: ["FN-DEP"],
      });
      const tasks = [dep, unrelated, dependent];

      const listTasks = vi.fn(async (options?: { column?: string; includeArchived?: boolean }) => {
        if (options?.column === "todo") {
          return tasks.filter((task) => task.column === "todo");
        }
        return tasks;
      });

      const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
        const task = tasks.find((candidate) => candidate.id === id);
        if (task) Object.assign(task, patch);
        return (task ?? createMockTask({ id })) as Task;
      });

      const store = createMockStore({
        listTasks,
        getTask: vi.fn(async (id: string) => (tasks.find((task) => task.id === id) ?? createMockTask({ id })) as any),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          groupOverlappingFiles: true,
        }),
        parseFileScopeFromPrompt: vi.fn(async (taskId: string): Promise<string[]> => {
          if (taskId === "FN-3170") return ["packages/dashboard/app/App.tsx"];
          if (taskId === "FN-3919") return ["packages/dashboard/app/App.tsx"];
          return ["packages/core/src/index.ts"];
        }),
        updateTask,
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      const movedHandler = (store.on as any).mock.calls.find((call: any) => call[0] === "task:moved")?.[1];
      await movedHandler({ task: dep, from: "in-progress", to: "done" });

      expect(updateTask).toHaveBeenCalledWith("FN-3919", { blockedBy: null, status: null });

      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(updateTask).not.toHaveBeenCalledWith("FN-3919", { status: "queued", blockedBy: "FN-3170" });
      expect(tasks.find((task) => task.id === "FN-3919")?.blockedBy ?? null).toBeNull();
    });

    it("does not trigger scheduling for non-done task:moved events", async () => {
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([
          createMockTask({ id: "FN-001", column: "todo", dependencies: [] }),
        ]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      scheduler.start();

      // Clear previous calls
      (store.moveTask as any).mockClear();

      // Find and call the task:moved handler
      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      // Simulate task:moved to in-progress (not done)
      const task = createMockTask({ id: "FN-001", column: "in-progress" });
      await movedHandler({ task, from: "todo", to: "in-progress" });

      // Should NOT have triggered additional scheduling (no new task moved to in-progress)
      // Note: The existing handler runs, but it doesn't call schedule() for non-done transitions
      // So moveTask won't be called for a task already in in-progress
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("triggers scheduling when task moves to todo (retry)", async () => {
      // Mock filesystem validation so schedule() can proceed
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      // Return FN-001 in todo with satisfied deps
      const listTasksMock = vi.fn()
        .mockResolvedValueOnce([]) // Initial schedule from start()
        .mockResolvedValueOnce([
          createMockTask({ id: "FN-001", column: "todo", dependencies: [] }),
        ]);

      const store = createMockStore({
        listTasks: listTasksMock,
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      scheduler.start();

      // Wait for initial schedule pass to complete
      await flushAsyncWork();

      // Find and call the task:moved handler
      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];
      expect(movedHandler).toBeDefined();

      // Simulate task:moved to todo (retry scenario)
      const todoTask = createMockTask({ id: "FN-001", column: "in-progress" });
      await movedHandler({ task: todoTask, from: "in-progress", to: "todo" });

      // Wait for async schedule to complete
      await flushAsyncWork();

      // Verify schedule() was called — task in todo should be scheduled
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });
  });

  describe("task unpause scheduling", () => {
    it("triggers scheduling immediately when a paused todo task is unpaused", async () => {
      // Mock filesystem validation so schedule() can proceed
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const listTasksMock = vi.fn()
        .mockResolvedValueOnce([]) // Initial schedule from start()
        .mockResolvedValueOnce([
          createMockTask({ id: "FN-001", column: "todo", dependencies: [] }),
        ]);

      const store = createMockStore({
        listTasks: listTasksMock,
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      scheduler.start();

      // Wait for initial schedule pass to complete
      await flushAsyncWork();

      // Find the task:updated handler
      const onCalls = (store.on as any).mock.calls;
      const updatedHandler = onCalls.find((call: any) => call[0] === "task:updated")?.[1];
      expect(updatedHandler).toBeDefined();

      // First, simulate pause event (to register the task as paused)
      await updatedHandler(createMockTask({ id: "FN-001", column: "todo", paused: true }));

      // Now simulate unpause event
      await updatedHandler(createMockTask({ id: "FN-001", column: "todo", paused: undefined }));

      // Wait for async scheduling to complete
      await flushAsyncWork();

      // Should have triggered scheduling and moved the task to in-progress
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });

    it("does not trigger scheduling on unpause if scheduler is not running", async () => {
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
      });

      const scheduler = new Scheduler(store);
      // Don't start the scheduler

      const onCalls = (store.on as any).mock.calls;
      const updatedHandler = onCalls.find((call: any) => call[0] === "task:updated")?.[1];

      // Pause then unpause
      await updatedHandler(createMockTask({ id: "FN-001", column: "todo", paused: true }));
      await updatedHandler(createMockTask({ id: "FN-001", column: "todo", paused: undefined }));

      // Should NOT have moved any tasks
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("does not trigger scheduling for tasks that were never paused", async () => {
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([
          createMockTask({ id: "FN-001", column: "todo", dependencies: [] }),
        ]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      scheduler.start();
      await flushAsyncWork();

      // Clear calls from initial schedule
      (store.moveTask as any).mockClear();

      const onCalls = (store.on as any).mock.calls;
      const updatedHandler = onCalls.find((call: any) => call[0] === "task:updated")?.[1];

      // Fire task:updated for a task that was never paused — should NOT trigger extra scheduling
      await updatedHandler(createMockTask({ id: "FN-001", column: "todo", paused: undefined }));

      await flushAsyncWork();

      // moveTask should not be called (no scheduling triggered)
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("does not trigger scheduling on unpause for in-progress tasks", async () => {
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      scheduler.start();
      await flushAsyncWork();

      (store.moveTask as any).mockClear();

      const onCalls = (store.on as any).mock.calls;
      const updatedHandler = onCalls.find((call: any) => call[0] === "task:updated")?.[1];

      // Pause then unpause an in-progress task — executor handles this, not scheduler
      await updatedHandler(createMockTask({ id: "FN-001", column: "in-progress", paused: true }));
      await updatedHandler(createMockTask({ id: "FN-001", column: "in-progress", paused: undefined }));

      await flushAsyncWork();

      // Scheduler should NOT try to schedule an in-progress task
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("triggers scheduling for unpaused triage tasks", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const scheduleSpy = vi.spyOn(Scheduler.prototype, "schedule");

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
      });

      const scheduler = new Scheduler(store);
      scheduler.start();
      await flushAsyncWork();

      // Clear calls from initial start() schedule
      scheduleSpy.mockClear();

      const onCalls = (store.on as any).mock.calls;
      const updatedHandler = onCalls.find((call: any) => call[0] === "task:updated")?.[1];

      // Pause then unpause a triage task
      await updatedHandler(createMockTask({ id: "FN-001", column: "triage", paused: true }));
      await updatedHandler(createMockTask({ id: "FN-001", column: "triage", paused: undefined }));

      // schedule() should have been triggered by the unpause
      expect(scheduleSpy).toHaveBeenCalled();

      scheduleSpy.mockRestore();
    });
  });

  describe("start/stop", () => {
    it("starts and stops the scheduler", () => {
      const store = createMockStore();
      const scheduler = new Scheduler(store);
      
      scheduler.start();
      // Should set up polling interval
      
      scheduler.stop();
      // Should clear polling interval
    });
  });

  describe("schedule() concurrency limits", () => {
    it("respects maxConcurrent limit", async () => {
      const tasks = [
        createMockTask({ id: "FN-001", column: "in-progress" }),
        createMockTask({ id: "FN-002", column: "in-progress" }),
        createMockTask({ id: "FN-003", column: "todo" }),
        createMockTask({ id: "FN-004", column: "todo" }),
      ];
      
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      scheduler.start();
      await scheduler.schedule();

      // With 2 already in-progress and maxConcurrent=2, no new tasks should start
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("respects maxWorktrees limit", async () => {
      const tasks = [
        createMockTask({ id: "FN-001", column: "in-progress" }),
        createMockTask({ id: "FN-002", column: "in-progress" }),
        createMockTask({ id: "FN-003", column: "in-progress" }),
        createMockTask({ id: "FN-004", column: "in-progress" }),
        createMockTask({ id: "FN-005", column: "todo" }),
      ];
      
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 10, maxWorktrees: 4 }),
      });

      const scheduler = new Scheduler(store);
      scheduler.start();
      await scheduler.schedule();

      // With 4 in-progress and maxWorktrees=4, no new tasks should start
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("FN-3908: logs queued concurrency reason once per unchanged state", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-001", column: "todo", dependencies: [] }),
        createMockTask({ id: "FN-002", column: "todo", dependencies: [] }),
      ];

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 1, maxWorktrees: 4 }),
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();
      await scheduler.schedule();

      const concurrencyReasonCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "FN-002" && String(call[1]).includes("queued — concurrency limit reached"),
      );
      expect(concurrencyReasonCalls).toHaveLength(1);
    });
  });

  describe("FN-5008: concurrency-gate attribution", () => {
    it("logs maxConcurrent as the sole binding gate", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-A", column: "in-progress" }),
        createMockTask({ id: "FN-B", column: "todo", dependencies: [] }),
        createMockTask({ id: "FN-C", column: "todo", dependencies: [] }),
      ];
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      const call = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === "FN-C");
      expect(String(call?.[1])).toContain("gate=maxConcurrent");
      expect(String(call?.[1])).toContain("maxConcurrent used=1/2");
      expect(String(call?.[1])).toContain("holders: FN-A");
    });

    it("logs maxWorktrees as the sole binding gate", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-A", column: "in-progress" }),
        createMockTask({ id: "FN-B", column: "in-progress" }),
        createMockTask({ id: "FN-C", column: "todo", dependencies: [] }),
        createMockTask({ id: "FN-D", column: "todo", dependencies: [] }),
      ];
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 10, maxWorktrees: 3 }),
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      const call = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === "FN-D");
      expect(String(call?.[1])).toContain("gate=maxWorktrees");
      expect(String(call?.[1])).toContain("maxWorktrees used=2/3");
      expect(String(call?.[1])).toContain("holders: FN-A, FN-B");
    });

    it("logs semaphore as the sole binding gate", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const semaphore = new AgentSemaphore(1);
      const tasks = [
        createMockTask({ id: "FN-A", column: "todo", dependencies: [] }),
        createMockTask({ id: "FN-B", column: "todo", dependencies: [] }),
      ];
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 10, maxWorktrees: 10 }),
      });

      const scheduler = new Scheduler(store, { semaphore });
      (scheduler as any).running = true;
      await scheduler.schedule();

      const call = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === "FN-B");
      expect(String(call?.[1])).toContain("gate=semaphore");
      expect(String(call?.[1])).toContain("semaphore used=0/1");
      expect(String(call?.[1])).toContain("semaphore slots may include triage/merge agents outside in-progress");
    });

    it("lists tied binding gates in stable order", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const semaphore = new AgentSemaphore(2);
      const tasks = [
        createMockTask({ id: "FN-A", column: "in-progress" }),
        createMockTask({ id: "FN-B", column: "todo", dependencies: [] }),
        createMockTask({ id: "FN-C", column: "todo", dependencies: [] }),
      ];
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 2 }),
      });

      const scheduler = new Scheduler(store, { semaphore });
      (scheduler as any).running = true;
      await scheduler.schedule();

      const call = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === "FN-C");
      expect(String(call?.[1])).toContain("gate=maxConcurrent, maxWorktrees");
    });

    it("dedupes unchanged queued-concurrency logs and audit events", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-A", column: "in-progress" }),
        createMockTask({ id: "FN-B", column: "todo", dependencies: [] }),
        createMockTask({ id: "FN-C", column: "todo", dependencies: [] }),
      ];
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();
      await scheduler.schedule();

      const concurrencyReasonCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "FN-C" && String(call[1]).includes("queued — concurrency limit reached"),
      );
      expect(concurrencyReasonCalls).toHaveLength(1);

      const auditCalls = (store.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as { mutationType?: string } | undefined)?.mutationType === "scheduler:dispatch-queued-concurrency",
      );
      expect(auditCalls).toHaveLength(1);
      expect(auditCalls[0]?.[0]?.metadata?.bindingGates).toEqual(["maxConcurrent"]);
    });

    it("dedupes queued-concurrency logs when only non-binding semaphore counts change", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const semaphore = new AgentSemaphore(40);
      const tasks = [
        createMockTask({ id: "FN-A", column: "in-progress" }),
        createMockTask({ id: "FN-B", column: "in-progress" }),
        createMockTask({ id: "FN-C", column: "todo", dependencies: [] }),
        createMockTask({ id: "FN-D", column: "todo", dependencies: [] }),
      ];
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 15, maxWorktrees: 3 }),
      });

      const scheduler = new Scheduler(store, { semaphore });
      (scheduler as any).running = true;

      await semaphore.acquire();
      await semaphore.acquire();
      await scheduler.schedule();
      semaphore.release();
      semaphore.release();
      await scheduler.schedule();

      const concurrencyReasonCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "FN-D" && String(call[1]).includes("queued — concurrency limit reached"),
      );
      expect(concurrencyReasonCalls).toHaveLength(1);

      const auditCalls = (store.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as { mutationType?: string } | undefined)?.mutationType === "scheduler:dispatch-queued-concurrency",
      );
      expect(auditCalls).toHaveLength(1);
      expect(auditCalls[0]?.[0]?.metadata?.bindingGates).toEqual(["maxWorktrees"]);
    });

    it("dedupes queued-concurrency logs across used/limit churn on the same binding gate", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      let semaphoreLimit = 2;
      const semaphore = new AgentSemaphore(() => semaphoreLimit);
      const tasks = [
        createMockTask({ id: "FN-A", column: "in-progress" }),
        createMockTask({ id: "FN-B", column: "todo", dependencies: [] }),
        createMockTask({ id: "FN-C", column: "todo", dependencies: [] }),
      ];
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 10, maxWorktrees: 10 }),
      });

      const scheduler = new Scheduler(store, { semaphore });
      (scheduler as any).running = true;

      await semaphore.acquire();
      await scheduler.schedule();
      semaphoreLimit = 3;
      await semaphore.acquire();
      await scheduler.schedule();

      const concurrencyReasonCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "FN-C" && String(call[1]).includes("queued — concurrency limit reached"),
      );
      expect(concurrencyReasonCalls).toHaveLength(1);
      expect(String(concurrencyReasonCalls[0]?.[1])).toContain("semaphore used=1/2");

      const auditCalls = (store.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as { mutationType?: string } | undefined)?.mutationType === "scheduler:dispatch-queued-concurrency",
      );
      expect(auditCalls).toHaveLength(1);
      expect(auditCalls[0]?.[0]?.metadata?.bindingGates).toEqual(["semaphore"]);
      expect(auditCalls[0]?.[0]?.metadata?.semaphore).toEqual({ used: 1, limit: 2, slack: 1 });
    });

    it("re-logs and re-audits when binding holder identity changes", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const firstPass = [
        createMockTask({ id: "FN-A", column: "in-progress" }),
        createMockTask({ id: "FN-C", column: "todo", dependencies: [] }),
        createMockTask({ id: "FN-D", column: "todo", dependencies: [] }),
      ];
      const secondPass = [
        createMockTask({ id: "FN-B", column: "in-progress" }),
        createMockTask({ id: "FN-C", column: "todo", dependencies: [] }),
        createMockTask({ id: "FN-D", column: "todo", dependencies: [] }),
      ];

      let phase = 1;
      const store = createMockStore({
        listTasks: vi.fn().mockImplementation(async () => (phase === 1 ? firstPass : secondPass)),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 10, maxWorktrees: 2 }),
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();
      phase = 2;
      await scheduler.schedule();

      const concurrencyReasonCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[0] === "FN-D" && String(call[1]).includes("queued — concurrency limit reached"),
      );
      expect(concurrencyReasonCalls).toHaveLength(2);

      const auditCalls = (store.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as { mutationType?: string } | undefined)?.mutationType === "scheduler:dispatch-queued-concurrency",
      );
      expect(auditCalls).toHaveLength(2);
      expect(auditCalls[0]?.[0]?.metadata?.bindingGates).toEqual(["maxWorktrees"]);
      expect(auditCalls[1]?.[0]?.metadata?.bindingGates).toEqual(["maxWorktrees"]);
      expect(auditCalls[0]?.[0]?.metadata?.holders?.maxWorktrees).toEqual(["FN-A"]);
      expect(auditCalls[1]?.[0]?.metadata?.holders?.maxWorktrees).toEqual(["FN-B"]);
    });

    it("re-logs and re-audits when binding gate changes", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const firstPass = [
        createMockTask({ id: "FN-A", column: "in-progress" }),
        createMockTask({ id: "FN-B", column: "todo", dependencies: [] }),
        createMockTask({ id: "FN-C", column: "todo", dependencies: [] }),
      ];
      const secondPass = [
        createMockTask({ id: "FN-A", column: "in-progress" }),
        createMockTask({ id: "FN-B", column: "in-progress" }),
        createMockTask({ id: "FN-C", column: "todo", dependencies: [] }),
        createMockTask({ id: "FN-E", column: "todo", dependencies: [] }),
      ];

      let phase = 1;
      const listTasks = vi.fn().mockImplementation(async () => (phase === 1 ? firstPass : secondPass));
      const getSettings = vi
        .fn()
        .mockImplementation(async () => (phase === 1 ? { maxConcurrent: 2, maxWorktrees: 4 } : { maxConcurrent: 10, maxWorktrees: 3 }));

      const store = createMockStore({ listTasks, getSettings });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();
      phase = 2;
      await scheduler.schedule();

      const concurrencyReasonCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => String(call[1]).includes("queued — concurrency limit reached"),
      );
      expect(concurrencyReasonCalls).toHaveLength(2);
      expect(String(concurrencyReasonCalls[0]?.[1])).toContain("gate=maxConcurrent");
      expect(String(concurrencyReasonCalls[1]?.[1])).toContain("gate=maxWorktrees");

      const auditCalls = (store.recordRunAuditEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[0] as { mutationType?: string } | undefined)?.mutationType === "scheduler:dispatch-queued-concurrency",
      );
      expect(auditCalls).toHaveLength(2);
      expect(auditCalls[0]?.[0]?.metadata?.bindingGates).toEqual(["maxConcurrent"]);
      expect(auditCalls[1]?.[0]?.metadata?.bindingGates).toEqual(["maxWorktrees"]);
    });

    it("formats queued-concurrency memo keys from binding gates and holder identity only", () => {
      const key = formatConcurrencyLimitMemoKey({
        available: 0,
        bindingGates: ["maxConcurrent", "maxWorktrees"],
        maxConcurrentGate: { used: 1, limit: 2, slack: 1 },
        maxWorktreesGate: { used: 9, limit: 10, slack: 1 },
        semaphoreGate: { used: 7, limit: 8, slack: 1 },
        holders: {
          maxConcurrent: ["FN-B", "FN-A"],
          maxWorktrees: ["FN-A", "FN-B", "FN-A"],
          semaphore: ["FN-Z"],
        },
      });

      expect(key).toBe("queued-concurrency:maxConcurrent,maxWorktrees:holders=FN-A,FN-B");
      expect(key).not.toMatch(/used=|limit=|available=|\d+\/\d+/);
      expect(key).not.toContain("FN-Z");
    });
  });

  describe("priority-aware todo dispatch", () => {
    it("schedules eligible todo tasks by priority desc then createdAt asc", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-010", column: "todo", priority: "normal", createdAt: "2026-01-01T00:02:00.000Z" }),
        createMockTask({ id: "FN-011", column: "todo", priority: "urgent", createdAt: "2026-01-01T00:10:00.000Z" }),
        createMockTask({ id: "FN-012", column: "todo", priority: "high", createdAt: "2026-01-01T00:03:00.000Z" }),
        createMockTask({ id: "FN-013", column: "todo", priority: "high", createdAt: "2026-01-01T00:01:00.000Z" }),
      ];

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 10,
          maxWorktrees: 10,
          groupOverlappingFiles: false,
        }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect((store.moveTask as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => call[0])).toEqual([
        "FN-011",
        "FN-013",
        "FN-012",
        "FN-010",
      ]);
    });

    it("keeps blocked high-priority todo tasks unscheduled while scheduling ready lower-priority work", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const future = new Date(Date.now() + 60_000).toISOString();
      const tasks = [
        createMockTask({ id: "FN-001", column: "in-progress" }),
        createMockTask({ id: "FN-100", column: "todo", priority: "urgent", dependencies: ["FN-900"] }),
        createMockTask({ id: "FN-900", column: "todo", priority: "low" }),
        createMockTask({ id: "FN-101", column: "todo", priority: "urgent", paused: true }),
        createMockTask({ id: "FN-102", column: "todo", priority: "urgent", nextRecoveryAt: future }),
        createMockTask({ id: "FN-103", column: "todo", priority: "urgent" }),
        createMockTask({ id: "FN-104", column: "todo", priority: "normal" }),
      ];

      const parseScopeMock = vi.fn(async (taskId: string): Promise<string[]> => {
        if (taskId === "FN-001" || taskId === "FN-103") {
          return ["packages/engine/src/scheduler.ts"];
        }
        if (taskId === "FN-900") {
          return ["packages/core/src/store.ts"];
        }
        if (taskId === "FN-104") {
          return ["packages/engine/src/triage.ts"];
        }
        return ["packages/engine/src/logger.ts"];
      });

      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 10,
          maxWorktrees: 10,
          groupOverlappingFiles: true,
        }),
        parseFileScopeFromPrompt: parseScopeMock,
        updateTask,
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      // Dependency-blocked urgent task should be queued, not started.
      expect(updateTask).toHaveBeenCalledWith("FN-100", { status: "queued", blockedBy: "FN-900" });
      // Overlap-blocked urgent task should be queued with blocker id.
      expect(updateTask).toHaveBeenCalledWith("FN-103", { status: "queued", blockedBy: null, overlapBlockedBy: "FN-001" });
      // Paused and recovery-gated urgent tasks never enter scheduling.
      expect(moveTask).not.toHaveBeenCalledWith("FN-101", "in-progress");
      expect(moveTask).not.toHaveBeenCalledWith("FN-102", "in-progress");

      // Lower-priority ready task still runs.
      expect(moveTask).toHaveBeenCalledWith("FN-104", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
      // Overlap-blocked urgent task must not run.
      expect(moveTask).not.toHaveBeenCalledWith("FN-103", "in-progress");
    });
  });

  describe("FN-4969 dependency-unblock prioritization", () => {
    it("promotes higher-fanout todo task over older same-priority tasks", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-010", column: "todo", priority: "normal", createdAt: "2026-01-01T00:02:00.000Z" }),
        createMockTask({ id: "FN-011", column: "todo", priority: "normal", createdAt: "2026-01-01T00:01:00.000Z" }),
        createMockTask({ id: "FN-012", column: "todo", priority: "normal", createdAt: "2026-01-01T00:03:00.000Z" }),
        createMockTask({ id: "FN-101", column: "todo", dependencies: ["FN-010"] }),
        createMockTask({ id: "FN-102", column: "todo", dependencies: ["FN-010"] }),
        createMockTask({ id: "FN-103", column: "todo", dependencies: ["FN-010"] }),
      ];

      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 1, maxWorktrees: 10, groupOverlappingFiles: false }),
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(moveTask.mock.calls[0][0]).toBe("FN-010");
    });

    it("keeps urgent tasks ahead of lower-priority high-fanout tasks", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-020", column: "todo", priority: "urgent", createdAt: "2026-01-01T00:02:00.000Z" }),
        createMockTask({ id: "FN-021", column: "todo", priority: "normal", createdAt: "2026-01-01T00:01:00.000Z" }),
        createMockTask({ id: "FN-201", column: "todo", dependencies: ["FN-021"] }),
        createMockTask({ id: "FN-202", column: "todo", dependencies: ["FN-021"] }),
        createMockTask({ id: "FN-203", column: "todo", dependencies: ["FN-021"] }),
        createMockTask({ id: "FN-204", column: "todo", dependencies: ["FN-021"] }),
        createMockTask({ id: "FN-205", column: "todo", dependencies: ["FN-021"] }),
      ];

      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 1, maxWorktrees: 10, groupOverlappingFiles: false }),
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(moveTask.mock.calls[0][0]).toBe("FN-020");
    });

    it("falls back to age then numeric id when fanout ties", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-029", column: "todo", priority: "normal", createdAt: "2026-01-01T00:01:00.000Z" }),
        createMockTask({ id: "FN-028", column: "todo", priority: "normal", createdAt: "2026-01-01T00:01:00.000Z" }),
        createMockTask({ id: "FN-027", column: "todo", priority: "normal", createdAt: "2026-01-01T00:00:00.000Z" }),
        createMockTask({ id: "FN-301", column: "todo", dependencies: ["FN-028"] }),
        createMockTask({ id: "FN-302", column: "todo", dependencies: ["FN-029"] }),
        createMockTask({ id: "FN-303", column: "todo", dependencies: ["FN-027"] }),
      ];

      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 3, maxWorktrees: 10, groupOverlappingFiles: false }),
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(moveTask.mock.calls.slice(0, 3).map((call: unknown[]) => call[0])).toEqual(["FN-027", "FN-028", "FN-029"]);
    });

    it("does not count done/archived dependents toward unblock priority", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-040", column: "todo", priority: "normal", createdAt: "2026-01-01T00:00:00.000Z" }),
        createMockTask({ id: "FN-041", column: "todo", priority: "normal", createdAt: "2026-01-01T00:01:00.000Z" }),
        createMockTask({ id: "FN-401", column: "done", dependencies: ["FN-040"] }),
        createMockTask({ id: "FN-402", column: "archived", dependencies: ["FN-040"] }),
      ];

      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 10, groupOverlappingFiles: false }),
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(moveTask.mock.calls.slice(0, 2).map((call: unknown[]) => call[0])).toEqual(["FN-040", "FN-041"]);
    });
  });

  describe("overlap ignore paths", () => {
    it("allows scheduling when overlap is only on ignored files", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-001", column: "in-progress" }),
        createMockTask({ id: "FN-002", column: "todo" }),
      ];

      const parseScopeMock = vi.fn(async (taskId: string): Promise<string[]> => {
        if (taskId === "FN-001") return ["docs/README.md"];
        if (taskId === "FN-002") return ["docs/README.md"];
        return [];
      });

      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          groupOverlappingFiles: true,
          overlapIgnorePaths: ["docs/README.md"],
        }),
        parseFileScopeFromPrompt: parseScopeMock,
        updateTask,
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(moveTask).toHaveBeenCalledWith("FN-002", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
      expect(updateTask).not.toHaveBeenCalledWith("FN-002", { status: "queued", blockedBy: "FN-001" });
    });

    it("allows scheduling when overlap is only within ignored directories", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-001", column: "in-review", worktree: "/test/project/.worktrees/fn-001" }),
        createMockTask({ id: "FN-002", column: "todo" }),
      ];

      const parseScopeMock = vi.fn(async (taskId: string): Promise<string[]> => {
        if (taskId === "FN-001") return ["docs/guide.md"];
        if (taskId === "FN-002") return ["docs/reference.md"];
        return [];
      });

      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          groupOverlappingFiles: true,
          overlapIgnorePaths: ["docs/"],
        }),
        parseFileScopeFromPrompt: parseScopeMock,
        updateTask,
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(moveTask).toHaveBeenCalledWith("FN-002", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
      expect(updateTask).not.toHaveBeenCalledWith("FN-002", { status: "queued", blockedBy: "FN-001" });
    });

    it("excludes paused in-review tasks from active scopes", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-001", column: "in-review", paused: true, worktree: "/test/project/.worktrees/fn-001" }),
        createMockTask({ id: "FN-002", column: "todo" }),
      ];

      const parseScopeMock = vi.fn(async (taskId: string): Promise<string[]> => {
        if (taskId === "FN-001") return ["src/foo.ts"];
        if (taskId === "FN-002") return ["src/foo.ts"];
        return [];
      });

      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          groupOverlappingFiles: true,
        }),
        parseFileScopeFromPrompt: parseScopeMock,
        updateTask,
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(moveTask).toHaveBeenCalledWith("FN-002", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
      expect(updateTask).not.toHaveBeenCalledWith("FN-002", { status: "queued", blockedBy: "FN-001" });
    });

    it("excludes permanently-failed in-review tasks from active scopes", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-001", column: "in-review", status: "failed", worktree: "/test/project/.worktrees/fn-001" }),
        createMockTask({ id: "FN-002", column: "todo" }),
      ];

      const parseScopeMock = vi.fn(async (taskId: string): Promise<string[]> => {
        if (taskId === "FN-001") return ["src/foo.ts"];
        if (taskId === "FN-002") return ["src/foo.ts"];
        return [];
      });

      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          groupOverlappingFiles: true,
        }),
        parseFileScopeFromPrompt: parseScopeMock,
        updateTask,
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(moveTask).toHaveBeenCalledWith("FN-002", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
      expect(updateTask).not.toHaveBeenCalledWith("FN-002", { status: "queued", blockedBy: "FN-001" });
    });

    it("clears stale blockedBy when prior overlap blocker is now permanently failed", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-FAIL", column: "in-review", status: "failed", worktree: "/test/project/.worktrees/fn-fail" }),
        createMockTask({ id: "FN-002", column: "todo", status: "queued", blockedBy: "FN-FAIL" }),
      ];

      const parseScopeMock = vi.fn(async (taskId: string): Promise<string[]> => {
        if (taskId === "FN-FAIL") return ["src/foo.ts"];
        if (taskId === "FN-002") return ["src/foo.ts"];
        return [];
      });

      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          groupOverlappingFiles: true,
        }),
        parseFileScopeFromPrompt: parseScopeMock,
        updateTask,
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(moveTask).toHaveBeenCalledWith("FN-002", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
      expect(updateTask).not.toHaveBeenCalledWith("FN-002", { status: "queued", blockedBy: "FN-FAIL" });
    });

    it("still blocks todo when overlapping in-review task is not paused and not failed", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-001", column: "in-review", worktree: "/test/project/.worktrees/fn-001" }),
        createMockTask({ id: "FN-002", column: "todo" }),
      ];

      const parseScopeMock = vi.fn(async (taskId: string): Promise<string[]> => {
        if (taskId === "FN-001") return ["src/foo.ts"];
        if (taskId === "FN-002") return ["src/foo.ts"];
        return [];
      });

      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          groupOverlappingFiles: true,
        }),
        parseFileScopeFromPrompt: parseScopeMock,
        updateTask,
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(updateTask).toHaveBeenCalledWith("FN-002", { status: "queued", blockedBy: null, overlapBlockedBy: "FN-001" });
      expect(moveTask).not.toHaveBeenCalledWith("FN-002", "in-progress");
    });

    it("still blocks overlap for non-ignored paths", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-001", column: "in-progress" }),
        createMockTask({ id: "FN-002", column: "todo" }),
      ];

      const parseScopeMock = vi.fn(async (taskId: string): Promise<string[]> => {
        if (taskId === "FN-001") return ["src/scheduler.ts"];
        if (taskId === "FN-002") return ["src/scheduler.ts"];
        return [];
      });

      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          groupOverlappingFiles: true,
          overlapIgnorePaths: ["docs/"],
        }),
        parseFileScopeFromPrompt: parseScopeMock,
        updateTask,
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(updateTask).toHaveBeenCalledWith("FN-002", { status: "queued", blockedBy: null, overlapBlockedBy: "FN-001" });
      expect(moveTask).not.toHaveBeenCalledWith("FN-002", "in-progress");
    });
  });

  describe("FN-4538 overlap blocker persistence", () => {
    it("FN-4538: overlap-blocked todo task with satisfied deps preserves overlapBlockedBy", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-DEP", column: "done" }),
        createMockTask({ id: "FN-OVER", column: "in-progress" }),
        createMockTask({ id: "FN-T", column: "todo", dependencies: ["FN-DEP"] }),
      ];

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, groupOverlappingFiles: true }),
        parseFileScopeFromPrompt: vi.fn(async (taskId: string) => {
          if (taskId === "FN-OVER" || taskId === "FN-T") return ["packages/core/src/store.ts"];
          return ["packages/core/src/types.ts"];
        }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(store.updateTask).toHaveBeenCalledWith("FN-T", {
        status: "queued",
        blockedBy: null,
        overlapBlockedBy: "FN-OVER",
      });
    });

    it("FN-4538: overlapBlockedBy cleared when overlap resolves", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-DEP", column: "done" }),
        createMockTask({ id: "FN-T", column: "todo", dependencies: ["FN-DEP"], status: "queued", overlapBlockedBy: "FN-OVER" }),
      ];

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, groupOverlappingFiles: true }),
        parseFileScopeFromPrompt: vi.fn(async () => ["packages/core/src/types.ts"]),
        updateTask: vi.fn().mockResolvedValue(undefined),
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(store.updateTask).toHaveBeenCalledWith("FN-T", { overlapBlockedBy: null });
    });
  });

  describe("blockedBy stability — FN-3899", () => {
    it("preserves a still-valid queued blocker instead of repointing to another active task", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-A", column: "in-progress" }),
        createMockTask({ id: "FN-B", column: "in-progress" }),
        createMockTask({ id: "FN-T", column: "todo", status: "queued", blockedBy: "FN-B" }),
      ];

      const parseScopeMock = vi.fn(async (taskId: string): Promise<string[]> => {
        if (taskId === "FN-A") return ["packages/engine/src/merger.ts", "packages/dashboard/app/components/Header.tsx"];
        if (taskId === "FN-B") return ["packages/dashboard/app/App.tsx"];
        if (taskId === "FN-T") return ["packages/dashboard/app/App.tsx"];
        return [];
      });

      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 10,
          maxWorktrees: 10,
          groupOverlappingFiles: true,
        }),
        parseFileScopeFromPrompt: parseScopeMock,
        updateTask,
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(updateTask).not.toHaveBeenCalledWith("FN-T", { status: "queued", blockedBy: "FN-A" });
      expect(moveTask).not.toHaveBeenCalledWith("FN-T", "in-progress", expect.anything());
    });

    it("recomputes stale queued blockers when the recorded blocker is no longer overlapping", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-A", column: "in-progress" }),
        createMockTask({ id: "FN-B", column: "in-progress" }),
        createMockTask({ id: "FN-T", column: "todo", status: "queued", blockedBy: "FN-A" }),
      ];

      const parseScopeMock = vi.fn(async (taskId: string): Promise<string[]> => {
        if (taskId === "FN-A") return ["packages/engine/src/merger.ts"];
        if (taskId === "FN-B") return ["packages/dashboard/app/App.tsx"];
        if (taskId === "FN-T") return ["packages/dashboard/app/App.tsx"];
        return [];
      });

      const updateTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 10,
          maxWorktrees: 10,
          groupOverlappingFiles: true,
        }),
        parseFileScopeFromPrompt: parseScopeMock,
        updateTask,
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(updateTask).toHaveBeenCalledWith("FN-T", { status: "queued", blockedBy: null, overlapBlockedBy: "FN-B" });
    });

    it("does not stamp blockedBy for todos without overlap, including empty scopes", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-A", column: "in-progress" }),
        createMockTask({ id: "FN-T1", column: "todo" }),
        createMockTask({ id: "FN-T2", column: "todo" }),
      ];

      const parseScopeMock = vi.fn(async (taskId: string): Promise<string[]> => {
        if (taskId === "FN-A") return ["packages/engine/src/merger.ts"];
        if (taskId === "FN-T1") return ["packages/dashboard/app/App.tsx"];
        if (taskId === "FN-T2") return [];
        return [];
      });

      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({
          maxConcurrent: 10,
          maxWorktrees: 10,
          groupOverlappingFiles: true,
        }),
        parseFileScopeFromPrompt: parseScopeMock,
        updateTask,
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(updateTask).not.toHaveBeenCalledWith("FN-T1", { status: "queued", blockedBy: "FN-A" });
      expect(updateTask).not.toHaveBeenCalledWith("FN-T2", { status: "queued", blockedBy: "FN-A" });
      expect(moveTask).toHaveBeenCalledWith("FN-T1", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
      expect(moveTask).toHaveBeenCalledWith("FN-T2", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });
  });

  describe("worktree reservation", () => {
    it("assigns a planned worktree path before moving a task to in-progress", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const task = createMockTask({ id: "FN-010", column: "todo" });
      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([task]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4, worktreeNaming: "task-id" }),
        updateTask,
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(updateTask).toHaveBeenCalledWith("FN-010", {
        status: null,
        blockedBy: null,
        executionStartBranch: undefined,
        effectiveNodeId: null,
        effectiveNodeSource: "local",
        mergeRetries: 0,
      });
      expect(moveTask).toHaveBeenCalledWith("FN-010", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
      expect(updateTask.mock.invocationCallOrder[0]).toBeLessThan(moveTask.mock.invocationCallOrder[0]);
    });

    it("reserves unique random worktree names within the same scheduling pass", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const randomSpy = vi.spyOn(Math, "random")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0);

      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([
          createMockTask({ id: "FN-011", column: "todo" }),
          createMockTask({ id: "FN-012", column: "todo" }),
        ]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 4, maxWorktrees: 4, worktreeNaming: "random" }),
        updateTask,
        moveTask,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(updateTask).toHaveBeenNthCalledWith(1, "FN-011", {
        status: null,
        blockedBy: null,
        executionStartBranch: undefined,
        effectiveNodeId: null,
        effectiveNodeSource: "local",
        mergeRetries: 0,
      });
      expect(updateTask).toHaveBeenNthCalledWith(2, "FN-012", {
        status: null,
        blockedBy: null,
        executionStartBranch: undefined,
        effectiveNodeId: null,
        effectiveNodeSource: "local",
        mergeRetries: 0,
      });

      randomSpy.mockRestore();
    });
  });

  describe("semaphore integration", () => {
    it("respects semaphore available count", async () => {
      const semaphore = {
        availableCount: 0,
        totalCount: 2,
        acquire: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(),
      } as unknown as AgentSemaphore;
      
      const tasks = [
        createMockTask({ id: "FN-001", column: "in-progress" }),
        createMockTask({ id: "FN-002", column: "in-progress" }),
        createMockTask({ id: "FN-003", column: "todo" }),
      ];
      
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 10, maxWorktrees: 4 }),
      });

      const scheduler = new Scheduler(store, { semaphore });
      scheduler.start();
      await scheduler.schedule();

      expect(store.moveTask).not.toHaveBeenCalled();
    });
  });

  describe("global pause", () => {
    it("halts scheduling when globalPause is active", async () => {
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([createMockTask({ id: "FN-001", column: "todo" })]),
        getSettings: vi.fn().mockResolvedValue({ 
          maxConcurrent: 2, 
          maxWorktrees: 4,
          globalPause: true,
        }),
      });

      const scheduler = new Scheduler(store);
      scheduler.start();
      await scheduler.schedule();

      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("aborts dispatch when globalPause becomes active mid-pass", async () => {
      const todoTask = createMockTask({ id: "FN-002", column: "todo" });
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");
      const getSettings = vi.fn()
        .mockResolvedValueOnce({
          maxConcurrent: 2,
          maxWorktrees: 4,
          globalPause: false,
          enginePaused: false,
        })
        .mockResolvedValue({
          maxConcurrent: 2,
          maxWorktrees: 4,
          globalPause: true,
          enginePaused: false,
        });
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([todoTask]),
        getTask: vi.fn().mockResolvedValue(todoTask),
        getSettings,
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(store.getTask).toHaveBeenCalledWith("FN-002");
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
    });
  });

  describe("engine pause", () => {
    it("halts new scheduling when enginePaused is active", async () => {
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([createMockTask({ id: "FN-001", column: "todo" })]),
        getSettings: vi.fn().mockResolvedValue({ 
          maxConcurrent: 2, 
          maxWorktrees: 4,
          enginePaused: true,
        }),
      });

      const scheduler = new Scheduler(store);
      scheduler.start();
      await scheduler.schedule();

      expect(store.moveTask).not.toHaveBeenCalled();
    });
  });

  describe("filesystem validation", () => {
    it("validates tasks using the .fusion task directory layout", async () => {
      const todoTask = createMockTask({ id: "FN-010", column: "todo" });
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const updateTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([todoTask]),
        moveTask,
        updateTask,
      });

      vi.mocked(existsSync).mockImplementation((path) => {
        const value = String(path);
        return value.includes(".fusion/tasks/FN-010") || value.includes("PROMPT.md");
      });
      vi.mocked(readFile).mockResolvedValue("# Prompt\n" as any);

      const scheduler = new Scheduler(store);
      scheduler.start();
      await scheduler.schedule();
      
      // Flush any remaining microtasks
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(moveTask).toHaveBeenCalledWith("FN-010", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
      expect(moveTask).not.toHaveBeenCalledWith("FN-010", "triage");
    });

    it("moves task to triage when task directory is missing", async () => {
      const tasks = [
        createMockTask({ id: "FN-001", column: "todo", dependencies: [] }),
      ];
      
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        getRootDir: vi.fn().mockReturnValue("/test/project"),
        getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
      });
      
      // Set up mocks directly on the store
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const logEntry = vi.fn().mockResolvedValue(undefined);
      store.moveTask = moveTask;
      store.logEntry = logEntry;

      // Mock missing directory
      vi.mocked(existsSync).mockReturnValue(false);

      const scheduler = new Scheduler(store);
      scheduler.start();
      await scheduler.schedule();
      
      // Flush any remaining microtasks
      await new Promise(resolve => setTimeout(resolve, 0));

      // Task should be moved to triage
      expect(moveTask).toHaveBeenCalledWith("FN-001", "triage");
      // Log entry should be written with reason
      expect(logEntry).toHaveBeenCalledWith(
        "FN-001",
        "Task moved to triage — filesystem validation failed",
        "missing directory"
      );
      // Task should not be moved to in-progress
      expect(moveTask).not.toHaveBeenCalledWith("FN-001", "in-progress");
    });

    it("moves task to triage when PROMPT.md is missing", async () => {
      const tasks = [
        createMockTask({ id: "FN-002", column: "todo", dependencies: [] }),
      ];
      
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        getRootDir: vi.fn().mockReturnValue("/test/project"),
        getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
      });

      const moveTask = vi.fn().mockResolvedValue(undefined);
      const logEntry = vi.fn().mockResolvedValue(undefined);
      store.moveTask = moveTask;
      store.logEntry = logEntry;

      // Mock directory exists but PROMPT.md doesn't
      vi.mocked(existsSync).mockImplementation((path) => {
        if (typeof path === "string" && path.includes("FN-002") && !path.endsWith("PROMPT.md")) {
          return true; // Directory exists
        }
        return false; // PROMPT.md missing
      });

      const scheduler = new Scheduler(store);
      scheduler.start();
      await scheduler.schedule();
      
      // Flush any remaining microtasks
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(moveTask).toHaveBeenCalledWith("FN-002", "triage");
      expect(logEntry).toHaveBeenCalledWith(
        "FN-002",
        "Task moved to triage — filesystem validation failed",
        "missing or empty PROMPT.md"
      );
    });

    it("moves task to triage when PROMPT.md is empty", async () => {
      const tasks = [
        createMockTask({ id: "FN-003", column: "todo", dependencies: [] }),
      ];
      
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        getRootDir: vi.fn().mockReturnValue("/test/project"),
        getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
      });

      const moveTask = vi.fn().mockResolvedValue(undefined);
      const logEntry = vi.fn().mockResolvedValue(undefined);
      store.moveTask = moveTask;
      store.logEntry = logEntry;

      // Mock directory and PROMPT.md exist
      vi.mocked(existsSync).mockReturnValue(true);
      // Mock empty file content
      vi.mocked(readFile).mockResolvedValue("   "); // whitespace only

      const scheduler = new Scheduler(store);
      scheduler.start();
      await scheduler.schedule();
      
      // Flush any remaining microtasks
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(moveTask).toHaveBeenCalledWith("FN-003", "triage");
      expect(logEntry).toHaveBeenCalledWith(
        "FN-003",
        "Task moved to triage — filesystem validation failed",
        "missing or empty PROMPT.md"
      );
    });

    it("logs warn when PROMPT.md read throws during validation", async () => {
      const store = createMockStore({
        getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
      });
      const scheduler = new Scheduler(store);

      vi.mocked(schedulerLog.warn).mockClear();
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockRejectedValue(new Error("EACCES"));

      const validation = await (scheduler as any).validateTaskFilesystem("FN-READ");

      expect(validation).toEqual({ valid: false, reason: "missing or empty PROMPT.md" });
      expect(schedulerLog.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "PROMPT.md read failed for task dispatch validation (FN-READ): EACCES",
        ),
      );
    });

    it("proceeds with scheduling when filesystem is valid", async () => {
      const tasks = [
        createMockTask({ id: "FN-004", column: "todo", dependencies: [] }),
      ];
      
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        getRootDir: vi.fn().mockReturnValue("/test/project"),
        getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
      });

      const moveTask = vi.fn().mockResolvedValue(undefined);
      const logEntry = vi.fn().mockResolvedValue(undefined);
      store.moveTask = moveTask;
      store.logEntry = logEntry;

      // Mock directory and PROMPT.md exist with valid content
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Valid PROMPT.md content\n\nThis task is valid.");

      const scheduler = new Scheduler(store);
      scheduler.start();
      await scheduler.schedule();
      
      // Flush any remaining microtasks
      await new Promise(resolve => setTimeout(resolve, 0));

      // Should NOT move to triage
      expect(moveTask).not.toHaveBeenCalledWith("FN-004", "triage");
      // Should NOT log validation failure
      expect(logEntry).not.toHaveBeenCalledWith(
        "FN-004",
        "Task moved to triage — filesystem validation failed",
        expect.any(String)
      );
      // Should move to in-progress (since deps are satisfied and concurrency allows)
      expect(moveTask).toHaveBeenCalledWith("FN-004", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });

    it("does not validate filesystem for tasks with unmet dependencies", async () => {
      const tasks = [
        createMockTask({ id: "FN-005", column: "todo", dependencies: ["FN-006"] }),
        createMockTask({ id: "FN-006", column: "todo", dependencies: [] }), // Unsatisfied dep
      ];
      
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        getRootDir: vi.fn().mockReturnValue("/test/project"),
        getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
      });

      const moveTask = vi.fn().mockResolvedValue(undefined);
      const updateTask = vi.fn().mockResolvedValue(undefined);
      store.moveTask = moveTask;
      store.updateTask = updateTask;

      // Mock that directory/PROMPT.md don't exist (would fail validation if checked)
      vi.mocked(existsSync).mockReturnValue(false);

      const scheduler = new Scheduler(store);
      scheduler.start();
      await scheduler.schedule();
      
      // Flush any remaining microtasks
      await new Promise(resolve => setTimeout(resolve, 0));

      // Task with unmet deps should be queued, not validated
      // Since KB-006 is not done, KB-005 should not be validated
      expect(updateTask).toHaveBeenCalledWith("FN-005", { status: "queued", blockedBy: "FN-006" });
      // No filesystem validation should occur (no move to triage)
      expect(moveTask).not.toHaveBeenCalledWith("FN-005", "triage");
    });
  });

  describe("pr monitoring", () => {
    it("hydrates PR monitoring with startup memoized slim reads", async () => {
      const prMonitor = {
        startMonitoring: vi.fn(),
        stopMonitoring: vi.fn(),
        updatePrInfo: vi.fn(),
        getTrackedPrs: vi.fn().mockReturnValue(new Map()),
        stopAll: vi.fn(),
      } as unknown as PrMonitor;

      const store = createMockStore();
      const scheduler = new Scheduler(store, {});
      scheduler.configurePrMonitoring({ prMonitor });
      await flushAsyncWork();

      expect(store.listTasks).toHaveBeenCalledWith({ slim: true, includeArchived: false, startupMemo: true });
    });

    it("stops monitoring when task moves out of in-review based on from column", () => {
      const prMonitor = {
        startMonitoring: vi.fn(),
        stopMonitoring: vi.fn(),
        updatePrInfo: vi.fn(),
        getTrackedPrs: vi.fn().mockReturnValue(new Map()),
        stopAll: vi.fn(),
      } as unknown as PrMonitor;

      const store = createMockStore();
      new Scheduler(store, { prMonitor });

      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];
      const task = createMockTask({ id: "FN-001", column: "done", prInfo: { status: "open" } as any });

      movedHandler({ task, from: "in-review", to: "done" });

      expect(prMonitor.stopMonitoring).toHaveBeenCalledWith("FN-001");
    });

    it("invokes onClosedPrFeedback with drained comments for closed/merged PR", async () => {
      const mockComments = [
        { id: 1, body: "Fix this", user: { login: "reviewer" }, created_at: "2024-01-01", updated_at: "2024-01-01", html_url: "https://example.com" },
        { id: 2, body: "Update that", user: { login: "reviewer2" }, created_at: "2024-01-01", updated_at: "2024-01-01", html_url: "https://example.com" },
      ];

      const prMonitor = {
        startMonitoring: vi.fn(),
        stopMonitoring: vi.fn(),
        updatePrInfo: vi.fn(),
        getTrackedPrs: vi.fn().mockReturnValue(new Map()),
        stopAll: vi.fn(),
        drainComments: vi.fn().mockReturnValue(mockComments),
      } as unknown as PrMonitor;

      const onClosedPrFeedback = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore();
      new Scheduler(store, { prMonitor, onClosedPrFeedback });

      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      const task = createMockTask({
        id: "FN-001",
        column: "done",
        prInfo: { status: "merged", number: 42 } as any,
      });

      movedHandler({ task, from: "in-review", to: "done" });

      // Wait for the void Promise.resolve chain to complete
      await flushAsyncWork();

      expect(prMonitor.drainComments).toHaveBeenCalledWith("FN-001");
      expect(onClosedPrFeedback).toHaveBeenCalledWith("FN-001", task.prInfo, mockComments);
      expect(prMonitor.stopMonitoring).toHaveBeenCalledWith("FN-001");
    });

    it("does not invoke onClosedPrFeedback when buffer is empty", async () => {
      const prMonitor = {
        startMonitoring: vi.fn(),
        stopMonitoring: vi.fn(),
        updatePrInfo: vi.fn(),
        getTrackedPrs: vi.fn().mockReturnValue(new Map()),
        stopAll: vi.fn(),
        drainComments: vi.fn().mockReturnValue([]),
      } as unknown as PrMonitor;

      const onClosedPrFeedback = vi.fn();
      const store = createMockStore();
      new Scheduler(store, { prMonitor, onClosedPrFeedback });

      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      const task = createMockTask({
        id: "FN-001",
        column: "done",
        prInfo: { status: "merged", number: 42 } as any,
      });

      movedHandler({ task, from: "in-review", to: "done" });

      await flushAsyncWork();

      expect(prMonitor.drainComments).toHaveBeenCalledWith("FN-001");
      expect(onClosedPrFeedback).not.toHaveBeenCalled();
      expect(prMonitor.stopMonitoring).toHaveBeenCalledWith("FN-001");
    });

    it("does not invoke onClosedPrFeedback for open PR", async () => {
      const prMonitor = {
        startMonitoring: vi.fn(),
        stopMonitoring: vi.fn(),
        updatePrInfo: vi.fn(),
        getTrackedPrs: vi.fn().mockReturnValue(new Map()),
        stopAll: vi.fn(),
        drainComments: vi.fn(),
      } as unknown as PrMonitor;

      const onClosedPrFeedback = vi.fn();
      const store = createMockStore();
      new Scheduler(store, { prMonitor, onClosedPrFeedback });

      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      const task = createMockTask({
        id: "FN-001",
        column: "done",
        prInfo: { status: "open", number: 42 } as any,
      });

      movedHandler({ task, from: "in-review", to: "done" });

      await flushAsyncWork();

      expect(prMonitor.drainComments).not.toHaveBeenCalled();
      expect(onClosedPrFeedback).not.toHaveBeenCalled();
      expect(prMonitor.stopMonitoring).toHaveBeenCalledWith("FN-001");
    });

    it("does not invoke onClosedPrFeedback when callback is not provided", async () => {
      const prMonitor = {
        startMonitoring: vi.fn(),
        stopMonitoring: vi.fn(),
        updatePrInfo: vi.fn(),
        getTrackedPrs: vi.fn().mockReturnValue(new Map()),
        stopAll: vi.fn(),
        drainComments: vi.fn().mockReturnValue([
          { id: 1, body: "Fix", user: { login: "r" }, created_at: "2024-01-01", updated_at: "2024-01-01", html_url: "" },
        ]),
      } as unknown as PrMonitor;

      // No onClosedPrFeedback provided
      const store = createMockStore();
      new Scheduler(store, { prMonitor });

      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      const task = createMockTask({
        id: "FN-001",
        column: "done",
        prInfo: { status: "closed", number: 42 } as any,
      });

      // Should not throw
      movedHandler({ task, from: "in-review", to: "done" });

      await flushAsyncWork();

      expect(prMonitor.drainComments).toHaveBeenCalledWith("FN-001");
      expect(prMonitor.stopMonitoring).toHaveBeenCalledWith("FN-001");
    });

    it("drains comments before stopping monitoring (order matters)", async () => {
      const callOrder: string[] = [];
      const mockComments = [
        { id: 1, body: "Fix this", user: { login: "reviewer" }, created_at: "2024-01-01", updated_at: "2024-01-01", html_url: "" },
      ];

      const prMonitor = {
        startMonitoring: vi.fn(),
        stopMonitoring: vi.fn(() => { callOrder.push("stopMonitoring"); }),
        updatePrInfo: vi.fn(),
        getTrackedPrs: vi.fn().mockReturnValue(new Map()),
        stopAll: vi.fn(),
        drainComments: vi.fn(() => { callOrder.push("drainComments"); return mockComments; }),
      } as unknown as PrMonitor;

      const onClosedPrFeedback = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore();
      new Scheduler(store, { prMonitor, onClosedPrFeedback });

      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      const task = createMockTask({
        id: "FN-001",
        column: "done",
        prInfo: { status: "merged", number: 42 } as any,
      });

      movedHandler({ task, from: "in-review", to: "done" });

      await flushAsyncWork();

      // drainComments should be called before stopMonitoring
      expect(callOrder).toEqual(["drainComments", "stopMonitoring"]);
    });

    it("second move event with empty drain does not create duplicate follow-up", async () => {
      const prMonitor = {
        startMonitoring: vi.fn(),
        stopMonitoring: vi.fn(),
        updatePrInfo: vi.fn(),
        getTrackedPrs: vi.fn().mockReturnValue(new Map()),
        stopAll: vi.fn(),
        drainComments: vi.fn().mockReturnValue([]),
      } as unknown as PrMonitor;

      const onClosedPrFeedback = vi.fn();
      const store = createMockStore();
      new Scheduler(store, { prMonitor, onClosedPrFeedback });

      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      const task = createMockTask({
        id: "FN-001",
        column: "done",
        prInfo: { status: "merged", number: 42 } as any,
      });

      // First move — comments were already drained, buffer is empty
      movedHandler({ task, from: "in-review", to: "done" });
      await flushAsyncWork();

      // Second move — still empty
      movedHandler({ task, from: "in-review", to: "done" });
      await flushAsyncWork();

      // onClosedPrFeedback should never be called since buffer is empty
      expect(onClosedPrFeedback).not.toHaveBeenCalled();
    });
  });

  describe("mission integration", () => {
    it("activateNextPendingSlice returns null when no missionStore", async () => {
      const store = createMockStore();
      const scheduler = new Scheduler(store);
      const result = await scheduler.activateNextPendingSlice("M-001");
      expect(result).toBeNull();
    });

    it("triggers feature in-progress update when task with sliceId moves to in-progress", async () => {
      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue({ id: "F-001", sliceId: "SL-001", status: "triaged" }),
        updateFeatureStatus: vi.fn().mockReturnValue({ id: "F-001", status: "in-progress" }),
      });

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(createMockTask({
          id: "FN-001",
          column: "in-progress",
          sliceId: "SL-001",
        })),
      });
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      // Trigger task:moved event by calling the registered handler
      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];
      expect(movedHandler).toBeDefined();

      // Simulate task moving to in-progress with sliceId
      const task = createMockTask({ id: "FN-001", column: "in-progress", sliceId: "SL-001" });
      movedHandler({ task, to: "in-progress" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockMissionStore.getFeatureByTaskId).toHaveBeenCalledWith("FN-001");
      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-001", "in-progress");
    });

    it("does not update feature status when already past triaged", async () => {
      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue({ id: "F-001", sliceId: "SL-001", status: "in-progress" }),
        updateFeatureStatus: vi.fn(),
      });

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(createMockTask({
          id: "FN-001",
          column: "in-progress",
          sliceId: "SL-001",
        })),
      });
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      const task = createMockTask({ id: "FN-001", column: "in-progress", sliceId: "SL-001" });
      movedHandler({ task, to: "in-progress" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockMissionStore.getFeatureByTaskId).toHaveBeenCalledWith("FN-001");
      expect(mockMissionStore.updateFeatureStatus).not.toHaveBeenCalled();
    });

    it("onSliceComplete auto-advances when autoAdvance is enabled", async () => {
      const missionHierarchy = {
        id: "M-001",
        status: "active",
        milestones: [
          {
            id: "MS-001",
            dependencies: [],
            slices: [
              { id: "SL-001", status: "complete" },
              { id: "SL-002", status: "pending" },
            ],
          },
        ],
      };
      const mockMissionStore = createMockMissionStore({
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
        getMission: vi.fn().mockReturnValue({ id: "M-001", status: "active", autoAdvance: true }),
        getMissionWithHierarchy: vi.fn().mockReturnValue(missionHierarchy),
        activateSlice: vi.fn().mockReturnValue({ id: "SL-002", status: "active" }),
      });

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(createMockTask({
          id: "FN-001",
          column: "done",
          sliceId: "SL-001",
        })),
      });
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const slice = { id: "SL-001", milestoneId: "MS-001", status: "complete" } as any;
      await scheduler.onSliceComplete(slice);

      expect(mockMissionStore.getMilestone).toHaveBeenCalledWith("MS-001");
      expect(mockMissionStore.getMission).toHaveBeenCalledWith("M-001");
      expect(mockMissionStore.getMissionWithHierarchy).toHaveBeenCalledWith("M-001");
      expect(mockMissionStore.activateSlice).toHaveBeenCalledWith("SL-002");
    });

    it("onSliceComplete does not auto-advance when autoAdvance is disabled", async () => {
      const mockMissionStore = createMockMissionStore({
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
        getMission: vi.fn().mockReturnValue({ id: "M-001", status: "active", autoAdvance: false }),
      });

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(createMockTask({
          id: "FN-001",
          column: "done",
          sliceId: "SL-001",
        })),
      });
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const slice = { id: "SL-001", milestoneId: "MS-001", status: "complete" } as any;
      await scheduler.onSliceComplete(slice);

      expect(mockMissionStore.getMission).toHaveBeenCalledWith("M-001");
      expect(mockMissionStore.activateSlice).not.toHaveBeenCalled();
    });

    // ── autopilotEnabled as primary control for onSliceComplete fallback ─────────

    it("onSliceComplete auto-advances when autopilotEnabled is true (autoAdvance false)", async () => {
      const missionHierarchy = {
        id: "M-001",
        status: "active",
        milestones: [
          {
            id: "MS-001",
            dependencies: [],
            slices: [
              { id: "SL-001", status: "complete" },
              { id: "SL-002", status: "pending" },
            ],
          },
        ],
      };
      const mockMissionStore = createMockMissionStore({
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
        getMission: vi.fn().mockReturnValue({ id: "M-001", status: "active", autopilotEnabled: true, autoAdvance: false }),
        getMissionWithHierarchy: vi.fn().mockReturnValue(missionHierarchy),
        activateSlice: vi.fn().mockReturnValue({ id: "SL-002", status: "active" }),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const slice = { id: "SL-001", milestoneId: "MS-001", status: "complete" } as any;
      await scheduler.onSliceComplete(slice);

      expect(mockMissionStore.getMission).toHaveBeenCalledWith("M-001");
      expect(mockMissionStore.activateSlice).toHaveBeenCalledWith("SL-002");
    });

    it("onSliceComplete auto-advances when autopilotEnabled is true (autoAdvance unset)", async () => {
      const missionHierarchy = {
        id: "M-001",
        status: "active",
        milestones: [
          {
            id: "MS-001",
            dependencies: [],
            slices: [
              { id: "SL-001", status: "complete" },
              { id: "SL-002", status: "pending" },
            ],
          },
        ],
      };
      const mockMissionStore = createMockMissionStore({
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
        getMission: vi.fn().mockReturnValue({ id: "M-001", status: "active", autopilotEnabled: true }),
        getMissionWithHierarchy: vi.fn().mockReturnValue(missionHierarchy),
        activateSlice: vi.fn().mockReturnValue({ id: "SL-002", status: "active" }),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const slice = { id: "SL-001", milestoneId: "MS-001", status: "complete" } as any;
      await scheduler.onSliceComplete(slice);

      expect(mockMissionStore.getMission).toHaveBeenCalledWith("M-001");
      expect(mockMissionStore.activateSlice).toHaveBeenCalledWith("SL-002");
    });

    it("onSliceComplete does not auto-advance when both autopilotEnabled and autoAdvance are false", async () => {
      const mockMissionStore = createMockMissionStore({
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
        getMission: vi.fn().mockReturnValue({ id: "M-001", status: "active", autopilotEnabled: false, autoAdvance: false }),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const slice = { id: "SL-001", milestoneId: "MS-001", status: "complete" } as any;
      await scheduler.onSliceComplete(slice);

      expect(mockMissionStore.getMission).toHaveBeenCalledWith("M-001");
      expect(mockMissionStore.activateSlice).not.toHaveBeenCalled();
    });

    it("onSliceComplete auto-advances when autopilotEnabled is false but autoAdvance is true (legacy compat)", async () => {
      const missionHierarchy = {
        id: "M-001",
        status: "active",
        milestones: [
          {
            id: "MS-001",
            dependencies: [],
            slices: [
              { id: "SL-001", status: "complete" },
              { id: "SL-002", status: "pending" },
            ],
          },
        ],
      };
      const mockMissionStore = createMockMissionStore({
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
        getMission: vi.fn().mockReturnValue({ id: "M-001", status: "active", autoAdvance: true }),
        getMissionWithHierarchy: vi.fn().mockReturnValue(missionHierarchy),
        activateSlice: vi.fn().mockReturnValue({ id: "SL-002", status: "active" }),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const slice = { id: "SL-001", milestoneId: "MS-001", status: "complete" } as any;
      await scheduler.onSliceComplete(slice);

      expect(mockMissionStore.getMission).toHaveBeenCalledWith("M-001");
      expect(mockMissionStore.activateSlice).toHaveBeenCalledWith("SL-002");
    });

    it("skips mission progression when task sliceId mismatches linked feature sliceId", async () => {
      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue({ id: "F-001", sliceId: "SL-OTHER" }),
        updateFeatureStatus: vi.fn(),
      });

      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(createMockTask({
          id: "FN-001",
          column: "done",
          sliceId: "SL-001",
        })),
      });
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      const task = createMockTask({ id: "FN-001", column: "done", sliceId: "SL-001" });
      movedHandler({ task, from: "in-progress", to: "done" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockMissionStore.updateFeatureStatus).not.toHaveBeenCalled();
      expect(mockMissionStore.getSlice).not.toHaveBeenCalled();
    });

    it("onSliceComplete does not auto-advance when mission is not active", async () => {
      const mockMissionStore = createMockMissionStore({
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
        getMission: vi.fn().mockReturnValue({ id: "M-001", status: "planning", autoAdvance: true }),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const slice = { id: "SL-001", milestoneId: "MS-001", status: "complete" } as any;
      await scheduler.onSliceComplete(slice);

      expect(mockMissionStore.getMission).toHaveBeenCalledWith("M-001");
      expect(mockMissionStore.activateSlice).not.toHaveBeenCalled();
    });

    it("handles task with sliceId but no linked feature gracefully", async () => {
      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue(undefined),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const slice = { id: "SL-001", milestoneId: "MS-001", status: "complete" } as any;
      await scheduler.onSliceComplete(slice);

      // onSliceComplete does not call getFeatureByTaskId; it checks milestone/mission/missionHierarchy
      // This test verifies no errors are thrown when slice has no linked feature
      expect(mockMissionStore.activateSlice).not.toHaveBeenCalled();
    });

    it("activateNextPendingSlice finds and activates correct slice", async () => {
      const nextSlice = { id: "SL-002", status: "pending", orderIndex: 1 };
      const mockMissionStore = createMockMissionStore({
        getMissionWithHierarchy: vi.fn().mockReturnValue({
          id: "M-001",
          status: "active",
          milestones: [
            {
              id: "MS-001",
              orderIndex: 0,
              dependencies: [],
              slices: [
                nextSlice,
                { id: "SL-003", status: "pending", orderIndex: 2 },
                { id: "SL-001", status: "complete", orderIndex: 0 },
              ],
            },
          ],
        }),
        activateSlice: vi.fn().mockReturnValue({ ...nextSlice, status: "active" }),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const result = await scheduler.activateNextPendingSlice("M-001");

      expect(mockMissionStore.getMissionWithHierarchy).toHaveBeenCalledWith("M-001");
      expect(mockMissionStore.activateSlice).toHaveBeenCalledWith("SL-002");
      expect(result).toEqual({ id: "SL-002", status: "active", orderIndex: 1 });
    });

    it("activateNextPendingSlice skips milestones with incomplete dependencies", async () => {
      const mockMissionStore = createMockMissionStore({
        getMissionWithHierarchy: vi.fn().mockReturnValue({
          id: "M-001",
          status: "active",
          milestones: [
            {
              id: "MS-001",
              orderIndex: 0,
              status: "planning",
              dependencies: ["MS-999"],
              slices: [{ id: "SL-001", status: "pending", orderIndex: 0 }],
            },
            {
              id: "MS-002",
              orderIndex: 1,
              status: "planning",
              dependencies: [],
              slices: [{ id: "SL-002", status: "pending", orderIndex: 0 }],
            },
          ],
        }),
        activateSlice: vi.fn().mockReturnValue({ id: "SL-002", status: "active" }),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const result = await scheduler.activateNextPendingSlice("M-001");

      expect(mockMissionStore.activateSlice).toHaveBeenCalledWith("SL-002");
      expect(result).toEqual({ id: "SL-002", status: "active" });
    });

    it("activateNextPendingSlice returns null when mission is not active", async () => {
      const mockMissionStore = createMockMissionStore({
        getMissionWithHierarchy: vi.fn().mockReturnValue({
          id: "M-001",
          status: "planning",
          milestones: [],
        }),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const result = await scheduler.activateNextPendingSlice("M-001");

      expect(result).toBeNull();
      expect(mockMissionStore.activateSlice).not.toHaveBeenCalled();
    });

    it("activateNextPendingSlice returns null when no pending slices", async () => {
      const mockMissionStore = createMockMissionStore({
        getMissionWithHierarchy: vi.fn().mockReturnValue({
          id: "M-001",
          status: "active",
          milestones: [
            {
              id: "MS-001",
              orderIndex: 0,
              dependencies: [],
              slices: [{ id: "SL-001", status: "complete", orderIndex: 0 }],
            },
          ],
        }),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const result = await scheduler.activateNextPendingSlice("M-001");

      expect(result).toBeNull();
      expect(mockMissionStore.activateSlice).not.toHaveBeenCalled();
    });
  });

  describe("blocked mission scheduling", () => {
    it("skips tasks belonging to a blocked mission", async () => {
      const task = createMockTask({
        id: "FN-100",
        column: "todo",
        sliceId: "SL-001",
      });

      const mockMissionStore = createMockMissionStore({
        getSlice: vi.fn().mockReturnValue({ id: "SL-001", milestoneId: "MS-001" }),
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
        getMission: vi.fn().mockReturnValue({ id: "M-001", status: "blocked" }),
      });

      (existsSync as any).mockReturnValue(true);
      (readFile as any).mockResolvedValue("# Task\n\nSome content\n");

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([task]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
        getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
      });

      const onSchedule = vi.fn();
      const scheduler = new Scheduler(store, { onSchedule, missionStore: mockMissionStore as any });
      (scheduler as any).running = true;
      await scheduler.schedule();

      // Task should NOT be scheduled because its mission is blocked
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(onSchedule).not.toHaveBeenCalled();
    });

    it("schedules tasks when mission is active", async () => {
      const task = createMockTask({
        id: "FN-100",
        column: "todo",
        sliceId: "SL-001",
      });

      const mockMissionStore = createMockMissionStore({
        getSlice: vi.fn().mockReturnValue({ id: "SL-001", milestoneId: "MS-001" }),
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
        getMission: vi.fn().mockReturnValue({ id: "M-001", status: "active" }),
      });

      (existsSync as any).mockReturnValue(true);
      (readFile as any).mockResolvedValue("# Task\n\nSome content\n");

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([task]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
        getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
      });

      const onSchedule = vi.fn();
      const scheduler = new Scheduler(store, { onSchedule, missionStore: mockMissionStore as any });
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(store.moveTask).toHaveBeenCalledWith("FN-100", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });

    it("schedules tasks without sliceId regardless of mission state", async () => {
      const task = createMockTask({
        id: "FN-100",
        column: "todo",
        // No sliceId — not associated with any mission
      });

      (existsSync as any).mockReturnValue(true);
      (readFile as any).mockResolvedValue("# Task\n\nSome content\n");

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([task]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
        getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
      });

      const onSchedule = vi.fn();
      const scheduler = new Scheduler(store, { onSchedule, missionStore: createMockMissionStore() as any });
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(store.moveTask).toHaveBeenCalledWith("FN-100", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });
  });

  describe("recovery due-time gating (nextRecoveryAt)", () => {
    it("skips todo tasks whose nextRecoveryAt is in the future", async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const task = createMockTask({
        id: "FN-010",
        column: "todo",
        nextRecoveryAt: future,
        recoveryRetryCount: 1,
      });

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([task]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
      });

      const onSchedule = vi.fn();
      const scheduler = new Scheduler(store, { onSchedule });
      scheduler.start();
      await scheduler.schedule();
      scheduler.stop();

      // Should NOT have been started
      expect(onSchedule).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalled();
    });

    it("picks up todo tasks whose nextRecoveryAt has elapsed", async () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const task = createMockTask({
        id: "FN-011",
        column: "todo",
        nextRecoveryAt: past,
        recoveryRetryCount: 1,
      });

      // Mock filesystem validation: task dir exists, PROMPT.md exists and non-empty
      (existsSync as any).mockReturnValue(true);
      (readFile as any).mockResolvedValue("# Task\n\nSome content\n## File Scope\n- foo.ts\n");

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([task]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
        getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
      });

      const onSchedule = vi.fn();
      const scheduler = new Scheduler(store, { onSchedule });
      // Call schedule() directly without start() to avoid scheduling guard race
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(store.moveTask).toHaveBeenCalledWith("FN-011", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });

    it("picks up todo tasks without nextRecoveryAt normally", async () => {
      const task = createMockTask({
        id: "FN-012",
        column: "todo",
        // No nextRecoveryAt — should be picked up normally
      });

      (existsSync as any).mockReturnValue(true);
      (readFile as any).mockResolvedValue("# Task\n\nSome content\n## File Scope\n- foo.ts\n");

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([task]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
        getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
      });

      const onSchedule = vi.fn();
      const scheduler = new Scheduler(store, { onSchedule });
      // Call schedule() directly without start() to avoid scheduling guard race
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(store.moveTask).toHaveBeenCalledWith("FN-012", "in-progress", expect.objectContaining({ allocateWorktree: expect.any(Function) }));
    });
  });

  describe("userPaused dispatch behavior", () => {
    it("skips dispatch for todo task marked userPaused and re-enables after clearing", async () => {
      const pausedTask = createMockTask({
        id: "FN-UP-1",
        column: "todo",
        dependencies: [],
        userPaused: true,
      });
      const activeTask = createMockTask({
        id: "FN-UP-1",
        column: "todo",
        dependencies: [],
      });
      const listTasks = vi
        .fn()
        .mockResolvedValueOnce([pausedTask])
        .mockResolvedValueOnce([activeTask]);
      const getTask = vi
        .fn()
        .mockResolvedValueOnce(pausedTask)
        .mockResolvedValueOnce(activeTask);
      const updateTask = vi.fn().mockResolvedValue(undefined);
      const moveTask = vi.fn().mockResolvedValue(undefined);
      const store = createMockStore({
        listTasks,
        getTask,
        updateTask,
        moveTask,
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 1, groupOverlappingFiles: true }),
        parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\n\n## File Scope\n- src/example.ts\n");

      await scheduler.schedule();
      expect(moveTask).not.toHaveBeenCalled();
      expect(updateTask).toHaveBeenCalledWith("FN-UP-1", { status: "queued" });
      expect(store.logEntry).toHaveBeenCalledWith("FN-UP-1", "queued — user paused (manual move to todo)");

      await scheduler.schedule();
      expect(moveTask).toHaveBeenCalledWith(
        "FN-UP-1",
        "in-progress",
        expect.objectContaining({ allocateWorktree: expect.any(Function) }),
      );
    });
  });

  describe("autopilot integration", () => {
    it("watches missions with autopilotEnabled on start", () => {
      const store = createMockStore();
      const mockMissionStore = createMockMissionStore({
        listMissions: vi.fn().mockReturnValue([
          { id: "M-001", autopilotEnabled: true, status: "active" },
          { id: "M-002", autopilotEnabled: false, status: "active" },
          { id: "M-003", autopilotEnabled: true, status: "complete" },
        ]),
        getMission: vi.fn((id: string) => {
          const missions: Record<string, any> = {
            "M-001": { id: "M-001", autopilotEnabled: true, autopilotState: "inactive" },
            "M-002": { id: "M-002", autopilotEnabled: false, autopilotState: "inactive" },
          };
          return missions[id];
        }),
      });
      const mockAutopilot = {
        setScheduler: vi.fn(),
        watchMission: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
        missionAutopilot: mockAutopilot as any,
      });
      scheduler.start();

      // setScheduler should be called with the scheduler instance
      expect(mockAutopilot.setScheduler).toHaveBeenCalledWith(scheduler);
      // Only M-001 should be watched (autopilotEnabled, not complete/archived)
      expect(mockAutopilot.watchMission).toHaveBeenCalledWith("M-001");
      expect(mockAutopilot.watchMission).not.toHaveBeenCalledWith("M-002");
      expect(mockAutopilot.watchMission).not.toHaveBeenCalledWith("M-003");
      // Autopilot should be started
      expect(mockAutopilot.start).toHaveBeenCalled();

      scheduler.stop();
      // Autopilot should be stopped
      expect(mockAutopilot.stop).toHaveBeenCalled();
    });

    it("does not start autopilot when no missionAutopilot option", () => {
      const store = createMockStore();
      const scheduler = new Scheduler(store);
      scheduler.start();
      // Should not throw
      scheduler.stop();
    });

    it("delegates to autopilot.handleTaskCompletion when autopilot is available", async () => {
      const store = createMockStore();
      const mockAutopilot = {
        setScheduler: vi.fn(),
        watchMission: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        handleTaskCompletion: vi.fn().mockResolvedValue(undefined),
        isWatching: vi.fn(() => true), // autopilot IS watching
      };
      const completeSlice = {
        id: "SL-001",
        milestoneId: "MS-001",
        status: "complete",
        orderIndex: 0,
      };

      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue({
          id: "F-001",
          sliceId: "SL-001",
          status: "active",
        }),
        updateFeatureStatus: vi.fn(),
        getSlice: vi.fn().mockReturnValue(completeSlice),
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
        missionAutopilot: mockAutopilot as any,
      });

      // Simulate task:moved event: task moves to "done"
      await (scheduler as any).handleMissionTaskMove("FN-001", "done");

      // Feature status should be updated to "done"
      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-001", "done");
      // Should delegate to autopilot (not call onSliceComplete)
      expect(mockAutopilot.handleTaskCompletion).toHaveBeenCalledWith("FN-001");
    });

    it("marks a linked feature in-progress when a task reaches in-review without task slice metadata", async () => {
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(createMockTask({
          id: "FN-1702",
          column: "in-review",
          sliceId: undefined,
        })),
      });
      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue({
          id: "F-1702",
          sliceId: "SL-001",
          status: "triaged",
        }),
        updateFeatureStatus: vi.fn(),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
      });

      await (scheduler as any).handleMissionTaskMove("FN-1702", "in-review");

      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-1702", "in-progress");
    });

    it("links a one-way mission task to a matching unlinked feature before marking it done", async () => {
      const store = createMockStore({
        getTask: vi.fn().mockResolvedValue(createMockTask({
          id: "FN-1702",
          title: "First-run onboarding trigger",
          column: "done",
          missionId: "M-001",
          sliceId: "SL-001",
        } as Partial<Task>)),
      });
      const matchedFeature = {
        id: "F-1702",
        sliceId: "SL-001",
        title: "First-run onboarding trigger",
        status: "triaged",
      };
      const linkedFeature = {
        ...matchedFeature,
        taskId: "FN-1702",
      };
      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn()
          .mockReturnValueOnce(undefined)
          .mockReturnValue(linkedFeature),
        listFeatures: vi.fn().mockReturnValue([matchedFeature]),
        linkFeatureToTask: vi.fn().mockReturnValue(linkedFeature),
        updateFeatureStatus: vi.fn(),
        getSlice: vi.fn().mockReturnValue({ id: "SL-001", milestoneId: "MS-001", status: "active" }),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
      });

      await (scheduler as any).handleMissionTaskMove("FN-1702", "done");

      expect(mockMissionStore.linkFeatureToTask).toHaveBeenCalledWith("F-1702", "FN-1702");
      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-1702", "done");
    });

    it("falls back to onSliceComplete when no autopilot", async () => {
      const store = createMockStore();
      const completeSlice = {
        id: "SL-001",
        milestoneId: "MS-001",
        status: "complete",
        orderIndex: 0,
      };

      const missionHierarchy = {
        id: "M-001",
        status: "active",
        autoAdvance: true,
        milestones: [
          {
            id: "MS-001",
            missionId: "M-001",
            status: "active",
            dependencies: [],
            slices: [
              { id: "SL-001", status: "complete", orderIndex: 0 },
              { id: "SL-002", status: "pending", orderIndex: 1 },
            ],
          },
        ],
      };

      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue({
          id: "F-001",
          sliceId: "SL-001",
          status: "active",
        }),
        updateFeatureStatus: vi.fn(),
        getSlice: vi.fn().mockReturnValue(completeSlice),
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
        getMission: vi.fn().mockReturnValue({ id: "M-001", status: "active", autoAdvance: true }),
        getMissionWithHierarchy: vi.fn().mockReturnValue(missionHierarchy),
        activateSlice: vi.fn().mockResolvedValue({ id: "SL-002" }),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
      });

      await (scheduler as any).handleMissionTaskMove("FN-001", "done");

      // Feature status should be updated
      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-001", "done");
      // Legacy path: activateSlice should be called via onSliceComplete
      expect(mockMissionStore.activateSlice).toHaveBeenCalledWith("SL-002");
    });

    it("autopilot does not advance when autoAdvance is false", async () => {
      const store = createMockStore();
      const mockAutopilot = {
        setScheduler: vi.fn(),
        watchMission: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        handleTaskCompletion: vi.fn().mockResolvedValue(undefined),
        isWatching: vi.fn(() => true), // autopilot IS watching
      };

      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue({
          id: "F-001",
          sliceId: "SL-001",
          status: "done",
        }),
        updateFeatureStatus: vi.fn(),
        getSlice: vi.fn().mockReturnValue({
          id: "SL-001",
          milestoneId: "MS-001",
          status: "complete",
          orderIndex: 0,
        }),
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
        missionAutopilot: mockAutopilot as any,
      });

      await (scheduler as any).handleMissionTaskMove("FN-001", "done");

      // Delegates to autopilot, which internally checks autoAdvance
      expect(mockAutopilot.handleTaskCompletion).toHaveBeenCalledWith("FN-001");
    });

    it("does not mark a feature done when the completed task is blocked", async () => {
      const store = createMockStore({
        getTask: vi.fn(async (taskId: string) => {
          if (taskId === "FN-001") {
            return createMockTask({
              id: "FN-001",
              blockedBy: "FN-000",
              column: "done",
            }) as TaskDetail;
          }
          return createMockTask({ id: taskId, column: "in-progress" }) as TaskDetail;
        }) as TaskStore["getTask"],
      });
      const mockAutopilot = {
        setScheduler: vi.fn(),
        watchMission: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        handleTaskCompletion: vi.fn().mockResolvedValue(undefined),
        isWatching: vi.fn(() => true),
      };
      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue({
          id: "F-001",
          sliceId: "SL-001",
          status: "in-progress",
        }),
        updateFeatureStatus: vi.fn(),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
        missionAutopilot: mockAutopilot as any,
      });

      await (scheduler as any).handleMissionTaskMove("FN-001", "done");

      expect(mockMissionStore.updateFeatureStatus).not.toHaveBeenCalled();
      expect(mockAutopilot.handleTaskCompletion).not.toHaveBeenCalled();
    });
  });

  describe("overlap bottleneck warnings", () => {
    it("logs scheduler warning and blocker task log for high overlap fan-out", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-B", column: "in-progress", blockedBy: undefined }),
        createMockTask({ id: "FN-1", column: "todo", blockedBy: "FN-B", dependencies: [] }),
        createMockTask({ id: "FN-2", column: "todo", blockedBy: "FN-B", dependencies: [] }),
        createMockTask({ id: "FN-3", column: "todo", blockedBy: "FN-B", dependencies: [] }),
        createMockTask({ id: "FN-4", column: "todo", blockedBy: "FN-B", dependencies: [] }),
        createMockTask({ id: "FN-5", column: "todo", blockedBy: "FN-B", dependencies: [] }),
      ];

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 10, maxWorktrees: 10, groupOverlappingFiles: false }),
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect(schedulerLog.warn).toHaveBeenCalledWith(expect.stringContaining("Overlap bottleneck: FN-B is currently blocking 5 todo task(s) via blockedBy"));
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-B",
        expect.stringContaining("Overlap bottleneck: FN-B is currently blocking 5 todo task(s) via blockedBy"),
      );
    });

    it("does not warn for small or dependency-only fan-out", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-B", column: "in-progress" }),
        createMockTask({ id: "FN-1", column: "todo", dependencies: ["FN-B"] }),
        createMockTask({ id: "FN-2", column: "todo", dependencies: ["FN-B"] }),
        createMockTask({ id: "FN-3", column: "todo", blockedBy: "FN-B" }),
      ];

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 10, maxWorktrees: 10, groupOverlappingFiles: false }),
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();

      expect((store.logEntry as ReturnType<typeof vi.fn>).mock.calls.some((call) =>
        call[0] === "FN-B" && String(call[1]).includes("Overlap bottleneck:"),
      )).toBe(false);
    });

    it("dedupes unchanged overlap bottleneck warnings across passes", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue("# Task\nDo something");

      const tasks = [
        createMockTask({ id: "FN-B", column: "in-progress" }),
        createMockTask({ id: "FN-1", column: "todo", blockedBy: "FN-B" }),
        createMockTask({ id: "FN-2", column: "todo", blockedBy: "FN-B" }),
        createMockTask({ id: "FN-3", column: "todo", blockedBy: "FN-B" }),
        createMockTask({ id: "FN-4", column: "todo", blockedBy: "FN-B" }),
        createMockTask({ id: "FN-5", column: "todo", blockedBy: "FN-B" }),
      ];

      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 10, maxWorktrees: 10, groupOverlappingFiles: false }),
      });

      const scheduler = new Scheduler(store);
      (scheduler as any).running = true;
      await scheduler.schedule();
      await scheduler.schedule();

      const overlapLogs = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.filter((call) =>
        call[0] === "FN-B" && String(call[1]).includes("Overlap bottleneck:"),
      );
      expect(overlapLogs).toHaveLength(1);
    });
  });

  describe("reconcileAllMissionFeatures", () => {
    it("returns early when missionStore is not provided", async () => {
      const store = createMockStore();
      const scheduler = new Scheduler(store);

      const result = await scheduler.reconcileAllMissionFeatures();

      expect(result).toBe(0);
    });

    it("skips non-active missions", async () => {
      const store = createMockStore();
      const mockMissionStore = createMockMissionStore({
        listMissions: vi.fn().mockReturnValue([
          { id: "M-001", status: "complete" },
          { id: "M-002", status: "archived" },
        ]),
        getMissionWithHierarchy: vi.fn(),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
      });

      await scheduler.reconcileAllMissionFeatures();

      expect(mockMissionStore.getMissionWithHierarchy).not.toHaveBeenCalled();
    });

    it("updates feature to in-progress when task is in-progress and feature is triaged", async () => {
      const store = createMockStore({
        getTask: vi.fn().mockReturnValue(createMockTask({ id: "FN-001", column: "in-progress" })),
      });
      const mockMissionStore = createMockMissionStore({
        listMissions: vi.fn().mockReturnValue([
          { id: "M-001", status: "active" },
        ]),
        getMissionWithHierarchy: vi.fn().mockReturnValue({
          id: "M-001",
          status: "active",
          milestones: [{
            id: "MS-001",
            slices: [{
              id: "SL-001",
              status: "active",
              features: [{
                id: "F-001",
                taskId: "FN-001",
                status: "triaged",
              }],
            }],
          }],
        }),
        updateFeatureStatus: vi.fn(),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
      });

      const result = await scheduler.reconcileAllMissionFeatures();

      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-001", "in-progress");
      expect(result).toBe(1);
    });

    it("updates feature to in-progress when task is in-review and feature is triaged", async () => {
      const store = createMockStore({
        getTask: vi.fn().mockReturnValue(createMockTask({ id: "FN-1702", column: "in-review" })),
      });
      const mockMissionStore = createMockMissionStore({
        listMissions: vi.fn().mockReturnValue([
          { id: "M-001", status: "active" },
        ]),
        getMissionWithHierarchy: vi.fn().mockReturnValue({
          id: "M-001",
          status: "active",
          milestones: [{
            id: "MS-001",
            slices: [{
              id: "SL-001",
              status: "active",
              features: [{
                id: "F-1702",
                taskId: "FN-1702",
                status: "triaged",
              }],
            }],
          }],
        }),
        updateFeatureStatus: vi.fn(),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
      });

      const result = await scheduler.reconcileAllMissionFeatures();

      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-1702", "in-progress");
      expect(result).toBe(1);
    });

    it("updates feature to done when task is done and feature is not done", async () => {
      const store = createMockStore({
        getTask: vi.fn().mockReturnValue(createMockTask({ id: "FN-001", column: "done" })),
      });
      const mockMissionStore = createMockMissionStore({
        listMissions: vi.fn().mockReturnValue([
          { id: "M-001", status: "active" },
        ]),
        getMissionWithHierarchy: vi.fn().mockReturnValue({
          id: "M-001",
          status: "active",
          milestones: [{
            id: "MS-001",
            slices: [{
              id: "SL-001",
              status: "active",
              features: [{
                id: "F-001",
                taskId: "FN-001",
                status: "in-progress",
              }],
            }],
          }],
        }),
        updateFeatureStatus: vi.fn(),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
      });

      const result = await scheduler.reconcileAllMissionFeatures();

      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-001", "done");
      expect(result).toBe(1);
    });

    it("does not reconcile feature to done when the linked task has unresolved dependencies", async () => {
      const getTask = vi.fn(async (id: string) => {
        if (id === "FN-001") {
          return createMockTask({
            id: "FN-001",
            column: "done",
            dependencies: ["FN-000"],
          });
        }
        return createMockTask({ id, column: "in-progress" });
      });
      const store = createMockStore({ getTask: getTask as any });
      const mockMissionStore = createMockMissionStore({
        listMissions: vi.fn().mockReturnValue([
          { id: "M-001", status: "active" },
        ]),
        getMissionWithHierarchy: vi.fn().mockReturnValue({
          id: "M-001",
          status: "active",
          milestones: [{
            id: "MS-001",
            slices: [{
              id: "SL-001",
              status: "active",
              features: [{
                id: "F-001",
                taskId: "FN-001",
                status: "in-progress",
              }],
            }],
          }],
        }),
        updateFeatureStatus: vi.fn(),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
      });

      const result = await scheduler.reconcileAllMissionFeatures();

      expect(mockMissionStore.updateFeatureStatus).not.toHaveBeenCalled();
      expect(result).toBe(0);
    });

    it("routes failed linked tasks through onTaskFailed during reconciliation", async () => {
      const store = createMockStore({
        getTask: vi.fn().mockReturnValue(createMockTask({
          id: "FN-001",
          column: "in-progress",
          status: "failed",
        })),
      });
      const onTaskFailed = vi.fn().mockResolvedValue(undefined);
      const mockMissionStore = createMockMissionStore({
        listMissions: vi.fn().mockReturnValue([
          { id: "M-001", status: "active" },
        ]),
        getMissionWithHierarchy: vi.fn().mockReturnValue({
          id: "M-001",
          status: "active",
          milestones: [{
            id: "MS-001",
            slices: [{
              id: "SL-001",
              status: "active",
              features: [{
                id: "F-001",
                taskId: "FN-001",
                status: "in-progress",
              }],
            }],
          }],
        }),
        updateFeatureStatus: vi.fn(),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
        onTaskFailed,
      });

      const result = await scheduler.reconcileAllMissionFeatures();

      expect(onTaskFailed).toHaveBeenCalledWith("FN-001");
      expect(mockMissionStore.updateFeatureStatus).not.toHaveBeenCalled();
      expect(result).toBe(1);
    });

    it("updates feature to triaged when task moves back to todo and feature is in-progress", async () => {
      const store = createMockStore({
        getTask: vi.fn().mockReturnValue(createMockTask({ id: "FN-001", column: "todo" })),
      });
      const mockMissionStore = createMockMissionStore({
        listMissions: vi.fn().mockReturnValue([
          { id: "M-001", status: "active" },
        ]),
        getMissionWithHierarchy: vi.fn().mockReturnValue({
          id: "M-001",
          status: "active",
          milestones: [{
            id: "MS-001",
            slices: [{
              id: "SL-001",
              status: "active",
              features: [{
                id: "F-001",
                taskId: "FN-001",
                status: "in-progress",
              }],
            }],
          }],
        }),
        updateFeatureStatus: vi.fn(),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
      });

      const result = await scheduler.reconcileAllMissionFeatures();

      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-001", "triaged");
      expect(result).toBe(1);
    });

    it("does not update correctly synced features", async () => {
      const store = createMockStore({
        getTask: vi.fn().mockReturnValue(createMockTask({ id: "FN-001", column: "in-progress" })),
      });
      const mockMissionStore = createMockMissionStore({
        listMissions: vi.fn().mockReturnValue([
          { id: "M-001", status: "active" },
        ]),
        getMissionWithHierarchy: vi.fn().mockReturnValue({
          id: "M-001",
          status: "active",
          milestones: [{
            id: "MS-001",
            slices: [{
              id: "SL-001",
              status: "active",
              features: [{
                id: "F-001",
                taskId: "FN-001",
                status: "in-progress", // Already synced
              }],
            }],
          }],
        }),
        updateFeatureStatus: vi.fn(),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
      });

      const result = await scheduler.reconcileAllMissionFeatures();

      expect(mockMissionStore.updateFeatureStatus).not.toHaveBeenCalled();
      expect(result).toBe(0);
    });

    it("repairs one-way mission task links by exact feature title during reconciliation", async () => {
      const matchedTask = createMockTask({
        id: "FN-1702",
        title: "First-run onboarding trigger",
        column: "done",
        missionId: "M-001",
        sliceId: "SL-001",
      } as Partial<Task>);
      const matchedFeature = {
        id: "F-1702",
        sliceId: "SL-001",
        title: "First-run onboarding trigger",
        taskId: undefined,
        status: "triaged",
      };
      const linkedFeature = {
        ...matchedFeature,
        taskId: "FN-1702",
      };
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([matchedTask]),
        getTask: vi.fn(),
      });
      const mockMissionStore = createMockMissionStore({
        listMissions: vi.fn().mockReturnValue([
          { id: "M-001", status: "active" },
        ]),
        getMissionWithHierarchy: vi.fn().mockReturnValue({
          id: "M-001",
          status: "active",
          milestones: [{
            id: "MS-001",
            slices: [{
              id: "SL-001",
              status: "active",
              features: [matchedFeature],
            }],
          }],
        }),
        linkFeatureToTask: vi.fn().mockReturnValue(linkedFeature),
        updateFeatureStatus: vi.fn(),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
      });

      const result = await scheduler.reconcileAllMissionFeatures();

      expect(mockMissionStore.linkFeatureToTask).toHaveBeenCalledWith("F-1702", "FN-1702");
      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-1702", "done");
      expect(result).toBe(2);
    });

    it("skips features without taskId", async () => {
      const store = createMockStore({
        getTask: vi.fn(),
      });
      const mockMissionStore = createMockMissionStore({
        listMissions: vi.fn().mockReturnValue([
          { id: "M-001", status: "active" },
        ]),
        getMissionWithHierarchy: vi.fn().mockReturnValue({
          id: "M-001",
          status: "active",
          milestones: [{
            id: "MS-001",
            slices: [{
              id: "SL-001",
              status: "active",
              features: [{
                id: "F-001",
                taskId: undefined, // No linked task
                status: "defined",
              }],
            }],
          }],
        }),
        updateFeatureStatus: vi.fn(),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
      });

      const result = await scheduler.reconcileAllMissionFeatures();

      expect(store.getTask).not.toHaveBeenCalled();
      expect(mockMissionStore.updateFeatureStatus).not.toHaveBeenCalled();
      expect(result).toBe(0);
    });

    it("skips inactive slices", async () => {
      const store = createMockStore({
        getTask: vi.fn(),
      });
      const mockMissionStore = createMockMissionStore({
        listMissions: vi.fn().mockReturnValue([
          { id: "M-001", status: "active" },
        ]),
        getMissionWithHierarchy: vi.fn().mockReturnValue({
          id: "M-001",
          status: "active",
          milestones: [{
            id: "MS-001",
            slices: [{
              id: "SL-001",
              status: "pending", // Not active
              features: [{
                id: "F-001",
                taskId: "FN-001",
                status: "triaged",
              }],
            }],
          }],
        }),
        updateFeatureStatus: vi.fn(),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
      });

      const result = await scheduler.reconcileAllMissionFeatures();

      expect(store.getTask).not.toHaveBeenCalled();
      expect(mockMissionStore.updateFeatureStatus).not.toHaveBeenCalled();
      expect(result).toBe(0);
    });

    it("handles multiple features across multiple missions and slices", async () => {
      const store = createMockStore({
        getTask: vi.fn(async (id: string) => {
          const columns: Record<string, string> = {
            "FN-001": "in-progress",
            "FN-002": "done",
            "FN-003": "triage",
          };
          return createMockTask({ id, column: columns[id] as "todo" });
        }) as unknown as (id: string) => Promise<TaskDetail>,
      });
      const mockMissionStore = createMockMissionStore({
        listMissions: vi.fn().mockReturnValue([
          { id: "M-001", status: "active" },
          { id: "M-002", status: "active" },
        ]),
        getMissionWithHierarchy: vi.fn((id: string) => {
          if (id === "M-001") {
            return {
              id: "M-001",
              status: "active",
              milestones: [{
                id: "MS-001",
                slices: [{
                  id: "SL-001",
                  status: "active",
                  features: [
                    { id: "F-001", taskId: "FN-001", status: "triaged" }, // Should update to in-progress
                    { id: "F-002", taskId: "FN-002", status: "in-progress" }, // Should update to done
                  ],
                }],
              }],
            };
          }
          return {
            id: "M-002",
            status: "active",
            milestones: [{
              id: "MS-002",
              slices: [{
                id: "SL-002",
                status: "active",
                features: [
                  { id: "F-003", taskId: "FN-003", status: "in-progress" }, // Should update to triaged
                ],
              }],
            }],
          };
        }),
        updateFeatureStatus: vi.fn(),
      });

      const scheduler = new Scheduler(store, {
        missionStore: mockMissionStore as any,
      });

      const result = await scheduler.reconcileAllMissionFeatures();

      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledTimes(3);
      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-001", "in-progress");
      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-002", "done");
      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-003", "triaged");
      expect(result).toBe(3);
    });
  });
});
