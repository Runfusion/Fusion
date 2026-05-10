import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMeshState } from "../useMeshState";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchMeshState: vi.fn(),
}));

const mockFetchMeshState = vi.mocked(api.fetchMeshState);

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useMeshState", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchMeshState.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads mesh state on mount", async () => {
    mockFetchMeshState.mockResolvedValueOnce({ collectedAt: "2026-01-01T00:00:00.000Z", sourceNodeId: "local", nodes: [] });
    const { result } = renderHook(() => useMeshState());

    await act(async () => {
      await flushPromises();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.meshState?.sourceNodeId).toBe("local");
  });

  it("refresh updates state", async () => {
    mockFetchMeshState
      .mockResolvedValueOnce({ collectedAt: "2026-01-01T00:00:00.000Z", sourceNodeId: "local", nodes: [] })
      .mockResolvedValueOnce({ collectedAt: "2026-01-01T00:01:00.000Z", sourceNodeId: "local", nodes: [{ nodeId: "remote", nodeName: "Remote", nodeUrl: "http://remote", nodeType: "remote", status: "online", metrics: null, lastSeen: "2026-01-01T00:01:00.000Z", connectedAt: "2026-01-01T00:00:00.000Z", knownPeers: [] }] });

    const { result } = renderHook(() => useMeshState());
    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.meshState?.nodes).toHaveLength(1);
  });

  it("retains stale mesh state on refresh error", async () => {
    mockFetchMeshState
      .mockResolvedValueOnce({ collectedAt: "2026-01-01T00:00:00.000Z", sourceNodeId: "local", nodes: [{ nodeId: "local", nodeName: "Local", nodeUrl: undefined, nodeType: "local", status: "online", metrics: null, lastSeen: "2026-01-01T00:00:00.000Z", connectedAt: "2026-01-01T00:00:00.000Z", knownPeers: [] }] })
      .mockRejectedValueOnce(new Error("mesh unavailable"));

    const { result } = renderHook(() => useMeshState());
    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBe("mesh unavailable");
    expect(result.current.meshState?.nodes).toHaveLength(1);
  });
});
