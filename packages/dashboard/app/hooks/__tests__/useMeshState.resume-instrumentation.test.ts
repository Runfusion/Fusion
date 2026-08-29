import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";

const { recordResumeEvent } = vi.hoisted(() => ({
  recordResumeEvent: vi.fn(),
}));

vi.mock("../../api", () => ({
  fetchMeshState: vi.fn(),
}));

vi.mock("../../utils/resumeInstrumentation", () => ({
  recordResumeEvent,
}));

const mockFetchMeshState = vi.mocked(api.fetchMeshState);

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function meshPayload(nodeId: string) {
  return {
    collectedAt: "2026-01-01T00:00:00.000Z",
    sourceNodeId: "local",
    nodes: [{ nodeId, nodeName: nodeId, nodeUrl: undefined, nodeType: "local", status: "online", metrics: null, lastSeen: "2026-01-01T00:00:00.000Z", connectedAt: "2026-01-01T00:00:00.000Z", knownPeers: [] }],
  };
}

describe("useMeshState resume instrumentation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchMeshState.mockReset();
    recordResumeEvent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits debounced-refresh then debounce-skipped and refreshes once for visibility events", async () => {
    mockFetchMeshState.mockResolvedValue(meshPayload("local"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    const { useMeshState } = await import("../useMeshState");
    renderHook(() => useMeshState());
    await act(async () => {
      await flushPromises();
    });

    // Reset to isolate visibility-driven refreshes from initial mount fetch.
    mockFetchMeshState.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(1100);
      document.dispatchEvent(new Event("visibilitychange"));
      await flushPromises();
    });

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await flushPromises();
    });

    expect(recordResumeEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      view: "useMeshState",
      trigger: "visibility",
      reason: "debounced-refresh",
    }));
    expect(recordResumeEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      view: "useMeshState",
      trigger: "visibility",
      reason: "debounce-skipped",
      detail: expect.objectContaining({
        timeSinceLastRefreshMs: expect.any(Number),
      }),
    }));
    expect(recordResumeEvent).toHaveBeenCalledTimes(2);
    expect(mockFetchMeshState).toHaveBeenCalledTimes(1);
  });
});
