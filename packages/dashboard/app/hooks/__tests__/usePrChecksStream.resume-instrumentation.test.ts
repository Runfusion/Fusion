import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordResumeEvent = vi.fn();

vi.mock("../../utils/resumeInstrumentation", () => ({
  recordResumeEvent,
}));

vi.mock("../../api", () => ({
  fetchPrChecks: vi.fn(),
}));

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("usePrChecksStream resume instrumentation", () => {
  beforeEach(() => {
    recordResumeEvent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits remount and visibility resume events with task detail", async () => {
    const { fetchPrChecks } = await import("../../api");
    const mockFetchPrChecks = vi.mocked(fetchPrChecks);
    mockFetchPrChecks.mockResolvedValue({ checks: [], rollup: "pending", lastCheckedAt: "" });

    const { usePrChecksStream } = await import("../usePrChecksStream");
    renderHook(() => usePrChecksStream({ taskId: "FN-1", projectId: "proj-1", prNumber: 42, enabled: true }));

    await waitFor(() => {
      expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
        view: "usePrChecksStream",
        trigger: "remount",
        detail: { taskId: "FN-1", prNumber: 42 },
      }));
    });

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
      view: "usePrChecksStream",
      trigger: "visibility",
      reason: "hidden",
      detail: { taskId: "FN-1", prNumber: 42 },
    }));
    expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
      view: "usePrChecksStream",
      trigger: "visibility",
      reason: "visible-resume",
      detail: { taskId: "FN-1", prNumber: 42 },
    }));
  });

  it("keeps stable-check polling backoff behavior", async () => {
    vi.useFakeTimers();
    const { fetchPrChecks } = await import("../../api");
    const mockFetchPrChecks = vi.mocked(fetchPrChecks);
    mockFetchPrChecks.mockResolvedValue({
      checks: [{ name: "ci", state: "success" }],
      rollup: "pending",
      lastCheckedAt: "",
    });

    const { usePrChecksStream } = await import("../usePrChecksStream");
    renderHook(() => usePrChecksStream({ taskId: "FN-1", projectId: "proj-1", prNumber: 42, enabled: true }));

    await act(async () => {
      await flushPromises();
    });
    mockFetchPrChecks.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await flushPromises();
    });
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await flushPromises();
    });
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await flushPromises();
    });

    expect(mockFetchPrChecks).toHaveBeenCalledTimes(3);

    await act(async () => {
      vi.advanceTimersByTime(59_000);
      await flushPromises();
    });
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(3);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await flushPromises();
    });
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(4);
  });
});
