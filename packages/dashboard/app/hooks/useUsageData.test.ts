import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useUsageData } from "./useUsageData";
import * as api from "../api";

describe("useUsageData", () => {
  const mockFetchUsageData = vi.spyOn(api, "fetchUsageData");

  beforeEach(() => {
    mockFetchUsageData.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches data on initial mount", async () => {
    const mockData = {
      providers: [
        {
          name: "Claude",
          icon: "🟠",
          status: "ok" as const,
          windows: [],
        },
      ],
    };
    mockFetchUsageData.mockResolvedValue(mockData);

    const { result } = renderHook(() => useUsageData());

    // Should be loading initially
    expect(result.current.loading).toBe(true);
    expect(result.current.providers).toEqual([]);

    // Wait for data to load
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.providers).toEqual(mockData.providers);
    expect(result.current.error).toBeNull();
    expect(result.current.lastUpdated).toBeInstanceOf(Date);
  });

  it("handles fetch errors", async () => {
    mockFetchUsageData.mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useUsageData());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Network error");
    expect(result.current.providers).toEqual([]);
  });

  it("polls data at specified interval", async () => {
    const mockData1 = {
      providers: [{ name: "Claude", icon: "🟠", status: "ok" as const, windows: [] }],
    };
    const mockData2 = {
      providers: [{ name: "Claude", icon: "🟠", status: "ok" as const, windows: [{ label: "Session", percentUsed: 50, percentLeft: 50, resetText: "2h" }] }],
    };

    mockFetchUsageData
      .mockResolvedValueOnce(mockData1)
      .mockResolvedValueOnce(mockData2);

    const { result } = renderHook(() => useUsageData({ pollInterval: 5000 }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.providers).toEqual(mockData1.providers);

    // Advance time to trigger poll
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    await waitFor(() => {
      expect(result.current.providers[0]?.windows?.length).toBe(1);
    });
  });

  it("does not poll when autoRefresh is false", async () => {
    const mockData = {
      providers: [{ name: "Claude", icon: "🟠", status: "ok" as const, windows: [] }],
    };
    mockFetchUsageData.mockResolvedValue(mockData);

    const { result } = renderHook(() => useUsageData({ autoRefresh: false, pollInterval: 1000 }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetchUsageData).toHaveBeenCalledTimes(1);

    // Advance time
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // Should not have fetched again
    expect(mockFetchUsageData).toHaveBeenCalledTimes(1);
  });

  it("manual refresh works", async () => {
    const mockData1 = {
      providers: [{ name: "Claude", icon: "🟠", status: "ok" as const, windows: [] }],
    };
    const mockData2 = {
      providers: [{ name: "Codex", icon: "🟢", status: "ok" as const, windows: [] }],
    };

    mockFetchUsageData
      .mockResolvedValueOnce(mockData1)
      .mockResolvedValueOnce(mockData2);

    const { result } = renderHook(() => useUsageData({ autoRefresh: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.providers).toEqual(mockData1.providers);

    // Manual refresh
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.providers).toEqual(mockData2.providers);
  });

  it("sets loading state on manual refresh", async () => {
    const mockData = {
      providers: [{ name: "Claude", icon: "🟠", status: "ok" as const, windows: [] }],
    };
    mockFetchUsageData.mockResolvedValue(mockData);

    const { result } = renderHook(() => useUsageData({ autoRefresh: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Start manual refresh but don't await yet
    let refreshPromise: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });

    // Should be loading immediately
    expect(result.current.loading).toBe(true);

    await act(async () => {
      await refreshPromise;
    });

    expect(result.current.loading).toBe(false);
  });

  it("clears error on successful manual refresh after error", async () => {
    mockFetchUsageData
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({
        providers: [{ name: "Claude", icon: "🟠", status: "ok" as const, windows: [] }],
      });

    const { result } = renderHook(() => useUsageData({ autoRefresh: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("Network error");

    // Manual refresh
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.providers).toHaveLength(1);
  });

  it("uses default 30 second poll interval", async () => {
    const mockData = {
      providers: [{ name: "Claude", icon: "🟠", status: "ok" as const, windows: [] }],
    };
    mockFetchUsageData.mockResolvedValue(mockData);

    renderHook(() => useUsageData());

    await waitFor(() => expect(mockFetchUsageData).toHaveBeenCalledTimes(1));

    // Should not poll after 29 seconds
    act(() => {
      vi.advanceTimersByTime(29000);
    });
    expect(mockFetchUsageData).toHaveBeenCalledTimes(1);

    // Should poll after 30 seconds
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await waitFor(() => expect(mockFetchUsageData).toHaveBeenCalledTimes(2));
  });

  it("handles abort errors gracefully (does not update state)", async () => {
    const abortError = new Error("AbortError");
    abortError.name = "AbortError";
    mockFetchUsageData.mockRejectedValue(abortError);

    const { result } = renderHook(() => useUsageData());

    // Wait a bit
    act(() => {
      vi.advanceTimersByTime(100);
    });

    // State should remain in loading since we don't update on abort
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("cleans up interval and abort controller on unmount", async () => {
    const mockData = {
      providers: [{ name: "Claude", icon: "🟠", status: "ok" as const, windows: [] }],
    };
    mockFetchUsageData.mockResolvedValue(mockData);

    const { unmount } = renderHook(() => useUsageData());

    await waitFor(() => expect(mockFetchUsageData).toHaveBeenCalledTimes(1));

    unmount();

    // Should not poll after unmount
    act(() => {
      vi.advanceTimersByTime(60000);
    });

    // Still only called once (no additional calls after unmount)
    expect(mockFetchUsageData).toHaveBeenCalledTimes(1);
  });
});
