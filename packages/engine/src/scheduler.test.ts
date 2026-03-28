import { describe, it, expect, vi, beforeEach } from "vitest";
import { Scheduler } from "./scheduler.js";
import { AgentSemaphore } from "./concurrency.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "KB-001",
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
  const listeners = new Map<string, Function[]>();
  return {
    on: vi.fn((event: string, fn: Function) => {
      const existing = listeners.get(event) || [];
      existing.push(fn);
      listeners.set(event, existing);
    }),
    /** Trigger registered listeners for an event (test helper). */
    _trigger(event: string, ...args: any[]) {
      for (const fn of listeners.get(event) || []) fn(...args);
    },
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
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "in-progress" }),
      makeTask({ id: "KB-003", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    // KB-003 should NOT be moved — 2 in-progress already fills maxConcurrent
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("counts specifying tasks toward concurrency", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "triage", status: "specifying" }),
      makeTask({ id: "KB-003", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    // 1 in-progress + 1 specifying = 2 agent slots, no room for KB-003
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("blocks all todo tasks when specifying fills all slots", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "triage", status: "specifying" }),
      makeTask({ id: "KB-002", column: "triage", status: "specifying" }),
      makeTask({ id: "KB-003", column: "todo" }),
      makeTask({ id: "KB-004", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("allows scheduling when mixed slots leave room", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "triage", status: "specifying" }),
      makeTask({ id: "KB-003", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 3,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });
    const scheduler = new Scheduler(store, { maxConcurrent: 3 });

    await runSchedule(scheduler);

    // 1 in-progress + 1 specifying = 2 slots used, 1 available
    expect(store.moveTask).toHaveBeenCalledWith("KB-003", "in-progress");
  });

  it("behaves normally when no tasks are specifying", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "triage" }), // no status: "specifying"
      makeTask({ id: "KB-003", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    // Only 1 in-progress, triage task without "specifying" doesn't count
    expect(store.moveTask).toHaveBeenCalledWith("KB-003", "in-progress");
  });
});

