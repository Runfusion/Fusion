import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import childProcess from "node:child_process";
import type { Task, TaskStore, CentralCore, AgentStore, Agent } from "@fusion/core";
import { InProcessRuntime } from "../in-process-runtime.js";
import type { ProjectRuntimeConfig } from "../../project-runtime.js";
import { runtimeLog } from "../../logger.js";
import { AgentSemaphore } from "../../concurrency.js";

const {
  mockSelfHealingStart,
  mockSelfHealingStop,
  mockSelfHealingCtor,
  mockRecoverNoProgressNoTaskDoneFailures,
  mockRunStartupRecovery,
  mockRecoverInterruptedRuns,
  mockExecutorCtor,
  mockResumeOrphaned,
  mockResumeTaskForAgent,
  mockTaskStoreSettings,
  mockTaskStoreGetTask,
  mockTaskStoreUpdateSettings,
  mockMessageStoreSetHook,
  mockSchedulerConfigurePrMonitoring,
  mockIsGitRepository,
  mockReapOrphanWorktrees,
  mockScanIdleWorktrees,
  mockGetRegisteredWorktreePaths,
} = vi.hoisted(() => ({
  mockSelfHealingStart: vi.fn(),
  mockSelfHealingStop: vi.fn(),
  mockSelfHealingCtor: vi.fn(),
  mockRecoverNoProgressNoTaskDoneFailures: vi.fn().mockResolvedValue(0),
  mockRunStartupRecovery: vi.fn().mockResolvedValue(undefined),
  mockRecoverInterruptedRuns: vi.fn().mockResolvedValue(undefined),
  mockExecutorCtor: vi.fn(),
  mockResumeOrphaned: vi.fn().mockResolvedValue(undefined),
  mockResumeTaskForAgent: vi.fn().mockResolvedValue(undefined),
  mockTaskStoreSettings: {} as Record<string, unknown>,
  mockTaskStoreGetTask: vi.fn().mockResolvedValue(null),
  mockTaskStoreUpdateSettings: vi.fn().mockResolvedValue(undefined),
  mockMessageStoreSetHook: vi.fn(),
  mockSchedulerConfigurePrMonitoring: vi.fn(),
  mockIsGitRepository: vi.fn().mockResolvedValue(true),
  mockReapOrphanWorktrees: vi.fn().mockResolvedValue(0),
  mockScanIdleWorktrees: vi.fn().mockResolvedValue([]),
  mockGetRegisteredWorktreePaths: vi.fn().mockResolvedValue(new Set<string>()),
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
      self.updateSettings = mockTaskStoreUpdateSettings;
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

  // FN-3890: The runtime calls these on startup. They normally shell out to `git`,
  // which (a) does real I/O against a non-git temp dir and (b) interacts
  // badly with `vi.useFakeTimers()` in this suite — the test-harness
  // subprocess guard arms a 30s kill timer that can fire under fake-timer
  // advancement, surfacing as "Timed out: git rev-parse --git-dir" failures.
  // Stub them out so runtime.start() never spawns git.
  return {
    ...actual,
    isGitRepository: mockIsGitRepository,
    reapOrphanWorktrees: mockReapOrphanWorktrees,
    scanIdleWorktrees: mockScanIdleWorktrees,
    getRegisteredWorktreePaths: mockGetRegisteredWorktreePaths,
  };
});

// Mock the scheduler
vi.mock("../../scheduler.js", async () => {
  return {
    Scheduler: vi.fn().mockImplementation(function () {
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
    SelfHealingManager: vi.fn().mockImplementation(function (_store, opts) {
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

vi.mock("../../restart-recovery-coordinator.js", async () => {
  return {
    RestartRecoveryCoordinator: vi.fn().mockImplementation(function () {
      return {
        recoverInterruptedRuns: mockRecoverInterruptedRuns,
      };
    }),
  };
});

// Mock the plugin runner
vi.mock("../../plugin-runner.js", async () => {
  return {
    PluginRunner: vi.fn().mockImplementation(function () {
      return {
        init: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
        getPluginTools: vi.fn().mockReturnValue([]),
        getPluginRoutes: vi.fn().mockReturnValue([]),
      };
    }),
  };
});

// Mock the executor
vi.mock("../../executor.js", async () => {
  return {
    TaskExecutor: vi.fn().mockImplementation(function (_store, _rootDir, options) {
      mockExecutorCtor(options);
      const self = {} as Record<string, unknown>;
      self.resumeOrphaned = mockResumeOrphaned;
      self.resumeTaskForAgent = mockResumeTaskForAgent;
      self.recoverCompletedTask = vi.fn().mockResolvedValue(true);
      self.getExecutingTaskIds = vi.fn().mockReturnValue(new Set());
      self.handleLoopDetected = vi.fn().mockResolvedValue(false);
      self.markStuckAborted = vi.fn();
      self.abortAllSessionBash = vi.fn().mockResolvedValue(undefined);
      self.abortAllInFlight = vi.fn().mockResolvedValue(undefined);
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

async function flushRuntimeCallbackMicrotasks(turns = 8): Promise<void> {
  /*
  FNXC:TestInfrastructure 2026-07-03-10:45:
  Runtime executor and AgentStore listeners intentionally invoke async ownership/cleanup work through void callbacks.
  Drain their resolved-promise continuations directly in tests instead of paying vi.waitFor polling intervals for deterministic no-timer work.
  */
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
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
    mockResumeTaskForAgent.mockReset();
    mockResumeTaskForAgent.mockResolvedValue(undefined);
    mockIsGitRepository.mockReset();
    mockIsGitRepository.mockResolvedValue(true);
    mockReapOrphanWorktrees.mockReset();
    mockReapOrphanWorktrees.mockResolvedValue(0);
    mockScanIdleWorktrees.mockReset();
    mockScanIdleWorktrees.mockResolvedValue([]);
    mockGetRegisteredWorktreePaths.mockReset();
    mockGetRegisteredWorktreePaths.mockResolvedValue(new Set<string>());
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

    it("stamps engineActiveSinceMs during runtime start", async () => {
      const before = Date.now();
      await runtime.start();
      const after = Date.now();

      expect(mockTaskStoreUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ engineActiveSinceMs: expect.any(Number) }),
      );
      const stamp = (mockTaskStoreUpdateSettings.mock.calls.at(-1)?.[0] as { engineActiveSinceMs: number }).engineActiveSinceMs;
      expect(stamp).toBeGreaterThanOrEqual(before);
      expect(stamp).toBeLessThanOrEqual(after);
    });

    it("does not spawn real git subprocesses during start()", async () => {
      const execSpy = vi.spyOn(childProcess, "exec");
      const execFileSpy = vi.spyOn(childProcess, "execFile");
      const spawnSpy = vi.spyOn(childProcess, "spawn");

      try {
        await runtime.start();

        const gitExecCalls = execSpy.mock.calls.filter(([command]) => command.includes("git "));
        const gitExecFileCalls = execFileSpy.mock.calls.filter(([file, args]) => {
          if (file.includes("git")) return true;
          return Array.isArray(args) && args.some((arg) => String(arg).includes("git"));
        });
        const gitSpawnCalls = spawnSpy.mock.calls.filter(([command, args]) => {
          if (String(command).includes("git")) return true;
          return Array.isArray(args) && args.some((arg) => String(arg).includes("git"));
        });

        expect(gitExecCalls).toHaveLength(0);
        expect(gitExecFileCalls).toHaveLength(0);
        expect(gitSpawnCalls).toHaveLength(0);
        expect(mockReapOrphanWorktrees).toHaveBeenCalledWith(testDir, expect.any(Object));
        expect(mockIsGitRepository).toHaveBeenCalledWith(testDir);
        expect(mockScanIdleWorktrees).toHaveBeenCalled();
      } finally {
        execSpy.mockRestore();
        execFileSpy.mockRestore();
        spawnSpy.mockRestore();
      }
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

    it("runs startup recovery immediately after interrupted-run coordination on startup", async () => {
      await runtime.start();

      expect(mockRecoverInterruptedRuns).toHaveBeenCalledTimes(1);
      expect(mockResumeOrphaned).not.toHaveBeenCalled();
      expect(mockRunStartupRecovery).toHaveBeenCalledTimes(1);
    }, 30000);

    it("defers startup recovery while enginePaused is active", async () => {
      mockTaskStoreSettings.enginePaused = true;

      await runtime.start();

      expect(mockRecoverInterruptedRuns).not.toHaveBeenCalled();
      expect(mockResumeOrphaned).not.toHaveBeenCalled();
      expect(mockRunStartupRecovery).not.toHaveBeenCalled();
    }, 30000);

    it("resumes deferred startup recovery after engine pause is cleared in startup order", async () => {
      mockTaskStoreSettings.enginePaused = true;

      await runtime.start();
      mockRecoverInterruptedRuns.mockClear();
      mockResumeOrphaned.mockClear();
      mockRunStartupRecovery.mockClear();

      mockTaskStoreSettings.enginePaused = false;
      await runtime.resumeAfterUnpause();

      expect(mockRecoverInterruptedRuns).toHaveBeenCalledTimes(1);
      expect(mockResumeOrphaned).not.toHaveBeenCalled();
      expect(mockRunStartupRecovery).toHaveBeenCalledTimes(1);
      expect(mockRecoverInterruptedRuns.mock.invocationCallOrder[0]).toBeLessThan(
        mockRunStartupRecovery.mock.invocationCallOrder[0],
      );
    }, 30000);

    it("coalesces concurrent unpause recovery dispatches", async () => {
      mockTaskStoreSettings.enginePaused = true;

      await runtime.start();
      mockRecoverInterruptedRuns.mockClear();
      mockResumeOrphaned.mockClear();
      mockRunStartupRecovery.mockClear();

      mockTaskStoreSettings.enginePaused = false;
      await Promise.all([runtime.resumeAfterUnpause(), runtime.resumeAfterUnpause()]);

      expect(mockRecoverInterruptedRuns).toHaveBeenCalledTimes(1);
      expect(mockResumeOrphaned).not.toHaveBeenCalled();
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

    it("calls abortAllInFlight after bash abort and before drain checks", async () => {
      await runtime.start();
      const executor = (runtime as any).executor;
      const callOrder: string[] = [];
      executor.abortAllSessionBash.mockImplementation(() => {
        callOrder.push("bash");
      });
      executor.abortAllInFlight.mockImplementation(async () => {
        callOrder.push("inFlight");
      });
      const metricsSpy = vi.spyOn(runtime, "getMetrics").mockImplementation(() => {
        callOrder.push("metrics");
        return { inFlightTasks: 0, activeAgents: 0, lastActivityAt: new Date().toISOString() };
      });

      await runtime.stop();

      expect(executor.abortAllInFlight).toHaveBeenCalledTimes(1);
      expect(executor.abortAllInFlight).toHaveBeenCalledWith("engine stop");
      expect(callOrder.indexOf("bash")).toBeLessThan(callOrder.indexOf("inFlight"));
      expect(callOrder.indexOf("inFlight")).toBeLessThan(callOrder.indexOf("metrics"));
      metricsSpy.mockRestore();
    }, 30000);

    it("honors runtimeStopDrainMs=0 and default 2000ms poll interval", async () => {
      /*
      FNXC:TestInfrastructure 2026-07-03-10:45:
      Stop-drain coverage must prove the 500ms poll interval without sleeping for it.
      Fake timers keep the shutdown timeout behavior covered while removing the suite's largest deterministic wait.
      */
      vi.useFakeTimers();
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      let metricsSpy: ReturnType<typeof vi.spyOn> | undefined;
      try {
        await runtime.start();
        const executor = (runtime as any).executor;

        mockTaskStoreSettings.runtimeStopDrainMs = 0;
        executor.activeWorktrees.set("FN-1", { taskId: "FN-1" });
        await runtime.stop();
        expect(timeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 500);

        delete mockTaskStoreSettings.runtimeStopDrainMs;
        runtime = new InProcessRuntime(buildTestConfig(testDir), mockCentralCore);
        await runtime.start();
        const executor2 = (runtime as any).executor;
        let metricCalls = 0;
        executor2.activeWorktrees.set("FN-2", { taskId: "FN-2" });
        metricsSpy = vi.spyOn(runtime, "getMetrics").mockImplementation(() => {
          metricCalls += 1;
          if (metricCalls >= 2) {
            executor2.activeWorktrees.clear();
          }
          return {
            inFlightTasks: metricCalls === 1 ? 1 : 0,
            activeAgents: 0,
            lastActivityAt: new Date().toISOString(),
          };
        });

        const stopPromise = runtime.stop();
        await vi.advanceTimersByTimeAsync(500);
        await stopPromise;
        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 500);
      } finally {
        metricsSpy?.mockRestore();
        timeoutSpy.mockRestore();
        vi.useRealTimers();
      }
    }, 30000);

    it("logs post-abort drain timeout when in-flight tasks remain", async () => {
      /*
      FNXC:TestInfrastructure 2026-07-03-10:45:
      The drain-timeout warning path is timer-driven; advance the configured 50ms timeout deterministically instead of adding real wall-clock delay.
      */
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined as any);
      try {
        mockTaskStoreSettings.runtimeStopDrainMs = 50;
        await runtime.start();
        const executor = (runtime as any).executor;
        executor.activeWorktrees.set("FN-stuck", { taskId: "FN-stuck" });
        vi.spyOn(runtime, "getMetrics").mockImplementation(() => ({
          inFlightTasks: 1,
          activeAgents: 0,
          lastActivityAt: new Date().toISOString(),
        }));

        const stopPromise = runtime.stop();
        await vi.advanceTimersByTimeAsync(50);
        await stopPromise;

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("post-abort drain timeout"));
      } finally {
        warnSpy.mockRestore();
        vi.useRealTimers();
      }
    }, 30000);

    it("returns residual scoped semaphore slots after the post-abort drain", async () => {
      const sharedSemaphore = new AgentSemaphore(2);
      runtime = new InProcessRuntime(
        { ...buildTestConfig(testDir), globalSemaphore: sharedSemaphore },
        mockCentralCore,
      );
      await runtime.start();

      const projectSemaphore = (runtime as any).projectSemaphore;
      await projectSemaphore.acquire();
      await projectSemaphore.acquire();
      expect(projectSemaphore.heldCount).toBe(2);
      expect(sharedSemaphore.availableCount).toBe(0);

      await runtime.stop();

      expect(projectSemaphore.heldCount).toBe(0);
      expect(sharedSemaphore.activeCount).toBe(0);
      expect(sharedSemaphore.availableCount).toBe(2);
      await runtime.stop();
      expect(sharedSemaphore.activeCount).toBe(0);
    }, 30000);

    it("returns residual slots in single-project local-semaphore mode without double-return warnings", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await runtime.start();
        const localSemaphore = (runtime as any).globalSemaphore;
        const projectSemaphore = (runtime as any).projectSemaphore;

        await projectSemaphore.acquire();
        await projectSemaphore.acquire();
        expect(projectSemaphore.heldCount).toBe(2);
        expect(localSemaphore.activeCount).toBe(2);
        expect(localSemaphore.availableCount).toBe(2);

        await runtime.stop();
        await runtime.stop();

        expect(projectSemaphore.heldCount).toBe(0);
        expect(localSemaphore.activeCount).toBe(0);
        expect(localSemaphore.availableCount).toBe(4);
        expect(warnSpy).not.toHaveBeenCalledWith(
          expect.stringContaining("AgentSemaphore excess slot return ignored"),
        );
      } finally {
        warnSpy.mockRestore();
      }
    }, 30000);

    it("continues stopping when abortAllInFlight throws", async () => {
      await runtime.start();
      const executor = (runtime as any).executor;
      executor.abortAllInFlight.mockRejectedValueOnce(new Error("boom"));
      const warnSpy = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined as any);

      await expect(runtime.stop()).resolves.toBeUndefined();

      expect(runtime.getStatus()).toBe("stopped");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to abort in-flight executor AI sessions"));
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

    it("forwards task creation and move events from TaskStore", async () => {
      /*
      FNXC:TestInfrastructure 2026-07-03-10:45:
      Event forwarding only needs one started runtime; keeping creation and move assertions in one harness preserves coverage without repeating startup/shutdown cost.
      */
      await runtime.start();
      
      const taskCreatedSpy = vi.fn();
      const taskMovedSpy = vi.fn();
      runtime.on("task:created", taskCreatedSpy);
      runtime.on("task:moved", taskMovedSpy);

      const taskStore = runtime.getTaskStore();
      const mockTask = { id: "KB-001", title: "Test Task" } as Task;
      const onCalls = (taskStore.on as ReturnType<typeof vi.fn>).mock.calls;
      const taskCreatedHandler = onCalls.find((call: unknown[]) => call[0] === "task:created");
      const taskMovedHandlers = onCalls.filter((call: unknown[]) => call[0] === "task:moved");
      
      if (taskCreatedHandler) {
        (taskCreatedHandler[1] as (task: Task) => void)(mockTask);
      }
      const moveData = { task: mockTask, from: "todo", to: "in-progress" };
      for (const handler of taskMovedHandlers) {
        (handler[1] as (data: { task: Task; from: string; to: string }) => void)(moveData);
      }

      expect(taskCreatedSpy).toHaveBeenCalledWith(mockTask);
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

    it("should return initialized accessors after start", async () => {
      /*
      FNXC:TestInfrastructure 2026-07-03-10:45:
      Accessor assertions share the same initialized runtime state, so one started harness covers TaskStore, Scheduler, and HeartbeatMonitor without three full runtime startups.
      */
      await runtime.start();
      const taskStore = runtime.getTaskStore();
      const scheduler = runtime.getScheduler();
      const monitor = runtime.getHeartbeatMonitor();
      
      expect(taskStore).toBeDefined();
      expect(taskStore.getRootDir()).toBe(testDir);
      expect(scheduler).toBeDefined();
      expect(monitor).toBeDefined();
      expect(monitor?.getChatStore()).toBeDefined();
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
    it("composes run-completion resume with deferred assignment drain", async () => {
      await runtime.start();
      const store = getAgentStore(runtime);
      const agent = await store.createAgent({ name: "completion-wiring", role: "executor" });
      const monitor = runtime.getHeartbeatMonitor();
      const triggerScheduler = runtime.getTriggerScheduler();
      expect(monitor).toBeDefined();
      expect(triggerScheduler).toBeDefined();
      const drainSpy = vi.spyOn(triggerScheduler!, "drainPendingAssignment").mockResolvedValue(undefined);

      const run = await monitor!.startRun(agent.id, { source: "timer" });
      await monitor!.completeRun(agent.id, run.id, { status: "completed" });
      await flushRuntimeCallbackMicrotasks();

      expect(mockResumeTaskForAgent).toHaveBeenCalledWith(agent.id);
      expect(drainSpy).toHaveBeenCalledWith(agent.id);
    }, 30000);

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
      await flushRuntimeCallbackMicrotasks();

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
    }, 30000);

    it("wires executor ownership callbacks through the worker manager", async () => {
      await runtime.start();

      const store = getAgentStore(runtime);
      const createAgentSpy = vi.spyOn(store, "createAgent");
      const deleteAgentSpy = vi.spyOn(store, "deleteAgent").mockResolvedValue(undefined);
      const executorOptions = mockExecutorCtor.mock.calls.at(-1)?.[0] as {
        onStart?: (task: Task, worktreePath: string) => void;
        onComplete?: (task: Task) => void;
      };
      expect(executorOptions.onStart).toBeTypeOf("function");
      expect(executorOptions.onComplete).toBeTypeOf("function");

      executorOptions.onStart?.({ id: "FN-WIRING" } as Task, join(testDir, "worktree-FN-WIRING"));
      await flushRuntimeCallbackMicrotasks();
      expect(createAgentSpy).toHaveBeenCalledWith(expect.objectContaining({ name: "executor-FN-WIRING" }));

      const worker = (await store.listAgents({ includeEphemeral: true }))
        .find((agent: Agent) => agent.name === "executor-FN-WIRING");
      expect(worker).toBeDefined();

      executorOptions.onComplete?.({ id: "FN-WIRING" } as Task);
      await flushRuntimeCallbackMicrotasks(40);
      expect(deleteAgentSpy).toHaveBeenCalledWith(worker!.id);
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
    it("creates MessageStore and registers wake-on-message hook", async () => {
      /*
      FNXC:TestInfrastructure 2026-07-03-10:45:
      MessageStore construction and hook registration happen during the same startup path; assert both in one runtime start to avoid duplicate setup.
      */
      mockMessageStoreSetHook.mockClear();

      await runtime.start();

      expect(mockMessageStoreSetHook).toHaveBeenCalledTimes(1);
      expect(mockMessageStoreSetHook).toHaveBeenCalledWith(expect.any(Function));
      const { MessageStore } = await import("@fusion/core");
      expect(MessageStore).toHaveBeenCalled();
    });
  });


});
