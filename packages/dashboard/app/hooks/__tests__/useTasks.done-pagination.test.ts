import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import * as api from "../../api";
import { useTasks } from "../useTasks";

const { sseHandlers } = vi.hoisted(() => ({ sseHandlers: {} as Record<string, (event: MessageEvent) => void> }));
vi.mock("../../sse-bus", () => ({
  subscribeSse: (_url: string, options: { events: Record<string, (event: MessageEvent) => void> }) => {
    Object.assign(sseHandlers, options.events);
    return () => undefined;
  },
}));

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
    pauseTask: vi.fn(),
  });
});

const fetchTasks = vi.mocked(api.fetchTasks);
const fetchCompletedTasks = vi.mocked(api.fetchCompletedTasks);

function task(id: string, column = "done"): Task {
  return { id, description: id, column, dependencies: [], steps: [], currentStep: 0, log: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", columnMovedAt: "2026-01-01T00:00:00.000Z" } as Task;
}

function response(
  tasks: Task[],
  total: number,
  nextCursor: string | null,
  counts = { byColumn: { done: total }, byWorkflow: { "builtin:coding": { done: total } } },
) {
  return { tasks, total, hasMore: nextCursor !== null, nextCursor, counts };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("useTasks Done keyset pagination", () => {
  beforeEach(() => {
    localStorage.clear();
    for (const key of Object.keys(sseHandlers)) delete sseHandlers[key];
    fetchTasks.mockReset().mockResolvedValue([task("FN-CURRENT", "todo")]);
    fetchCompletedTasks.mockReset().mockResolvedValue(response([], 0, null));
  });

  it("loads all 205 rows using only server continuations while deduplicating boundaries", async () => {
    const completed = Array.from({ length: 205 }, (_, index) => task(`FN-DONE-${205 - index}`));
    for (let offset = 0; offset < completed.length; offset += 50) {
      const rows = completed.slice(offset, offset + 50);
      if (offset === 50) rows.unshift(completed[49]!);
      const next = offset + 50 < completed.length ? `cursor-${offset + 50}` : null;
      fetchCompletedTasks.mockResolvedValueOnce(response(rows, 205, next));
    }
    const { result } = renderHook(() => useTasks({ projectId: "project-a", sseEnabled: false }));
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));
    while (result.current.completedHasMore) await act(() => result.current.loadMoreCompletedTasks());

    const ids = result.current.tasks.filter((candidate) => candidate.column === "done").map((candidate) => candidate.id);
    expect(ids).toHaveLength(205);
    expect(new Set(ids).size).toBe(205);
    expect(result.current.completedCounts.byColumn.done).toBe(205);
    expect(fetchCompletedTasks).toHaveBeenNthCalledWith(1, "project-a", 50, undefined, "completion-date-desc", { signal: expect.any(AbortSignal) });
    expect(fetchCompletedTasks).toHaveBeenLastCalledWith("project-a", 50, "cursor-200", "completion-date-desc", { signal: expect.any(AbortSignal) });
  });

  it("reconciles aggregate and selected-workflow counts for every live Complete transition", async () => {
    const workflowByTaskId: Record<string, string> = { "FN-A": "wf-a", "FN-B": "wf-b" };
    fetchCompletedTasks.mockResolvedValueOnce(response(
      [task("FN-A", "complete-a")],
      1,
      null,
      { byColumn: { "complete-a": 1 }, byWorkflow: { "wf-a": { "complete-a": 1 } } },
    ));
    const { result } = renderHook(() => useTasks({
      projectId: "project-a",
      sseEnabled: true,
      resolveColumnFlags: (candidate) => ({ complete: candidate.column.startsWith("complete-") }),
      resolveWorkflowId: (candidate) => workflowByTaskId[candidate.id] ?? "wf-default",
    }));
    await waitFor(() => expect(result.current.completedCounts.byColumn["complete-a"]).toBe(1));

    await act(async () => {
      sseHandlers["task:created"]?.(new MessageEvent("task:created", {
        data: JSON.stringify({ ...task("FN-B", "complete-b"), projectId: "project-a" }),
      }));
    });
    expect(result.current.completedCounts.byColumn).toMatchObject({ "complete-a": 1, "complete-b": 1 });
    expect(result.current.completedCounts.byWorkflow).toMatchObject({
      "wf-a": { "complete-a": 1 },
      "wf-b": { "complete-b": 1 },
    });

    await act(async () => {
      sseHandlers["task:moved"]?.(new MessageEvent("task:moved", {
        data: JSON.stringify({ task: task("FN-A", "complete-b"), from: "complete-a", to: "complete-b", projectId: "project-a" }),
      }));
    });
    expect(result.current.completedCounts.byColumn).toMatchObject({ "complete-a": 0, "complete-b": 2 });
    expect(result.current.completedCounts.byWorkflow).toMatchObject({
      "wf-a": { "complete-a": 0, "complete-b": 1 },
      "wf-b": { "complete-b": 1 },
    });

    await act(async () => {
      sseHandlers["task:moved"]?.(new MessageEvent("task:moved", {
        data: JSON.stringify({ task: task("FN-B", "todo"), from: "complete-b", to: "todo", projectId: "project-a" }),
      }));
    });
    expect(result.current.completedCounts.byColumn["complete-b"]).toBe(1);
    expect(result.current.completedCounts.byWorkflow["wf-b"]?.["complete-b"]).toBe(0);

    await act(async () => {
      sseHandlers["task:deleted"]?.(new MessageEvent("task:deleted", {
        data: JSON.stringify({ ...task("FN-A", "complete-b"), projectId: "project-a" }),
      }));
    });
    expect(result.current.completedTotal).toBe(0);
    expect(result.current.completedCounts.byColumn).toMatchObject({ "complete-a": 0, "complete-b": 0 });
    expect(result.current.completedCounts.byWorkflow["wf-a"]).toMatchObject({ "complete-a": 0, "complete-b": 0 });
  });

  it("keeps a terminal server cursor closed after live Done count mutations", async () => {
    fetchCompletedTasks.mockResolvedValueOnce(response([task("FN-HEAD")], 2, null));
    const { result } = renderHook(() => useTasks({
      projectId: "project-a",
      sseEnabled: true,
      resolveWorkflowId: () => "builtin:coding",
    }));
    await waitFor(() => expect(result.current.completedTotal).toBe(2));
    expect(result.current.completedHasMore).toBe(false);

    await act(async () => {
      sseHandlers["task:created"]?.(new MessageEvent("task:created", {
        data: JSON.stringify({ ...task("FN-LIVE"), projectId: "project-a" }),
      }));
    });

    expect(result.current.completedTotal).toBe(3);
    expect(result.current.completedHasMore).toBe(false);
    await act(() => result.current.loadMoreCompletedTasks());
    expect(fetchCompletedTasks).toHaveBeenCalledTimes(1);
  });

  it("does not increment exact server counts for an updated Done row outside loaded pages", async () => {
    fetchCompletedTasks.mockResolvedValueOnce(response([task("FN-HEAD")], 2, "tail-cursor"));
    const { result } = renderHook(() => useTasks({
      projectId: "project-a",
      sseEnabled: true,
      resolveWorkflowId: () => "builtin:coding",
    }));
    await waitFor(() => expect(result.current.completedTotal).toBe(2));

    await act(async () => {
      sseHandlers["task:updated"]?.(new MessageEvent("task:updated", {
        data: JSON.stringify({ ...task("FN-UNLOADED"), projectId: "project-a" }),
      }));
    });

    expect(result.current.tasks.some((candidate) => candidate.id === "FN-UNLOADED")).toBe(true);
    expect(result.current.completedTotal).toBe(2);
    expect(result.current.completedCounts.byColumn.done).toBe(2);
    expect(result.current.completedCounts.byWorkflow["builtin:coding"]?.done).toBe(2);
  });

  it("does not change Done membership or counts for a stale rejected update", async () => {
    const current = {
      ...task("FN-CURRENT-DONE"),
      updatedAt: "2026-02-01T00:00:00.000Z",
      columnMovedAt: "2026-02-01T00:00:00.000Z",
    };
    fetchCompletedTasks.mockResolvedValueOnce(response([current], 1, null));
    const { result } = renderHook(() => useTasks({
      projectId: "project-a",
      sseEnabled: true,
      resolveWorkflowId: () => "builtin:coding",
    }));
    await waitFor(() => expect(result.current.completedTotal).toBe(1));

    await act(async () => {
      sseHandlers["task:updated"]?.(new MessageEvent("task:updated", {
        data: JSON.stringify({ ...task("FN-CURRENT-DONE", "todo"), projectId: "project-a" }),
      }));
    });

    expect(result.current.tasks.find((candidate) => candidate.id === "FN-CURRENT-DONE")?.column).toBe("done");
    expect(result.current.completedTotal).toBe(1);
    expect(result.current.completedCounts.byColumn.done).toBe(1);
    expect(result.current.completedCounts.byWorkflow["builtin:coding"]?.done).toBe(1);
  });

  it("does not derive continuation from the deduplicated row count", async () => {
    fetchCompletedTasks
      .mockResolvedValueOnce(response([task("FN-3"), task("FN-2")], 3, "opaque-boundary"))
      .mockResolvedValueOnce(response([task("FN-2"), task("FN-1")], 3, null));
    const { result } = renderHook(() => useTasks({ projectId: "project-a", sseEnabled: false }));
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));
    await act(() => result.current.loadMoreCompletedTasks());
    expect(fetchCompletedTasks).toHaveBeenLastCalledWith("project-a", 50, "opaque-boundary", "completion-date-desc", { signal: expect.any(AbortSignal) });
    expect(result.current.tasks.filter((candidate) => candidate.column === "done")).toHaveLength(3);
  });

  it("keeps the same cursor eligible after a transient continuation error", async () => {
    fetchCompletedTasks
      .mockResolvedValueOnce(response([task("FN-2")], 2, "retry-cursor"))
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce(response([task("FN-1")], 2, null));
    const { result } = renderHook(() => useTasks({ projectId: "project-a", sseEnabled: false }));
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));
    await expect(act(() => result.current.loadMoreCompletedTasks())).rejects.toThrow("temporary");
    expect(result.current.completedLoadingMore).toBe(false);
    await act(() => result.current.loadMoreCompletedTasks());
    expect(fetchCompletedTasks).toHaveBeenNthCalledWith(3, "project-a", 50, "retry-cursor", "completion-date-desc", { signal: expect.any(AbortSignal) });
    expect(result.current.completedHasMore).toBe(false);
  });

  it("advances through a page with no new IDs when the opaque cursor changes", async () => {
    fetchCompletedTasks
      .mockResolvedValueOnce(response([task("FN-2")], 2, "cursor-a"))
      .mockResolvedValueOnce(response([task("FN-2")], 2, "cursor-b"))
      .mockResolvedValueOnce(response([task("FN-1")], 2, null));
    const { result } = renderHook(() => useTasks({ projectId: "project-a", sseEnabled: false }));
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));
    const initialProgress = result.current.completedProgressKey;
    await act(() => result.current.loadMoreCompletedTasks());
    expect(result.current.completedProgressKey).not.toBe(initialProgress);
    expect(result.current.completedHasMore).toBe(true);
    await act(() => result.current.loadMoreCompletedTasks());
    expect(result.current.tasks.filter((candidate) => candidate.column === "done")).toHaveLength(2);
    expect(result.current.completedHasMore).toBe(false);
  });

  it.each([undefined, null, "cursor-a"])('stops automatic loading on an invalid continuation %s', async (nextCursor) => {
    fetchCompletedTasks
      .mockResolvedValueOnce(response([task("FN-2")], 2, "cursor-a"))
      .mockResolvedValueOnce({ ...response([], 2, nextCursor ?? null), hasMore: true, nextCursor });
    const { result } = renderHook(() => useTasks({ projectId: "project-a", sseEnabled: false }));
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));
    await act(() => result.current.loadMoreCompletedTasks());
    expect(result.current.completedHasMore).toBe(false);
    expect(result.current.completedPaginationError).toBe("invalid-continuation");
    await act(() => result.current.loadMoreCompletedTasks());
    expect(fetchCompletedTasks).toHaveBeenCalledTimes(2);
  });

  it("releases an invalidated owner without allowing its finally to unlock a successor", async () => {
    const stale = deferred<ReturnType<typeof response>>();
    const next = deferred<ReturnType<typeof response>>();
    fetchCompletedTasks
      .mockResolvedValueOnce(response([task("FN-2")], 2, "cursor-a"))
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(next.promise);
    vi.mocked(api.pauseTask).mockResolvedValueOnce(task("FN-CURRENT", "todo"));
    const { result } = renderHook(() => useTasks({ projectId: "project-a", sseEnabled: false }));
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));
    let oldLoad!: Promise<void>;
    await act(async () => { oldLoad = result.current.loadMoreCompletedTasks(); await Promise.resolve(); });
    await act(() => result.current.pauseTask("FN-CURRENT"));
    expect(result.current.completedLoadingMore).toBe(false);
    let successor!: Promise<void>;
    await act(async () => { successor = result.current.loadMoreCompletedTasks(); await Promise.resolve(); });
    stale.resolve(response([task("FN-STALE")], 2, null));
    await act(() => oldLoad);
    expect(result.current.completedLoadingMore).toBe(true);
    next.resolve(response([task("FN-1")], 2, null));
    await act(() => successor);
    expect(result.current.completedLoadingMore).toBe(false);
    expect(result.current.tasks.some((candidate) => candidate.id === "FN-STALE")).toBe(false);
    expect(result.current.tasks.some((candidate) => candidate.id === "FN-1")).toBe(true);
  });

  it("times out a continuation, preserves rows, and permits an explicit retry", async () => {
    fetchCompletedTasks
      .mockResolvedValueOnce(response([task("FN-2")], 2, "retry-cursor"))
      .mockImplementationOnce((_projectId, _limit, _cursor, _sort, options) => new Promise((_, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }))
      .mockResolvedValueOnce(response([task("FN-1")], 2, null));
    const { result } = renderHook(() => useTasks({ projectId: "project-a", sseEnabled: false }));
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));
    vi.useFakeTimers();
    let timedOut!: Promise<void>;
    await act(async () => { timedOut = result.current.loadMoreCompletedTasks(); await Promise.resolve(); });
    const rejection = expect(timedOut).rejects.toThrow("Aborted");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await rejection;
    expect(result.current.completedLoadingMore).toBe(false);
    expect(result.current.completedPaginationError).toBe("timeout");
    expect(result.current.tasks.some((candidate) => candidate.id === "FN-2")).toBe(true);
    await act(() => result.current.retryCompletedTasksPagination());
    expect(result.current.completedPaginationError).toBeNull();
    expect(result.current.tasks.some((candidate) => candidate.id === "FN-1")).toBe(true);
    vi.useRealTimers();
  });

  it("does not resurrect a task moved out of Done while a page is in flight", async () => {
    const late = deferred<ReturnType<typeof response>>();
    fetchCompletedTasks
      .mockResolvedValueOnce(response([task("FN-2")], 2, "late-cursor"))
      .mockReturnValueOnce(late.promise);
    const { result } = renderHook(() => useTasks({
      projectId: "project-a",
      sseEnabled: true,
      resolveWorkflowId: () => "builtin:coding",
    }));
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));
    let load!: Promise<void>;
    await act(async () => { load = result.current.loadMoreCompletedTasks(); await Promise.resolve(); });
    await act(async () => {
      sseHandlers["task:moved"]?.(new MessageEvent("task:moved", { data: JSON.stringify({ task: task("FN-1", "todo"), from: "done", to: "todo", projectId: "project-a" }) }));
    });
    late.resolve(response([task("FN-1")], 2, null));
    await act(() => load);
    expect(result.current.tasks.find((candidate) => candidate.id === "FN-1")?.column).toBe("todo");
    expect(result.current.tasks.filter((candidate) => candidate.column === "done").map((candidate) => candidate.id)).toEqual(["FN-2"]);
    expect(result.current.completedTotal).toBe(1);
    expect(result.current.completedCounts.byColumn.done).toBe(1);
    expect(result.current.completedCounts.byWorkflow["builtin:coding"]?.done).toBe(1);
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-09-09-15:44:
  FN-319's late-page live-mutation path used `column === "done"` before the resolver. A workflow that
  marks the built-in `done` id as non-complete must keep that live mutation out of completed history.
  */
  it("does not resurrect a resolved non-complete done lane from a late completed page", async () => {
    const late = deferred<ReturnType<typeof response>>();
    fetchCompletedTasks
      .mockResolvedValueOnce(response(
        [task("FN-2", "complete-a")],
        2,
        "late-cursor",
        { byColumn: { "complete-a": 2 }, byWorkflow: { "wf-a": { "complete-a": 2 } } },
      ))
      .mockReturnValueOnce(late.promise);
    const { result } = renderHook(() => useTasks({
      projectId: "project-a",
      sseEnabled: true,
      resolveColumnFlags: (candidate) => ({ complete: candidate.column === "complete-a" }),
      resolveWorkflowId: () => "wf-a",
    }));
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));
    let load!: Promise<void>;
    await act(async () => { load = result.current.loadMoreCompletedTasks(); await Promise.resolve(); });
    await act(async () => {
      sseHandlers["task:moved"]?.(new MessageEvent("task:moved", {
        data: JSON.stringify({
          task: task("FN-1", "done"),
          from: "complete-a",
          to: "done",
          projectId: "project-a",
        }),
      }));
    });
    late.resolve(response(
      [task("FN-1")],
      2,
      null,
      { byColumn: { "complete-a": 1, done: 1 }, byWorkflow: { "wf-a": { "complete-a": 1, done: 1 } } },
    ));
    await act(() => load);
    expect(result.current.tasks.find((candidate) => candidate.id === "FN-1")?.column).toBe("done");
    expect(result.current.tasks.filter((candidate) => candidate.column === "complete-a").map((candidate) => candidate.id)).toEqual(["FN-2"]);
    expect(result.current.completedTotal).toBe(1);
    expect(result.current.completedCounts.byColumn["complete-a"]).toBe(1);
    expect(result.current.completedCounts.byColumn.done ?? 0).toBe(0);
  });

  it("fences a late Done page as soon as search changes", async () => {
    const late = deferred<ReturnType<typeof response>>();
    fetchCompletedTasks
      .mockResolvedValueOnce(response([task("FN-HEAD")], 2, "old-cursor"))
      .mockReturnValueOnce(late.promise);
    const { result, rerender } = renderHook(
      ({ searchQuery }: { searchQuery?: string }) => useTasks({ projectId: "project-a", searchQuery, sseEnabled: false }),
      { initialProps: { searchQuery: undefined } },
    );
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));
    let oldLoad!: Promise<void>;
    await act(async () => { oldLoad = result.current.loadMoreCompletedTasks(); await Promise.resolve(); });

    rerender({ searchQuery: "needle" });
    late.resolve(response([task("FN-STALE")], 2, null));
    await act(() => oldLoad);

    expect(result.current.tasks.some((candidate) => candidate.id === "FN-STALE")).toBe(false);
    expect(result.current.completedHasMore).toBe(true);
  });

  it("fences a late Done page across a search A → B → A incarnation cycle", async () => {
    const late = deferred<ReturnType<typeof response>>();
    fetchCompletedTasks
      .mockResolvedValueOnce(response([task("FN-HEAD")], 2, "old-cursor"))
      .mockReturnValueOnce(late.promise);
    const { result, rerender } = renderHook(
      ({ searchQuery }: { searchQuery?: string }) => useTasks({ projectId: "project-a", searchQuery, sseEnabled: false }),
      { initialProps: { searchQuery: undefined } },
    );
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));
    let oldLoad!: Promise<void>;
    await act(async () => { oldLoad = result.current.loadMoreCompletedTasks(); await Promise.resolve(); });

    rerender({ searchQuery: "needle" });
    rerender({ searchQuery: undefined });
    late.resolve(response([task("FN-STALE")], 2, null));
    await act(() => oldLoad);

    expect(result.current.tasks.some((candidate) => candidate.id === "FN-STALE")).toBe(false);
    expect(result.current.completedHasMore).toBe(true);
  });

  it("fences a late Done page when refresh starts a new page-zero session", async () => {
    const late = deferred<ReturnType<typeof response>>();
    fetchCompletedTasks
      .mockResolvedValueOnce(response([task("FN-OLD-HEAD")], 2, "old-cursor"))
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(response([task("FN-NEW-HEAD")], 2, "new-cursor"))
      .mockResolvedValueOnce(response([task("FN-NEW-TAIL")], 2, null));
    const { result } = renderHook(() => useTasks({ projectId: "project-a", sseEnabled: false }));
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));
    let oldLoad!: Promise<void>;
    await act(async () => { oldLoad = result.current.loadMoreCompletedTasks(); await Promise.resolve(); });

    await act(() => result.current.refreshTasks({ resetCompletedPages: true }));
    late.resolve(response([task("FN-STALE-TAIL")], 2, null));
    await act(() => oldLoad);
    await act(() => result.current.loadMoreCompletedTasks());

    expect(fetchCompletedTasks).toHaveBeenNthCalledWith(3, "project-a", 50, undefined, "completion-date-desc", { signal: expect.any(AbortSignal) });
    expect(fetchCompletedTasks).toHaveBeenLastCalledWith("project-a", 50, "new-cursor", "completion-date-desc", { signal: expect.any(AbortSignal) });
    expect(result.current.tasks.some((candidate) => candidate.id === "FN-STALE-TAIL")).toBe(false);
    expect(result.current.tasks.filter((candidate) => candidate.column === "done").map((candidate) => candidate.id)).toEqual([
      "FN-NEW-HEAD",
      "FN-NEW-TAIL",
    ]);
  });

  it("fences a late page after changing sort and restarts at page zero", async () => {
    const late = deferred<ReturnType<typeof response>>();
    fetchCompletedTasks
      .mockResolvedValueOnce(response([task("FN-OLD-2")], 2, "old-cursor"))
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce(response([task("FN-NEW-100")], 2, "new-cursor"))
      .mockResolvedValueOnce(response([task("FN-NEW-99")], 2, null));
    const { result } = renderHook(() => useTasks({ projectId: "project-a", sseEnabled: false }));
    await waitFor(() => expect(result.current.completedHasMore).toBe(true));
    let oldLoad!: Promise<void>;
    await act(async () => { oldLoad = result.current.loadMoreCompletedTasks(); await Promise.resolve(); });
    await act(() => result.current.changeCompletedSortMode("task-id-desc"));
    late.resolve(response([task("FN-OLD-1")], 2, null));
    await act(() => oldLoad);
    await act(() => result.current.loadMoreCompletedTasks());
    expect(fetchCompletedTasks).toHaveBeenNthCalledWith(3, "project-a", 50, undefined, "task-id-desc", { signal: expect.any(AbortSignal) });
    expect(fetchCompletedTasks).toHaveBeenLastCalledWith("project-a", 50, "new-cursor", "task-id-desc", { signal: expect.any(AbortSignal) });
    expect(result.current.tasks.filter((candidate) => candidate.column === "done").map((candidate) => candidate.id)).toEqual(["FN-NEW-100", "FN-NEW-99"]);
  });
});
