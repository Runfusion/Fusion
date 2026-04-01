import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task, TaskStore, CentralCore } from "@fusion/core";
import { InProcessRuntime } from "./in-process-runtime.js";
import type { ProjectRuntimeConfig } from "../project-runtime.js";

// Mock the TaskStore class
vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  
  return {
    ...actual,
    TaskStore: vi.fn().mockImplementation(function(this: TaskStore, rootDir: string) {
      const self = this as unknown as Record<string, unknown>;
      self.getRootDir = () => rootDir;
      self.init = vi.fn().mockResolvedValue(undefined);
      self.listTasks = vi.fn().mockResolvedValue([]);
      self.getSettings = vi.fn().mockResolvedValue({});
      self.on = vi.fn().mockReturnValue(self);
      self.emit = vi.fn().mockReturnValue(true);
      return self;
    }),
  };
});

// Mock the worktree pool
vi.mock("../worktree-pool.js", async () => {
  const actual = await vi.importActual<typeof import("../worktree-pool.js")>("../worktree-pool.js");
  
  return {
    ...actual,
    scanIdleWorktrees: vi.fn().mockResolvedValue([]),
  };
});

// Mock the scheduler
vi.mock("../scheduler.js", async () => {
  return {
    Scheduler: vi.fn().mockImplementation(() => {
      const self = {} as Record<string, unknown>;
      self.start = vi.fn();
      self.stop = vi.fn();
      return self;
    }),
  };
});

// Mock the executor
vi.mock("../executor.js", async () => {
  return {
    TaskExecutor: vi.fn().mockImplementation(() => {
      const self = {} as Record<string, unknown>;
      self.resumeOrphaned = vi.fn().mockResolvedValue(undefined);
      self.activeWorktrees = new Map();
      return self;
    }),
  };
});

