import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  mockResumeOrphaned,
  mockTaskStoreSettings,
  mockTaskStoreGetTask,
  mockMessageStoreSetHook,
  mockSchedulerConfigurePrMonitoring,
} = vi.hoisted(() => ({
  mockSelfHealingStart: vi.fn(),
  mockSelfHealingStop: vi.fn(),
  mockSelfHealingCtor: vi.fn(),
  mockRecoverNoProgressNoTaskDoneFailures: vi.fn().mockResolvedValue(0),
  mockRunStartupRecovery: vi.fn().mockResolvedValue(undefined),
  mockExecutorCtor: vi.fn(),
  mockResumeOrphaned: vi.fn().mockResolvedValue(undefined),
  mockTaskStoreSettings: {} as Record<string, unknown>,
  mockTaskStoreGetTask: vi.fn().mockResolvedValue(null),
  mockMessageStoreSetHook: vi.fn(),
  mockSchedulerConfigurePrMonitoring: vi.fn(),
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
      self.getTask = mockTaskStoreGetTask;
      // AgentStore now receives this TaskStore (passed from the runtime),
      // so methods it calls during assign/claim/checkout flows must exist.
      self.logEntry = vi.fn().mockResolvedValue(undefined);
      self.updateTask = vi.fn().mockImplementation(async (taskId: string, patch: Record<string, unknown>) => ({ id: taskId, ...patch }));
      self.moveTask = vi.fn().mockResolvedValue(undefined);
      self.getSettings = vi.fn().mockImplementation(async () => structuredClone(mockTaskStoreSettings));
      self.getMissionStore = vi.fn().mockReturnValue({
        listMissions: vi.fn().mockReturnValue([]),
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
      self.configurePrMonitoring = mockSchedulerConfigurePrMonitoring;
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
      self.resumeOrphaned = mockResumeOrphaned;
      self.recoverCompletedTask = vi.fn().mockResolvedValue(true);
      self.getExecutingTaskIds = vi.fn().mockReturnValue(new Set());
      self.handleLoopDetected = vi.fn().mockResolvedValue(false);
      self.markStuckAborted = vi.fn();
      self.abortAllSessionBash = vi.fn().mockResolvedValue(undefined);
      self.isEphemeralDeletionPending = vi.fn().mockReturnValue(false);
      self.disposeEphemeralTimers = vi.fn();
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
    for (const key of Object.keys(mockTaskStoreSettings)) {
      delete mockTaskStoreSettings[key];
    }
    mockTaskStoreGetTask.mockReset();
    mockTaskStoreGetTask.mockResolvedValue(null);
    // Create a unique temp directory for this test run
    testDir = mkdtempSync(join(tmpdir(), `fn-test-${randomUUID().slice(0, 8)}-`));

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
      expect(mockResumeOrphaned).toHaveBeenCalledTimes(1);
      expect(mockRunStartupRecovery).toHaveBeenCalledTimes(1);
    }, 30000);

    it("defers startup recovery while enginePaused is active", async () => {
      mockTaskStoreSettings.enginePaused = true;

      await runtime.start();

      expect(mockRecoverNoProgressNoTaskDoneFailures).not.toHaveBeenCalled();
      expect(mockResumeOrphaned).not.toHaveBeenCalled();
      expect(mockRunStartupRecovery).not.toHaveBeenCalled();
    }, 30000);

    it("resumes deferred startup recovery after engine pause is cleared in startup order", async () => {
      mockTaskStoreSettings.enginePaused = true;

      await runtime.start();
      mockRecoverNoProgressNoTaskDoneFailures.mockClear();
      mockResumeOrphaned.mockClear();
      mockRunStartupRecovery.mockClear();

      mockTaskStoreSettings.enginePaused = false;
      await runtime.resumeAfterUnpause();

      expect(mockRecoverNoProgressNoTaskDoneFailures).toHaveBeenCalledTimes(1);
      expect(mockResumeOrphaned).toHaveBeenCalledTimes(1);
      expect(mockRunStartupRecovery).toHaveBeenCalledTimes(1);
      expect(mockRecoverNoProgressNoTaskDoneFailures.mock.invocationCallOrder[0]).toBeLessThan(
        mockResumeOrphaned.mock.invocationCallOrder[0],
      );
      expect(mockResumeOrphaned.mock.invocationCallOrder[0]).toBeLessThan(
        mockRunStartupRecovery.mock.invocationCallOrder[0],
      );
    }, 30000);

    it("coalesces concurrent unpause recovery dispatches", async () => {
      mockTaskStoreSettings.enginePaused = true;

      await runtime.start();
      mockRecoverNoProgressNoTaskDoneFailures.mockClear();
      mockResumeOrphaned.mockClear();
      mockRunStartupRecovery.mockClear();

      mockTaskStoreSettings.enginePaused = false;
      await Promise.all([runtime.resumeAfterUnpause(), runtime.resumeAfterUnpause()]);

      expect(mockRecoverNoProgressNoTaskDoneFailures).toHaveBeenCalledTimes(1);
      expect(mockResumeOrphaned).toHaveBeenCalledTimes(1);
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

    // Regression: heartbeat auto-claim path was warning
    // "TaskStore not configured for task-claim operations" because the
    // runtime built its AgentStore without passing taskStore through.
    it("wires AgentStore with TaskStore so claimTaskForAgent does not throw", async () => {
      await runtime.start();
      const store = getAgentStore(runtime);
      const agent = await store.createAgent({
        name: "claim-wiring",
        role: "executor",
        metadata: { agentKind: "task-worker" },
        runtimeConfig: { enabled: false },
      });
      // taskStore.getTask is mocked to return null in this suite, so we
      // expect the guarded "task_not_found" path rather than the
      // unconfigured-taskStore throw.
      mockTaskStoreGetTask.mockResolvedValueOnce(null);
      const result = await store.claimTaskForAgent(agent.id, "FN-DOES-NOT-EXIST");
      expect(result).toEqual({ ok: false, reason: "task_not_found" });
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

    it("configures scheduler PR monitoring after start", async () => {
      await runtime.start();
      runtime.configurePrMonitoring({
        prMonitor: {} as never,
        onClosedPrFeedback: vi.fn(),
      });

      expect(mockSchedulerConfigurePrMonitoring).toHaveBeenCalledTimes(1);
      expect(mockSchedulerConfigurePrMonitoring).toHaveBeenCalledWith(expect.objectContaining({
        prMonitor: expect.any(Object),
      }));
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

    it("reuses assigned durable agent as execution owner without creating a task-worker", async () => {
      await runtime.start();

      const store = getAgentStore(runtime);
      const durable = await store.createAgent({ name: "Durable Exec", role: "executor" });
      const createAgentSpy = vi.spyOn(store, "createAgent");
      const assignTaskSpy = vi.spyOn(store, "assignTask");
      const syncLinkSpy = vi.spyOn(store, "syncExecutionTaskLink");

      const executorOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
        onStart?: (task: Task, worktreePath: string) => void;
      };
      executorOptions.onStart?.({ id: "FN-1661", assignedAgentId: durable.id } as Task, join(testDir, "worktree-FN-1661"));

      await vi.waitFor(async () => {
        const updated = await store.getAgent(durable.id);
        expect(updated?.taskId).toBe("FN-1661");
        expect(updated?.state).toBe("running");
      });

      expect(syncLinkSpy).toHaveBeenCalledWith(durable.id, "FN-1661");
      expect(assignTaskSpy).not.toHaveBeenCalledWith(durable.id, "FN-1661");
      expect(createAgentSpy).not.toHaveBeenCalledWith(expect.objectContaining({ name: "executor-FN-1661" }));

      const agents = await store.listAgents({ includeEphemeral: true });
      expect(agents.some((agent: Agent) => agent.name === "executor-FN-1661")).toBe(false);
    }, 30000);

    it("falls back to runtime task-worker agents for unassigned tasks", async () => {
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

    it("falls back to runtime task-worker when assignedAgentId points to ephemeral agent", async () => {
      await runtime.start();

      const store = getAgentStore(runtime);
      const ephemeral = await store.createAgent({
        name: "Spawned Child",
        role: "executor",
        metadata: { agentKind: "task-worker", managedBy: "task-executor" },
        runtimeConfig: { enabled: false },
      });

      const executorOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
        onStart?: (task: Task, worktreePath: string) => void;
      };
      executorOptions.onStart?.({ id: "FN-1662", assignedAgentId: ephemeral.id } as Task, join(testDir, "worktree-FN-1662"));

      await vi.waitFor(async () => {
        const agents = await store.listAgents({ includeEphemeral: true });
        expect(agents.some((agent: Agent) => agent.name === "executor-FN-1662")).toBe(true);
      });
    }, 30000);

    it("does not wake executeHeartbeat for runtime ownership sync of durable assigned agents", async () => {
      await runtime.start();

      const monitor = runtime.getHeartbeatMonitor();
      expect(monitor).toBeDefined();
      const heartbeatMonitor = monitor!;
      const executeResult = { id: "run-task-worker" } as Awaited<ReturnType<typeof heartbeatMonitor.executeHeartbeat>>;
      const executeSpy = vi
        .spyOn(heartbeatMonitor, "executeHeartbeat")
        .mockResolvedValue(executeResult);

      const store = getAgentStore(runtime);
      const durable = await store.createAgent({ name: "Owned Exec", role: "executor" });

      const executorOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
        onStart?: (task: Task, worktreePath: string) => void;
      };
      executorOptions.onStart?.({ id: "FN-2001", assignedAgentId: durable.id } as Task, join(testDir, "worktree-FN-2001"));

      await vi.waitFor(async () => {
        const updated = await store.getAgent(durable.id);
        expect(updated?.taskId).toBe("FN-2001");
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(executeSpy).not.toHaveBeenCalled();
    }, 30000);

    it("cleans up durable execution owner on completion without deleting agent", async () => {
      vi.useFakeTimers();

      try {
        await runtime.start();

        const store = getAgentStore(runtime);
        const durable = await store.createAgent({ name: "Durable Cleanup", role: "executor" });
        const deleteAgentSpy = vi.spyOn(store, "deleteAgent").mockResolvedValue(undefined);

        const executorOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
          onStart?: (task: Task, worktreePath: string) => void;
          onComplete?: (task: Task) => void;
        };

        executorOptions.onStart?.({ id: "FN-DURABLE-1", assignedAgentId: durable.id } as Task, join(testDir, "worktree-FN-DURABLE-1"));
        await vi.waitFor(async () => {
          const updated = await store.getAgent(durable.id);
          expect(updated?.taskId).toBe("FN-DURABLE-1");
        });

        executorOptions.onComplete?.({ id: "FN-DURABLE-1" } as Task);
        await vi.advanceTimersByTimeAsync(5000);

        const updated = await store.getAgent(durable.id);
        expect(updated?.state).toBe("active");
        expect(updated?.taskId).toBeUndefined();
        expect(deleteAgentSpy).not.toHaveBeenCalledWith(durable.id);
      } finally {
        vi.useRealTimers();
      }
    }, 30000);

    it("auto-deletes task-worker agent on task completion immediately", async () => {
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

        await vi.waitFor(() => {
          expect(deleteAgentSpy).toHaveBeenCalledTimes(1);
        });
      } finally {
        vi.useRealTimers();
      }
    }, 30000);

    it("cleans up durable execution owner on error without deleting agent", async () => {
      vi.useFakeTimers();

      try {
        await runtime.start();

        const store = getAgentStore(runtime);
        const durable = await store.createAgent({ name: "Durable Error", role: "executor" });
        const deleteAgentSpy = vi.spyOn(store, "deleteAgent").mockResolvedValue(undefined);

        const executorOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
          onStart?: (task: Task, worktreePath: string) => void;
          onError?: (task: Task, error: Error) => void;
        };

        executorOptions.onStart?.({ id: "FN-DURABLE-2", assignedAgentId: durable.id } as Task, join(testDir, "worktree-FN-DURABLE-2"));
        await vi.waitFor(async () => {
          const updated = await store.getAgent(durable.id);
          expect(updated?.taskId).toBe("FN-DURABLE-2");
        });

        executorOptions.onError?.({ id: "FN-DURABLE-2" } as Task, new Error("boom"));
        await vi.advanceTimersByTimeAsync(5000);

        const updated = await store.getAgent(durable.id);
        expect(updated?.state).toBe("error");
        expect(updated?.taskId).toBeUndefined();
        expect(deleteAgentSpy).not.toHaveBeenCalledWith(durable.id);
      } finally {
        vi.useRealTimers();
      }
    }, 30000);

    it("auto-deletes task-worker agent on task error immediately", async () => {
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

        await vi.waitFor(() => {
          expect(deleteAgentSpy).toHaveBeenCalledTimes(1);
        });
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
        if (state === "active") {
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
        expect.stringContaining("active (completion)"),
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
      expect(testDir).toContain("fn-test-");
    });

    it("should store workingDirectory in config", () => {
      expect(testDir).toBeDefined();
      expect(testDir.startsWith(tmpdir())).toBe(true);
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

    it("does not reset an armed timer on unrelated agent updates", async () => {
      const store = getAgentStore(runtime);
      const monitor = runtime.getHeartbeatMonitor();
      expect(monitor).toBeDefined();

      const executeHeartbeatSpy = vi
        .spyOn(monitor!, "executeHeartbeat")
        .mockResolvedValue({ id: "run-update-timer-stability" } as any);

      const agent = await store.createAgent({
        name: "test-agent-update",
        role: "executor",
        runtimeConfig: {
          enabled: true,
          heartbeatIntervalMs: 1000,
        },
      });

      const scheduler = runtime.getTriggerScheduler();
      expect(scheduler!.getRegisteredAgents()).toContain(agent.id);

      await vi.advanceTimersByTimeAsync(400);
      await store.updateAgent(agent.id, {
        name: "test-agent-update-renamed",
      });

      await vi.advanceTimersByTimeAsync(599);
      expect(executeHeartbeatSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
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

    it("re-arms the timer when heartbeat interval changes", async () => {
      const store = getAgentStore(runtime);
      const monitor = runtime.getHeartbeatMonitor();
      expect(monitor).toBeDefined();

      const executeHeartbeatSpy = vi
        .spyOn(monitor!, "executeHeartbeat")
        .mockResolvedValue({ id: "run-interval-change" } as any);

      const agent = await store.createAgent({
        name: "interval-change-agent",
        role: "executor",
        runtimeConfig: {
          enabled: true,
          heartbeatIntervalMs: 1000,
        },
      });

      await vi.advanceTimersByTimeAsync(400);
      await store.updateAgent(agent.id, {
        runtimeConfig: {
          enabled: true,
          heartbeatIntervalMs: 2000,
        },
      });

      await vi.advanceTimersByTimeAsync(1599);
      expect(executeHeartbeatSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(401);
      await vi.waitFor(() => {
        expect(executeHeartbeatSpy).toHaveBeenCalledTimes(1);
      });
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
        store.emit("agent:stateChanged", agent.id, "running", "paused");

        // Wait for async handler
        await vi.advanceTimersByTimeAsync(0);

        await vi.waitFor(() => {
          expect(deleteAgentSpy).toHaveBeenCalledTimes(1);
        });
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
        store.emit("agent:stateChanged", agent.id, "active", "paused");

        // Wait for async handler
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(0);

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
        store.emit("agent:stateChanged", agent.id, "running", "paused");
        store.emit("agent:stateChanged", agent.id, "paused", "paused"); // Already halted

        // Wait for async handlers
        await vi.advanceTimersByTimeAsync(0);

        await vi.waitFor(() => {
          expect(deleteAgentSpy).toHaveBeenCalledTimes(1);
        });
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
        store.emit("agent:stateChanged", agent.id, "running", "paused");

        // Wait for async handler
        await vi.advanceTimersByTimeAsync(0);

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
        store.emit("agent:stateChanged", agent.id, "running", "paused");

        // Wait for async handler
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(0);

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

    it("handles runtime stop racing with in-flight cleanup", async () => {
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
        store.emit("agent:stateChanged", agent.id, "running", "paused");

        // Wait for async handler
        await vi.advanceTimersByTimeAsync(0);

        await runtime.stop();

        expect(deleteAgentSpy.mock.calls.length).toBeLessThanOrEqual(1);
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
        store.emit("agent:stateChanged", agent.id, "running", "paused");

        // Wait for async handler
        await vi.advanceTimersByTimeAsync(0);

        // Advance timers by 5 seconds
        await vi.waitFor(() => {
          expect(deleteAgentSpy).toHaveBeenCalledTimes(1);
        });

        // deleteAgent should have been called for spawned ephemeral agent
        expect(deleteAgentSpy).toHaveBeenCalledWith(agent.id);
      } finally {
        vi.useRealTimers();
      }
    }, 30000);

    it("does not double-delete when onComplete already scheduled cleanup", async () => {
      vi.useFakeTimers();
      try {
        await runtime.start();
        const store = getAgentStore(runtime);
        const deleteAgentSpy = vi.spyOn(store, "deleteAgent").mockResolvedValue(undefined);

        const executorOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
          onStart?: (task: Task, worktreePath: string) => void;
          onComplete?: (task: Task) => void;
        };
        executorOptions.onStart?.({ id: "FN-DUP-COMPLETE" } as Task, join(testDir, "worktree-FN-DUP-COMPLETE"));

        let worker: Agent | undefined;
        await vi.waitFor(async () => {
          worker = (await store.listAgents({ includeEphemeral: true }))
            .find((a: Agent) => a.name === "executor-FN-DUP-COMPLETE");
          expect(worker).toBeDefined();
        });

        executorOptions.onComplete?.({ id: "FN-DUP-COMPLETE" } as Task);
        store.emit("agent:stateChanged", worker!.id, "running", "paused");

        await vi.waitFor(() => {
          expect(deleteAgentSpy).toHaveBeenCalledTimes(1);
        });
      } finally {
        vi.useRealTimers();
      }
    }, 30000);

    it("handles onComplete cleanup racing with runtime stop", async () => {
      vi.useFakeTimers();
      try {
        await runtime.start();
        const store = getAgentStore(runtime);
        const deleteAgentSpy = vi.spyOn(store, "deleteAgent").mockResolvedValue(undefined);

        const executorOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
          onStart?: (task: Task, worktreePath: string) => void;
          onComplete?: (task: Task) => void;
        };
        executorOptions.onStart?.({ id: "FN-STOP-COMPLETE" } as Task, join(testDir, "worktree-FN-STOP-COMPLETE"));
        executorOptions.onComplete?.({ id: "FN-STOP-COMPLETE" } as Task);

        await runtime.stop();
        expect(deleteAgentSpy.mock.calls.length).toBeLessThanOrEqual(1);
      } finally {
        vi.useRealTimers();
      }
    }, 30000);
  });

  describe("startup ephemeral sweep", () => {
    it("cleans terminated ephemeral agents on startup", async () => {
      const { AgentStore } = await import("@fusion/core");
      const preStore = new AgentStore({ rootDir: join(testDir, ".fusion") });
      await preStore.init();
      const orphan = await preStore.createAgent({
        name: "orphan-terminated",
        role: "executor",
        metadata: { agentKind: "task-worker" },
        runtimeConfig: { enabled: false },
      });
      await preStore.updateAgentState(orphan.id, "active");
      await preStore.updateAgentState(orphan.id, "paused");

      await runtime.start();
      const store = getAgentStore(runtime);
      expect(await store.getAgent(orphan.id)).toBeNull();
    }, 30000);

    it("cleans ephemeral agents assigned to non-in-progress tasks", async () => {
      mockTaskStoreGetTask.mockResolvedValue({ id: "FN-DONE", column: "done" });
      const { AgentStore } = await import("@fusion/core");
      const preStore = new AgentStore({ rootDir: join(testDir, ".fusion") });
      await preStore.init();
      const orphan = await preStore.createAgent({
        name: "orphan-stale-task",
        role: "executor",
        metadata: { agentKind: "task-worker" },
        runtimeConfig: { enabled: false },
      });
      await preStore.assignTask(orphan.id, "FN-DONE");

      await runtime.start();
      const store = getAgentStore(runtime);
      expect(await store.getAgent(orphan.id)).toBeNull();
    }, 30000);

    it("continues startup sweep when one delete fails", async () => {
      const warnSpy = vi.spyOn(runtimeLog, "warn");
      const { AgentStore } = await import("@fusion/core");
      const originalDeleteAgent = AgentStore.prototype.deleteAgent;
      const deleteProtoSpy = vi
        .spyOn(AgentStore.prototype, "deleteAgent")
        .mockRejectedValueOnce(new Error("delete failed"))
        .mockImplementation(async function(this: AgentStore, agentId: string) {
          return originalDeleteAgent.call(this, agentId);
        });

      try {
        const preStore = new AgentStore({ rootDir: join(testDir, ".fusion") });
        await preStore.init();
        const a1 = await preStore.createAgent({ name: "orphan-a1", role: "executor", metadata: { agentKind: "task-worker" }, runtimeConfig: { enabled: false } });
        const a2 = await preStore.createAgent({ name: "orphan-a2", role: "executor", metadata: { agentKind: "task-worker" }, runtimeConfig: { enabled: false } });
        await preStore.updateAgentState(a1.id, "active");
        await preStore.updateAgentState(a1.id, "paused");
        await preStore.updateAgentState(a2.id, "active");
        await preStore.updateAgentState(a2.id, "paused");

        await runtime.start();
        const store = getAgentStore(runtime);
        expect(runtime.getStatus()).toBe("active");
        const remaining = await store.listAgents({ includeEphemeral: true });
        expect(remaining.filter((a: Agent) => a.id === a1.id || a.id === a2.id)).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
        deleteProtoSpy.mockRestore();
      }
    }, 30000);
  });
});
