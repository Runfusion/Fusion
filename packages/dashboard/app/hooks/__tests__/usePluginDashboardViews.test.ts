import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
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

  it("fetches and returns dashboard views", async () => {
    mockFetch.mockResolvedValueOnce([
      { pluginId: "dep", view: { viewId: "graph", label: "Graph", componentPath: "./Graph.js" } },
    ]);

    const { result } = renderHook(() => usePluginDashboardViews());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.views).toHaveLength(1);
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
