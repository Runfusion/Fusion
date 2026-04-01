import { describe, it, expect, vi, beforeEach } from "vitest";
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
    it("moves task to triage when task directory is missing", async () => {
      const tasks = [
        createMockTask({ id: "FN-001", column: "todo", dependencies: [] }),
      ];
      
      const store = createMockStore({
        listTasks: vi.fn().mockResolvedValue(tasks),
        getSettings: vi.fn().mockResolvedValue({ maxConcurrent: 2, maxWorktrees: 4 }),
        updateTask: vi.fn().mockResolvedValue(undefined),
        getRootDir: vi.fn().mockReturnValue("/test/project"),
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
      await movedHandler({ task, to: "in-progress" });

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
      await movedHandler({ task, to: "in-progress" });

      expect(mockMissionStore.getFeatureByTaskId).toHaveBeenCalledWith("FN-001");
      expect(mockMissionStore.updateFeatureStatus).not.toHaveBeenCalled();
    });

    it("triggers feature done update when task with sliceId moves to done", async () => {
      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue({ id: "F-001", sliceId: "SL-001" }),
        updateFeatureStatus: vi.fn().mockReturnValue({ id: "F-001", status: "done" }),
        getSlice: vi.fn().mockReturnValue({ id: "SL-001", milestoneId: "MS-001" }),
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
        computeSliceStatus: vi.fn().mockReturnValue("active"),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      // Trigger task:moved event by calling the registered handler
      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];
      expect(movedHandler).toBeDefined();

      // Simulate task moving to done with sliceId
      const task = createMockTask({ id: "FN-001", sliceId: "SL-001" });
      await movedHandler({ task, to: "done" });

      expect(mockMissionStore.getFeatureByTaskId).toHaveBeenCalledWith("FN-001");
      expect(mockMissionStore.updateFeatureStatus).toHaveBeenCalledWith("F-001", "done");
    });

    it("auto-advances when slice completes and autoAdvance is enabled", async () => {
      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue({ id: "F-001", sliceId: "SL-001" }),
        updateFeatureStatus: vi.fn().mockReturnValue({ id: "F-001", status: "done" }),
        getSlice: vi.fn().mockReturnValue({ id: "SL-001", milestoneId: "MS-001" }),
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
        computeSliceStatus: vi.fn().mockReturnValue("complete"),
        getMission: vi.fn().mockReturnValue({ id: "M-001", autoAdvance: true }),
        findNextPendingSlice: vi.fn().mockReturnValue({ id: "SL-002" }),
        activateSlice: vi.fn().mockReturnValue({ id: "SL-002", status: "active" }),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      // Trigger task:moved event
      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      const task = createMockTask({ id: "FN-001", sliceId: "SL-001" });
      await movedHandler({ task, to: "done" });

      expect(mockMissionStore.computeSliceStatus).toHaveBeenCalledWith("SL-001");
      expect(mockMissionStore.getMission).toHaveBeenCalledWith("M-001");
      expect(mockMissionStore.findNextPendingSlice).toHaveBeenCalledWith("M-001");
      expect(mockMissionStore.activateSlice).toHaveBeenCalledWith("SL-002");
    });

    it("does not auto-advance when autoAdvance is disabled", async () => {
      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue({ id: "F-001", sliceId: "SL-001" }),
        updateFeatureStatus: vi.fn().mockReturnValue({ id: "F-001", status: "done" }),
        getSlice: vi.fn().mockReturnValue({ id: "SL-001", milestoneId: "MS-001" }),
        getMilestone: vi.fn().mockReturnValue({ id: "MS-001", missionId: "M-001" }),
        computeSliceStatus: vi.fn().mockReturnValue("complete"),
        getMission: vi.fn().mockReturnValue({ id: "M-001", autoAdvance: false }),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      // Trigger task:moved event
      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      const task = createMockTask({ id: "FN-001", sliceId: "SL-001" });
      await movedHandler({ task, to: "done" });

      expect(mockMissionStore.getMission).toHaveBeenCalledWith("M-001");
      expect(mockMissionStore.findNextPendingSlice).not.toHaveBeenCalled();
      expect(mockMissionStore.activateSlice).not.toHaveBeenCalled();
    });

    it("handles task with sliceId but no linked feature gracefully", async () => {
      const mockMissionStore = createMockMissionStore({
        getFeatureByTaskId: vi.fn().mockReturnValue(undefined),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      // Trigger task:moved event
      const onCalls = (store.on as any).mock.calls;
      const movedHandler = onCalls.find((call: any) => call[0] === "task:moved")?.[1];

      const task = createMockTask({ id: "FN-001", sliceId: "SL-001" });
      await movedHandler({ task, to: "done" });

      expect(mockMissionStore.getFeatureByTaskId).toHaveBeenCalledWith("FN-001");
      expect(mockMissionStore.updateFeatureStatus).not.toHaveBeenCalled();
    });

    it("activateNextPendingSlice finds and activates correct slice", async () => {
      const nextSlice = { id: "SL-002", status: "pending" };
      const mockMissionStore = createMockMissionStore({
        findNextPendingSlice: vi.fn().mockReturnValue(nextSlice),
        activateSlice: vi.fn().mockReturnValue({ ...nextSlice, status: "active" }),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const result = await scheduler.activateNextPendingSlice("M-001");

      expect(mockMissionStore.findNextPendingSlice).toHaveBeenCalledWith("M-001");
      expect(mockMissionStore.activateSlice).toHaveBeenCalledWith("SL-002");
      expect(result).toEqual({ id: "SL-002", status: "active" });
    });

    it("activateNextPendingSlice returns null when no pending slices", async () => {
      const mockMissionStore = createMockMissionStore({
        findNextPendingSlice: vi.fn().mockReturnValue(undefined),
      });

      const store = createMockStore();
      const scheduler = new Scheduler(store, { missionStore: mockMissionStore as any });

      const result = await scheduler.activateNextPendingSlice("M-001");

      expect(result).toBeNull();
      expect(mockMissionStore.activateSlice).not.toHaveBeenCalled();
    });
  });
});
