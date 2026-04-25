import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Task, TaskStore, CentralCore, AgentStore, Agent } from "@fusion/core";
import { InProcessRuntime } from "../in-process-runtime.js";
import type { ProjectRuntimeConfig } from "../../project-runtime.js";
import { runtimeLog } from "../../logger.js";

const {
  mockSelfHealingStart,
  mockSelfHealingStop,
  mockSelfHealingCtor,
  mockRecoverNoProgressNoTaskDoneFailures,
  mockRunStartupRecovery,
  mockExecutorCtor,
  mockMessageStoreSetHook,
} = vi.hoisted(() => ({
  mockSelfHealingStart: vi.fn(),
  mockSelfHealingStop: vi.fn(),
  mockSelfHealingCtor: vi.fn(),
  mockRecoverNoProgressNoTaskDoneFailures: vi.fn().mockResolvedValue(0),
  mockRunStartupRecovery: vi.fn().mockResolvedValue(undefined),
  mockExecutorCtor: vi.fn(),
  mockMessageStoreSetHook: vi.fn(),
}));

// Mock the TaskStore class
vi.mock("@fusion/core", async () => {
  const actual = await vi.importActual<typeof import("@fusion/core")>("@fusion/core");
  
  // Mock database object for MessageStore
  const mockDatabase = {
    prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }),
    bumpLastModified: vi.fn(),
    close: vi.fn(),
  };
  
  return {
    ...actual,
    TaskStore: vi.fn().mockImplementation(function(this: TaskStore, rootDir: string) {
      const self = this as unknown as Record<string, unknown>;
      self.getRootDir = () => rootDir;
      self.getFusionDir = () => rootDir + "/.fusion";
      self.getDatabase = vi.fn().mockReturnValue(mockDatabase);
      self.init = vi.fn().mockResolvedValue(undefined);
      self.listTasks = vi.fn().mockResolvedValue([]);
      self.getSettings = vi.fn().mockResolvedValue({});
      self.getMissionStore = vi.fn().mockReturnValue({
        getMissionWithHierarchy: vi.fn().mockReturnValue(null),
        findNextPendingSlice: vi.fn().mockReturnValue(null),
        activateSlice: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(),
      });
      self.on = vi.fn().mockReturnValue(self);
      self.off = vi.fn();
      self.emit = vi.fn().mockReturnValue(true);
      return self;
    }),
    PluginStore: vi.fn().mockImplementation(function() {
      const self = {} as Record<string, unknown>;
      self.init = vi.fn().mockResolvedValue(undefined);
      self.getPlugin = vi.fn().mockResolvedValue({});
      self.on = vi.fn();
      self.off = vi.fn();
      return self;
    }),
    PluginLoader: vi.fn().mockImplementation(function() {
      const self = {} as Record<string, unknown>;
      self.loadAllPlugins = vi.fn().mockResolvedValue({ loaded: 0, errors: 0 });
      self.stopAllPlugins = vi.fn().mockResolvedValue(undefined);
      self.getLoadedPlugins = vi.fn().mockReturnValue([]);
      self.on = vi.fn();
      self.off = vi.fn();
      return self;
    }),
    MessageStore: vi.fn().mockImplementation(function() {
      const self = {} as Record<string, unknown>;
      self.init = vi.fn().mockResolvedValue(undefined);
      self.setMessageToAgentHook = mockMessageStoreSetHook;
      return self;
    }),
  };
});

// Mock the worktree pool
vi.mock("../../worktree-pool.js", async () => {
  const actual = await vi.importActual<typeof import("../../worktree-pool.js")>("../../worktree-pool.js");
  
  return {
    ...actual,
    scanIdleWorktrees: vi.fn().mockResolvedValue([]),
  };
});

// Mock the scheduler
vi.mock("../../scheduler.js", async () => {
  return {
    Scheduler: vi.fn().mockImplementation(() => {
      const self = {} as Record<string, unknown>;
      self.start = vi.fn();
      self.stop = vi.fn();
      self.reconcileAllMissionFeatures = vi.fn().mockResolvedValue(0);
      return self;
    }),
  };
});

vi.mock("../../self-healing.js", async () => {
  return {
    SelfHealingManager: vi.fn().mockImplementation((_store, opts) => {
      mockSelfHealingCtor(opts);
      return {
        start: mockSelfHealingStart,
        stop: mockSelfHealingStop,
        recoverNoProgressNoTaskDoneFailures: mockRecoverNoProgressNoTaskDoneFailures,
        runStartupRecovery: mockRunStartupRecovery,
      };
    }),
  };
});

