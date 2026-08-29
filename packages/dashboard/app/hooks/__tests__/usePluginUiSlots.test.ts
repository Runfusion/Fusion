import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { usePluginUiSlots, __test_clearCache } from "../usePluginUiSlots";
import * as api from "../../api";
import type { PluginUiSlotEntry } from "../../api";

vi.mock("../../api", () => ({
  fetchPluginUiSlots: vi.fn(),
}));

const mockFetchPluginUiSlots = vi.mocked(api.fetchPluginUiSlots);

function createSlotEntry(slotId: string, pluginId = "test-plugin"): PluginUiSlotEntry {
  return {
    pluginId,
    slot: {
      slotId,
      label: `Test slot ${slotId}`,
      componentPath: `./components/${slotId}.js`,
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("usePluginUiSlots", () => {
  beforeEach(() => {
    mockFetchPluginUiSlots.mockReset();
    __test_clearCache();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("calls fetchPluginUiSlots on mount and returns slots", async () => {
    const slots = [createSlotEntry("task-detail-tab", "plugin-a")];
    mockFetchPluginUiSlots.mockResolvedValueOnce(slots);

    const { result } = renderHook(() => usePluginUiSlots());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.slots).toEqual(slots);
    expect(result.current.error).toBeNull();
    expect(mockFetchPluginUiSlots).toHaveBeenCalledWith(undefined);
  });

  it("passes projectId to fetchPluginUiSlots", async () => {
    mockFetchPluginUiSlots.mockResolvedValueOnce([]);

    const { result } = renderHook(() => usePluginUiSlots("proj-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockFetchPluginUiSlots).toHaveBeenCalledWith("proj-1");
  });

  describe("cache behavior", () => {
    it("uses cache on second render with same projectId", async () => {
      const slots = [createSlotEntry("header-action", "plugin-b")];
      mockFetchPluginUiSlots.mockResolvedValueOnce(slots);

      const { result: first } = renderHook(() => usePluginUiSlots());
      await waitFor(() => expect(first.current.loading).toBe(false));
      expect(first.current.slots).toEqual(slots);

      // Second hook instance with same projectId — should use cache
      mockFetchPluginUiSlots.mockClear();

      const { result: second } = renderHook(() => usePluginUiSlots());
      await waitFor(() => expect(second.current.loading).toBe(false));

      expect(second.current.slots).toEqual(slots);
      expect(mockFetchPluginUiSlots).not.toHaveBeenCalled();
    });

    it("fetches fresh data after TTL expires", async () => {
      vi.useFakeTimers();

      const slots = [createSlotEntry("board-column-footer", "plugin-c")];
      // Provide two resolutions: first for initial render, second for post-TTL render
      mockFetchPluginUiSlots
        .mockResolvedValueOnce(slots)
        .mockResolvedValueOnce([...slots, createSlotEntry("extra-slot", "plugin-c")]);

      const { result: first } = renderHook(() => usePluginUiSlots("ttl-test"));

      // Flush React state updates with fake timers
      await act(async () => {
        vi.advanceTimersByTime(1);
      });

      expect(first.current.loading).toBe(false);
      expect(first.current.slots).toEqual(slots);

      // Fast-forward past cache TTL (60 seconds)
      await act(async () => {
        vi.advanceTimersByTime(60_001);
      });

      const { result: second } = renderHook(() => usePluginUiSlots("ttl-test"));

      // Flush React state updates for second render
      await act(async () => {
        vi.advanceTimersByTime(1);
      });

      expect(second.current.loading).toBe(false);
      // Should have fetched fresh data (mocked with extra entry)
      expect(second.current.slots).toHaveLength(2);
    });

    it("caches separately per projectId", async () => {
      const slotsA = [createSlotEntry("settings-section", "plugin-a")];
      const slotsB = [createSlotEntry("settings-section", "plugin-b")];

      mockFetchPluginUiSlots.mockResolvedValueOnce(slotsA);

      const { result: first } = renderHook(() => usePluginUiSlots("proj-a"));
      await waitFor(() => expect(first.current.loading).toBe(false));
      expect(first.current.slots).toEqual(slotsA);

      // Different projectId should trigger a separate fetch
      mockFetchPluginUiSlots.mockClear();
      mockFetchPluginUiSlots.mockResolvedValueOnce(slotsB);

      const { result: second } = renderHook(() => usePluginUiSlots("proj-b"));
      await waitFor(() => expect(second.current.loading).toBe(false));

      expect(mockFetchPluginUiSlots).toHaveBeenCalledWith("proj-b");
      expect(second.current.slots).toEqual(slotsB);
    });
  });

  describe("getSlotsForId", () => {
    it("returns entries with matching slotId", async () => {
      const entries = [
        createSlotEntry("task-detail-tab", "plugin-a"),
        createSlotEntry("header-action", "plugin-b"),
        createSlotEntry("task-detail-tab", "plugin-c"),
      ];
      mockFetchPluginUiSlots.mockResolvedValueOnce(entries);

      const { result } = renderHook(() => usePluginUiSlots());
      await waitFor(() => expect(result.current.loading).toBe(false));

      const tabs = result.current.getSlotsForId("task-detail-tab");
      expect(tabs).toHaveLength(2);
      expect(tabs[0].pluginId).toBe("plugin-a");
      expect(tabs[1].pluginId).toBe("plugin-c");
    });

    it("returns empty array when no plugins register for that slotId", async () => {
      const entries = [createSlotEntry("task-detail-tab", "plugin-a")];
      mockFetchPluginUiSlots.mockResolvedValueOnce(entries);

      const { result } = renderHook(() => usePluginUiSlots());
      await waitFor(() => expect(result.current.loading).toBe(false));

      const result2 = result.current.getSlotsForId("non-existent-slot");
      expect(result2).toHaveLength(0);
    });

    it("returns entries from multiple plugins for the same slotId", async () => {
      const entries = [
        createSlotEntry("board-column-footer", "plugin-x"),
        createSlotEntry("board-column-footer", "plugin-y"),
        createSlotEntry("board-column-footer", "plugin-z"),
      ];
      mockFetchPluginUiSlots.mockResolvedValueOnce(entries);

      const { result } = renderHook(() => usePluginUiSlots());
      await waitFor(() => expect(result.current.loading).toBe(false));

      const footers = result.current.getSlotsForId("board-column-footer");
      expect(footers).toHaveLength(3);
      expect(footers.map((e) => e.pluginId)).toEqual(["plugin-x", "plugin-y", "plugin-z"]);
    });
  });

  describe("loading state", () => {
    it("loading is true during initial fetch, false after completion", async () => {
      const { promise, resolve } = deferred<PluginUiSlotEntry[]>();
      mockFetchPluginUiSlots.mockReturnValueOnce(promise);

      const { result } = renderHook(() => usePluginUiSlots());

      expect(result.current.loading).toBe(true);
      expect(result.current.slots).toEqual([]);

      await act(async () => {
        resolve([]);
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
    });

    it("loading is false immediately on cache hit (no loading flicker)", async () => {
      const slots = [createSlotEntry("quick-slot", "plugin-q")];
      mockFetchPluginUiSlots.mockResolvedValueOnce(slots);

      const { result: first } = renderHook(() => usePluginUiSlots());
      await waitFor(() => expect(first.current.loading).toBe(false));

      mockFetchPluginUiSlots.mockClear();

      const { result: second } = renderHook(() => usePluginUiSlots());
      // Cache hit — loading is immediately false
      expect(second.current.loading).toBe(false);
      expect(second.current.slots).toEqual(slots);
    });
  });

  describe("error handling", () => {
    it("sets error string when fetch fails and loading becomes false", async () => {
      mockFetchPluginUiSlots.mockRejectedValueOnce(new Error("network error"));

      const { result } = renderHook(() => usePluginUiSlots());

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.error).toBe("network error");
      expect(result.current.slots).toEqual([]);
    });

    it("clears error when subsequent fetch succeeds", async () => {
      mockFetchPluginUiSlots
        .mockRejectedValueOnce(new Error("first error"))
        .mockResolvedValueOnce([createSlotEntry("recovery-slot", "plugin-r")]);

      const { result } = renderHook(() => usePluginUiSlots("retry-test"));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBe("first error");

      // Reset and fetch again
      mockFetchPluginUiSlots.mockClear();
      mockFetchPluginUiSlots.mockResolvedValueOnce([createSlotEntry("recovery-slot", "plugin-r")]);

      const { result: second } = renderHook(() => usePluginUiSlots("retry-test"));
      await waitFor(() => expect(second.current.loading).toBe(false));
      expect(second.current.error).toBeNull();
    });
  });

  it("handles empty array from API correctly", async () => {
    mockFetchPluginUiSlots.mockResolvedValueOnce([]);

    const { result } = renderHook(() => usePluginUiSlots());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.slots).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.getSlotsForId("anything")).toEqual([]);
  });

  it("__test_clearCache clears cache between tests for isolation", async () => {
    const slots = [createSlotEntry("isolation-slot", "plugin-iso")];
    mockFetchPluginUiSlots.mockResolvedValueOnce(slots);

    const { result: first } = renderHook(() => usePluginUiSlots("iso-proj"));
    await waitFor(() => expect(first.current.loading).toBe(false));
    expect(first.current.slots).toEqual(slots);

    // Clear cache — next render should fetch again
    __test_clearCache();
    mockFetchPluginUiSlots.mockClear();
    mockFetchPluginUiSlots.mockResolvedValueOnce([...slots, createSlotEntry("new-slot", "plugin-iso")]);

    const { result: second } = renderHook(() => usePluginUiSlots("iso-proj"));
    await waitFor(() => expect(second.current.loading).toBe(false));

    expect(mockFetchPluginUiSlots).toHaveBeenCalledWith("iso-proj");
    expect(second.current.slots).toHaveLength(2);
  });

  it("cancels in-flight request when projectId changes", async () => {
    const { promise, resolve } = deferred<PluginUiSlotEntry[]>();
    mockFetchPluginUiSlots.mockReturnValueOnce(promise);

    const { result, rerender } = renderHook(
      ({ id }) => usePluginUiSlots(id),
      { initialProps: { id: "proj-old" } },
    );

    expect(result.current.loading).toBe(true);

    // Change projectId before the promise resolves
    await act(async () => {
      rerender({ id: "proj-new" });
    });

    // Resolve the old request
    await act(async () => {
      resolve([createSlotEntry("stale-slot", "stale-plugin")]);
    });

    // The stale result should NOT be applied
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Should have a fresh fetch for the new projectId
    expect(mockFetchPluginUiSlots).toHaveBeenCalledWith("proj-new");
  });
});
