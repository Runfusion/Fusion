import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { usePluginDashboardViews, __test_clearDashboardViewsCache } from "../usePluginDashboardViews";
import * as api from "../../api";
import { subscribeSse } from "../../sse-bus";

vi.mock("../../api", () => ({
  fetchPluginDashboardViews: vi.fn(),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(() => vi.fn()),
}));

const mockFetch = vi.mocked(api.fetchPluginDashboardViews);
const mockSubscribeSse = vi.mocked(subscribeSse);

const compoundEngineeringView = {
  pluginId: "fusion-plugin-compound-engineering",
  view: {
    viewId: "compound-engineering",
    label: "Compound Engineering",
    componentPath: "./dashboard-view",
    icon: "Boxes",
    placement: "primary" as const,
    order: 36,
  },
};

function emitPluginLifecycle(transition: string): void {
  const subscription = mockSubscribeSse.mock.calls.at(-1)?.[1];
  const handler = subscription?.events?.["plugin:lifecycle"];
  if (!handler) throw new Error("expected plugin:lifecycle subscription");
  handler(new MessageEvent("plugin:lifecycle", { data: JSON.stringify({ transition }) }));
}

describe("usePluginDashboardViews", () => {
  beforeEach(() => {
    __test_clearDashboardViewsCache();
    mockFetch.mockReset();
    mockSubscribeSse.mockClear();
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

  it("refreshes the current project's cached views across install, disable, and uninstall lifecycle transitions", async () => {
    mockFetch
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([compoundEngineeringView])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([compoundEngineeringView])
      .mockResolvedValueOnce([]);

    const { result } = renderHook(() => usePluginDashboardViews("project-a"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.views).toEqual([]);

    emitPluginLifecycle("registered");
    await waitFor(() => expect(result.current.views).toEqual([compoundEngineeringView]));

    emitPluginLifecycle("disabled");
    await waitFor(() => expect(result.current.views).toEqual([]));

    emitPluginLifecycle("enabled");
    await waitFor(() => expect(result.current.views).toEqual([compoundEngineeringView]));

    emitPluginLifecycle("uninstalled");
    await waitFor(() => expect(result.current.views).toEqual([]));
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("never exposes project A's Compound Engineering view after switching to project B", async () => {
    mockFetch
      .mockResolvedValueOnce([compoundEngineeringView])
      .mockResolvedValueOnce([]);

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => usePluginDashboardViews(projectId),
      { initialProps: { projectId: "project-a" } },
    );
    await waitFor(() => expect(result.current.views).toEqual([compoundEngineeringView]));

    rerender({ projectId: "project-b" });
    await waitFor(() => expect(result.current.views).toEqual([]));
    expect(mockFetch).toHaveBeenNthCalledWith(1, "project-a");
    expect(mockFetch).toHaveBeenNthCalledWith(2, "project-b");
  });

  it("supports filtering view entries by pluginId in consumers", async () => {
    mockFetch.mockResolvedValueOnce([
      { pluginId: "fusion-plugin-dependency-graph", view: { viewId: "graph", label: "Graph", componentPath: "./Graph.js" } },
      { pluginId: "fusion-plugin-queue", view: { viewId: "queue", label: "Queue", componentPath: "./Queue.js" } },
    ]);

    const { result } = renderHook(() => usePluginDashboardViews("project-a"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const graphViews = result.current.views.filter((entry) => entry.pluginId === "fusion-plugin-dependency-graph");
    expect(graphViews).toEqual([
      { pluginId: "fusion-plugin-dependency-graph", view: { viewId: "graph", label: "Graph", componentPath: "./Graph.js" } },
    ]);
  });
});