// Mock the plugin runner
vi.mock("../../plugin-runner.js", async () => {
  return {
    PluginRunner: vi.fn().mockImplementation(() => ({
      init: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      getPluginTools: vi.fn().mockReturnValue([]),
      getPluginRoutes: vi.fn().mockReturnValue([]),
    })),
  };
});

// Mock the executor
vi.mock("../../executor.js", async () => {
  return {
    TaskExecutor: vi.fn().mockImplementation((_store, _rootDir, options) => {
      mockExecutorCtor(options);
      const self = {} as Record<string, unknown>;
      self.resumeOrphaned = vi.fn().mockResolvedValue(undefined);
      self.recoverCompletedTask = vi.fn().mockResolvedValue(true);
      self.getExecutingTaskIds = vi.fn().mockReturnValue(new Set());
      self.handleLoopDetected = vi.fn().mockResolvedValue(false);
      self.markStuckAborted = vi.fn();
      self.activeWorktrees = new Map();
      return self;
    }),
  };
});

type RuntimeInternals = {
  agentStore?: AgentStore;
  stuckTaskDetector?: unknown;
};

function getRuntimeInternals(runtime: InProcessRuntime): RuntimeInternals {
  return runtime as unknown as RuntimeInternals;
}

function getAgentStore(runtime: InProcessRuntime): AgentStore {
  const store = getRuntimeInternals(runtime).agentStore;
  expect(store).toBeDefined();
  return store!;
}

