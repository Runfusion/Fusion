import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RoutineRunner, type RoutineRunnerOptions } from "./routine-runner.js";
import type {
  RoutineStore,
  Routine,
  RoutineExecutionResult,
  AgentStore,
  TaskStore,
  Settings,
} from "@fusion/core";
import type { HeartbeatMonitor } from "./agent-heartbeat.js";

// Default settings inline to avoid @fusion/core build dependency during tests
const DEFAULT_SETTINGS: Settings = {
  maxConcurrent: 2,
  maxWorktrees: 4,
  pollIntervalMs: 30000,
  autoResolveConflicts: true,
  requirePlanApproval: false,
  recycleWorktrees: false,
  worktreeNaming: "random",
  globalPause: false,
  enginePaused: false,
  ntfyEnabled: false,
  defaultProvider: "anthropic",
  defaultModelId: "claude-sonnet-4-5",
  planningProvider: "anthropic",
  planningModelId: "claude-sonnet-4-5",
  validatorProvider: "openai",
  validatorModelId: "gpt-4o",
  taskStuckTimeoutMs: undefined,
  groupOverlappingFiles: false,
  autoMerge: true,
};

function createMockRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "test-routine-id",
    agentId: "test-agent",
    name: "Test Routine",
    description: "A test routine",
    trigger: { type: "cron", cronExpression: "0 * * * *" },
    catchUpPolicy: "run_one",
    executionPolicy: "parallel",
    enabled: true,
    runCount: 0,
    runHistory: [],
    cronExpression: "0 * * * *",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockRoutineStore(routines: Routine[] = []): RoutineStore {
  const routineMap = new Map(routines.map((r) => [r.id, r]));

  return {
    getRoutine: vi.fn().mockImplementation((id: string) => {
      const routine = routineMap.get(id);
      if (!routine) {
        throw Object.assign(new Error(`Routine '${id}' not found`), { code: "ENOENT" });
      }
      return routine;
    }),
    listRoutines: vi.fn().mockResolvedValue(routines),
    updateRoutine: vi.fn().mockImplementation((id: string, _updates: any) => {
      const routine = routineMap.get(id);
      if (!routine) {
        throw Object.assign(new Error(`Routine '${id}' not found`), { code: "ENOENT" });
      }
      return routine;
    }),
    getDueRoutines: vi.fn().mockResolvedValue([]),
    recordRun: vi.fn().mockImplementation((id: string, result: RoutineExecutionResult) => {
      return createMockRoutine({ id, lastRunResult: result });
    }),
    startRoutineExecution: vi.fn().mockResolvedValue(undefined),
    completeRoutineExecution: vi.fn().mockResolvedValue(undefined),
    cancelRoutineExecution: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as RoutineStore;
}

function createMockAgentStore(): AgentStore {
  return {
    getAgent: vi.fn().mockImplementation(async (id: string) => ({
      id,
      name: "Test Agent",
      role: "executor" as const,
      state: "idle" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    updateAgentState: vi.fn().mockResolvedValue(undefined),
    getBudgetStatus: vi.fn().mockResolvedValue({
      agentId: "",
      currentUsage: 0,
      budgetLimit: null,
      usagePercent: null,
      thresholdPercent: null,
      isOverBudget: false,
      isOverThreshold: false,
      lastResetAt: null,
      nextResetAt: null,
    }),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as AgentStore;
}

function createMockTaskStore(): TaskStore {
  return {
    getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function createMockHeartbeatMonitor(): HeartbeatMonitor {
  return {
    executeHeartbeat: vi.fn().mockResolvedValue({
      id: "run-123",
      agentId: "test-agent",
      status: "completed" as const,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    }),
    start: vi.fn(),
    stop: vi.fn(),
    trackAgent: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as HeartbeatMonitor;
}

function createRoutineRunner(options?: Partial<RoutineRunnerOptions>): RoutineRunner {
  return new RoutineRunner({
    routineStore: options?.routineStore ?? createMockRoutineStore(),
    heartbeatMonitor: options?.heartbeatMonitor ?? createMockHeartbeatMonitor(),
    rootDir: options?.rootDir ?? "/test/root",
  });
}

describe("RoutineRunner", () => {
  describe("executeRoutine", () => {
    it("successfully executes a routine with trigger type 'cron'", async () => {
      const routine = createMockRoutine({ id: "routine-1", name: "Test Routine" });
      const routineStore = createMockRoutineStore([routine]);
      const heartbeatMonitor = createMockHeartbeatMonitor();
      const runner = createRoutineRunner({ routineStore, heartbeatMonitor });

      const result = await runner.executeRoutine("routine-1", "cron");

      expect(result.routineId).toBe("routine-1");
      expect(result.success).toBe(true);
      expect(heartbeatMonitor.executeHeartbeat).toHaveBeenCalledTimes(1);
      expect(heartbeatMonitor.executeHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "routine",
          triggerDetail: "routine:routine-1:cron",
        }),
      );
    });

    it("throws descriptive error when routine not found", async () => {
      const routineStore = createMockRoutineStore([]);
      const runner = createRoutineRunner({ routineStore });

      await expect(runner.executeRoutine("nonexistent", "cron")).rejects.toThrow(
        "Routine 'nonexistent' not found",
      );
    });

    it("throws descriptive error when routine is disabled", async () => {
      const routine = createMockRoutine({ id: "routine-disabled", enabled: false });
      const routineStore = createMockRoutineStore([routine]);
      const runner = createRoutineRunner({ routineStore });

      await expect(runner.executeRoutine("routine-disabled", "cron")).rejects.toThrow(
        "Routine 'routine-disabled' is disabled",
      );
    });

    it("calls executeHeartbeat with source 'routine' and correct triggerDetail format", async () => {
      const routine = createMockRoutine({ id: "routine-trigger", name: "Trigger Test" });
      const routineStore = createMockRoutineStore([routine]);
      const heartbeatMonitor = createMockHeartbeatMonitor();
      const runner = createRoutineRunner({ routineStore, heartbeatMonitor });

      await runner.executeRoutine("routine-trigger", "webhook");

      expect(heartbeatMonitor.executeHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "routine",
          triggerDetail: "routine:routine-trigger:webhook",
        }),
      );
    });

    it("includes routineId, routineName, triggerType in contextSnapshot", async () => {
      const routine = createMockRoutine({ id: "routine-context", name: "Context Test" });
      const routineStore = createMockRoutineStore([routine]);
      const heartbeatMonitor = createMockHeartbeatMonitor();
      const runner = createRoutineRunner({ routineStore, heartbeatMonitor });

      await runner.executeRoutine("routine-context", "api");

      expect(heartbeatMonitor.executeHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          contextSnapshot: expect.objectContaining({
            routineId: "routine-context",
            routineName: "Context Test",
            triggerType: "api",
          }),
        }),
      );
    });

    it("calls completeRoutineExecution after execution completes", async () => {
      const routine = createMockRoutine({ id: "routine-record" });
      const routineStore = createMockRoutineStore([routine]);
      const heartbeatMonitor = createMockHeartbeatMonitor();
      const runner = createRoutineRunner({ routineStore, heartbeatMonitor });

      await runner.executeRoutine("routine-record", "cron");

      // completeRoutineExecution is called once with the result
      expect(routineStore.completeRoutineExecution).toHaveBeenCalledTimes(1);
      expect(routineStore.completeRoutineExecution).toHaveBeenCalledWith(
        "routine-record",
        expect.objectContaining({
          success: true,
        }),
      );
    });

    it("marks execution as failed when executeHeartbeat rejects", async () => {
      const routine = createMockRoutine({ id: "routine-fail" });
      const routineStore = createMockRoutineStore([routine]);
      const heartbeatMonitor = createMockHeartbeatMonitor();
      (heartbeatMonitor.executeHeartbeat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Heartbeat failed"),
      );
      const runner = createRoutineRunner({ routineStore, heartbeatMonitor });

      const result = await runner.executeRoutine("routine-fail", "cron");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Heartbeat failed");
    });

    it("cleans up inFlightExecutions map after successful completion", async () => {
      const routine = createMockRoutine({ id: "routine-cleanup" });
      const routineStore = createMockRoutineStore([routine]);
      const heartbeatMonitor = createMockHeartbeatMonitor();
      const runner = createRoutineRunner({ routineStore, heartbeatMonitor });

      expect(runner.isRoutineRunning("routine-cleanup")).toBe(false);

      await runner.executeRoutine("routine-cleanup", "cron");

      // After completion, should not be in-flight
      expect(runner.isRoutineRunning("routine-cleanup")).toBe(false);
    });

    it("cleans up inFlightExecutions map even on error", async () => {
      const routine = createMockRoutine({ id: "routine-error-cleanup", enabled: false });
      const routineStore = createMockRoutineStore([routine]);
      const runner = createRoutineRunner({ routineStore });

      try {
        await runner.executeRoutine("routine-error-cleanup", "cron");
      } catch {
        // Expected to throw
      }

      // After an error, the routine should not be in the in-flight map
      expect(runner.isRoutineRunning("routine-error-cleanup")).toBe(false);
    });
  });

  describe("concurrency policies", () => {
    it("parallel policy: runs even when another execution is in-flight", async () => {
      const routine = createMockRoutine({
        id: "routine-parallel",
        executionPolicy: "parallel",
      });
      const routineStore = createMockRoutineStore([routine]);
      const heartbeatMonitor = createMockHeartbeatMonitor();
      // Make heartbeat slow
      (heartbeatMonitor.executeHeartbeat as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          await new Promise((r) => setTimeout(r, 50));
          return {
            id: "run-123",
            agentId: "test-agent",
            status: "completed" as const,
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
          };
        },
      );
      const runner = createRoutineRunner({ routineStore, heartbeatMonitor });

      // Start two executions
      const [result1, result2] = await Promise.all([
        runner.executeRoutine("routine-parallel", "cron"),
        runner.executeRoutine("routine-parallel", "cron"),
      ]);

      // Both should succeed (parallel)
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });

    it("reject policy: returns failed result when another execution is in-flight", async () => {
      const routine = createMockRoutine({
        id: "routine-reject",
        executionPolicy: "reject",
      });
      const routineStore = createMockRoutineStore([routine]);
      const heartbeatMonitor = createMockHeartbeatMonitor();
      // Make heartbeat slow
      (heartbeatMonitor.executeHeartbeat as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          await new Promise((r) => setTimeout(r, 100));
          return {
            id: "run-123",
            agentId: "test-agent",
            status: "completed" as const,
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
          };
        },
      );
      const runner = createRoutineRunner({ routineStore, heartbeatMonitor });

      // Start first execution
      const promise1 = runner.executeRoutine("routine-reject", "cron");

      // Immediately try second execution - should be rejected
      const result2 = await runner.executeRoutine("routine-reject", "cron");

      expect(result2.success).toBe(false);
      expect(result2.error).toBe("Routine rejected — already running");
      expect(heartbeatMonitor.executeHeartbeat).toHaveBeenCalledTimes(1); // Only first call

      await promise1; // Clean up
    });

    it("queue policy: waits for existing execution to complete", async () => {
      const routine = createMockRoutine({
        id: "routine-queue",
        executionPolicy: "queue",
      });
      const routineStore = createMockRoutineStore([routine]);
      const heartbeatMonitor = createMockHeartbeatMonitor();
      let callCount = 0;
      (heartbeatMonitor.executeHeartbeat as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          callCount++;
          await new Promise((r) => setTimeout(r, 50));
          return {
            id: "run-123",
            agentId: "test-agent",
            status: "completed" as const,
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
          };
        },
      );
      const runner = createRoutineRunner({ routineStore, heartbeatMonitor });

      // Start first execution
      const [result1, result2] = await Promise.all([
        runner.executeRoutine("routine-queue", "cron"),
        runner.executeRoutine("routine-queue", "cron"),
      ]);

      // Both should succeed (second waited for first)
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      // Both heartbeats should have been called (sequential due to queue)
      expect(callCount).toBe(2);
    });
  });

  describe("handleCatchUp", () => {
    it("skip policy: does NOT call executeRoutine, only logs", async () => {
      const routine = createMockRoutine({
        id: "routine-catchup-skip",
        catchUpPolicy: "skip",
        lastRunAt: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
        cronExpression: "0 * * * *",
      });
      const routineStore = createMockRoutineStore([routine]);
      const heartbeatMonitor = createMockHeartbeatMonitor();
      const runner = createRoutineRunner({ routineStore, heartbeatMonitor });

      await runner.handleCatchUp(routine);

      // No executions should have happened
      expect(heartbeatMonitor.executeHeartbeat).not.toHaveBeenCalled();
    });

    it("never-run routine (lastRunAt undefined): skips catch-up", async () => {
      const routine = createMockRoutine({
        id: "routine-never-run",
        lastRunAt: undefined,
        cronExpression: "0 * * * *",
      });
      const routineStore = createMockRoutineStore([routine]);
      const heartbeatMonitor = createMockHeartbeatMonitor();
      const runner = createRoutineRunner({ routineStore, heartbeatMonitor });

      await runner.handleCatchUp(routine);

      // No executions should have happened
      expect(heartbeatMonitor.executeHeartbeat).not.toHaveBeenCalled();
    });

    it("caps at MAX_CATCH_UP_INTERVALS (10) even when more intervals exist", async () => {
      const twoHoursAgo = new Date(Date.now() - 7200000);
      const routine = createMockRoutine({
        id: "routine-many-missed",
        catchUpPolicy: "run",
        lastRunAt: twoHoursAgo.toISOString(),
        cronExpression: "*/5 * * * *", // Every 5 minutes = 24 missed in 2 hours
      });
      const routineStore = createMockRoutineStore([routine]);
      const heartbeatMonitor = createMockHeartbeatMonitor();
      const runner = createRoutineRunner({ routineStore, heartbeatMonitor });

      await runner.handleCatchUp(routine);

      // Should be capped at 10
      expect(heartbeatMonitor.executeHeartbeat).toHaveBeenCalledTimes(10);
    });
  });

  describe("helper methods", () => {
    it("getInFlightCount returns correct count", async () => {
      const routine1 = createMockRoutine({ id: "routine-count-1" });
      const routine2 = createMockRoutine({ id: "routine-count-2" });
      const routineStore = createMockRoutineStore([routine1, routine2]);
      const heartbeatMonitor = createMockHeartbeatMonitor();
      // Make heartbeat slow to allow checking in-flight count
      (heartbeatMonitor.executeHeartbeat as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          await new Promise((r) => setTimeout(r, 100));
          return {
            id: "run-123",
            agentId: "test-agent",
            status: "completed" as const,
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
          };
        },
      );
      const runner = createRoutineRunner({ routineStore, heartbeatMonitor });

      expect(runner.getInFlightCount()).toBe(0);

      // Start first execution
      const promise1 = runner.executeRoutine("routine-count-1", "cron");
      // Allow microtask to complete to see the in-flight state
      await new Promise((r) => setTimeout(r, 10));
      expect(runner.getInFlightCount()).toBe(1);

      // Start second execution (will run in parallel since policy is "parallel")
      const promise2 = runner.executeRoutine("routine-count-2", "cron");
      await new Promise((r) => setTimeout(r, 10));
      expect(runner.getInFlightCount()).toBe(2);

      await Promise.all([promise1, promise2]);
      expect(runner.getInFlightCount()).toBe(0);
    });

    it("isRoutineRunning returns true during execution, false after", async () => {
      const routine = createMockRoutine({ id: "routine-running" });
      const routineStore = createMockRoutineStore([routine]);
      const heartbeatMonitor = createMockHeartbeatMonitor();
      // Make heartbeat slow to allow checking in-flight state
      (heartbeatMonitor.executeHeartbeat as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          await new Promise((r) => setTimeout(r, 50));
          return {
            id: "run-123",
            agentId: "test-agent",
            status: "completed" as const,
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
          };
        },
      );
      const runner = createRoutineRunner({ routineStore, heartbeatMonitor });

      expect(runner.isRoutineRunning("routine-running")).toBe(false);

      const promise = runner.executeRoutine("routine-running", "cron");
      // Allow microtask to complete to see the in-flight state
      await new Promise((r) => setTimeout(r, 10));
      expect(runner.isRoutineRunning("routine-running")).toBe(true);

      await promise;
      expect(runner.isRoutineRunning("routine-running")).toBe(false);
    });
  });
});
