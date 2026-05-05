import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { usePluginDashboardViews, __test_clearDashboardViewsCache } from "../usePluginDashboardViews";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchPluginDashboardViews: vi.fn(),
}));

const mockFetch = vi.mocked(api.fetchPluginDashboardViews);

describe("usePluginDashboardViews", () => {
  beforeEach(() => {
    __test_clearDashboardViewsCache();
    mockFetch.mockReset();
  });

  it("returns empty array when no dashboard views are registered", async () => {
    mockFetch.mockResolvedValueOnce([]);
    const { result } = renderHook(() => usePluginDashboardViews());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.views).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("fetches and returns dashboard views", async () => {
    mockFetch.mockResolvedValueOnce([
      { pluginId: "dep", view: { viewId: "graph", label: "Graph", componentPath: "./Graph.js" } },
    ]);

    const { result } = renderHook(() => usePluginDashboardViews());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.views).toHaveLength(1);
  });

  it("caches results and doesn't re-fetch within ttl", async () => {
    mockFetch.mockResolvedValueOnce([
      { pluginId: "dep", view: { viewId: "graph", label: "Graph", componentPath: "./Graph.js" } },
    ]);

    const first = renderHook(() => usePluginDashboardViews("project-a"));
    await waitFor(() => expect(first.result.current.loading).toBe(false));

    mockFetch.mockClear();
    const second = renderHook(() => usePluginDashboardViews("project-a"));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sets loading only on initial fetch, not on cache-hit", async () => {
    mockFetch.mockResolvedValueOnce([
      { pluginId: "dep", view: { viewId: "graph", label: "Graph", componentPath: "./Graph.js" } },
    ]);

    const first = renderHook(() => usePluginDashboardViews("project-a"));
    expect(first.result.current.loading).toBe(true);
    await waitFor(() => expect(first.result.current.loading).toBe(false));

    mockFetch.mockClear();
    const second = renderHook(() => usePluginDashboardViews("project-a"));
    expect(second.result.current.loading).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handles fetch errors gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => usePluginDashboardViews());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.views).toEqual([]);
    expect(result.current.error).toBe("boom");
  });

  it("refetch invalidates cache and fetches again", async () => {
    mockFetch
      .mockResolvedValueOnce([{ pluginId: "a", view: { viewId: "x", label: "X", componentPath: "./x.js" } }])
      .mockResolvedValueOnce([{ pluginId: "a", view: { viewId: "y", label: "Y", componentPath: "./y.js" } }]);

    const { result } = renderHook(() => usePluginDashboardViews("project-a"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.views[0]?.view.viewId).toBe("x");

    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.views[0]?.view.viewId).toBe("y"));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("uses project-scoped cache keys", async () => {
    mockFetch.mockResolvedValueOnce([{ pluginId: "a", view: { viewId: "x", label: "X", componentPath: "./x.js" } }]);
    const first = renderHook(() => usePluginDashboardViews("project-a"));
    await waitFor(() => expect(first.result.current.loading).toBe(false));

    mockFetch.mockClear();
    renderHook(() => usePluginDashboardViews("project-a"));
    expect(mockFetch).not.toHaveBeenCalled();

    mockFetch.mockResolvedValueOnce([{ pluginId: "b", view: { viewId: "y", label: "Y", componentPath: "./y.js" } }]);
    const second = renderHook(() => usePluginDashboardViews("project-b"));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(mockFetch).toHaveBeenCalledWith("project-b");
  });
});