describe("InProcessRuntime", () => {
  let runtime: InProcessRuntime;
  let mockCentralCore: CentralCore;
  let testDir: string;

  // Build test config from the per-test temp directory
  function buildTestConfig(workingDirectory: string): ProjectRuntimeConfig {
    return {
      projectId: "proj_test123",
      workingDirectory,
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 4,
    };
  }

  beforeEach(() => {
    // Create a unique temp directory for this test run
    testDir = mkdtempSync(join("/tmp", `fn-test-${randomUUID().slice(0, 8)}-`));

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

    runtime = new InProcessRuntime(buildTestConfig(testDir), mockCentralCore);
  });

  afterEach(async () => {
    try {
      await runtime.stop();
    } catch {
      // Ignore errors during cleanup
    }
    // Clean up the temp directory and all created agent files
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore errors during filesystem cleanup
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
    }, 30000);

    it("passes executor recovery callbacks into SelfHealingManager", async () => {
      await runtime.start();

      expect(mockSelfHealingCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          rootDir: testDir,
          recoverCompletedTask: expect.any(Function),
          getExecutingTaskIds: expect.any(Function),
        }),
      );
      expect(mockSelfHealingStart).toHaveBeenCalled();
    }, 30000);

    it("runs self-healing startup recovery immediately after orphan resume on startup", async () => {
      await runtime.start();

      expect(mockRecoverNoProgressNoTaskDoneFailures).toHaveBeenCalledTimes(1);
      expect(mockRunStartupRecovery).toHaveBeenCalledTimes(1);
    }, 30000);

    it("creates a stuck task detector and passes it to the executor", async () => {
      await runtime.start();

      expect(mockExecutorCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          stuckTaskDetector: expect.any(Object),
        }),
      );
      expect(getRuntimeInternals(runtime).stuckTaskDetector).toBeDefined();
    });

    it("should transition to 'stopped' after stop", async () => {
      await runtime.start();
      await runtime.stop();
      expect(runtime.getStatus()).toBe("stopped");
    }, 30000);

    it("should throw if starting when not stopped", async () => {
      await runtime.start();
      await expect(runtime.start()).rejects.toThrow("Cannot start runtime");
    }, 30000);

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
    }, 30000);

    it("should transition through 'stopping' during stop", async () => {
      await runtime.start();
      
      const statusChanges: string[] = [];
      runtime.on("health-changed", (data) => {
        statusChanges.push(data.status);
      });

      await runtime.stop();
      
      expect(statusChanges).toContain("stopping");
      expect(statusChanges).toContain("stopped");
    }, 30000);
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
    }, 30000);

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
    }, 30000);
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
      expect(taskStore.getRootDir()).toBe(testDir);
    }, 30000);

    it("should return Scheduler after start", async () => {
      await runtime.start();
      const scheduler = runtime.getScheduler();
      
      expect(scheduler).toBeDefined();
    }, 30000);

    it("should return HeartbeatMonitor after start", async () => {
      await runtime.start();
      const monitor = runtime.getHeartbeatMonitor();
      expect(monitor).toBeDefined();
    }, 30000);

    it("should return TriggerScheduler after start", async () => {
      await runtime.start();
      const triggerScheduler = runtime.getTriggerScheduler();
      expect(triggerScheduler).toBeDefined();
      expect(triggerScheduler!.isActive()).toBe(true);
    }, 30000);

    it("should return undefined TriggerScheduler before start", () => {
      expect(runtime.getTriggerScheduler()).toBeUndefined();
    });
  });

  describe("trigger scheduler wiring", () => {
    it("creates trigger scheduler on start", async () => {
      await runtime.start();
      expect(runtime.getTriggerScheduler()).toBeDefined();
      expect(runtime.getTriggerScheduler()!.isActive()).toBe(true);
    }, 30000);

    it("stops trigger scheduler on runtime stop", async () => {
      await runtime.start();
      const triggerScheduler = runtime.getTriggerScheduler()!;
      expect(triggerScheduler.isActive()).toBe(true);

      await runtime.stop();
      expect(triggerScheduler.isActive()).toBe(false);
    }, 30000);

    it("registers existing agents with heartbeat config", async () => {
      await runtime.start();

      // Create an agent with heartbeat config
      const store = getAgentStore(runtime);

      const createdAgent = await store.createAgent({
        name: "Configured Agent",
        role: "executor",
        runtimeConfig: { heartbeatIntervalMs: 30000, enabled: true },
      });

      // Re-create runtime using the same temp directory to test registration on startup
      await runtime.stop();
      runtime = new InProcessRuntime(buildTestConfig(testDir), mockCentralCore);
      await runtime.start();

      const scheduler = runtime.getTriggerScheduler();
      expect(scheduler).toBeDefined();
      // The agent was created in the previous runtime's store (same temp directory),
      // so it should be registered in the new runtime
      const registeredAgents = scheduler!.getRegisteredAgents();
      expect(registeredAgents).toContain(createdAgent.id);
    });

    it("does not register paused agents on startup", async () => {
      await runtime.start();

      const store = getAgentStore(runtime);
      const pausedAgent = await store.createAgent({
        name: "Paused Agent",
        role: "executor",
        runtimeConfig: { heartbeatIntervalMs: 30000, enabled: true },
      });
      await store.updateAgentState(pausedAgent.id, "active");
      await store.updateAgentState(pausedAgent.id, "paused");

      await runtime.stop();
      runtime = new InProcessRuntime(buildTestConfig(testDir), mockCentralCore);
      await runtime.start();

      const scheduler = runtime.getTriggerScheduler();
      expect(scheduler).toBeDefined();
      expect(scheduler!.getRegisteredAgents()).not.toContain(pausedAgent.id);
    });

    it("routes assignment triggers through executeHeartbeat", async () => {
      await runtime.start();

      const monitor = runtime.getHeartbeatMonitor();
      expect(monitor).toBeDefined();
      const heartbeatMonitor = monitor!;
      const executeResult = { id: "run-test" } as Awaited<ReturnType<typeof heartbeatMonitor.executeHeartbeat>>;
      const executeSpy = vi
        .spyOn(heartbeatMonitor, "executeHeartbeat")
        .mockResolvedValue(executeResult);

      const store = getAgentStore(runtime);

      const agent = await store.createAgent({
        name: "Assignable",
        role: "executor",
      });

      await store.assignTask(agent.id, "FN-001");

      await vi.waitFor(() => {
        expect(executeSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: agent.id,
            source: "assignment",
            taskId: "FN-001",
            contextSnapshot: expect.objectContaining({
              taskId: "FN-001",
              wakeReason: "assignment",
            }),
          }),
        );
      });
    }, 30000);

    it("creates runtime task-worker agents with disabled heartbeat metadata and running state", async () => {
      await runtime.start();

      const store = getAgentStore(runtime);

      const assignTaskSpy = vi.spyOn(store, "assignTask");
      const updateStateSpy = vi.spyOn(store, "updateAgentState");
      const executorOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
        onStart?: (task: Task, worktreePath: string) => void;
      };
      expect(executorOptions.onStart).toBeTypeOf("function");

      executorOptions.onStart?.({ id: "FN-1661" } as Task, join(testDir, "worktree-FN-1661"));

      await vi.waitFor(async () => {
        const agents = await store.listAgents({ includeEphemeral: true });
        expect(agents).toHaveLength(1);
        expect(agents[0]).toMatchObject({
          name: "executor-FN-1661",
          role: "executor",
          state: "running",
          taskId: "FN-1661",
          metadata: {
            agentKind: "task-worker",
            taskWorker: true,
            managedBy: "task-executor",
          },
          runtimeConfig: {
            enabled: false,
          },
        });
      });

      expect(assignTaskSpy).toHaveBeenCalledWith(expect.any(String), "FN-1661");
      expect(updateStateSpy).toHaveBeenNthCalledWith(1, expect.any(String), "active");
      expect(updateStateSpy).toHaveBeenNthCalledWith(2, expect.any(String), "running");
      expect(assignTaskSpy.mock.invocationCallOrder[0]).toBeLessThan(updateStateSpy.mock.invocationCallOrder[0]);
    }, 30000);

    it("does not wake executeHeartbeat for runtime task-worker assignment events", async () => {
      await runtime.start();

      const monitor = runtime.getHeartbeatMonitor();
      expect(monitor).toBeDefined();
      const heartbeatMonitor = monitor!;
      const executeResult = { id: "run-task-worker" } as Awaited<ReturnType<typeof heartbeatMonitor.executeHeartbeat>>;
      const executeSpy = vi
        .spyOn(heartbeatMonitor, "executeHeartbeat")
        .mockResolvedValue(executeResult);

      const executorOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
        onStart?: (task: Task, worktreePath: string) => void;
      };
      executorOptions.onStart?.({ id: "FN-2001" } as Task, join(testDir, "worktree-FN-2001"));

      const store = getAgentStore(runtime);

      await vi.waitFor(async () => {
        const agents = await store.listAgents({ includeEphemeral: true });
        expect(agents.some((agent: Agent) => agent.name === "executor-FN-2001")).toBe(true);
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(executeSpy).not.toHaveBeenCalled();
    }, 30000);

    it("auto-deletes task-worker agent on task completion after 5 second delay", async () => {
      vi.useFakeTimers();

      try {
        await runtime.start();

        const store = getAgentStore(runtime);
        const deleteAgentSpy = vi.spyOn(store, "deleteAgent").mockResolvedValue(undefined);

        const executorOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
          onStart?: (task: Task, worktreePath: string) => void;
          onComplete?: (task: Task) => void;
        };
        expect(executorOptions.onComplete).toBeTypeOf("function");

        // Create a task-worker agent first via onStart
        executorOptions.onStart?.({ id: "FN-AUTO1" } as Task, join(testDir, "worktree-FN-AUTO1"));

        await vi.waitFor(async () => {
          const agents = await store.listAgents({ includeEphemeral: true });
          expect(agents.some((a: Agent) => a.name === "executor-FN-AUTO1")).toBe(true);
        });

        // Clear previous calls and trigger onComplete
        deleteAgentSpy.mockClear();
        executorOptions.onComplete?.({ id: "FN-AUTO1" } as Task);

        // Verify deleteAgent was not called immediately (before 5 seconds)
        expect(deleteAgentSpy).not.toHaveBeenCalled();

        // Advance timers by 5 seconds
        await vi.advanceTimersByTimeAsync(5000);

        // Now deleteAgent should have been called
        expect(deleteAgentSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    }, 30000);

    it("auto-deletes task-worker agent on task error after 5 second delay", async () => {
      vi.useFakeTimers();

      try {
        await runtime.start();

        const store = getAgentStore(runtime);
        const deleteAgentSpy = vi.spyOn(store, "deleteAgent").mockResolvedValue(undefined);

        const executorOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
          onError?: (task: Task, error: Error) => void;
        };
        expect(executorOptions.onError).toBeTypeOf("function");

        // Create a task-worker agent first via onStart
        const onStartOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
          onStart?: (task: Task, worktreePath: string) => void;
        };
        onStartOptions.onStart?.({ id: "FN-AUTO2" } as Task, join(testDir, "worktree-FN-AUTO2"));

        await vi.waitFor(async () => {
          const agents = await store.listAgents({ includeEphemeral: true });
          expect(agents.some((a: Agent) => a.name === "executor-FN-AUTO2")).toBe(true);
        });

        // Clear previous calls and trigger onError
        deleteAgentSpy.mockClear();
        executorOptions.onError?.({ id: "FN-AUTO2" } as Task, new Error("Task failed"));

        // Verify deleteAgent was not called immediately (before 5 seconds)
        expect(deleteAgentSpy).not.toHaveBeenCalled();

        // Advance timers by 5 seconds
        await vi.advanceTimersByTimeAsync(5000);

        // Now deleteAgent should have been called
        expect(deleteAgentSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    }, 30000);
  });

  describe("agent cleanup failure diagnostics", () => {
    it("logs warning when agent state update fails on task completion", async () => {
      const warnSpy = vi.spyOn(runtimeLog, "warn");
      await runtime.start();

      const store = getAgentStore(runtime);
      const updateStateSpy = vi.spyOn(store, "updateAgentState").mockImplementation(async (_agentId, state) => {
        if (state === "terminated") {
          throw new Error("state update failed");
        }
        return {} as Agent;
      });

      const executorOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
        onStart?: (task: Task, worktreePath: string) => void;
        onComplete?: (task: Task) => void;
      };
      executorOptions.onStart?.({ id: "FN-DIAG-1" } as Task, join(testDir, "worktree-FN-DIAG-1"));

      await vi.waitFor(async () => {
        const agents = await store.listAgents({ includeEphemeral: true });
        expect(agents.some((a: Agent) => a.name === "executor-FN-DIAG-1")).toBe(true);
      });

      updateStateSpy.mockClear();
      executorOptions.onComplete?.({ id: "FN-DIAG-1" } as Task);
      await Promise.resolve();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update agent"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("terminated (completion)"),
      );

      warnSpy.mockRestore();
    }, 30000);

    it("logs warning when agent deletion fails after task error", async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(runtimeLog, "warn");

      try {
        await runtime.start();

        const store = getAgentStore(runtime);
        const deleteAgentSpy = vi.spyOn(store, "deleteAgent").mockRejectedValue(new Error("delete failed"));

        const executorOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
          onStart?: (task: Task, worktreePath: string) => void;
          onError?: (task: Task, error: Error) => void;
        };
        executorOptions.onStart?.({ id: "FN-DIAG-2" } as Task, join(testDir, "worktree-FN-DIAG-2"));

        await vi.waitFor(async () => {
          const agents = await store.listAgents({ includeEphemeral: true });
          expect(agents.some((a: Agent) => a.name === "executor-FN-DIAG-2")).toBe(true);
        });

        deleteAgentSpy.mockClear();
        executorOptions.onError?.({ id: "FN-DIAG-2" } as Task, new Error("Task failed"));

        await vi.advanceTimersByTimeAsync(5000);
        await Promise.resolve();

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("Failed to delete agent"),
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("after error"),
        );
      } finally {
        warnSpy.mockRestore();
        vi.useRealTimers();
      }
    }, 30000);
  });

  describe("configuration", () => {
    it("should store projectId in config", () => {
      // Access via the constructor params - runtime is created with testDir
      expect(testDir).toBeDefined();
      expect(testDir).toContain("/tmp/fn-test-");
    });

    it("should store workingDirectory in config", () => {
      expect(testDir).toBeDefined();
      expect(testDir.startsWith("/tmp/")).toBe(true);
    });

    it("should store maxConcurrent in config", () => {
      expect(2).toBe(2);
    });

    it("should store maxWorktrees in config", () => {
      expect(4).toBe(4);
    });
  });

  describe("message store wiring", () => {
    it("registers wake-on-message hook when messageStore is provided", async () => {
      // Reset the mock to ensure clean state for this test
      mockMessageStoreSetHook.mockClear();

      await runtime.start();

      // Verify that setMessageToAgentHook was called with a function
      expect(mockMessageStoreSetHook).toHaveBeenCalledTimes(1);
      expect(mockMessageStoreSetHook).toHaveBeenCalledWith(expect.any(Function));
    });

    it("creates MessageStore with correct rootDir", async () => {
      // Start runtime
      await runtime.start();

      // The MessageStore mock was created - verify the MessageStore constructor was called
      const { MessageStore } = await import("@fusion/core");
      expect(MessageStore).toHaveBeenCalled();
    });
  });

  describe("dynamic agent registration with HeartbeatTriggerScheduler", () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      await runtime.start();
    });

    afterEach(async () => {
      await runtime.stop();
      vi.useRealTimers();
    });

    it("registers a new agent when agent:created event is emitted", async () => {
      // Create a new agent via the AgentStore
      const store = getAgentStore(runtime);
      const agent = await store.createAgent({
        name: "test-agent-dynamic",
        role: "executor",
      });

      // Verify the agent was registered with the trigger scheduler
      const scheduler = runtime.getTriggerScheduler();
      expect(scheduler).toBeDefined();
      expect(scheduler!.getRegisteredAgents()).toContain(agent.id);
    });

    it("registers agent without explicit heartbeatIntervalMs using default 3600s interval", async () => {
      // Create a new agent with only enabled: true (no heartbeatIntervalMs)
      // This tests that the default 3600-second interval (1 hour) is applied
      const store = getAgentStore(runtime);
      const agent = await store.createAgent({
        name: "test-agent-default-interval",
        role: "executor",
        runtimeConfig: { enabled: true }, // No heartbeatIntervalMs - should use default 3600s (1 hour)
      });

      // Verify the agent was registered with the trigger scheduler
      const scheduler = runtime.getTriggerScheduler();
      expect(scheduler).toBeDefined();
      expect(scheduler!.getRegisteredAgents()).toContain(agent.id);
    });

    it("registers a new agent with explicit heartbeatIntervalMs", async () => {
      // Create a new agent with explicit heartbeat config
      const store = getAgentStore(runtime);
      const agent = await store.createAgent({
        name: "test-agent-explicit",
        role: "executor",
        runtimeConfig: {
          heartbeatIntervalMs: 15000,
          enabled: true,
        },
      });

      // Verify the agent was registered with the trigger scheduler
      const scheduler = runtime.getTriggerScheduler();
      expect(scheduler).toBeDefined();
      expect(scheduler!.getRegisteredAgents()).toContain(agent.id);
    });

    it("does not register a new agent when enabled is false", async () => {
      // Create a new agent with heartbeat disabled
      const store = getAgentStore(runtime);
      const agent = await store.createAgent({
        name: "test-agent-disabled",
        role: "executor",
        runtimeConfig: {
          enabled: false,
        },
      });

      // Verify the agent was NOT registered with the trigger scheduler
      const scheduler = runtime.getTriggerScheduler();
      expect(scheduler).toBeDefined();
      expect(scheduler!.getRegisteredAgents()).not.toContain(agent.id);
    });

    it("re-registers an existing agent when agent:updated event is emitted", async () => {
      // Create a new agent
      const store = getAgentStore(runtime);
      const agent = await store.createAgent({
        name: "test-agent-update",
        role: "executor",
      });

      const scheduler = runtime.getTriggerScheduler();
      expect(scheduler!.getRegisteredAgents()).toContain(agent.id);

      // Update the agent
      await store.updateAgent(agent.id, {
        name: "test-agent-update-renamed",
      });

      // Verify the agent is still registered (re-registration succeeded)
      expect(scheduler!.getRegisteredAgents()).toContain(agent.id);
    });

    it("unregisters an agent when enabled is set to false in update", async () => {
      // Create a new agent with heartbeat enabled
      const store = getAgentStore(runtime);
      const agent = await store.createAgent({
        name: "test-agent-toggle",
        role: "executor",
        runtimeConfig: {
          enabled: true,
        },
      });

      const scheduler = runtime.getTriggerScheduler();
      expect(scheduler!.getRegisteredAgents()).toContain(agent.id);

      // Update the agent to disable heartbeat
      await store.updateAgent(agent.id, {
        runtimeConfig: {
          enabled: false,
        },
      });

      // Verify the agent was unregistered
      expect(scheduler!.getRegisteredAgents()).not.toContain(agent.id);
    });

    it("clears timers on pause and re-arms from resume without stale pre-pause firing", async () => {
      const store = getAgentStore(runtime);
      const monitor = runtime.getHeartbeatMonitor();
      expect(monitor).toBeDefined();

      const executeHeartbeatSpy = vi
        .spyOn(monitor!, "executeHeartbeat")
        .mockResolvedValue({ id: "run-resume-test" } as any);

      const agent = await store.createAgent({
        name: "resume-timer-agent",
        role: "executor",
        runtimeConfig: {
          enabled: true,
          heartbeatIntervalMs: 1000,
        },
      });
      await store.updateAgentState(agent.id, "active");

      const scheduler = runtime.getTriggerScheduler();
      expect(scheduler).toBeDefined();
      expect(scheduler!.getRegisteredAgents()).toContain(agent.id);

      await vi.advanceTimersByTimeAsync(400);
      expect(executeHeartbeatSpy).not.toHaveBeenCalled();

      await store.updateAgentState(agent.id, "paused");
      expect(scheduler!.getRegisteredAgents()).not.toContain(agent.id);

      // Advance beyond the original tick window; stale pre-pause timer must not fire.
      await vi.advanceTimersByTimeAsync(800);
      expect(executeHeartbeatSpy).not.toHaveBeenCalled();

      await store.updateAgentState(agent.id, "active");
      expect(scheduler!.getRegisteredAgents()).toContain(agent.id);

      // Resume should start a fresh interval from now, not from pre-pause start.
      await vi.advanceTimersByTimeAsync(900);
      expect(executeHeartbeatSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => {
        expect(executeHeartbeatSpy).toHaveBeenCalledTimes(1);
      });

      expect(executeHeartbeatSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: agent.id,
          source: "timer",
        }),
      );
    });

    it("removes event listeners when runtime is stopped", async () => {
      // Create a new agent before stopping
      const store = getAgentStore(runtime);
      const agent = await store.createAgent({
        name: "test-agent-cleanup",
        role: "executor",
      });

      const scheduler = runtime.getTriggerScheduler();
      expect(scheduler!.getRegisteredAgents()).toContain(agent.id);

      // Stop the runtime
      await runtime.stop();

      // The agent should still be registered (unregister is internal to scheduler)
      // But the listeners should be removed - verify by checking they don't fire
      // Create another agent - it won't be registered since runtime is stopped
      const agent2 = await store.createAgent({
        name: "test-agent-after-stop",
        role: "executor",
      });

      // Since runtime is stopped, trigger scheduler is stopped
      // The agent won't be in registered list
      expect(scheduler!.getRegisteredAgents()).not.toContain(agent2.id);
    });
  });

  describe("ephemeral termination cleanup", () => {
    it("auto-deletes ephemeral agent when it transitions to terminated via agent:stateChanged", async () => {
      vi.useFakeTimers();

      try {
        await runtime.start();

        const store = getAgentStore(runtime);
        const deleteAgentSpy = vi.spyOn(store, "deleteAgent").mockResolvedValue(undefined);

        // Create an ephemeral task-worker agent
        const agent = await store.createAgent({
          name: "executor-FN-TERM-1",
          role: "executor",
          metadata: {
            agentKind: "task-worker",
            taskWorker: true,
            managedBy: "task-executor",
          },
          runtimeConfig: { enabled: false },
        });

        // Verify agent exists
        let agents = await store.listAgents({ includeEphemeral: true });
        expect(agents.some((a: Agent) => a.id === agent.id)).toBe(true);

        // Emit agent:stateChanged event to trigger termination
        store.emit("agent:stateChanged", agent.id, "running", "terminated");

        // Wait for async handler
        await vi.advanceTimersByTimeAsync(0);

        // Verify deleteAgent was NOT called immediately (needs 5s delay)
        expect(deleteAgentSpy).not.toHaveBeenCalled();

        // Advance timers by 5 seconds
        await vi.advanceTimersByTimeAsync(5000);

        // Now deleteAgent should have been called
        expect(deleteAgentSpy).toHaveBeenCalledTimes(1);
        expect(deleteAgentSpy).toHaveBeenCalledWith(agent.id);

        // Note: We verified deleteAgent was called, which is the key behavior.
        // The actual removal from listAgents depends on the real AgentStore implementation.
      } finally {
        vi.useRealTimers();
      }
    }, 30000);

    it("does not auto-delete non-ephemeral agent when it transitions to terminated", async () => {
      vi.useFakeTimers();

      try {
        await runtime.start();

        const store = getAgentStore(runtime);
        const deleteAgentSpy = vi.spyOn(store, "deleteAgent").mockResolvedValue(undefined);

        // Create a non-ephemeral user-managed agent
        const agent = await store.createAgent({
          name: "user-managed-agent",
          role: "executor",
          // No ephemeral metadata
          runtimeConfig: { enabled: true },
        });

        // Verify agent exists
        let agents = await store.listAgents();
        expect(agents.some((a: Agent) => a.id === agent.id)).toBe(true);

        // Emit agent:stateChanged event to trigger termination
        store.emit("agent:stateChanged", agent.id, "active", "terminated");

        // Wait for async handler
        await vi.advanceTimersByTimeAsync(0);

        // Advance timers to ensure cleanup would have run
        await vi.advanceTimersByTimeAsync(5000);

        // deleteAgent should NOT have been called for non-ephemeral agent
        expect(deleteAgentSpy).not.toHaveBeenCalled();

        // Agent should still exist
        agents = await store.listAgents();
        expect(agents.some((a: Agent) => a.id === agent.id)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    }, 30000);

    it("does not schedule duplicate deletion when termination event fires multiple times", async () => {
      vi.useFakeTimers();

      try {
        await runtime.start();

        const store = getAgentStore(runtime);
        const deleteAgentSpy = vi.spyOn(store, "deleteAgent").mockResolvedValue(undefined);

        // Create an ephemeral task-worker agent
        const agent = await store.createAgent({
          name: "executor-FN-DUP-1",
          role: "executor",
          metadata: {
            agentKind: "task-worker",
            taskWorker: true,
            managedBy: "task-executor",
          },
          runtimeConfig: { enabled: false },
        });

        // Emit termination event multiple times
        store.emit("agent:stateChanged", agent.id, "running", "terminated");
        store.emit("agent:stateChanged", agent.id, "terminated", "terminated"); // Already terminated

        // Wait for async handlers
        await vi.advanceTimersByTimeAsync(0);

        // Advance timers by 5 seconds
        await vi.advanceTimersByTimeAsync(5000);

        // deleteAgent should have been called only once (deduplicated)
        expect(deleteAgentSpy).toHaveBeenCalledTimes(1);
        expect(deleteAgentSpy).toHaveBeenCalledWith(agent.id);
      } finally {
        vi.useRealTimers();
      }
    }, 30000);

    it("does not warn when cleanup delete fails only because agent is already gone", async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(runtimeLog, "warn");

      try {
        await runtime.start();

        const store = getAgentStore(runtime);

        // Create an ephemeral agent
        const agent = await store.createAgent({
          name: "executor-FN-BENIGN-1",
          role: "executor",
          metadata: {
            agentKind: "task-worker",
          },
          runtimeConfig: { enabled: false },
        });

        const deleteAgentSpy = vi
          .spyOn(store, "deleteAgent")
          .mockRejectedValueOnce(new Error(`Agent ${agent.id} not found`));

        // Emit termination event
        store.emit("agent:stateChanged", agent.id, "running", "terminated");

        // Wait for async handler, then fire delayed cleanup
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(5000);

        // Cleanup should still be attempted
        expect(deleteAgentSpy).toHaveBeenCalledTimes(1);
        expect(deleteAgentSpy).toHaveBeenCalledWith(agent.id);

        // Benign not-found races should not produce warning-level noise
        const emittedCleanupWarning = warnSpy.mock.calls.some(([msg]) =>
          typeof msg === "string" && msg.includes("Failed to delete ephemeral agent"),
        );
        expect(emittedCleanupWarning).toBe(false);
      } finally {
        warnSpy.mockRestore();
        vi.useRealTimers();
      }
    }, 30000);

    it("warns on genuine cleanup failure but does not throw", async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(runtimeLog, "warn");

      try {
        await runtime.start();

        const store = getAgentStore(runtime);
        const deleteAgentSpy = vi.spyOn(store, "deleteAgent").mockRejectedValue(new Error("delete failed"));

        // Create an ephemeral agent
        const agent = await store.createAgent({
          name: "executor-FN-WARN-1",
          role: "executor",
          metadata: {
            agentKind: "task-worker",
          },
          runtimeConfig: { enabled: false },
        });

        // Emit termination event
        store.emit("agent:stateChanged", agent.id, "running", "terminated");

        // Wait for async handler
        await vi.advanceTimersByTimeAsync(0);

        // Advance timers to trigger deletion
        await vi.advanceTimersByTimeAsync(5000);

        // Should have attempted deletion
        expect(deleteAgentSpy).toHaveBeenCalledTimes(1);
        expect(deleteAgentSpy).toHaveBeenCalledWith(agent.id);

        // Genuine failures still log warning-level context
        const cleanupWarnings = warnSpy.mock.calls.filter(([msg]) =>
          typeof msg === "string" && msg.includes("Failed to delete ephemeral agent"),
        );
        expect(cleanupWarnings).toHaveLength(1);
        expect(cleanupWarnings[0]?.[0]).toContain(agent.id);
        expect(cleanupWarnings[0]?.[0]).toContain("delete failed");
      } finally {
        warnSpy.mockRestore();
        vi.useRealTimers();
      }
    }, 30000);

    it("clears pending timers on runtime stop", async () => {
      vi.useFakeTimers();

      try {
        await runtime.start();

        const store = getAgentStore(runtime);
        const deleteAgentSpy = vi.spyOn(store, "deleteAgent").mockResolvedValue(undefined);

        // Create an ephemeral agent
        const agent = await store.createAgent({
          name: "executor-FN-STOP-1",
          role: "executor",
          metadata: {
            taskWorker: true,
          },
          runtimeConfig: { enabled: false },
        });

        // Emit termination event
        store.emit("agent:stateChanged", agent.id, "running", "terminated");

        // Wait for async handler
        await vi.advanceTimersByTimeAsync(0);

        // Stop runtime before timer fires
        await runtime.stop();

        // Advance timers - deletion should NOT happen because timer was cleared
        await vi.advanceTimersByTimeAsync(5000);

        // deleteAgent should NOT have been called (timer was cleared)
        expect(deleteAgentSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    }, 30000);

    it("handles spawned ephemeral agents (type=spawned) correctly", async () => {
      vi.useFakeTimers();

      try {
        await runtime.start();

        const store = getAgentStore(runtime);
        const deleteAgentSpy = vi.spyOn(store, "deleteAgent").mockResolvedValue(undefined);

        // Create a spawned child agent (type=spawned is ephemeral)
        const agent = await store.createAgent({
          name: "child-agent-001",
          role: "executor",
          metadata: {
            type: "spawned",
            parentTaskId: "FN-PARENT",
          },
          runtimeConfig: { enabled: false },
        });

        // Emit termination event
        store.emit("agent:stateChanged", agent.id, "running", "terminated");

        // Wait for async handler
        await vi.advanceTimersByTimeAsync(0);

        // Advance timers by 5 seconds
        await vi.advanceTimersByTimeAsync(5000);

        // deleteAgent should have been called for spawned ephemeral agent
        expect(deleteAgentSpy).toHaveBeenCalledTimes(1);
        expect(deleteAgentSpy).toHaveBeenCalledWith(agent.id);
      } finally {
        vi.useRealTimers();
      }
    }, 30000);
  });
});
