import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
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

// Mock useTasks hook
vi.mock("./useTasks", () => ({
  useTasks: vi.fn(() => ({
    tasks: [],
    createTask: vi.fn(),
    moveTask: vi.fn(),
    deleteTask: vi.fn(),
    mergeTask: vi.fn(),
    retryTask: vi.fn(),
    updateTask: vi.fn(),
    duplicateTask: vi.fn(),
    archiveTask: vi.fn(),
    unarchiveTask: vi.fn(),
    archiveAllDone: vi.fn(),
  })),
}));

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
      const { useTasks } = await import("./useTasks");
      vi.mocked(useTasks).mockReturnValue({
        tasks: [],
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      const { result } = renderHook(() => useExecutorStats());

      // Advance timers to let the initial fetch complete
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
      const { useTasks } = await import("./useTasks");
      vi.mocked(useTasks).mockReturnValue({
        tasks: [],
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.maxConcurrent).toBe(4);
    });

    it("uses lastActivityAt from API", async () => {
      const { useTasks } = await import("./useTasks");
      vi.mocked(useTasks).mockReturnValue({
        tasks: [],
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.lastActivityAt).toBe("2026-04-01T12:00:00.000Z");
    });
  });

  describe("task count derivations", () => {
    it("counts tasks in in-progress column as runningTaskCount", async () => {
      const { useTasks } = await import("./useTasks");
      const tasks: Task[] = [
        createMockTask("FN-001", "in-progress"),
        createMockTask("FN-002", "in-progress"),
        createMockTask("FN-003", "in-progress"),
      ];
      vi.mocked(useTasks).mockReturnValue({
        tasks,
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.runningTaskCount).toBe(3);
    });

    it("counts tasks in todo column as queuedTaskCount", async () => {
      const { useTasks } = await import("./useTasks");
      const tasks: Task[] = [
        createMockTask("FN-001", "todo"),
        createMockTask("FN-002", "todo"),
      ];
      vi.mocked(useTasks).mockReturnValue({
        tasks,
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.queuedTaskCount).toBe(2);
    });

    it("counts tasks in in-review column as inReviewCount", async () => {
      const { useTasks } = await import("./useTasks");
      const tasks: Task[] = [
        createMockTask("FN-001", "in-review"),
        createMockTask("FN-002", "in-review"),
        createMockTask("FN-003", "in-review"),
      ];
      vi.mocked(useTasks).mockReturnValue({
        tasks,
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.inReviewCount).toBe(3);
    });

    it("counts tasks with blockedBy set as blockedTaskCount", async () => {
      const { useTasks } = await import("./useTasks");
      const tasks: Task[] = [
        { ...createMockTask("FN-001", "todo"), blockedBy: ["FN-000"] },
        { ...createMockTask("FN-002", "todo") }, // no blockedBy
        { ...createMockTask("FN-003", "todo"), blockedBy: ["FN-001", "FN-002"] },
      ];
      vi.mocked(useTasks).mockReturnValue({
        tasks,
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.blockedTaskCount).toBe(2);
    });

    it("does not count tasks without blockedBy as blocked", async () => {
      const { useTasks } = await import("./useTasks");
      const tasks: Task[] = [
        createMockTask("FN-001", "todo"),
        createMockTask("FN-002", "todo"),
        createMockTask("FN-003", "todo"),
      ];
      vi.mocked(useTasks).mockReturnValue({
        tasks,
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.blockedTaskCount).toBe(0);
    });

    it("does not count tasks with empty blockedBy array as blocked", async () => {
      const { useTasks } = await import("./useTasks");
      const tasks: Task[] = [
        { ...createMockTask("FN-001", "todo"), blockedBy: [] },
        { ...createMockTask("FN-002", "todo"), blockedBy: [] },
      ];
      vi.mocked(useTasks).mockReturnValue({
        tasks,
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.blockedTaskCount).toBe(0);
    });
  });

  describe("stuck task detection", () => {
    it("detects tasks in in-progress with no activity for > 10 minutes as stuck", async () => {
      const { useTasks } = await import("./useTasks");
      // Set updatedAt to 11 minutes ago
      const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      const tasks: Task[] = [
        { ...createMockTask("FN-001", "in-progress"), updatedAt: elevenMinutesAgo },
        { ...createMockTask("FN-002", "in-progress") }, // just updated
      ];
      vi.mocked(useTasks).mockReturnValue({
        tasks,
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.stuckTaskCount).toBe(1);
    });

    it("does not count non-in-progress tasks as stuck even if old", async () => {
      const { useTasks } = await import("./useTasks");
      // Set updatedAt to 11 minutes ago for a todo task
      const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      const tasks: Task[] = [
        { ...createMockTask("FN-001", "todo"), updatedAt: elevenMinutesAgo },
      ];
      vi.mocked(useTasks).mockReturnValue({
        tasks,
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.stuckTaskCount).toBe(0);
    });

    it("does not count recent in-progress tasks as stuck", async () => {
      const { useTasks } = await import("./useTasks");
      // Set updatedAt to 5 minutes ago
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const tasks: Task[] = [
        { ...createMockTask("FN-001", "in-progress"), updatedAt: fiveMinutesAgo },
      ];
      vi.mocked(useTasks).mockReturnValue({
        tasks,
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.stuckTaskCount).toBe(0);
    });
  });

  describe("executor state derivation", () => {
    it("returns 'idle' when globalPause is true", async () => {
      const { useTasks } = await import("./useTasks");
      vi.mocked(useTasks).mockReturnValue({
        tasks: [],
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });
      mockFetchExecutorStats.mockResolvedValue({
        globalPause: true,
        enginePaused: false,
        maxConcurrent: 4,
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.executorState).toBe("idle");
    });

    it("returns 'idle' when enginePaused is true and runningTaskCount is 0", async () => {
      const { useTasks } = await import("./useTasks");
      vi.mocked(useTasks).mockReturnValue({
        tasks: [],
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });
      mockFetchExecutorStats.mockResolvedValue({
        globalPause: false,
        enginePaused: true,
        maxConcurrent: 4,
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.executorState).toBe("idle");
    });

    it("returns 'paused' when enginePaused is true and runningTaskCount > 0", async () => {
      const { useTasks } = await import("./useTasks");
      const tasks: Task[] = [createMockTask("FN-001", "in-progress")];
      vi.mocked(useTasks).mockReturnValue({
        tasks,
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });
      mockFetchExecutorStats.mockResolvedValue({
        globalPause: false,
        enginePaused: true,
        maxConcurrent: 4,
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.executorState).toBe("paused");
    });

    it("returns 'running' when globalPause is false, enginePaused is false, and runningTaskCount > 0", async () => {
      const { useTasks } = await import("./useTasks");
      const tasks: Task[] = [createMockTask("FN-001", "in-progress")];
      vi.mocked(useTasks).mockReturnValue({
        tasks,
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });
      mockFetchExecutorStats.mockResolvedValue({
        globalPause: false,
        enginePaused: false,
        maxConcurrent: 4,
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.executorState).toBe("running");
    });

    it("returns 'idle' when no tasks are running and not paused", async () => {
      const { useTasks } = await import("./useTasks");
      vi.mocked(useTasks).mockReturnValue({
        tasks: [],
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });
      mockFetchExecutorStats.mockResolvedValue({
        globalPause: false,
        enginePaused: false,
        maxConcurrent: 4,
      });

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.stats.executorState).toBe("idle");
    });
  });

  describe("project context", () => {
    it("passes projectId to useTasks when provided", async () => {
      const { useTasks } = await import("./useTasks");
      const mockUseTasks = vi.mocked(useTasks);
      mockUseTasks.mockReturnValue({
        tasks: [],
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      renderHook(() => useExecutorStats("proj_abc123"));

      expect(mockUseTasks).toHaveBeenCalledWith({ projectId: "proj_abc123" });
    });

    it("passes no options to useTasks when projectId is not provided", async () => {
      const { useTasks } = await import("./useTasks");
      const mockUseTasks = vi.mocked(useTasks);
      mockUseTasks.mockReturnValue({
        tasks: [],
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      renderHook(() => useExecutorStats());

      expect(mockUseTasks).toHaveBeenCalledWith(undefined);
    });
  });

  describe("refresh function", () => {
    it("manually refreshes stats", async () => {
      const { useTasks } = await import("./useTasks");
      vi.mocked(useTasks).mockReturnValue({
        tasks: [],
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });

      const { result } = renderHook(() => useExecutorStats());

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
      const { useTasks } = await import("./useTasks");
      vi.mocked(useTasks).mockReturnValue({
        tasks: [],
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });
      mockFetchExecutorStats.mockRejectedValue(new Error("Network error"));

      const { result } = renderHook(() => useExecutorStats());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      expect(result.current.error).toBe("Network error");
    });

    it("clears error on successful refresh", async () => {
      const { useTasks } = await import("./useTasks");
      vi.mocked(useTasks).mockReturnValue({
        tasks: [],
        createTask: vi.fn(),
        moveTask: vi.fn(),
        deleteTask: vi.fn(),
        mergeTask: vi.fn(),
        retryTask: vi.fn(),
        updateTask: vi.fn(),
        duplicateTask: vi.fn(),
        archiveTask: vi.fn(),
        unarchiveTask: vi.fn(),
        archiveAllDone: vi.fn(),
      });
      mockFetchExecutorStats.mockRejectedValueOnce(new Error("Network error"));

      const { result } = renderHook(() => useExecutorStats());

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
