import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePrChecksStream } from "../usePrChecksStream";
import * as api from "../../api";

vi.mock("../../api", () => ({
  fetchPrChecks: vi.fn(),
}));

const mockFetchPrChecks = vi.mocked(api.fetchPrChecks);

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("usePrChecksStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls at the default interval", async () => {
    mockFetchPrChecks.mockResolvedValue({ checks: [], rollup: "unknown", lastCheckedAt: "2026-01-01T00:00:00Z" });

    renderHook(() => usePrChecksStream({ taskId: "KB-1", prNumber: 1, enabled: true }));
    await flush();
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    await flush();
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(2);
  });

  it("backs off after 3 identical payloads", async () => {
    mockFetchPrChecks.mockResolvedValue({
      checks: [{ name: "ci", required: true, state: "pending" }],
      rollup: "pending",
      lastCheckedAt: "2026-01-01T00:00:00Z",
    });

    renderHook(() => usePrChecksStream({ taskId: "KB-1", prNumber: 1, enabled: true }));

    await flush();
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(15_000));
    await flush();
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(15_000));
    await flush();
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTime(15_000));
    await flush();
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(4);

    await act(async () => vi.advanceTimersByTime(59_000));
    await flush();
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(4);
    await act(async () => vi.advanceTimersByTime(1_000));
    await flush();
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(5);
  });

  it("pauses when hidden and resumes on visibilitychange", async () => {
    mockFetchPrChecks.mockResolvedValue({ checks: [], rollup: "unknown", lastCheckedAt: "2026-01-01T00:00:00Z" });

    renderHook(() => usePrChecksStream({ taskId: "KB-1", prNumber: 1, enabled: true }));
    await flush();
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(60_000);
    });
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(2);
  });

  it("refresh triggers off-cycle fetch", async () => {
    mockFetchPrChecks.mockResolvedValue({ checks: [], rollup: "unknown", lastCheckedAt: "2026-01-01T00:00:00Z" });

    const { result } = renderHook(() => usePrChecksStream({ taskId: "KB-1", prNumber: 1, enabled: true }));
    await flush();
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockFetchPrChecks).toHaveBeenCalledTimes(2);
  });

  it("stops polling after unmount", async () => {
    mockFetchPrChecks.mockResolvedValue({ checks: [], rollup: "unknown", lastCheckedAt: "2026-01-01T00:00:00Z" });

    const { unmount } = renderHook(() => usePrChecksStream({ taskId: "KB-1", prNumber: 1, enabled: true }));
    await flush();
    expect(mockFetchPrChecks).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => vi.advanceTimersByTime(60_000));

    expect(mockFetchPrChecks).toHaveBeenCalledTimes(1);
  });
});
