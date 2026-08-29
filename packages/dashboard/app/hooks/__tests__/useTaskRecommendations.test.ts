import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskRecommendations } from "../useTaskRecommendations";

vi.mock("../../api", () => ({
  fetchTaskRecommendations: vi.fn(),
  createTaskFromRecommendation: vi.fn(),
}));

import { createTaskFromRecommendation, fetchTaskRecommendations } from "../../api";

const mockFetchTaskRecommendations = vi.mocked(fetchTaskRecommendations);
const mockCreateTaskFromRecommendation = vi.mocked(createTaskFromRecommendation);

const item = (taskId: string, recommendationId: string) => ({
  taskId,
  taskTitle: `Task ${taskId}`,
  recommendation: {
    id: recommendationId,
    title: `Recommendation ${recommendationId}`,
    description: "Follow up",
    category: "improvement",
  },
});

const page = (items: ReturnType<typeof item>[], options: { rowOffset?: number; returnedRowCount?: number; totalRowCount?: number; hasMore?: boolean } = {}) => ({
  items,
  rowOffset: options.rowOffset ?? 0,
  rowLimit: 50,
  returnedRowCount: options.returnedRowCount ?? 1,
  totalRowCount: options.totalRowCount ?? 1,
  hasMore: options.hasMore ?? false,
});

describe("useTaskRecommendations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pages by returned source rows and appends only unseen composite recommendation keys", async () => {
    mockFetchTaskRecommendations
      .mockResolvedValueOnce(page([item("FN-1", "same")], { returnedRowCount: 1, totalRowCount: 3, hasMore: true }) as never)
      .mockResolvedValueOnce(page([item("FN-1", "same"), item("FN-2", "same")], { rowOffset: 1, returnedRowCount: 2, totalRowCount: 3 }) as never);

    const { result } = renderHook(() => useTaskRecommendations("project-a"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchTaskRecommendations).toHaveBeenLastCalledWith("project-a", { limit: 50, offset: 0 });
    await act(async () => { await result.current.loadMore(); });

    expect(mockFetchTaskRecommendations).toHaveBeenLastCalledWith("project-a", { limit: 50, offset: 1 });
    expect(result.current.items.map((entry) => `${entry.taskId}:${entry.recommendation.id}`)).toEqual(["FN-1:same", "FN-2:same"]);
    expect(result.current.hasMore).toBe(false);
  });

  it("retains loaded recommendations and permits retry after a later page fails", async () => {
    mockFetchTaskRecommendations
      .mockResolvedValueOnce(page([item("FN-1", "REC-1")], { returnedRowCount: 1, totalRowCount: 2, hasMore: true }) as never)
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(page([item("FN-2", "REC-2")], { rowOffset: 1, returnedRowCount: 1, totalRowCount: 2 }) as never);

    const { result } = renderHook(() => useTaskRecommendations("project-a"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.loadMore(); });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.error).toBe("network unavailable");
    expect(result.current.hasMore).toBe(true);

    await act(async () => { await result.current.loadMore(); });
    expect(result.current.items.map((entry) => entry.taskId)).toEqual(["FN-1", "FN-2"]);
    expect(result.current.error).toBeNull();
  });

  it("recovers an initial fetch failure through refresh without losing the retry path", async () => {
    mockFetchTaskRecommendations
      .mockRejectedValueOnce(new Error("initial unavailable"))
      .mockResolvedValueOnce(page([item("FN-1", "REC-1")]) as never);
    const { result } = renderHook(() => useTaskRecommendations("project-a"));
    await waitFor(() => expect(result.current.error).toBe("initial unavailable"));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.error).toBeNull();
    expect(result.current.items).toHaveLength(1);
  });

  it("records a create failure only against its composite row key", async () => {
    mockFetchTaskRecommendations.mockResolvedValueOnce(page([item("FN-1", "same"), item("FN-2", "same")], { returnedRowCount: 2, totalRowCount: 2 }) as never);
    mockCreateTaskFromRecommendation.mockRejectedValueOnce(new Error("create unavailable"));
    const { result } = renderHook(() => useTaskRecommendations("project-a"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.createTask("FN-1", "same"); });
    expect(result.current.createStates.get("FN-1:same")).toEqual({ running: false, error: "create unavailable" });
    expect(result.current.createStates.get("FN-2:same")).toBeUndefined();
  });

  it("drops stale project responses and restarts paging when the project changes", async () => {
    let resolveOldPage: (value: ReturnType<typeof page>) => void = () => undefined;
    mockFetchTaskRecommendations
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldPage = resolve; }) as never)
      .mockResolvedValueOnce(page([item("FN-new", "REC-new")]) as never);

    const { result, rerender } = renderHook(({ projectId }) => useTaskRecommendations(projectId), { initialProps: { projectId: "project-a" } });
    rerender({ projectId: "project-b" });

    await waitFor(() => expect(mockFetchTaskRecommendations).toHaveBeenLastCalledWith("project-b", { limit: 50, offset: 0 }));
    resolveOldPage(page([item("FN-old", "REC-old")]));
    await waitFor(() => expect(result.current.items.map((entry) => entry.taskId)).toEqual(["FN-new"]));
  });

  it("tracks creates by task and recommendation id so equal recommendation ids do not collide", async () => {
    mockFetchTaskRecommendations.mockResolvedValueOnce(page([item("FN-1", "same"), item("FN-2", "same")], { returnedRowCount: 2, totalRowCount: 2 }) as never);
    mockCreateTaskFromRecommendation
      .mockResolvedValueOnce({ task: { id: "FN-created-1" } } as never)
      .mockResolvedValueOnce({ task: { id: "FN-created-2" } } as never);

    const { result } = renderHook(() => useTaskRecommendations("project-a"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await Promise.all([
        result.current.createTask("FN-1", "same"),
        result.current.createTask("FN-2", "same"),
      ]);
    });

    expect(mockCreateTaskFromRecommendation).toHaveBeenCalledWith("FN-1", "same", "project-a");
    expect(mockCreateTaskFromRecommendation).toHaveBeenCalledWith("FN-2", "same", "project-a");
    expect(result.current.items.map((entry) => entry.recommendation.createdTaskId)).toEqual(["FN-created-1", "FN-created-2"]);
  });
});
