import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import * as api from "../../api";
import { useTasks } from "../useTasks";

vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  const fetchTasks = vi.fn();
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchTasks,
    fetchTaskPage: vi.fn(async (projectId?: string, options?: { query?: string }) => {
      const tasks = await fetchTasks(undefined, undefined, projectId, options?.query, options?.query ? false : true);
      return { tasks, total: tasks.length, hasMore: false, nextCursor: null };
    }),
    fetchCompletedTasks: vi.fn(),
  });
});

const fetchTasks = vi.mocked(api.fetchTasks);
const fetchCompletedTasks = vi.mocked(api.fetchCompletedTasks);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function task(id: string, column: string): Task {
  return {
    id,
    description: id,
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
  } as Task;
}

describe("useTasks Done pagination", () => {
  beforeEach(() => {
    localStorage.clear();
    fetchTasks.mockReset().mockResolvedValue([task("FN-CURRENT", "todo")]);
    fetchCompletedTasks.mockReset().mockResolvedValue({ tasks: [], total: 0, hasMore: false });
  });

  it("loads 50 Done tasks initially while exposing the exact server total", async () => {
    const completed = Array.from({ length: 50 }, (_, index) => task(`FN-DONE-${index}`, "done"));
    fetchCompletedTasks.mockResolvedValueOnce({ tasks: completed, total: 1_284, hasMore: true });

    const { result } = renderHook(() => useTasks({ projectId: "project-a", sseEnabled: false }));

    await waitFor(() => expect(result.current.tasks).toHaveLength(51));
    expect(fetchTasks).toHaveBeenCalledWith(undefined, undefined, "project-a", undefined, true);
    expect(fetchCompletedTasks).toHaveBeenCalledWith("project-a", 50, 0, "completion-date-desc");
    expect(result.current.completedTotal).toBe(1_284);
    expect(result.current.completedHasMore).toBe(true);
  });

  it("loads every page when completed history exceeds 202 rows", async () => {
    const completed = Array.from({ length: 205 }, (_, index) => task(`FN-DONE-${205 - index}`, "done"));
    for (let offset = 0; offset < completed.length; offset += 50) {
      const page = completed.slice(offset, offset + 50);
      fetchCompletedTasks.mockResolvedValueOnce({
        tasks: page,
        total: completed.length,
        hasMore: offset + page.length < completed.length,
      });
    }

    const { result } = renderHook(() => useTasks({ projectId: "project-a", sseEnabled: false }));
    await waitFor(() => expect(result.current.completedTotal).toBe(205));
    while (result.current.completedHasMore) {
      await act(async () => result.current.loadMoreCompletedTasks());
    }

    const doneIds = result.current.tasks.filter((candidate) => candidate.column === "done").map((candidate) => candidate.id);
    expect(doneIds).toHaveLength(205);
    expect(new Set(doneIds).size).toBe(205);
    expect(fetchCompletedTasks).toHaveBeenCalledTimes(5);
    expect(fetchCompletedTasks).toHaveBeenLastCalledWith("project-a", 50, 200, "completion-date-desc");
  });

  it("deduplicates later pages and advances from the number of unique loaded Done rows", async () => {
    const firstPage = [task("FN-DONE-3", "done"), task("FN-DONE-2", "done")];
    fetchCompletedTasks
      .mockResolvedValueOnce({ tasks: firstPage, total: 3, hasMore: true })
      .mockResolvedValueOnce({ tasks: [task("FN-DONE-2", "done"), task("FN-DONE-1", "done")], total: 3, hasMore: false });

    const { result } = renderHook(() => useTasks({ projectId: "project-a", sseEnabled: false }));
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));

    await act(async () => result.current.loadMoreCompletedTasks());

    expect(fetchCompletedTasks).toHaveBeenLastCalledWith("project-a", 50, 2, "completion-date-desc");
    expect(result.current.tasks.filter((candidate) => candidate.column === "done").map((candidate) => candidate.id).sort())
      .toEqual(["FN-DONE-1", "FN-DONE-2", "FN-DONE-3"]);
    expect(result.current.completedHasMore).toBe(false);
  });

  it("fences an older Show-more response when the sort changes", async () => {
    const olderPage = deferred<{ tasks: Task[]; total: number; hasMore: boolean }>();
    fetchCompletedTasks
      .mockResolvedValueOnce({ tasks: [task("FN-OLD-2", "done")], total: 2, hasMore: true })
      .mockReturnValueOnce(olderPage.promise)
      .mockResolvedValueOnce({ tasks: [task("FN-NEW-100", "done")], total: 1, hasMore: false });

    const { result } = renderHook(() => useTasks({ projectId: "project-a", sseEnabled: false }));
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));

    let olderLoad!: Promise<void>;
    await act(async () => {
      olderLoad = result.current.loadMoreCompletedTasks();
      await Promise.resolve();
    });
    expect(result.current.completedLoadingMore).toBe(true);

    await act(async () => result.current.changeCompletedSortMode("task-id-desc"));
    expect(result.current.completedLoadingMore).toBe(false);
    expect(result.current.tasks.some((candidate) => candidate.id === "FN-NEW-100")).toBe(true);

    await act(async () => {
      olderPage.resolve({ tasks: [task("FN-OLD-1", "done")], total: 2, hasMore: false });
      await olderLoad;
    });

    expect(result.current.tasks.filter((candidate) => candidate.column === "done").map((candidate) => candidate.id))
      .toEqual(["FN-NEW-100"]);
    expect(result.current.completedLoadingMore).toBe(false);
  });

  it("reloads page zero and keeps later pages in the selected server order", async () => {
    fetchCompletedTasks
      .mockResolvedValueOnce({
        tasks: [task("FN-DONE-OLD-2", "done"), task("FN-DONE-OLD-1", "done")],
        total: 4,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        tasks: [task("FN-DONE-100", "done"), task("FN-DONE-99", "done")],
        total: 3,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        tasks: [task("FN-DONE-98", "done")],
        total: 3,
        hasMore: false,
      });

    const { result } = renderHook(() => useTasks({ projectId: "project-a", sseEnabled: false }));
    await waitFor(() => expect(result.current.tasks.some((candidate) => candidate.id === "FN-DONE-OLD-2")).toBe(true));

    await act(async () => result.current.changeCompletedSortMode("task-id-desc"));

    expect(fetchCompletedTasks).toHaveBeenNthCalledWith(2, "project-a", 50, 0, "task-id-desc");
    expect(result.current.completedSortMode).toBe("task-id-desc");
    expect(result.current.tasks.some((candidate) => candidate.id.startsWith("FN-DONE-OLD"))).toBe(false);

    await act(async () => result.current.loadMoreCompletedTasks());

    expect(fetchCompletedTasks).toHaveBeenLastCalledWith("project-a", 50, 2, "task-id-desc");
    expect(result.current.tasks.filter((candidate) => candidate.column === "done").map((candidate) => candidate.id))
      .toEqual(["FN-DONE-100", "FN-DONE-99", "FN-DONE-98"]);
  });
});
