import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, fireEvent } from "@testing-library/react";
import { useExecutorStats } from "../useExecutorStats";
import * as apiModule from "../../api";
import type { Task } from "@fusion/core";

// Mock the API module
vi.mock("../../api", async () => {
  const actual = await vi.importActual("../../api");
  return {
    ...actual,
    fetchExecutorStats: vi.fn(),
  };
});

describe("useExecutorStats", () => {
  const mockFetchExecutorStats = apiModule.fetchExecutorStats as ReturnType<typeof vi.fn>;

  function createDeferredStats() {
    let resolve!: (value: Awaited<ReturnType<typeof apiModule.fetchExecutorStats>>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<Awaited<ReturnType<typeof apiModule.fetchExecutorStats>>>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    return { promise, resolve, reject };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    mockFetchExecutorStats.mockResolvedValue({
      globalPause: false,
      enginePaused: false,
      maxConcurrent: 4,
      lastActivityAt: "2026-04-01T12:00:00.000Z",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("returns initial stats with zero counts when tasks array is empty", async () => {
      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.runningTaskCount).toBe(0);
      expect(result.current.stats.blockedTaskCount).toBe(0);
      expect(result.current.stats.stuckTaskCount).toBe(0);
      expect(result.current.stats.queuedTaskCount).toBe(0);
      expect(result.current.stats.inReviewCount).toBe(0);
    });

    it("uses maxConcurrent from API", async () => {
      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.maxConcurrent).toBe(4);
    });

    it("uses lastActivityAt from API", async () => {
      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.lastActivityAt).toBe("2026-04-01T12:00:00.000Z");
    });
  });

  describe("task count derivations", () => {
    it("counts tasks in in-progress column as runningTaskCount", async () => {
      const tasks: Task[] = [
        createMockTask("FN-001", "in-progress"),
        createMockTask("FN-002", "in-progress"),
        createMockTask("FN-003", "in-progress"),
      ];

      const { result } = renderHook(() => useExecutorStats(tasks));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.runningTaskCount).toBe(3);
    });

    it("counts tasks in todo column as queuedTaskCount", async () => {
      const tasks: Task[] = [
        createMockTask("FN-001", "todo"),
        createMockTask("FN-002", "todo"),
      ];

      const { result } = renderHook(() => useExecutorStats(tasks));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.queuedTaskCount).toBe(2);
    });

    it("counts tasks in in-review column as inReviewCount", async () => {
      const tasks: Task[] = [
        createMockTask("FN-001", "in-review"),
        createMockTask("FN-002", "in-review"),
        createMockTask("FN-003", "in-review"),
      ];

      const { result } = renderHook(() => useExecutorStats(tasks));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.inReviewCount).toBe(3);
    });

    it("counts tasks with blockedBy set as blockedTaskCount", async () => {
      const tasks: Task[] = [
        { ...createMockTask("FN-001", "todo"), blockedBy: "FN-000" },
        { ...createMockTask("FN-002", "todo") }, // no blockedBy
        { ...createMockTask("FN-003", "todo"), blockedBy: "FN-002" },
      ];

      const { result } = renderHook(() => useExecutorStats(tasks));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.blockedTaskCount).toBe(2);
    });

    it("does not count tasks without blockedBy as blocked", async () => {
      const tasks: Task[] = [
        createMockTask("FN-001", "todo"),
        createMockTask("FN-002", "todo"),
        createMockTask("FN-003", "todo"),
      ];

      const { result } = renderHook(() => useExecutorStats(tasks));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.blockedTaskCount).toBe(0);
    });

    it("does not count tasks with empty blockedBy string as blocked", async () => {
      const tasks: Task[] = [
        { ...createMockTask("FN-001", "todo"), blockedBy: "" },
        { ...createMockTask("FN-002", "todo"), blockedBy: "" },
      ];

      const { result } = renderHook(() => useExecutorStats(tasks));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.blockedTaskCount).toBe(0);
    });
  });

  describe("stuck task detection", () => {
    it("detects tasks in in-progress with no activity beyond threshold as stuck", async () => {
      // Set updatedAt to 11 minutes ago
      const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      const tasks: Task[] = [
        { ...createMockTask("FN-001", "in-progress"), updatedAt: elevenMinutesAgo },
        { ...createMockTask("FN-002", "in-progress") }, // just updated
      ];

      // Pass 10-minute (600000ms) threshold
      const { result } = renderHook(() => useExecutorStats(tasks, undefined, 600000));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.stuckTaskCount).toBe(1);
    });

    it("returns 0 stuck tasks when taskStuckTimeoutMs is undefined (disabled)", async () => {
      const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      const tasks: Task[] = [
        { ...createMockTask("FN-001", "in-progress"), updatedAt: elevenMinutesAgo },
      ];

      // No threshold = stuck detection disabled
      const { result } = renderHook(() => useExecutorStats(tasks));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.stuckTaskCount).toBe(0);
    });

    it("does not count non-in-progress tasks as stuck even if old", async () => {
      // Set updatedAt to 11 minutes ago for a todo task
      const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      const tasks: Task[] = [
        { ...createMockTask("FN-001", "todo"), updatedAt: elevenMinutesAgo },
      ];

      const { result } = renderHook(() => useExecutorStats(tasks, undefined, 600000));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.stuckTaskCount).toBe(0);
    });

    it("does not count recent in-progress tasks as stuck", async () => {
      // Set updatedAt to 5 minutes ago — below the 10-minute threshold
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const tasks: Task[] = [
        { ...createMockTask("FN-001", "in-progress"), updatedAt: fiveMinutesAgo },
      ];

      const { result } = renderHook(() => useExecutorStats(tasks, undefined, 600000));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.stuckTaskCount).toBe(0);
    });

    it("respects custom threshold values", async () => {
      // Set updatedAt to 3 minutes ago
      const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      const tasks: Task[] = [
        { ...createMockTask("FN-001", "in-progress"), updatedAt: threeMinutesAgo },
      ];

      // With a 2-minute threshold, it should be stuck
      const { result } = renderHook(() => useExecutorStats(tasks, undefined, 120000));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.stuckTaskCount).toBe(1);
    });

    it("returns 0 when taskStuckTimeoutMs is 0", async () => {
      const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      const tasks: Task[] = [
        { ...createMockTask("FN-001", "in-progress"), updatedAt: elevenMinutesAgo },
      ];

      const { result } = renderHook(() => useExecutorStats(tasks, undefined, 0));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.stuckTaskCount).toBe(0);
    });
  });

  describe("executor state derivation", () => {
    it("returns 'stopped' when globalPause is true", async () => {
      mockFetchExecutorStats.mockResolvedValue({
        globalPause: true,
        enginePaused: false,
        maxConcurrent: 4,
      });

      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.executorState).toBe("stopped");
    });

    it("returns 'stopped' when globalPause is true even with running tasks", async () => {
      const tasks: Task[] = [createMockTask("FN-001", "in-progress")];
      mockFetchExecutorStats.mockResolvedValue({
        globalPause: true,
        enginePaused: false,
        maxConcurrent: 4,
      });

      const { result } = renderHook(() => useExecutorStats(tasks));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.runningTaskCount).toBe(1);
      expect(result.current.stats.executorState).toBe("stopped");
    });

    it("returns 'idle' when enginePaused is true and runningTaskCount is 0", async () => {
      mockFetchExecutorStats.mockResolvedValue({
        globalPause: false,
        enginePaused: true,
        maxConcurrent: 4,
      });

      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.executorState).toBe("idle");
    });

    it("returns 'paused' when enginePaused is true and runningTaskCount > 0", async () => {
      const tasks: Task[] = [createMockTask("FN-001", "in-progress")];
      mockFetchExecutorStats.mockResolvedValue({
        globalPause: false,
        enginePaused: true,
        maxConcurrent: 4,
      });

      const { result } = renderHook(() => useExecutorStats(tasks));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.executorState).toBe("paused");
    });

    it("returns 'running' when globalPause is false, enginePaused is false, and runningTaskCount > 0", async () => {
      const tasks: Task[] = [createMockTask("FN-001", "in-progress")];
      mockFetchExecutorStats.mockResolvedValue({
        globalPause: false,
        enginePaused: false,
        maxConcurrent: 4,
      });

      const { result } = renderHook(() => useExecutorStats(tasks));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.executorState).toBe("running");
    });

    it("returns 'idle' when no tasks are running and not paused", async () => {
      mockFetchExecutorStats.mockResolvedValue({
        globalPause: false,
        enginePaused: false,
        maxConcurrent: 4,
      });

      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.executorState).toBe("idle");
    });
  });

  describe("project context", () => {
    it("passes projectId to fetchExecutorStats when provided", async () => {
      renderHook(() => useExecutorStats([], "proj_abc123"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(mockFetchExecutorStats).toHaveBeenCalledWith("proj_abc123");
    });

    it("passes undefined to fetchExecutorStats when projectId is not provided", async () => {
      renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(mockFetchExecutorStats).toHaveBeenCalledWith(undefined);
    });

    it("treats a project switch as a fresh initial load without showing prior project stats", async () => {
      const projectBFetch = createDeferredStats();
      mockFetchExecutorStats
        .mockResolvedValueOnce({
          globalPause: false,
          enginePaused: false,
          maxConcurrent: 9,
          lastActivityAt: "2026-04-01T12:00:00.000Z",
        })
        .mockReturnValueOnce(projectBFetch.promise);

      const { result, rerender } = renderHook(
        ({ projectId }) => useExecutorStats([], projectId),
        { initialProps: { projectId: "project-a" } }
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(result.current.loading).toBe(false);
      expect(result.current.stats.maxConcurrent).toBe(9);

      rerender({ projectId: "project-b" });

      expect(result.current.loading).toBe(true);
      expect(result.current.stats.maxConcurrent).toBe(2);
      expect(result.current.stats.lastActivityAt).toBeUndefined();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(mockFetchExecutorStats).toHaveBeenLastCalledWith("project-b");
      expect(result.current.loading).toBe(true);

      await act(async () => {
        projectBFetch.resolve({
          globalPause: false,
          enginePaused: false,
          maxConcurrent: 6,
          lastActivityAt: "2026-04-01T12:05:00.000Z",
        });
        await projectBFetch.promise;
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.stats.maxConcurrent).toBe(6);
      expect(result.current.stats.lastActivityAt).toBe("2026-04-01T12:05:00.000Z");
    });

    it("does not inherit transient-failure debounce state across project switches", async () => {
      mockFetchExecutorStats
        .mockResolvedValueOnce({
          globalPause: false,
          enginePaused: false,
          maxConcurrent: 9,
        })
        .mockRejectedValueOnce(new Error("Load failed"));

      const { result, rerender } = renderHook(
        ({ projectId }) => useExecutorStats([], projectId),
        { initialProps: { projectId: "project-a" } }
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(result.current.error).toBeNull();

      rerender({ projectId: "project-b" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe("Load failed");
    });
  });

  describe("reactive task updates", () => {
    it("reflects new task counts when tasks change", async () => {
      const initialTasks: Task[] = [
        createMockTask("FN-001", "todo"),
      ];

      const { result, rerender } = renderHook(
        ({ tasks }) => useExecutorStats(tasks),
        { initialProps: { tasks: initialTasks } }
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.queuedTaskCount).toBe(1);
      expect(result.current.stats.runningTaskCount).toBe(0);

      // Simulate task moving from todo to in-progress
      const updatedTasks: Task[] = [
        { ...createMockTask("FN-001", "in-progress") },
        createMockTask("FN-002", "todo"),
      ];

      rerender({ tasks: updatedTasks });

      expect(result.current.stats.queuedTaskCount).toBe(1);
      expect(result.current.stats.runningTaskCount).toBe(1);
    });
  });

  describe("refresh function", () => {
    it("reports loading only for the initial unresolved fetch", async () => {
      const initialFetch = createDeferredStats();
      mockFetchExecutorStats.mockReturnValueOnce(initialFetch.promise);

      const { result } = renderHook(() => useExecutorStats([]));

      expect(result.current.loading).toBe(true);

      await act(async () => {
        initialFetch.resolve({
          globalPause: false,
          enginePaused: false,
          maxConcurrent: 4,
          lastActivityAt: "2026-04-01T12:00:00.000Z",
        });
        await initialFetch.promise;
      });

      expect(result.current.loading).toBe(false);
    });

    it("keeps loading false during post-success background heartbeat refreshes", async () => {
      const backgroundFetch = createDeferredStats();
      mockFetchExecutorStats
        .mockResolvedValueOnce({
          globalPause: false,
          enginePaused: false,
          maxConcurrent: 4,
          lastActivityAt: "2026-04-01T12:00:00.000Z",
        })
        .mockReturnValueOnce(backgroundFetch.promise);

      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(result.current.loading).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(mockFetchExecutorStats).toHaveBeenCalledTimes(2);
      expect(result.current.loading).toBe(false);

      await act(async () => {
        backgroundFetch.resolve({
          globalPause: false,
          enginePaused: false,
          maxConcurrent: 7,
          lastActivityAt: "2026-04-01T12:05:00.000Z",
        });
        await backgroundFetch.promise;
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.stats.maxConcurrent).toBe(7);
    });

    it("manually refreshes stats", async () => {
      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.maxConcurrent).toBe(4);

      // Update mock to return new data
      mockFetchExecutorStats.mockResolvedValueOnce({
        globalPause: true,
        enginePaused: false,
        maxConcurrent: 8,
      });

      await act(async () => {
        await result.current.refresh();
      });

      expect(mockFetchExecutorStats).toHaveBeenCalled();
      expect(result.current.stats.maxConcurrent).toBe(8);
    });
  });

  describe("error handling", () => {
    it("sets error state when API call fails", async () => {
      mockFetchExecutorStats.mockRejectedValue(new Error("Request failed: 500"));

      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.error).toBe("Request failed: 500");
    });

    it("clears error on successful refresh", async () => {
      mockFetchExecutorStats.mockRejectedValueOnce(new Error("Request failed: 500"));

      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.error).toBe("Request failed: 500");

      mockFetchExecutorStats.mockResolvedValueOnce({
        globalPause: false,
        enginePaused: false,
        maxConcurrent: 4,
      });

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.error).toBeNull();
    });

    it("surfaces a first-ever transient fetch failure when no last-good stats exist", async () => {
      mockFetchExecutorStats.mockRejectedValueOnce(new Error("Load failed"));

      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.error).toBe("Load failed");
    });

    it("suppresses a single transient failure after a prior success and keeps last-good stats", async () => {
      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(result.current.error).toBeNull();
      expect(result.current.stats.maxConcurrent).toBe(4);

      mockFetchExecutorStats.mockRejectedValueOnce(new Error("Load failed"));

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.stats.maxConcurrent).toBe(4);
    });

    it("surfaces sustained consecutive transient failures after the debounce threshold", async () => {
      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      mockFetchExecutorStats.mockRejectedValueOnce(new Error("Load failed"));
      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.error).toBeNull();

      mockFetchExecutorStats.mockRejectedValueOnce(new Error("Failed to fetch"));
      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.error).toBe("Failed to fetch");
    });

    it("resets the transient failure counter after a successful refresh", async () => {
      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      mockFetchExecutorStats.mockRejectedValueOnce(new Error("Load failed"));
      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.error).toBeNull();

      mockFetchExecutorStats.mockResolvedValueOnce({
        globalPause: false,
        enginePaused: false,
        maxConcurrent: 6,
      });
      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.error).toBeNull();
      expect(result.current.stats.maxConcurrent).toBe(6);

      mockFetchExecutorStats.mockRejectedValueOnce(new Error("Failed to fetch"));
      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.error).toBeNull();
    });

    it("keeps visibility-resume suppression ahead of transient failure debounce", async () => {
      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      act(() => {
        fireEvent(document, new Event("visibilitychange"));
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      act(() => {
        fireEvent(document, new Event("visibilitychange"));
      });

      mockFetchExecutorStats.mockRejectedValueOnce(new Error("Load failed"));
      await act(async () => {
        await result.current.refresh();
      });
      mockFetchExecutorStats.mockRejectedValueOnce(new Error("Failed to fetch"));
      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe("board-sync regression", () => {
    it("derives the complete footer count matrix from the same tasks array the board uses", async () => {
      const now = new Date("2026-07-03T12:00:00.000Z").getTime();
      const staleUpdatedAt = new Date(now - 11 * 60 * 1000).toISOString();
      const freshUpdatedAt = new Date(now - 2 * 60 * 1000).toISOString();
      const tasks: Task[] = [
        createMockTask("FN-001", "triage"),
        createMockTask("FN-002", "todo"),
        { ...createMockTask("FN-003", "in-progress"), updatedAt: staleUpdatedAt },
        { ...createMockTask("FN-004", "in-progress"), updatedAt: freshUpdatedAt },
        createMockTask("FN-005", "in-review"),
        { ...createMockTask("FN-006", "done"), status: "running" } as Task,
        createMockTask("FN-007", "archived"),
        { ...createMockTask("FN-008", "todo"), blockedBy: "FN-006" },
        { ...createMockTask("FN-009", "todo"), dependencies: ["FN-006"] },
        { ...createMockTask("FN-010", "todo"), blockedBy: ["FN-006", "FN-006"] } as unknown as Task,
        { ...createMockTask("FN-011", "todo"), blockedBy: "" },
        { ...createMockTask("FN-012", "todo"), blockedBy: [] } as unknown as Task,
        { ...createMockTask("FN-013", "todo"), blockedBy: null } as unknown as Task,
        { ...createMockTask("FN-014", "custom-column" as Task["column"]) },
        { ...createMockTask("FN-015", "triage"), status: "planning" } as Task,
        { ...createMockTask("FN-016", "custom-planning" as Task["column"]), status: "planning" } as Task,
      ];

      const { result } = renderHook(() => useExecutorStats(tasks, undefined, 10 * 60 * 1000, now));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.queuedTaskCount).toBe(10); // triage/planning + todo, no done/archived/non-planning custom
      expect(result.current.stats.runningTaskCount).toBe(2); // in-progress only
      expect(result.current.stats.stuckTaskCount).toBe(1); // stuck is an in-progress subset
      expect(result.current.stats.blockedTaskCount).toBe(2); // actionable string/array blockedBy only
      expect(result.current.stats.inReviewCount).toBe(1); // in-review only
      expect("doneTaskCount" in result.current.stats).toBe(false);
      expect(result.current.stats.executorState).toBe("running");
    });

    it("counts planning/triage as queued but excludes done, archived, and unknown columns", async () => {
      const tasks: Task[] = [
        createMockTask("FN-001", "triage"),
        { ...createMockTask("FN-002", "triage"), status: "planning" } as Task,
        createMockTask("FN-003", "done"),
        createMockTask("FN-004", "archived"),
        { ...createMockTask("FN-005", "custom-column" as Task["column"]) },
        { ...createMockTask("FN-006", "custom-planning" as Task["column"]), status: "planning" } as Task,
      ];

      const { result } = renderHook(() => useExecutorStats(tasks));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.runningTaskCount).toBe(0);
      expect(result.current.stats.queuedTaskCount).toBe(3);
      expect(result.current.stats.inReviewCount).toBe(0);
      expect(result.current.stats.blockedTaskCount).toBe(0);
      expect(result.current.stats.stuckTaskCount).toBe(0);
    });

    it("updates counts immediately when tasks array reference changes", async () => {
      const initialTasks: Task[] = [
        createMockTask("FN-001", "todo"),
        createMockTask("FN-002", "todo"),
      ];

      const { result, rerender } = renderHook(
        ({ tasks }) => useExecutorStats(tasks),
        { initialProps: { tasks: initialTasks } },
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.queuedTaskCount).toBe(2);

      // Move FN-001 to in-progress, add a new todo
      const updatedTasks: Task[] = [
        { ...createMockTask("FN-001", "in-progress") },
        createMockTask("FN-002", "todo"),
        createMockTask("FN-003", "todo"),
      ];

      rerender({ tasks: updatedTasks });

      // Should reflect immediately without waiting for polling
      expect(result.current.stats.queuedTaskCount).toBe(2);
      expect(result.current.stats.runningTaskCount).toBe(1);
    });

    it("uses string blockedBy matching the real Task type", async () => {
      // Regression: blockedBy is string | undefined, not string[]
      const tasks: Task[] = [
        { ...createMockTask("FN-001", "todo"), blockedBy: "FN-099" },  // string, not array
        { ...createMockTask("FN-002", "in-progress"), blockedBy: "FN-098" },
        { ...createMockTask("FN-003", "todo") },  // no blockedBy
      ];

      const { result } = renderHook(() => useExecutorStats(tasks));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // Both FN-001 and FN-002 have blockedBy set
      expect(result.current.stats.blockedTaskCount).toBe(2);
    });
  });
});

function createMockTask(id: string, column: Task["column"]): Task {
  return {
    id,
    description: `Task ${id}`,
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