describe("Scheduler dynamic settings reload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSchedule(scheduler: Scheduler): Promise<void> {
    (scheduler as any).running = true;
    await scheduler.schedule();
  }

  it("reads maxConcurrent from store settings on each schedule() call", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    // Start with maxConcurrent: 1 — no room
    store.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });
    const scheduler = new Scheduler(store);

    await runSchedule(scheduler);
    expect(store.moveTask).not.toHaveBeenCalled();

    // Now bump maxConcurrent to 2 — room for KB-002
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });

    await runSchedule(scheduler);
    expect(store.moveTask).toHaveBeenCalledWith("KB-002", "in-progress");
  });

  it("reads maxWorktrees from store settings on each schedule() call", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "in-progress" }),
      makeTask({ id: "KB-003", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    // Start with maxWorktrees: 2 — no room (2 in-progress worktrees)
    store.getSettings.mockResolvedValue({
      maxConcurrent: 4,
      maxWorktrees: 2,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });
    const scheduler = new Scheduler(store);

    await runSchedule(scheduler);
    expect(store.moveTask).not.toHaveBeenCalled();

    // Bump maxWorktrees to 3 — room for KB-003
    store.getSettings.mockResolvedValue({
      maxConcurrent: 4,
      maxWorktrees: 3,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });

    await runSchedule(scheduler);
    expect(store.moveTask).toHaveBeenCalledWith("KB-003", "in-progress");
  });

  it("refreshes poll interval when settings.pollIntervalMs changes", async () => {
    const store = createMockStore([]);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });
    const scheduler = new Scheduler(store);

    // Manually set running and activePollMs to simulate start()
    (scheduler as any).running = true;
    (scheduler as any).activePollMs = 15000;
    (scheduler as any).pollInterval = setInterval(() => {}, 15000);

    // First schedule — same interval, no change
    await scheduler.schedule();
    expect((scheduler as any).activePollMs).toBe(15000);

    // Change pollIntervalMs
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 5000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });

    await scheduler.schedule();
    expect((scheduler as any).activePollMs).toBe(5000);

    // Clean up
    scheduler.stop();
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
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "todo" }),
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
      if (id === "KB-001") return ["packages/shared/utils.ts"];
      if (id === "KB-002") return ["packages/shared/utils.ts"];
      return [];
    });

    const scheduler = new Scheduler(store, { maxConcurrent: 3 });
    await runSchedule(scheduler);

    // KB-002 should NOT be moved to in-progress (deferred)
    expect(store.moveTask).not.toHaveBeenCalled();
    // KB-002 should have status set to "queued" with blockedBy
    expect(store.updateTask).toHaveBeenCalledWith("KB-002", { status: "queued", blockedBy: "KB-001" });
  });

  it("sets blockedBy to the overlapping task ID when deferred due to file scope overlap", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "todo" }),
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
      if (id === "KB-001") return ["packages/shared/utils.ts"];
      if (id === "KB-002") return ["packages/shared/utils.ts"];
      return [];
    });

    const scheduler = new Scheduler(store, { maxConcurrent: 3 });
    await runSchedule(scheduler);

    expect(store.updateTask).toHaveBeenCalledWith("KB-002", { status: "queued", blockedBy: "KB-001" });
  });

  it("clears blockedBy when a task is started", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });

    const scheduler = new Scheduler(store, { maxConcurrent: 2 });
    await runSchedule(scheduler);

    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: null, blockedBy: null });
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "in-progress");
  });

  it("does not emit console.log when deferring due to file overlap", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const tasks = [
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "todo" }),
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
      if (id === "KB-001") return ["packages/shared/utils.ts"];
      if (id === "KB-002") return ["packages/shared/utils.ts"];
      return [];
    });

    const scheduler = new Scheduler(store, { maxConcurrent: 3 });
    await runSchedule(scheduler);

    // Verify no log about deferring/file overlap was emitted
    const calls = logSpy.mock.calls.flat().map(String);
    expect(calls.some((msg) => msg.includes("Deferring") && msg.includes("file overlap"))).toBe(false);
    logSpy.mockRestore();
  });

  it("does not set status 'queued' when file scopes do not overlap", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "todo" }),
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
      if (id === "KB-001") return ["packages/a/file.ts"];
      if (id === "KB-002") return ["packages/b/file.ts"];
      return [];
    });

    const scheduler = new Scheduler(store, { maxConcurrent: 3 });
    await runSchedule(scheduler);

    // KB-002 should be moved (no overlap)
    expect(store.moveTask).toHaveBeenCalledWith("KB-002", "in-progress");
  });
});

describe("Scheduler explicit dep relaxation (in-review as met)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSchedule(scheduler: Scheduler): Promise<void> {
    (scheduler as any).running = true;
    await scheduler.schedule();
  }

  it("allows task to start when explicit dep is in-review", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-review", worktree: "/tmp/wt/kb-001" }),
      makeTask({ id: "KB-002", column: "todo", dependencies: ["KB-001"] }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    expect(store.moveTask).toHaveBeenCalledWith("KB-002", "in-progress");
  });

  it("blocks task when explicit dep is in-progress (not yet done or in-review)", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "todo", dependencies: ["KB-001"] }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 3 });

    await runSchedule(scheduler);

    expect(store.moveTask).not.toHaveBeenCalledWith("KB-002", "in-progress");
    expect(store.updateTask).toHaveBeenCalledWith("KB-002", { status: "queued" });
  });

  it("allows task to start when explicit dep is done", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "done" }),
      makeTask({ id: "KB-002", column: "todo", dependencies: ["KB-001"] }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    expect(store.moveTask).toHaveBeenCalledWith("KB-002", "in-progress");
  });

  it("blocks task when explicit dep is in todo", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "todo" }),
      makeTask({ id: "KB-002", column: "todo", dependencies: ["KB-001"] }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 3 });

    await runSchedule(scheduler);

    // KB-001 should be started (no deps), KB-002 blocked (dep in todo)
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "in-progress");
    expect(store.moveTask).not.toHaveBeenCalledWith("KB-002", "in-progress");
  });
});

