import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";

const { recordResumeEvent } = vi.hoisted(() => ({
  recordResumeEvent: vi.fn(),
}));

vi.mock("../../api", () => ({
  fetchNodes: vi.fn(),
  registerNode: vi.fn(),
  updateNode: vi.fn(),
  unregisterNode: vi.fn(),
  checkNodeHealth: vi.fn(),
  discoverRemoteNodeProjects: vi.fn(),
  fetchDockerNodeConfig: vi.fn(),
  updateDockerNodeConfig: vi.fn(),
  fetchDockerConfigDiff: vi.fn(),
}));

vi.mock("../../api-node", () => ({
  persistNodeProjectPathMappings: vi.fn(),
}));

vi.mock("../../utils/resumeInstrumentation", () => ({
  recordResumeEvent,
}));

const mockFetchNodes = vi.mocked(api.fetchNodes);

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useNodes resume instrumentation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchNodes.mockReset();
    recordResumeEvent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits debounced-refresh then debounce-skipped and refreshes once for visibility events", async () => {
    mockFetchNodes.mockResolvedValue([]);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    const { useNodes } = await import("../useNodes");
    renderHook(() => useNodes());
    await act(async () => {
      await flushPromises();
    });

    // Reset to isolate visibility-driven refreshes from initial mount fetch.
    mockFetchNodes.mockClear();

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
      view: "useNodes",
      trigger: "visibility",
      reason: "debounced-refresh",
    }));
    expect(recordResumeEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      view: "useNodes",
      trigger: "visibility",
      reason: "debounce-skipped",
      detail: expect.objectContaining({
        timeSinceLastRefreshMs: expect.any(Number),
      }),
    }));
    expect(recordResumeEvent).toHaveBeenCalledTimes(2);
    expect(mockFetchNodes).toHaveBeenCalledTimes(1);
  });
});
