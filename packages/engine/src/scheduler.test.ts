import { describe, it, expect, vi, beforeEach } from "vitest";
import { Scheduler } from "./scheduler.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "HAI-001",
    title: "Test Task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockStore(tasks: any[] = []) {
  return {
    listTasks: vi.fn().mockResolvedValue(tasks),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    }),
    updateTask: vi.fn().mockResolvedValue({}),
    moveTask: vi.fn().mockResolvedValue({}),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
  } as any;
}

describe("Scheduler concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Helper: set scheduler to running state and call schedule() directly.
   * Avoids start() which fires a non-awaited schedule() that conflicts
   * with our test's awaited call via the re-entrance guard.
   */
  async function runSchedule(scheduler: Scheduler): Promise<void> {
    (scheduler as any).running = true;
    await scheduler.schedule();
  }

  it("respects maxConcurrent with only in-progress tasks", async () => {
    const tasks = [
      makeTask({ id: "HAI-001", column: "in-progress" }),
      makeTask({ id: "HAI-002", column: "in-progress" }),
      makeTask({ id: "HAI-003", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    // HAI-003 should NOT be moved — 2 in-progress already fills maxConcurrent
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("counts specifying tasks toward concurrency", async () => {
    const tasks = [
      makeTask({ id: "HAI-001", column: "in-progress" }),
      makeTask({ id: "HAI-002", column: "triage", status: "specifying" }),
      makeTask({ id: "HAI-003", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    // 1 in-progress + 1 specifying = 2 agent slots, no room for HAI-003
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("blocks all todo tasks when specifying fills all slots", async () => {
    const tasks = [
      makeTask({ id: "HAI-001", column: "triage", status: "specifying" }),
      makeTask({ id: "HAI-002", column: "triage", status: "specifying" }),
      makeTask({ id: "HAI-003", column: "todo" }),
      makeTask({ id: "HAI-004", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("allows scheduling when mixed slots leave room", async () => {
    const tasks = [
      makeTask({ id: "HAI-001", column: "in-progress" }),
      makeTask({ id: "HAI-002", column: "triage", status: "specifying" }),
      makeTask({ id: "HAI-003", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 3 });

    await runSchedule(scheduler);

    // 1 in-progress + 1 specifying = 2 slots used, 1 available
    expect(store.moveTask).toHaveBeenCalledWith("HAI-003", "in-progress");
  });

  it("behaves normally when no tasks are specifying", async () => {
    const tasks = [
      makeTask({ id: "HAI-001", column: "in-progress" }),
      makeTask({ id: "HAI-002", column: "triage" }), // no status: "specifying"
      makeTask({ id: "HAI-003", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    // Only 1 in-progress, triage task without "specifying" doesn't count
    expect(store.moveTask).toHaveBeenCalledWith("HAI-003", "in-progress");
  });
});

describe("Scheduler file-scope overlap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSchedule(scheduler: Scheduler): Promise<void> {
    (scheduler as any).running = true;
    await scheduler.schedule();
  }

  it("sets status 'queued' for a todo task deferred due to file scope overlap", async () => {
    const tasks = [
      makeTask({ id: "HAI-001", column: "in-progress" }),
      makeTask({ id: "HAI-002", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    // Enable file scope grouping
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: true,
      autoMerge: false,
    });
    // Both tasks share overlapping file scopes
    store.parseFileScopeFromPrompt.mockImplementation(async (id: string) => {
      if (id === "HAI-001") return ["packages/shared/utils.ts"];
      if (id === "HAI-002") return ["packages/shared/utils.ts"];
      return [];
    });

    const scheduler = new Scheduler(store, { maxConcurrent: 3 });
    await runSchedule(scheduler);

    // HAI-002 should NOT be moved to in-progress (deferred)
    expect(store.moveTask).not.toHaveBeenCalled();
    // HAI-002 should have status set to "queued"
    expect(store.updateTask).toHaveBeenCalledWith("HAI-002", { status: "queued" });
  });

  it("does not set status 'queued' when file scopes do not overlap", async () => {
    const tasks = [
      makeTask({ id: "HAI-001", column: "in-progress" }),
      makeTask({ id: "HAI-002", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: true,
      autoMerge: false,
    });
    store.parseFileScopeFromPrompt.mockImplementation(async (id: string) => {
      if (id === "HAI-001") return ["packages/a/file.ts"];
      if (id === "HAI-002") return ["packages/b/file.ts"];
      return [];
    });

    const scheduler = new Scheduler(store, { maxConcurrent: 3 });
    await runSchedule(scheduler);

    // HAI-002 should be moved (no overlap)
    expect(store.moveTask).toHaveBeenCalledWith("HAI-002", "in-progress");
  });
});

describe("Scheduler worktree limit logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSchedule(scheduler: Scheduler): Promise<void> {
    (scheduler as any).running = true;
    await scheduler.schedule();
  }

  it("logs worktree limit on the first pass when maxed out", async () => {
    const tasks = [
      makeTask({ id: "HAI-001", column: "in-progress" }),
      makeTask({ id: "HAI-002", column: "in-progress" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxWorktrees: 2 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runSchedule(scheduler);

    expect(logSpy).toHaveBeenCalledWith(
      "[scheduler] Worktree limit reached (2/2)",
    );
    logSpy.mockRestore();
  });

  it("does not log worktree limit on subsequent passes while still maxed", async () => {
    const tasks = [
      makeTask({ id: "HAI-001", column: "in-progress" }),
      makeTask({ id: "HAI-002", column: "in-progress" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxWorktrees: 2 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runSchedule(scheduler);
    await runSchedule(scheduler);
    await runSchedule(scheduler);

    const limitMessages = logSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("Worktree limit reached"),
    );
    expect(limitMessages).toHaveLength(1);
    logSpy.mockRestore();
  });

  it("logs worktree limit again after worktrees free up and become maxed again", async () => {
    const maxedTasks = [
      makeTask({ id: "HAI-001", column: "in-progress" }),
      makeTask({ id: "HAI-002", column: "in-progress" }),
    ];
    const freeTasks = [
      makeTask({ id: "HAI-001", column: "in-progress" }),
    ];

    const store = createMockStore(maxedTasks);
    const scheduler = new Scheduler(store, { maxWorktrees: 2, maxConcurrent: 2 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // First pass: maxed out — should log
    await runSchedule(scheduler);

    // Second pass: slot freed — should not log limit
    store.listTasks.mockResolvedValue(freeTasks);
    await runSchedule(scheduler);

    // Third pass: maxed out again — should log again
    store.listTasks.mockResolvedValue(maxedTasks);
    await runSchedule(scheduler);

    const limitMessages = logSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("Worktree limit reached"),
    );
    expect(limitMessages).toHaveLength(2);
    logSpy.mockRestore();
  });
});
