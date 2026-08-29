import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";

const { recordResumeEvent } = vi.hoisted(() => ({
  recordResumeEvent: vi.fn(),
}));

vi.mock("../../api", () => ({
  fetchManagedDockerNodes: vi.fn(),
  fetchManagedDockerNodeContainerStatus: vi.fn(),
  fetchDockerNodeLogs: vi.fn(),
  createManagedDockerNode: vi.fn(),
}));

vi.mock("../../utils/resumeInstrumentation", () => ({
  recordResumeEvent,
}));

const mockFetchManagedDockerNodes = vi.mocked(api.fetchManagedDockerNodes);

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useManagedDockerNodes resume instrumentation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchManagedDockerNodes.mockReset();
    recordResumeEvent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits debounced-refresh then debounce-skipped and refreshes once for visibility events", async () => {
    mockFetchManagedDockerNodes.mockResolvedValue([]);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    const { useManagedDockerNodes } = await import("../useManagedDockerNodes");
    renderHook(() => useManagedDockerNodes());
    await act(async () => {
      await flushPromises();
    });

    // Reset to isolate visibility-driven refreshes from initial mount fetch.
    mockFetchManagedDockerNodes.mockClear();

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
      view: "useManagedDockerNodes",
      trigger: "visibility",
      reason: "debounced-refresh",
    }));
    expect(recordResumeEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      view: "useManagedDockerNodes",
      trigger: "visibility",
      reason: "debounce-skipped",
      detail: expect.objectContaining({
        timeSinceLastRefreshMs: expect.any(Number),
      }),
    }));
    expect(recordResumeEvent).toHaveBeenCalledTimes(2);
    expect(mockFetchManagedDockerNodes).toHaveBeenCalledTimes(1);
  });
});
