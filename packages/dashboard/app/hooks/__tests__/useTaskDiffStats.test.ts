import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTaskDiffStats } from "../useTaskDiffStats";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchTaskDiff: vi.fn(),
}));

const mockFetchTaskDiff = vi.mocked(api.fetchTaskDiff);

describe("useTaskDiffStats", () => {
  beforeEach(() => {
    mockFetchTaskDiff.mockReset();
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

  it("does not fetch for non-done columns", async () => {
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
});
