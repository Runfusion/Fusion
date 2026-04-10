import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Routine, RoutineStore, ProjectSettings } from "@fusion/core";
import { RoutineScheduler } from "./routine-scheduler.js";
import type { RoutineRunner } from "./routine-runner.js";

// Mock the logger
vi.mock("./logger.js", () => ({
  createLogger: () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe("RoutineScheduler", () => {
  let mockRoutineStore: RoutineStore;
  let mockRoutineRunner: RoutineRunner;
  let mockGetSettings: ReturnType<typeof vi.fn>;
  let onStart: ReturnType<typeof vi.fn>;
  let onStop: ReturnType<typeof vi.fn>;
  let scheduler: RoutineScheduler;

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
    mockRoutineStore = {
      getRoutine: vi.fn(),
      listRoutines: vi.fn(),
      createRoutine: vi.fn(),
      updateRoutine: vi.fn(),
      deleteRoutine: vi.fn(),
      getDueRoutines: vi.fn().mockResolvedValue([]),
      startRoutineExecution: vi.fn().mockResolvedValue(undefined),
      completeRoutineExecution: vi.fn().mockResolvedValue(undefined),
      cancelRoutineExecution: vi.fn().mockResolvedValue(undefined),
      recordRun: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as RoutineStore;

    mockRoutineRunner = {
      execute: vi.fn().mockResolvedValue({ success: true }),
      isExecuting: vi.fn().mockReturnValue(false),
      determineCatchUp: vi.fn().mockReturnValue({ shouldCatchUp: false }),
      clearInFlight: vi.fn(),
    } as unknown as RoutineRunner;

    mockGetSettings = vi.fn().mockReturnValue({
      globalPause: false,
      enginePaused: false,
    });

    onStart = vi.fn();
    onStop = vi.fn();

    scheduler = new RoutineScheduler({
      routineStore: mockRoutineStore,
      routineRunner: mockRoutineRunner,
      pollIntervalMs: 1000, // Fast for testing
      getSettings: mockGetSettings as () => ProjectSettings,
      onStart,
      onStop,
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.clearAllMocks();
  });

  describe("lifecycle", () => {
    it("should start and stop correctly", () => {
      scheduler.start();
      expect(scheduler.getStatus()).toBe("running");
      expect(onStart).toHaveBeenCalled();

      scheduler.stop();
      expect(scheduler.getStatus()).toBe("stopped");
      expect(onStop).toHaveBeenCalled();
    });

    it("should not start twice", () => {
      scheduler.start();
      scheduler.start(); // Second start should be no-op
      expect(onStart).toHaveBeenCalledTimes(1);
      scheduler.stop();
    });

    it("should not stop twice", () => {
      scheduler.start();
      scheduler.stop();
      scheduler.stop(); // Second stop should be no-op
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("should subscribe to routine store events on start", () => {
      scheduler.start();
      expect(mockRoutineStore.on).toHaveBeenCalledWith(
        "routine:created",
        expect.any(Function)
      );
      expect(mockRoutineStore.on).toHaveBeenCalledWith(
        "routine:updated",
        expect.any(Function)
      );
      expect(mockRoutineStore.on).toHaveBeenCalledWith(
        "routine:deleted",
        expect.any(Function)
      );
    });

    it("should unsubscribe from routine store events on stop", () => {
      scheduler.start();
      scheduler.stop();
      expect(mockRoutineStore.off).toHaveBeenCalledWith(
        "routine:created",
        expect.any(Function)
      );
      expect(mockRoutineStore.off).toHaveBeenCalledWith(
        "routine:updated",
        expect.any(Function)
      );
      expect(mockRoutineStore.off).toHaveBeenCalledWith(
        "routine:deleted",
        expect.any(Function)
      );
    });
  });

  describe("poll behavior", () => {
    it("should skip poll when globalPause is true", async () => {
      mockGetSettings.mockReturnValue({ globalPause: true });
      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(mockRoutineStore.getDueRoutines).not.toHaveBeenCalled();
    });

    it("should skip poll when enginePaused is true", async () => {
      mockGetSettings.mockReturnValue({ enginePaused: true });
      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(mockRoutineStore.getDueRoutines).not.toHaveBeenCalled();
    });

    it("should process due routines", async () => {
      const routine = createMockRoutine();
      vi.mocked(mockRoutineStore.getDueRoutines).mockResolvedValue([routine]);
      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(mockRoutineStore.getDueRoutines).toHaveBeenCalled();
      expect(mockRoutineRunner.execute).toHaveBeenCalledWith(routine);
    });

    it("should skip disabled routines", async () => {
      const routine = createMockRoutine({ enabled: false });
      vi.mocked(mockRoutineStore.getDueRoutines).mockResolvedValue([routine]);
      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(mockRoutineRunner.execute).not.toHaveBeenCalled();
    });

    it("should skip routines that are already executing", async () => {
      const routine = createMockRoutine();
      vi.mocked(mockRoutineStore.getDueRoutines).mockResolvedValue([routine]);
      vi.mocked(mockRoutineRunner.isExecuting).mockReturnValue(true);
      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(mockRoutineRunner.execute).not.toHaveBeenCalled();
    });

    it("should handle catch-up execution", async () => {
      const routine = createMockRoutine({ catchUpPolicy: "run_one" });
      vi.mocked(mockRoutineStore.getDueRoutines).mockResolvedValue([routine]);
      vi.mocked(mockRoutineRunner.determineCatchUp).mockReturnValue({
        shouldCatchUp: true,
        catchUpFrom: "2024-01-01T00:00:00.000Z",
      });
      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(mockRoutineRunner.execute).toHaveBeenCalledWith(routine, {
        catchUpFrom: "2024-01-01T00:00:00.000Z",
      });
    });

    it("should isolate per-routine failures", async () => {
      const routine1 = createMockRoutine({ id: "routine-1" });
      const routine2 = createMockRoutine({ id: "routine-2" });
      vi.mocked(mockRoutineStore.getDueRoutines).mockResolvedValue([
        routine1,
        routine2,
      ]);
      vi.mocked(mockRoutineRunner.execute)
        .mockRejectedValueOnce(new Error("Failed"))
        .mockResolvedValueOnce({ success: true, routineId: "routine-2", executedAt: new Date().toISOString() });
      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Both should have been attempted despite the first failure
      expect(mockRoutineRunner.execute).toHaveBeenCalledTimes(2);
    });
  });

  describe("re-entrance guard", () => {
    it("should skip concurrent polls", async () => {
      // Make getDueRoutines slow
      vi.mocked(mockRoutineStore.getDueRoutines).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 500))
      );
      scheduler.start();

      // Trigger immediate poll
      await scheduler.triggerPoll();

      // The slow poll should be running, triggerPoll should complete quickly
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(scheduler.getStatus()).toBe("running");
    });
  });
});
