import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTaskDiffStats, __test_clearDiffStatsCache } from "../useTaskDiffStats";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchTaskDiff: vi.fn(),
}));

const mockFetchTaskDiff = vi.mocked(api.fetchTaskDiff);

describe("useTaskDiffStats", () => {
  beforeEach(() => {
    mockFetchTaskDiff.mockReset();
    __test_clearDiffStatsCache();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches diff stats for done tasks with a commit SHA", async () => {
    mockFetchTaskDiff.mockResolvedValueOnce({
      files: [
        { path: "src/a.ts", status: "modified", additions: 10, deletions: 2, patch: "" },
        { path: "src/b.ts", status: "added", additions: 5, deletions: 0, patch: "" },
      ],
      stats: { filesChanged: 2, additions: 15, deletions: 2 },
    });

    const { result } = renderHook(() =>
      useTaskDiffStats("FN-123", "done", "abc1234", undefined),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.stats).toEqual({ filesChanged: 2, additions: 15, deletions: 2 });
    expect(mockFetchTaskDiff).toHaveBeenCalledWith("FN-123", undefined, undefined);
  });

  it("passes projectId to fetchTaskDiff", async () => {
    mockFetchTaskDiff.mockResolvedValueOnce({
      files: [],
      stats: { filesChanged: 0, additions: 0, deletions: 0 },
    });

    const { result } = renderHook(() =>
      useTaskDiffStats("FN-123", "done", "abc1234", "proj-1"),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchTaskDiff).toHaveBeenCalledWith("FN-123", undefined, "proj-1");
  });

  it("does not fetch for active columns without a worktree", async () => {
    const { result: inProgress } = renderHook(() =>
      useTaskDiffStats("FN-123", "in-progress", "abc1234", undefined),
    );
    const { result: todo } = renderHook(() =>
      useTaskDiffStats("FN-123", "todo", "abc1234", undefined),
    );
    const { result: inReview } = renderHook(() =>
      useTaskDiffStats("FN-123", "in-review", "abc1234", undefined),
    );

    await waitFor(() => expect(inProgress.current.loading).toBe(false));
    await waitFor(() => expect(todo.current.loading).toBe(false));
    await waitFor(() => expect(inReview.current.loading).toBe(false));

    expect(inProgress.current.stats).toBeNull();
    expect(todo.current.stats).toBeNull();
    expect(inReview.current.stats).toBeNull();
    expect(mockFetchTaskDiff).not.toHaveBeenCalled();
  });

  it("fetches diff stats for active tasks with a worktree", async () => {
    mockFetchTaskDiff.mockResolvedValueOnce({
      files: [
        { path: "src/a.ts", status: "modified", additions: 10, deletions: 2, patch: "" },
      ],
      stats: { filesChanged: 1, additions: 10, deletions: 2 },
    });

    const { result } = renderHook(() =>
      useTaskDiffStats(
        "FN-123",
        "in-progress",
        undefined,
        "proj-1",
        { worktree: "/repo/.worktrees/fn-123" },
      ),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.stats).toEqual({ filesChanged: 1, additions: 10, deletions: 2 });
    expect(mockFetchTaskDiff).toHaveBeenCalledWith("FN-123", "/repo/.worktrees/fn-123", "proj-1");
  });

  it("does not fetch for done tasks without a commit SHA", async () => {
    const { result } = renderHook(() =>
      useTaskDiffStats("FN-123", "done", undefined, undefined),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.stats).toBeNull();
    expect(mockFetchTaskDiff).not.toHaveBeenCalled();
  });

  it("does not fetch for empty task ID", async () => {
    const { result } = renderHook(() =>
      useTaskDiffStats("", "done", "abc1234", undefined),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.stats).toBeNull();
    expect(mockFetchTaskDiff).not.toHaveBeenCalled();
  });

  it("returns null stats on fetch failure", async () => {
    mockFetchTaskDiff.mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() =>
      useTaskDiffStats("FN-123", "done", "abc1234", undefined),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.stats).toBeNull();
  });

  it("cancels in-flight request on dependency change", async () => {
    let resolveFirst: (value: unknown) => void;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    mockFetchTaskDiff.mockReturnValueOnce(firstPromise as any);
    mockFetchTaskDiff.mockResolvedValueOnce({
      files: [],
      stats: { filesChanged: 3, additions: 5, deletions: 1 },
    });

    const { result, rerender } = renderHook(
      ({ taskId }) => useTaskDiffStats(taskId, "done", "abc1234", undefined),
      { initialProps: { taskId: "FN-100" } },
    );

    // Rerender with a different taskId before the first fetch resolves
    rerender({ taskId: "FN-200" });

    // Resolve the first (now cancelled) request
    resolveFirst!({
      files: [],
      stats: { filesChanged: 99, additions: 99, deletions: 99 },
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // The cancelled response should not have been stored
    expect(result.current.stats).toEqual({ filesChanged: 3, additions: 5, deletions: 1 });
    expect(mockFetchTaskDiff).toHaveBeenCalledTimes(2);
  });

  it("resets stats when column changes from done to non-done", async () => {
    mockFetchTaskDiff.mockResolvedValueOnce({
      files: [],
      stats: { filesChanged: 5, additions: 10, deletions: 3 },
    });

    const { result, rerender } = renderHook(
      ({ column }) => useTaskDiffStats("FN-123", column, "abc1234", undefined),
      { initialProps: { column: "done" as string } },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stats).toEqual({ filesChanged: 5, additions: 10, deletions: 3 });

    // Switch to a non-done column
    rerender({ column: "in-progress" });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stats).toBeNull();
  });

  describe("enabled option", () => {
    it("fetches when enabled is true (default)", async () => {
      mockFetchTaskDiff.mockResolvedValueOnce({
        files: [],
        stats: { filesChanged: 1, additions: 2, deletions: 3 },
      });

      const { result } = renderHook(() =>
        useTaskDiffStats("FN-123", "done", "abc1234", undefined, { enabled: true }),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.stats).toEqual({ filesChanged: 1, additions: 2, deletions: 3 });
      expect(mockFetchTaskDiff).toHaveBeenCalled();
    });

    it("fetches when enabled is not specified (default)", async () => {
      mockFetchTaskDiff.mockResolvedValueOnce({
        files: [],
        stats: { filesChanged: 1, additions: 2, deletions: 3 },
      });

      const { result } = renderHook(() =>
        useTaskDiffStats("FN-123", "done", "abc1234", undefined),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.stats).toEqual({ filesChanged: 1, additions: 2, deletions: 3 });
      expect(mockFetchTaskDiff).toHaveBeenCalled();
    });

    it("does not fetch when enabled is false", async () => {
      const { result } = renderHook(() =>
        useTaskDiffStats("FN-123", "done", "abc1234", undefined, { enabled: false }),
      );

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.stats).toBeNull();
      expect(mockFetchTaskDiff).not.toHaveBeenCalled();
    });

    it("returns stable state (loading: false) when disabled", async () => {
      const { result } = renderHook(() =>
        useTaskDiffStats("FN-123", "done", "abc1234", undefined, { enabled: false }),
      );

      // Immediately check (before any async)
      expect(result.current.loading).toBe(false);
      expect(result.current.stats).toBeNull();

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.stats).toBeNull();
      expect(mockFetchTaskDiff).not.toHaveBeenCalled();
    });

    it("respects enabled flag changes", async () => {
      mockFetchTaskDiff.mockResolvedValueOnce({
        files: [],
        stats: { filesChanged: 5, additions: 10, deletions: 2 },
      });

      const { result, rerender } = renderHook(
        ({ enabled }) => useTaskDiffStats("FN-123", "done", "abc1234", undefined, { enabled }),
        { initialProps: { enabled: true } },
      );

      // Fetch should happen initially
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.stats).toEqual({ filesChanged: 5, additions: 10, deletions: 2 });

      // Toggle enabled off - should not refetch
      mockFetchTaskDiff.mockClear();
      rerender({ enabled: false });

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(mockFetchTaskDiff).not.toHaveBeenCalled();
    });
  });

  describe("caching", () => {
    beforeEach(() => {
      // Clear cache before each caching test to ensure isolation
      __test_clearDiffStatsCache();
      mockFetchTaskDiff.mockClear();
    });

    it("returns cached stats without making a fetch", async () => {
      // First render - fetches and caches
      mockFetchTaskDiff.mockResolvedValueOnce({
        files: [],
        stats: { filesChanged: 10, additions: 50, deletions: 5 },
      });

      const { result: first } = renderHook(() =>
        useTaskDiffStats("FN-CACHE-1", "done", "abc1234", undefined),
      );

      await waitFor(() => expect(first.current.loading).toBe(false));
      expect(first.current.stats).toEqual({ filesChanged: 10, additions: 50, deletions: 5 });
      expect(mockFetchTaskDiff).toHaveBeenCalledTimes(1);

      // Second render with same taskId - should use cache
      mockFetchTaskDiff.mockClear();

      const { result: second } = renderHook(() =>
        useTaskDiffStats("FN-CACHE-1", "done", "abc1234", undefined),
      );

      await waitFor(() => expect(second.current.loading).toBe(false));
      // Should return cached value, not new value
      expect(second.current.stats).toEqual({ filesChanged: 10, additions: 50, deletions: 5 });
      // No additional fetch
      expect(mockFetchTaskDiff).not.toHaveBeenCalled();
    });

    it("returns cached stats immediately without loading flicker", async () => {
      // Pre-populate cache by doing an initial fetch
      mockFetchTaskDiff.mockResolvedValueOnce({
        files: [],
        stats: { filesChanged: 7, additions: 30, deletions: 3 },
      });

      const { result: first } = renderHook(() =>
        useTaskDiffStats("FN-CACHE-2", "done", "abc1234", undefined),
      );

      await waitFor(() => expect(first.current.loading).toBe(false));
      expect(first.current.stats).toEqual({ filesChanged: 7, additions: 30, deletions: 3 });

      // Second hook instance - cache hit should be immediate
      mockFetchTaskDiff.mockClear();

      const { result: second } = renderHook(() =>
        useTaskDiffStats("FN-CACHE-2", "done", "abc1234", undefined),
      );

      // Cache hit - no loading state, no fetch
      expect(second.current.loading).toBe(false);
      expect(second.current.stats).toEqual({ filesChanged: 7, additions: 30, deletions: 3 });
      expect(mockFetchTaskDiff).not.toHaveBeenCalled();
    });

    it("caches stats separately per task ID", async () => {
      // Pre-populate cache for FN-100
      mockFetchTaskDiff.mockResolvedValueOnce({
        files: [],
        stats: { filesChanged: 5, additions: 25, deletions: 2 },
      });

      const { result: first } = renderHook(() =>
        useTaskDiffStats("FN-100", "done", "abc1234", undefined),
      );

      await waitFor(() => expect(first.current.loading).toBe(false));
      expect(first.current.stats).toEqual({ filesChanged: 5, additions: 25, deletions: 2 });

      // Fetch for FN-200 (note: cache already has FN-100 entry)
      mockFetchTaskDiff.mockResolvedValueOnce({
        files: [],
        stats: { filesChanged: 15, additions: 100, deletions: 10 },
      });

      const { result: second } = renderHook(() =>
        useTaskDiffStats("FN-200", "done", "def5678", undefined),
      );

      await waitFor(() => expect(second.current.loading).toBe(false));
      expect(second.current.stats).toEqual({ filesChanged: 15, additions: 100, deletions: 10 });

      // Both should have been fetched (FN-100 was in cache from first test's beforeEach, but this test's beforeEach cleared it)
      expect(mockFetchTaskDiff).toHaveBeenCalledTimes(2);

      // Each should have its own cached value
      mockFetchTaskDiff.mockClear();

      const { result: cached1 } = renderHook(() =>
        useTaskDiffStats("FN-100", "done", "abc1234", undefined),
      );
      const { result: cached2 } = renderHook(() =>
        useTaskDiffStats("FN-200", "done", "def5678", undefined),
      );

      expect(cached1.current.stats).toEqual({ filesChanged: 5, additions: 25, deletions: 2 });
      expect(cached2.current.stats).toEqual({ filesChanged: 15, additions: 100, deletions: 10 });
      expect(mockFetchTaskDiff).not.toHaveBeenCalled();
    });

    it("caches stats separately per project ID", async () => {
      // Pre-populate cache for task without projectId
      mockFetchTaskDiff.mockResolvedValueOnce({
        files: [],
        stats: { filesChanged: 3, additions: 15, deletions: 1 },
      });

      const { result: first } = renderHook(() =>
        useTaskDiffStats("FN-PROJ", "done", "abc1234", undefined),
      );

      await waitFor(() => expect(first.current.loading).toBe(false));
      expect(first.current.stats).toEqual({ filesChanged: 3, additions: 15, deletions: 1 });

      // Fetch same task with different projectId
      mockFetchTaskDiff.mockResolvedValueOnce({
        files: [],
        stats: { filesChanged: 8, additions: 40, deletions: 4 },
      });

      const { result: second } = renderHook(() =>
        useTaskDiffStats("FN-PROJ", "done", "abc1234", "proj-1"),
      );

      await waitFor(() => expect(second.current.loading).toBe(false));
      expect(second.current.stats).toEqual({ filesChanged: 8, additions: 40, deletions: 4 });

      // Both should have been fetched
      expect(mockFetchTaskDiff).toHaveBeenCalledTimes(2);

      // Cache should have both entries
      mockFetchTaskDiff.mockClear();

      const { result: cachedNoProj } = renderHook(() =>
        useTaskDiffStats("FN-PROJ", "done", "abc1234", undefined),
      );
      const { result: cachedWithProj } = renderHook(() =>
        useTaskDiffStats("FN-PROJ", "done", "abc1234", "proj-1"),
      );

      expect(cachedNoProj.current.stats).toEqual({ filesChanged: 3, additions: 15, deletions: 1 });
      expect(cachedWithProj.current.stats).toEqual({ filesChanged: 8, additions: 40, deletions: 4 });
      expect(mockFetchTaskDiff).not.toHaveBeenCalled();
    });

    it("clears cache via __test_clearDiffStatsCache", async () => {
      // Pre-populate cache
      mockFetchTaskDiff.mockResolvedValueOnce({
        files: [],
        stats: { filesChanged: 5, additions: 25, deletions: 2 },
      });

      const { result: first } = renderHook(() =>
        useTaskDiffStats("FN-CLEAR", "done", "abc1234", undefined),
      );

      await waitFor(() => expect(first.current.loading).toBe(false));
      expect(first.current.stats).toEqual({ filesChanged: 5, additions: 25, deletions: 2 });

      // Clear cache
      __test_clearDiffStatsCache();

      // Next fetch should not hit cache
      mockFetchTaskDiff.mockClear();
      mockFetchTaskDiff.mockResolvedValueOnce({
        files: [],
        stats: { filesChanged: 99, additions: 999, deletions: 99 },
      });

      const { result: second } = renderHook(() =>
        useTaskDiffStats("FN-CLEAR", "done", "abc1234", undefined),
      );

      await waitFor(() => expect(second.current.loading).toBe(false));
      // Should fetch fresh value
      expect(second.current.stats).toEqual({ filesChanged: 99, additions: 999, deletions: 99 });
      expect(mockFetchTaskDiff).toHaveBeenCalled();
    });
  });
});
