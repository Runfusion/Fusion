import { describe, it, expect, vi } from "vitest";
import { Scheduler, pathsOverlap } from "./scheduler.js";
import type { TaskStore, Task } from "@kb/core";

// Helper to create mock tasks
function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "KB-001",
    description: "Test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  } as Task;
}

// Mock store factory
function createMockStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    listTasks: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({}),
    updateTask: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    parseFileScopeFromPrompt: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  } as unknown as TaskStore;
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

describe("Scheduler", () => {
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
        createMockTask({ id: "KB-001", column: "in-progress" }),
        createMockTask({ id: "KB-002", column: "in-progress" }),
        createMockTask({ id: "KB-003", column: "todo" }),
        createMockTask({ id: "KB-004", column: "todo" }),
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
        createMockTask({ id: "KB-001", column: "in-progress" }),
        createMockTask({ id: "KB-002", column: "in-progress" }),
        createMockTask({ id: "KB-003", column: "in-progress" }),
        createMockTask({ id: "KB-004", column: "in-progress" }),
        createMockTask({ id: "KB-005", column: "todo" }),
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
  });

  describe("semaphore integration", () => {
    it("respects semaphore available count", async () => {
      const semaphore = {
        availableCount: 0,
        totalCount: 2,
        acquire: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(),
      };
      
      const tasks = [
        createMockTask({ id: "KB-001", column: "in-progress" }),
        createMockTask({ id: "KB-002", column: "in-progress" }),
        createMockTask({ id: "KB-003", column: "todo" }),
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
        listTasks: vi.fn().mockResolvedValue([createMockTask({ id: "KB-001", column: "todo" })]),
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
  });

  describe("engine pause", () => {
    it("halts new scheduling when enginePaused is active", async () => {
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([createMockTask({ id: "KB-001", column: "todo" })]),
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
});
