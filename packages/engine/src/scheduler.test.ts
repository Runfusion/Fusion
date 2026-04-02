import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrMonitor } from "./pr-monitor.js";
import { Scheduler, pathsOverlap } from "./scheduler.js";
import { AgentSemaphore } from "./concurrency.js";
import type { TaskStore, Task } from "@fusion/core";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

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
    logEntry: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/test/project"),
    getTasksDir: vi.fn().mockReturnValue("/test/project/.fusion/tasks"),
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

  describe("event-driven scheduling", () => {
    it("registers task:created event listener", () => {
      const store = createMockStore();
      new Scheduler(store);
      // Verify task:created listener is registered
      expect(store.on).toHaveBeenCalledWith("task:created", expect.any(Function));
    });

    it("triggers scheduling immediately when task:created event fires", async () => {
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

      // Find and call the task:created handler
      const onCalls = (store.on as any).mock.calls;
      const createdHandler = onCalls.find((call: any) => call[0] === "task:created")?.[1];
      expect(createdHandler).toBeDefined();

      // Simulate task:created event
      const newTask = createMockTask({ id: "FN-002", column: "todo" });
      await createdHandler(newTask);

      // Verify schedule() was called (moveTask should be called since task can start)
      expect(store.moveTask).toHaveBeenCalledWith("FN-002", "in-progress");
    });

    it("registers task:moved event listener", () => {
      const store = createMockStore();
      new Scheduler(store);
      // Verify task:moved listener is registered
      expect(store.on).toHaveBeenCalledWith("task:moved", expect.any(Function));
    });

    it("triggers scheduling immediately when task:moved to done event fires", async () => {
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue([
          createMockTask({ id: "FN-001", column: "done", dependencies: [] }), // Completed dep
          createMockTask({ id: "FN-002", column: "todo", dependencies: ["FN-001"] }), // Waiting on FN-001
        ]),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        moveTask: vi.fn().mockResolvedValue(undefined),
      });

      const scheduler = new Scheduler(store);
      scheduler.start();

      // Find and call the task:moved handler
      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];
      expect(movedHandler).toBeDefined();

      // Simulate task:moved to done event
      const doneTask = createMockTask({ id: "FN-001", column: "todo" });
      await movedHandler({ task: doneTask, from: "in-progress", to: "done" });

      // Verify schedule() was called - FN-002 should now be able to start
      expect(store.moveTask).toHaveBeenCalledWith("FN-002", "in-progress");
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

      expect(moveTask).toHaveBeenCalledWith("FN-010", "in-progress");
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
      expect(moveTask).toHaveBeenCalledWith("FN-004", "in-progress");
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
      expect(updateTask).toHaveBeenCalledWith("FN-005", { status: "queued" });
      // No filesystem validation should occur (no move to triage)
      expect(moveTask).not.toHaveBeenCalledWith("FN-005", "triage");
    });
  });

  describe("pr monitoring", () => {
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
  });

  describe("mission integration", () => {
    // Helper to create mock MissionStore
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
        ...overrides,
      };
    }

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

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      // Trigger task:moved event by calling the registered handler
      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];
      expect(movedHandler).toBeDefined();

      // Simulate task moving to in-progress with sliceId
      const task = createMockTask({ id: "FN-001", sliceId: "SL-001" });
      movedHandler({ task, to: "in-progress" });
      await Promise.resolve();

      expect(mockMissionStore.getFeatureByTaskId).toHaveBeenCalledWith("FN-001");
      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-001", "in-progress");
    });

    it("does not update feature status when already past triaged", async () => {
      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue({ id: "F-001", sliceId: "SL-001", status: "in-progress" }),
        updateFeatureStatus: vi.fn(),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      const task = createMockTask({ id: "FN-001", sliceId: "SL-001" });
      movedHandler({ task, to: "in-progress" });
      await Promise.resolve();

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

      const store = createMockStore();
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

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const slice = { id: "SL-001", milestoneId: "MS-001", status: "complete" } as any;
      await scheduler.onSliceComplete(slice);

      expect(mockMissionStore.getMission).toHaveBeenCalledWith("M-001");
      expect(mockMissionStore.activateSlice).not.toHaveBeenCalled();
    });

    it("skips mission progression when task sliceId mismatches linked feature sliceId", async () => {
      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue({ id: "F-001", sliceId: "SL-OTHER" }),
        updateFeatureStatus: vi.fn(),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      const task = createMockTask({ id: "FN-001", sliceId: "SL-001" });
      movedHandler({ task, from: "in-progress", to: "done" });
      await Promise.resolve();

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
});