describe("Scheduler baseBranch recording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSchedule(scheduler: Scheduler): Promise<void> {
    (scheduler as any).running = true;
    await scheduler.schedule();
  }

  it("sets baseBranch when explicit dep is in-review with worktree", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-review", worktree: "/tmp/wt/kb-001" }),
      makeTask({ id: "KB-002", column: "todo", dependencies: ["KB-001"] }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    expect(store.updateTask).toHaveBeenCalledWith("KB-002", {
      status: null,
      blockedBy: null,
      baseBranch: "kb/kb-001",
    });
  });

  it("does not set baseBranch when dep is done (already merged to main)", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "done" }),
      makeTask({ id: "KB-002", column: "todo", dependencies: ["KB-001"] }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    expect(store.updateTask).toHaveBeenCalledWith("KB-002", {
      status: null,
      blockedBy: null,
      baseBranch: undefined,
    });
  });

  it("sets baseBranch from blockedBy when blocker is in-review with worktree", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-review", worktree: "/tmp/wt/kb-001" }),
      makeTask({ id: "KB-002", column: "todo", blockedBy: "KB-001" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    expect(store.updateTask).toHaveBeenCalledWith("KB-002", {
      status: null,
      blockedBy: null,
      baseBranch: "kb/kb-001",
    });
  });

  it("does not set baseBranch when dep is in-review without worktree", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-review" }), // no worktree
      makeTask({ id: "KB-002", column: "todo", dependencies: ["KB-001"] }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    expect(store.updateTask).toHaveBeenCalledWith("KB-002", {
      status: null,
      blockedBy: null,
      baseBranch: undefined,
    });
  });

  it("prefers explicit dep over blockedBy for baseBranch", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-review", worktree: "/tmp/wt/kb-001" }),
      makeTask({ id: "KB-003", column: "in-review", worktree: "/tmp/wt/kb-003" }),
      makeTask({ id: "KB-002", column: "todo", dependencies: ["KB-001"], blockedBy: "KB-003" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    // Should use explicit dep KB-001, not blockedBy KB-003
    expect(store.updateTask).toHaveBeenCalledWith("KB-002", {
      status: null,
      blockedBy: null,
      baseBranch: "kb/kb-001",
    });
  });

  it("does not set baseBranch for tasks with no deps or blockedBy", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    expect(store.updateTask).toHaveBeenCalledWith("KB-001", {
      status: null,
      blockedBy: null,
      baseBranch: undefined,
    });
  });
});

describe("Scheduler in-review file scope overlap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSchedule(scheduler: Scheduler): Promise<void> {
    (scheduler as any).running = true;
    await scheduler.schedule();
  }

  it("blocks todo task when in-review task with worktree has overlapping file scope", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-review", worktree: "/tmp/wt/kb-001" }),
      makeTask({ id: "KB-002", column: "todo" }),
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
      if (id === "KB-001") return ["packages/shared/utils.ts"];
      if (id === "KB-002") return ["packages/shared/utils.ts"];
      return [];
    });

    const scheduler = new Scheduler(store, { maxConcurrent: 3 });
    await runSchedule(scheduler);

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("KB-002", { status: "queued", blockedBy: "KB-001" });
  });

  it("does not block when in-review task has no worktree (already merged)", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-review" }), // no worktree — merged
      makeTask({ id: "KB-002", column: "todo" }),
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
      if (id === "KB-001") return ["packages/shared/utils.ts"];
      if (id === "KB-002") return ["packages/shared/utils.ts"];
      return [];
    });

    const scheduler = new Scheduler(store, { maxConcurrent: 3 });
    await runSchedule(scheduler);

    // KB-002 should be started (no overlap with merged in-review task)
    expect(store.moveTask).toHaveBeenCalledWith("KB-002", "in-progress");
  });
});

