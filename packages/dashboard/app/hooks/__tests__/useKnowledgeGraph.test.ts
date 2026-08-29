import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKnowledgeGraph } from "../useKnowledgeGraph";

const api = vi.hoisted(() => ({ status: vi.fn(), nodes: vi.fn(), node: vi.fn(), neighbors: vi.fn(), path: vi.fn(), build: vi.fn() }));
vi.mock("../../api/system/knowledge-graph.js", () => ({ fetchKnowledgeGraphStatus: api.status, queryKnowledgeGraphNodes: api.nodes, fetchKnowledgeGraphNode: api.node, fetchKnowledgeGraphNeighbors: api.neighbors, fetchKnowledgeGraphPath: api.path, buildKnowledgeGraphArtifacts: api.build }));
const status = { available: true, pathLimits: { defaultMaxHops: 6, maxHops: 10, maxExpansions: 20_000 } };
const emptyNodes = { nodes: [], total: 0, limit: 50, offset: 0 };
function defaults() { api.status.mockResolvedValue(status); api.nodes.mockResolvedValue(emptyNodes); api.node.mockResolvedValue({ node: { id: "a" }, outgoing: [], incoming: [], outgoingTotal: 0, incomingTotal: 0 }); api.neighbors.mockResolvedValue({ neighbors: [], total: 0 }); }

beforeEach(() => { vi.clearAllMocks(); defaults(); });
afterEach(() => { vi.useRealTimers(); });

describe("useKnowledgeGraph", () => {
  it("loads status lazily and debounces one search for a filter update", async () => {
    renderHook(() => useKnowledgeGraph({ projectId: "project", enabled: false }));
    expect(api.status).not.toHaveBeenCalled();
    // Mounting an enabled instance makes the lazy boundary explicit.
    const enabled = renderHook(() => useKnowledgeGraph({ projectId: "project", enabled: true }));
    await waitFor(() => { expect(api.status).toHaveBeenCalledWith("project"); expect(api.nodes).toHaveBeenCalledTimes(1); });
    act(() => { enabled.result.current.setFilters({ pathPrefix: "src", limit: 50, offset: 0 }); });
    await waitFor(() => expect(api.nodes).toHaveBeenLastCalledWith("project", expect.objectContaining({ pathPrefix: "src" })));
  });

  it("fences stale searches and loads node details with neighbors", async () => {
    let resolveFirst: ((value: typeof emptyNodes) => void) | undefined;
    api.nodes.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; })).mockResolvedValueOnce({ ...emptyNodes, total: 2 });
    const { result } = renderHook(() => useKnowledgeGraph({ enabled: true }));
    await waitFor(() => expect(resolveFirst).toBeTypeOf("function"));
    act(() => result.current.setFilters({ pathPrefix: "new", limit: 50, offset: 0 }));
    await waitFor(() => expect(result.current.nodes?.total).toBe(2));
    await act(async () => { resolveFirst?.(emptyNodes); });
    expect(result.current.nodes?.total).toBe(2);
    await act(async () => { await result.current.selectNode("a"); });
    expect(api.node).toHaveBeenCalledWith(undefined, "a"); expect(api.neighbors).toHaveBeenCalledWith(undefined, expect.objectContaining({ nodeId: "a" }));
    expect(result.current.detail?.node.id).toBe("a");
  });

  it("preserves every path outcome, rejects unknown ids distinctly, and reapplies raised hop bounds", async () => {
    api.path.mockResolvedValueOnce({ outcome: "found", path: { nodes: [], edges: [] }, hops: 0, maxHops: 6, expansions: 0, truncated: false })
      .mockResolvedValueOnce({ outcome: "not-found", path: null, maxHops: 6, expansions: 1, truncated: false })
      .mockResolvedValueOnce({ outcome: "limit-reached", path: null, maxHops: 8, expansions: 1, truncated: true, limit: "max-hops" })
      .mockRejectedValueOnce(new Error("Unknown graph node"));
    const { result } = renderHook(() => useKnowledgeGraph({ enabled: true }));
    await waitFor(() => expect(result.current.status).toEqual(status));
    for (const outcome of ["found", "not-found", "limit-reached"]) {
      await act(async () => { await result.current.findPath(); });
      expect(result.current.pathResult?.outcome).toBe(outcome);
    }
    act(() => result.current.setPathInput({ fromId: "a", toId: "b", maxHops: 8 }));
    await act(async () => { await result.current.findPath(); });
    expect(result.current.pathResult).toBeNull(); expect(result.current.error).toBe("Unknown graph node");
    expect(api.path).toHaveBeenLastCalledWith(undefined, { fromId: "a", toId: "b", maxHops: 8 });
  });

  it("rebuilds once, refreshes status, and returns rejected calls as state", async () => {
    api.build.mockResolvedValue({ changed: true });
    const { result } = renderHook(() => useKnowledgeGraph({ projectId: "project", enabled: true }));
    await waitFor(() => expect(result.current.status).toEqual(status));
    await act(async () => { await result.current.rebuild(true); });
    expect(api.build).toHaveBeenCalledWith("project", true); expect(api.status).toHaveBeenCalledTimes(2); expect(result.current.rebuilding).toBe(false);
    api.path.mockRejectedValueOnce(new Error("network failure"));
    await act(async () => { await result.current.findPath(); });
    expect(result.current.error).toBe("network failure");
  });
});
