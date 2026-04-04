import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useExecutorStats } from "./useExecutorStats";
import * as apiModule from "../api";
import type { Task } from "@fusion/core";

// Mock the API module
vi.mock("../api", async () => {
  const actual = await vi.importActual("../api");
  return {
    ...actual,
    fetchExecutorStats: vi.fn(),
  };
});

describe("useExecutorStats", () => {
  const mockFetchExecutorStats = apiModule.fetchExecutorStats as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
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
    it("returns 'idle' when globalPause is true", async () => {
      mockFetchExecutorStats.mockResolvedValue({
        globalPause: true,
        enginePaused: false,
        maxConcurrent: 4,
      });

      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.executorState).toBe("idle");
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
      mockFetchExecutorStats.mockRejectedValue(new Error("Network error"));

      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.error).toBe("Network error");
    });

    it("clears error on successful refresh", async () => {
      mockFetchExecutorStats.mockRejectedValueOnce(new Error("Network error"));

      const { result } = renderHook(() => useExecutorStats([]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.error).toBe("Network error");

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
  });

  describe("board-sync regression", () => {
    it("derives counts from the same tasks array the board uses", async () => {
      // Simulate a full board: 2 triage, 3 todo (1 blocked), 2 in-progress, 1 in-review, 4 done
      const tasks: Task[] = [
        createMockTask("FN-001", "triage"),
        createMockTask("FN-002", "triage"),
        createMockTask("FN-003", "todo"),
        { ...createMockTask("FN-004", "todo"), blockedBy: "FN-010" },
        createMockTask("FN-005", "todo"),
        createMockTask("FN-006", "in-progress"),
        createMockTask("FN-007", "in-progress"),
        createMockTask("FN-008", "in-review"),
        createMockTask("FN-009", "done"),
        createMockTask("FN-010", "done"),
        createMockTask("FN-011", "done"),
        createMockTask("FN-012", "done"),
      ];

      const { result } = renderHook(() => useExecutorStats(tasks));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // These must match the column counts shown on the board
      expect(result.current.stats.runningTaskCount).toBe(2);  // in-progress
      expect(result.current.stats.queuedTaskCount).toBe(3);   // todo
      expect(result.current.stats.inReviewCount).toBe(1);     // in-review
      expect(result.current.stats.blockedTaskCount).toBe(1);  // blockedBy set
      expect(result.current.stats.stuckTaskCount).toBe(0);    // all recent

      // Verify the executor state reflects running tasks
      expect(result.current.stats.executorState).toBe("running");
    });

    it("does not count triage, done, or archived tasks in any footer metric", async () => {
      const tasks: Task[] = [
        createMockTask("FN-001", "triage"),
        createMockTask("FN-002", "done"),
        createMockTask("FN-003", "archived"),
      ];

      const { result } = renderHook(() => useExecutorStats(tasks));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.runningTaskCount).toBe(0);
      expect(result.current.stats.queuedTaskCount).toBe(0);
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
