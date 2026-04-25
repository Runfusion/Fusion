import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useUsageData } from "../useUsageData";
import * as api from "../../api";

describe("useUsageData", () => {
  const mockFetchUsageData = vi.spyOn(api, "fetchUsageData");

  beforeEach(() => {
    mockFetchUsageData.mockClear();
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

    const { result } = renderHook(() => useUsageData({ autoRefresh: false }));

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

    const { result } = renderHook(() => useUsageData({ autoRefresh: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("Network error");
    expect(result.current.providers).toEqual([]);
  });

  it("manual refresh fetches new data", async () => {
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
    await result.current.refresh();

    await waitFor(() => expect(result.current.providers).toEqual(mockData2.providers));
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
    await result.current.refresh();

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.providers).toHaveLength(1);
  });

  it("exports the correct interface", () => {
    expect(typeof useUsageData).toBe("function");
  });

  it("returns expected default values before first fetch", () => {
    mockFetchUsageData.mockImplementation(() => new Promise(() => {})); // Never resolves

    const { result } = renderHook(() => useUsageData({ autoRefresh: false }));

    expect(result.current.providers).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.lastUpdated).toBeNull();
    expect(typeof result.current.refresh).toBe("function");
  });
});
