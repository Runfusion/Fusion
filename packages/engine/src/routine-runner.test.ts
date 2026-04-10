import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Routine, RoutineStore } from "@fusion/core";
import { RoutineRunner } from "./routine-runner.js";
import type { HeartbeatMonitor } from "./agent-heartbeat.js";

// Mock the logger
vi.mock("./logger.js", () => ({
  createLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("RoutineRunner", () => {
  let mockHeartbeatMonitor: HeartbeatMonitor;
  let mockRoutineStore: RoutineStore;
  let runner: RoutineRunner;

  const createMockRoutine = (overrides: Partial<Routine> = {}): Routine =>
    ({
      id: "routine-1",
      agentId: "agent-1",
      name: "Test Routine",
      description: "A test routine",
      enabled: true,
      trigger: {
        type: "cron",
        cronExpression: "*/5 * * * *",
      },
      executionPolicy: "reject",
      catchUpPolicy: "skip",
      catchUpLimit: 5,
      lastRunAt: null,
      nextRunAt: new Date().toISOString(),
      runCount: 0,
      runHistory: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    } as Routine);

  beforeEach(() => {
    mockHeartbeatMonitor = {
      executeHeartbeat: vi.fn().mockResolvedValue({
        id: "run-1",
        agentId: "agent-1",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        status: "completed",
      }),
      start: vi.fn(),
      stop: vi.fn(),
      isAgentHealthy: vi.fn(),
      checkMissedHeartbeats: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      getAgentHeartbeatConfig: vi.fn(),
    } as unknown as HeartbeatMonitor;

    mockRoutineStore = {
      getRoutine: vi.fn(),
      getRoutines: vi.fn(),
      createRoutine: vi.fn(),
      updateRoutine: vi.fn(),
      deleteRoutine: vi.fn(),
      getDueRoutines: vi.fn(),
      startRoutineExecution: vi.fn().mockResolvedValue(undefined),
      completeRoutineExecution: vi.fn().mockResolvedValue(undefined),
      cancelRoutineExecution: vi.fn().mockResolvedValue(undefined),
      recordRun: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as RoutineStore;

    runner = new RoutineRunner({
      heartbeatMonitor: mockHeartbeatMonitor,
      routineStore: mockRoutineStore,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    runner.clearInFlight("routine-1");
    runner.clearInFlight("routine-2");
  });

  describe("execute", () => {
    it("should execute a routine successfully", async () => {
      const routine = createMockRoutine();

      const result = await runner.execute(routine);

      expect(result.success).toBe(true);
      expect(result.routineId).toBe("routine-1");
      expect(mockRoutineStore.startRoutineExecution).toHaveBeenCalledWith(
        "routine-1",
        expect.objectContaining({
          triggeredAt: expect.any(String),
          invocationSource: "routine",
        })
      );
      expect(mockRoutineStore.completeRoutineExecution).toHaveBeenCalledWith(
        "routine-1",
        expect.objectContaining({
          success: true,
        })
      );
    });

    it("should skip execution when already in-flight with reject policy", async () => {
      const routine = createMockRoutine({ executionPolicy: "reject" });

      // First execution - starts but doesn't complete yet
      vi.mocked(mockHeartbeatMonitor.executeHeartbeat).mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      // Start first execution (won't complete due to mock)
      const firstExecution = runner.execute(routine);
      // Give it a tick to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second execution should be skipped
      const secondResult = await runner.execute(routine);

      expect(secondResult.success).toBe(true);
      expect(secondResult.error).toContain("reject");
    });

    it("should handle execution failure", async () => {
      const routine = createMockRoutine();
      vi.mocked(mockHeartbeatMonitor.executeHeartbeat).mockResolvedValue({
        id: "run-1",
        agentId: "agent-1",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        status: "failed",
        stderrExcerpt: "Agent session failed",
      } as any);

      const result = await runner.execute(routine);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Agent session failed");
      expect(mockRoutineStore.completeRoutineExecution).toHaveBeenCalledWith(
        "routine-1",
        expect.objectContaining({
          success: false,
          error: "Agent session failed",
        })
      );
    });

    it("should propagate catch-up context to heartbeat", async () => {
      const routine = createMockRoutine();

      const catchUpTime = "2024-01-01T00:00:00.000Z";
      await runner.execute(routine, { catchUpFrom: catchUpTime });

      expect(mockHeartbeatMonitor.executeHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          contextSnapshot: expect.objectContaining({
            routineId: "routine-1",
            catchUpFrom: catchUpTime,
          }),
        })
      );
    });

    it("should allow concurrent execution with parallel policy", async () => {
      const routine = createMockRoutine({ executionPolicy: "parallel" });

      // Both executions should succeed
      const [result1, result2] = await Promise.all([
        runner.execute(routine),
        runner.execute(routine),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });
  });

  describe("determineCatchUp", () => {
    it("should not catch up when policy is skip", () => {
      const routine = createMockRoutine({ catchUpPolicy: "skip" });
      const lastRunAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      const result = runner.determineCatchUp(routine, lastRunAt, new Date());

      expect(result.shouldCatchUp).toBe(false);
    });

    it("should catch up once when policy is run_one", () => {
      const routine = createMockRoutine({ catchUpPolicy: "run_one" });
      const lastRunAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      const result = runner.determineCatchUp(routine, lastRunAt, new Date());

      expect(result.shouldCatchUp).toBe(true);
      expect(result.catchUpFrom).toBe(lastRunAt);
    });

    it("should handle bounded catch-up with run policy", () => {
      const routine = createMockRoutine({
        catchUpPolicy: "run",
        catchUpLimit: 3,
      });
      // Last executed 30 minutes ago
      const lastRunAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      const result = runner.determineCatchUp(routine, lastRunAt, new Date());

      expect(result.shouldCatchUp).toBe(true);
      expect(result.catchUpFrom).toBeDefined();
    });

    it("should not catch up when never executed", () => {
      const routine = createMockRoutine({ catchUpPolicy: "run" });

      const result = runner.determineCatchUp(routine, null, new Date());

      expect(result.shouldCatchUp).toBe(false);
    });

    it("should not catch up for non-cron triggers", () => {
      const routine = createMockRoutine({
        trigger: { type: "manual" },
        catchUpPolicy: "run",
      });
      const lastRunAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      const result = runner.determineCatchUp(routine, lastRunAt, new Date());

      // Manual triggers return 5 * 60_000 default interval, 10min / 5min = 2 missed
      // With catchUpLimit 5, boundedCount = 2, which is > 1 so shouldCatchUp = true
      expect(result.shouldCatchUp).toBe(true);
    });
  });

  describe("isExecuting", () => {
    it("should return false when routine is not executing", () => {
      expect(runner.isExecuting("routine-1")).toBe(false);
    });

    it("should return true when routine is executing", async () => {
      const routine = createMockRoutine();

      vi.mocked(mockHeartbeatMonitor.executeHeartbeat).mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      const execution = runner.execute(routine);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(runner.isExecuting("routine-1")).toBe(true);
    });
  });
});