describe("Scheduler paused tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSchedule(scheduler: Scheduler): Promise<void> {
    (scheduler as any).running = true;
    await scheduler.schedule();
  }

  it("does not schedule paused todo tasks", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "todo", paused: true }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("schedules non-paused todo tasks normally", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "todo", paused: false }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "in-progress");
  });

  it("does not count paused specifying tasks toward agent slots", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "triage", status: "specifying", paused: true }),
      makeTask({ id: "KB-002", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 1,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });
    const scheduler = new Scheduler(store, { maxConcurrent: 1 });

    await runSchedule(scheduler);

    // The paused specifying task doesn't consume a slot, so KB-002 should be scheduled
    expect(store.moveTask).toHaveBeenCalledWith("KB-002", "in-progress");
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
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "in-progress" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 2,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });
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
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "in-progress" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 2,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });
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
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "in-progress" }),
    ];
    const freeTasks = [
      makeTask({ id: "KB-001", column: "in-progress" }),
    ];

    const store = createMockStore(maxedTasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 2,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });
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

describe("Scheduler globalPause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSchedule(scheduler: Scheduler): Promise<void> {
    (scheduler as any).running = true;
    await scheduler.schedule();
  }

  it("does not move any tasks when globalPause is true", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "todo" }),
      makeTask({ id: "KB-002", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      globalPause: true,
    });
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("resumes scheduling when globalPause is toggled back to false", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      globalPause: true,
    });
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);
    expect(store.moveTask).not.toHaveBeenCalled();

    // Toggle globalPause off
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      globalPause: false,
    });

    await runSchedule(scheduler);
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "in-progress");
  });

  it("logs once when entering global pause state", async () => {
    const tasks = [makeTask({ id: "KB-001", column: "todo" })];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      globalPause: true,
    });
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runSchedule(scheduler);
    await runSchedule(scheduler);
    await runSchedule(scheduler);

    const pauseMessages = logSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("Global pause active"),
    );
    expect(pauseMessages).toHaveLength(1);
    logSpy.mockRestore();
  });
});

describe("Scheduler immediate resume on unpause via settings:updated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls schedule() immediately when globalPause transitions from true to false", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      globalPause: false,
    });
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });
    // Set running state without calling start() (avoids the initial schedule() call)
    (scheduler as any).running = true;

    // Fire the settings:updated event: true → false
    store._trigger("settings:updated", {
      settings: { globalPause: false },
      previous: { globalPause: true },
    });

    // schedule() is async, give it time to process
    await new Promise((r) => setTimeout(r, 50));

    // schedule() should have been called → task moved to in-progress
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "in-progress");
  });

  it("does NOT call schedule() when globalPause stays false (false → false)", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });
    (scheduler as any).running = true;

    // Fire the settings:updated event: false → false
    store._trigger("settings:updated", {
      settings: { globalPause: false },
      previous: { globalPause: false },
    });

    await new Promise((r) => setTimeout(r, 50));

    // schedule() should NOT have been called
    expect(store.listTasks).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("does NOT call schedule() when globalPause stays true (true → true)", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });
    (scheduler as any).running = true;

    // Fire the settings:updated event: true → true
    store._trigger("settings:updated", {
      settings: { globalPause: true },
      previous: { globalPause: true },
    });

    await new Promise((r) => setTimeout(r, 50));

    // schedule() should NOT have been called
    expect(store.listTasks).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("does NOT call schedule() when scheduler is not running", async () => {
    const store = createMockStore();
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });
    // running = false (default)

    // Fire the settings:updated event: true → false
    store._trigger("settings:updated", {
      settings: { globalPause: false },
      previous: { globalPause: true },
    });

    await new Promise((r) => setTimeout(r, 50));

    // schedule() should NOT have been called since scheduler is not running
    expect(store.listTasks).not.toHaveBeenCalled();
  });
});