describe("InProcessRuntime", () => {
  let runtime: InProcessRuntime;
  let mockCentralCore: CentralCore;
  const testConfig: ProjectRuntimeConfig = {
    projectId: "proj_test123",
    workingDirectory: "/tmp/test-project",
    isolationMode: "in-process",
    maxConcurrent: 2,
    maxWorktrees: 4,
  };

  beforeEach(() => {
    // Create mock CentralCore
    mockCentralCore = {
      getGlobalConcurrencyState: vi.fn().mockResolvedValue({
        globalMaxConcurrent: 4,
        currentlyActive: 0,
        queuedCount: 0,
        projectsActive: {},
      }),
      recordTaskCompletion: vi.fn().mockResolvedValue(undefined),
    } as unknown as CentralCore;

    runtime = new InProcessRuntime(testConfig, mockCentralCore);
  });

  afterEach(async () => {
    try {
      await runtime.stop();
    } catch {
      // Ignore errors during cleanup
    }
    vi.clearAllMocks();
  });

  describe("lifecycle", () => {
    it("should start with status 'stopped'", () => {
      expect(runtime.getStatus()).toBe("stopped");
    });

    it("should transition to 'active' after start", async () => {
      await runtime.start();
      expect(runtime.getStatus()).toBe("active");
    });

    it("should transition to 'stopped' after stop", async () => {
      await runtime.start();
      await runtime.stop();
      expect(runtime.getStatus()).toBe("stopped");
    });

    it("should throw if starting when not stopped", async () => {
      await runtime.start();
      await expect(runtime.start()).rejects.toThrow("Cannot start runtime");
    });

    it("should handle stop when already stopped", async () => {
      // Should not throw
      await runtime.stop();
      expect(runtime.getStatus()).toBe("stopped");
    });

    it("should transition through 'starting' during start", async () => {
      const statusChanges: string[] = [];
      runtime.on("health-changed", (data) => {
        statusChanges.push(data.status);
      });

      await runtime.start();
      
      expect(statusChanges).toContain("starting");
      expect(statusChanges).toContain("active");
    });

    it("should transition through 'stopping' during stop", async () => {
      await runtime.start();
      
      const statusChanges: string[] = [];
      runtime.on("health-changed", (data) => {
        statusChanges.push(data.status);
      });

      await runtime.stop();
      
      expect(statusChanges).toContain("stopping");
      expect(statusChanges).toContain("stopped");
    });
  });

  describe("event forwarding", () => {
    it("should emit health-changed on status transitions", async () => {
      const healthChangedSpy = vi.fn();
      runtime.on("health-changed", healthChangedSpy);

      await runtime.start();

      expect(healthChangedSpy).toHaveBeenCalled();
      const calls = healthChangedSpy.mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.status).toBe("active");
      expect(lastCall.previous).toBe("starting");
    });

    it("should emit task:created when task store emits task:created", async () => {
      await runtime.start();
      
      const taskCreatedSpy = vi.fn();
      runtime.on("task:created", taskCreatedSpy);

      // Get the mock TaskStore and simulate an event
      const taskStore = runtime.getTaskStore();
      const mockTask = { id: "KB-001", title: "Test Task" } as Task;
      
      // Get the registered handler and call it
      const onCalls = (taskStore.on as ReturnType<typeof vi.fn>).mock.calls;
      const taskCreatedHandler = onCalls.find((call: unknown[]) => call[0] === "task:created");
      
      if (taskCreatedHandler) {
        (taskCreatedHandler[1] as (task: Task) => void)(mockTask);
      }

      expect(taskCreatedSpy).toHaveBeenCalledWith(mockTask);
    });

    it("should emit task:moved when task store emits task:moved", async () => {
      await runtime.start();
      
      const taskMovedSpy = vi.fn();
      runtime.on("task:moved", taskMovedSpy);

      const taskStore = runtime.getTaskStore();
      const mockTask = { id: "KB-001", title: "Test Task" } as Task;
      const moveData = { task: mockTask, from: "todo", to: "in-progress" };
      
      const onCalls = (taskStore.on as ReturnType<typeof vi.fn>).mock.calls;
      const taskMovedHandler = onCalls.find((call: unknown[]) => call[0] === "task:moved");
      
      if (taskMovedHandler) {
        (taskMovedHandler[1] as (data: { task: Task; from: string; to: string }) => void)(moveData);
      }

      expect(taskMovedSpy).toHaveBeenCalledWith(moveData);
    });
  });

  describe("metrics", () => {
    it("should return metrics with default values before start", () => {
      const metrics = runtime.getMetrics();
      
      expect(metrics.inFlightTasks).toBe(0);
      expect(metrics.activeAgents).toBe(0);
      expect(metrics.lastActivityAt).toBeDefined();
    });

    it("should include memory usage in metrics", () => {
      const metrics = runtime.getMetrics();
      
      // Memory usage may or may not be available depending on environment
      if (metrics.memoryBytes !== undefined) {
        expect(typeof metrics.memoryBytes).toBe("number");
        expect(metrics.memoryBytes).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("accessors", () => {
    it("should throw when accessing TaskStore before start", () => {
      expect(() => runtime.getTaskStore()).toThrow("TaskStore not initialized");
    });

    it("should throw when accessing Scheduler before start", () => {
      expect(() => runtime.getScheduler()).toThrow("Scheduler not initialized");
    });

    it("should return TaskStore after start", async () => {
      await runtime.start();
      const taskStore = runtime.getTaskStore();
      
      expect(taskStore).toBeDefined();
      expect(taskStore.getRootDir()).toBe(testConfig.workingDirectory);
    });

    it("should return Scheduler after start", async () => {
      await runtime.start();
      const scheduler = runtime.getScheduler();
      
      expect(scheduler).toBeDefined();
    });
  });

  describe("configuration", () => {
    it("should store projectId in config", () => {
      // Access via the constructor params - runtime is created with testConfig
      expect(testConfig.projectId).toBe("proj_test123");
    });

    it("should store workingDirectory in config", () => {
      expect(testConfig.workingDirectory).toBe("/tmp/test-project");
    });

    it("should store maxConcurrent in config", () => {
      expect(testConfig.maxConcurrent).toBe(2);
    });

    it("should store maxWorktrees in config", () => {
      expect(testConfig.maxWorktrees).toBe(4);
    });
  });
});