describe("Scheduler in-review worktrees do not count against maxWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSchedule(scheduler: Scheduler): Promise<void> {
    (scheduler as any).running = true;
    await scheduler.schedule();
  }

  it("in-review task with worktree does NOT count against maxWorktrees", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-review", worktree: "/tmp/wt/kb-001" }),
      makeTask({ id: "KB-002", column: "in-review", worktree: "/tmp/wt/kb-002" }),
      makeTask({ id: "KB-003", column: "in-review", worktree: "/tmp/wt/kb-003" }),
      makeTask({ id: "KB-004", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 4,
      maxWorktrees: 2,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });
    const scheduler = new Scheduler(store);

    await runSchedule(scheduler);

    // 3 in-review worktrees should NOT block KB-004 — only in-progress counts
    expect(store.moveTask).toHaveBeenCalledWith("KB-004", "in-progress");
  });

  it("in-review tasks with worktrees do NOT block scheduling even when many exist", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-review", worktree: "/tmp/wt/kb-001" }),
      makeTask({ id: "KB-002", column: "in-review", worktree: "/tmp/wt/kb-002" }),
      makeTask({ id: "KB-003", column: "in-review", worktree: "/tmp/wt/kb-003" }),
      makeTask({ id: "KB-004", column: "in-review", worktree: "/tmp/wt/kb-004" }),
      makeTask({ id: "KB-005", column: "in-review", worktree: "/tmp/wt/kb-005" }),
      makeTask({ id: "KB-006", column: "in-progress" }),
      makeTask({ id: "KB-007", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 4,
      maxWorktrees: 2,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });
    const scheduler = new Scheduler(store);

    await runSchedule(scheduler);

    // 5 in-review + 1 in-progress = only 1 active worktree, room for KB-007
    expect(store.moveTask).toHaveBeenCalledWith("KB-007", "in-progress");
  });

  it("maxWorktrees correctly limits only in-progress tasks", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "in-progress" }),
      makeTask({ id: "KB-002", column: "in-progress" }),
      makeTask({ id: "KB-003", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 4,
      maxWorktrees: 2,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });
    const scheduler = new Scheduler(store);

    await runSchedule(scheduler);

    // 2 in-progress = 2 active worktrees, maxWorktrees: 2 — no room for KB-003
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});

describe("Scheduler semaphore-aware slot counting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runSchedule(scheduler: Scheduler): Promise<void> {
    (scheduler as any).running = true;
    await scheduler.schedule();
  }

  it("with semaphore, specifying tasks do not double-count against agentSlots", async () => {
    // Scenario: maxConcurrent=2, 1 specifying task holding a semaphore slot,
    // 0 in-progress. Semaphore has 1 available slot. Should allow 1 new task.
    const sem = new AgentSemaphore(2);
    // Simulate a specifying task holding a slot
    await sem.acquire();

    const tasks = [
      makeTask({ id: "KB-001", column: "triage", status: "specifying" }),
      makeTask({ id: "KB-002", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });
    const scheduler = new Scheduler(store, { maxConcurrent: 2, semaphore: sem });

    await runSchedule(scheduler);

    // With semaphore: agentSlots = inProgress(0), available = min(2-0, 4-0, 1) = 1
    // KB-002 should be scheduled
    expect(store.moveTask).toHaveBeenCalledWith("KB-002", "in-progress");

    sem.release();
  });

  it("with semaphore, fully occupied semaphore blocks scheduling even with no in-progress tasks", async () => {
    const sem = new AgentSemaphore(2);
    // Both slots held (e.g., by two specifying agents)
    await sem.acquire();
    await sem.acquire();

    const tasks = [
      makeTask({ id: "KB-001", column: "triage", status: "specifying" }),
      makeTask({ id: "KB-002", column: "triage", status: "specifying" }),
      makeTask({ id: "KB-003", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });
    const scheduler = new Scheduler(store, { maxConcurrent: 2, semaphore: sem });

    await runSchedule(scheduler);

    // semaphoreAvailable = 0 so nothing can start
    expect(store.moveTask).not.toHaveBeenCalled();

    sem.release();
    sem.release();
  });

  it("without semaphore, specifying tasks still reduce available slots (backward compat)", async () => {
    const tasks = [
      makeTask({ id: "KB-001", column: "triage", status: "specifying" }),
      makeTask({ id: "KB-002", column: "triage", status: "specifying" }),
      makeTask({ id: "KB-003", column: "todo" }),
    ];
    const store = createMockStore(tasks);
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });
    // No semaphore provided — fallback path
    const scheduler = new Scheduler(store, { maxConcurrent: 2 });

    await runSchedule(scheduler);

    // agentSlots = 0 + 2(specifying) = 2, available = min(2-2, 4-0, Inf) = 0
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});
