import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAgentLogs, MAX_LOG_ENTRIES, isLogGapMarker } from "../useAgentLogs";
import { __resetSseBus } from "../../sse-bus";
import { fetchAgentLogsWithMeta } from "../../api";

// Mock the api module
vi.mock("../../api", () => ({
  fetchAgentLogsWithMeta: vi.fn().mockResolvedValue({ entries: [], total: 0, hasMore: false }),
}));

const mockFetchAgentLogsWithMeta = vi.mocked(fetchAgentLogsWithMeta);

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners: Record<string, ((e: any) => void)[]> = {};
  readyState = 0;
  close = vi.fn(() => {
    this.readyState = 2;
  });

  constructor(url: string) {
    this.url = url;
    this.readyState = 1;
    MockEventSource.instances.push(this);
  }

  addEventListener(event: string, fn: (e: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  // Helper to simulate a server event
  _emit(event: string, data: any) {
    for (const fn of this.listeners[event] || []) {
      fn({ data: JSON.stringify(data) });
    }
  }

  /*
  FNXC:AgentLogResync 2026-07-26-14:52:
  Fires a payload-less transport event ("open"/"error"). The sse-bus turns the SECOND `open` on a
  channel into `onReconnect`, which is exactly the shape of the hidden-tab suspend/resume: the socket
  is torn down while hidden and reopened on return, and the stream replays nothing it emitted in
  between.
  */
  _fire(event: string) {
    for (const fn of this.listeners[event] || []) {
      fn({});
    }
  }
}

const originalEventSource = globalThis.EventSource;

const INITIAL_LOAD_LIMIT = 100;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetSseBus();
  MockEventSource.instances = [];
  (globalThis as any).EventSource = MockEventSource;
  mockFetchAgentLogsWithMeta.mockReset().mockResolvedValue({ entries: [], total: 0, hasMore: false });
});

afterEach(() => {
  (globalThis as any).EventSource = originalEventSource;
});

describe("useAgentLogs", () => {
  it("does not fetch or connect when enabled=false", () => {
    const { result } = renderHook(() => useAgentLogs("FN-001", false));

    expect(mockFetchAgentLogsWithMeta).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);
    expect(result.current.entries).toEqual([]);
  });

  it("reports loading immediately when enabled until initial history fetch completes", async () => {
    const deferred = createDeferred<{ entries: []; total: number; hasMore: boolean }>();
    mockFetchAgentLogsWithMeta.mockReturnValueOnce(deferred.promise);

    const { result } = renderHook(() => useAgentLogs("FN-001", true));

    expect(result.current.loading).toBe(true);
    expect(result.current.entries).toEqual([]);

    await act(async () => {
      deferred.resolve({ entries: [], total: 0, hasMore: false });
      await deferred.promise;
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.entries).toEqual([]);
  });

  it("fetches historical logs and opens SSE when enabled=true", async () => {
    const historicalLogs = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "old", type: "text" as const },
    ];
    mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
      entries: historicalLogs,
      total: historicalLogs.length,
      hasMore: false,
    });

    const { result } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(result.current.entries).toEqual(historicalLogs);
    });

    expect(mockFetchAgentLogsWithMeta).toHaveBeenCalledWith("FN-001", undefined, { limit: INITIAL_LOAD_LIMIT });
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe("/api/tasks/FN-001/logs/stream");
  });

  it("sets hasMore and total from API response", async () => {
    mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
      entries: [],
      total: 150,
      hasMore: true,
    });

    const { result } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(result.current.total).toBe(150);
      expect(result.current.hasMore).toBe(true);
    });
  });

  it("appends live SSE entries to historical entries", async () => {
    mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
      entries: [
        { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "old", type: "text" as const },
      ],
      total: 2,
      hasMore: false,
    });

    const { result } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "FN-001",
        text: "new",
        type: "text",
      });
    });

    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries[1].text).toBe("new");
  });

  it("keeps deterministic chronological order when history has tied timestamps and SSE appends tied timestamps", async () => {
    mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
      entries: [
        { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "hist-1", type: "text" as const },
        { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "hist-2", type: "text" as const },
      ],
      total: 3,
      hasMore: false,
    });

    const { result } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.text)).toEqual(["hist-1", "hist-2"]);
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es._emit("agent:log", {
        timestamp: "2026-01-01T00:00:00Z",
        taskId: "FN-001",
        text: "live-3",
        type: "text",
      });
    });

    expect(result.current.entries.map((entry) => entry.text)).toEqual(["hist-1", "hist-2", "live-3"]);
  });

  it("closes SSE when enabled changes to false", async () => {
    mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: [], total: 0, hasMore: false });

    const { rerender } = renderHook(
      ({ enabled }) => useAgentLogs("FN-001", enabled),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const es = MockEventSource.instances[0];

    rerender({ enabled: false });

    expect(es.close).toHaveBeenCalled();
  });

  it("closes SSE on unmount", async () => {
    mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: [], total: 0, hasMore: false });

    const { unmount } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const es = MockEventSource.instances[0];

    unmount();

    expect(es.close).toHaveBeenCalled();
  });

  it("keeps oversized historical logs without truncating older entries", async () => {
    const oversizedCount = 525;
    const historicalLogs = Array.from({ length: oversizedCount }, (_, index) => ({
      timestamp: `2026-01-01T00:${String(index).padStart(2, "0")}:00Z`,
      taskId: "FN-001",
      text: `entry-${index}`,
      type: "text" as const,
    }));
    mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
      entries: historicalLogs,
      total: historicalLogs.length,
      hasMore: false,
    });

    const { result } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(oversizedCount);
    });

    expect(result.current.entries[0].text).toBe("entry-0");
    expect(result.current.entries.at(-1)?.text).toBe(`entry-${oversizedCount - 1}`);
  });

  /*
  FNXC:MobileTabRetention 2026-07-26-12:20:
  This case previously asserted the live SSE tail was retained WITHOUT truncation. That contract is
  deliberately reversed: an unbounded tail grows the resident set for the whole session, which is what
  makes a mobile browser discard the backgrounded tab (white-splash reload on return). The tail is now
  a bounded ring at MAX_LOG_ENTRIES, and `hasMore` is forced true once it trims so the reader always
  keeps a "load older" affordance rather than seeing a silently-clipped tail.
  */
  it("bounds the live SSE tail at MAX_LOG_ENTRIES and signals truncation via hasMore", async () => {
    const streamedCount = 520;
    mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: [], total: streamedCount, hasMore: false });

    const { result } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const es = MockEventSource.instances[0];
    act(() => {
      for (let index = 0; index < streamedCount; index++) {
        es._emit("agent:log", {
          timestamp: `2026-01-01T00:${String(index).padStart(2, "0")}:00Z`,
          taskId: "FN-001",
          text: `live-${index}`,
          type: "text",
        });
      }
    });

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(MAX_LOG_ENTRIES);
    });

    expect(result.current.entries[0].text).toBe(`live-${streamedCount - MAX_LOG_ENTRIES}`);
    expect(result.current.entries.at(-1)?.text).toBe(`live-${streamedCount - 1}`);
    expect(result.current.hasMore).toBe(true);
  });

  it("does not fetch when taskId is null", () => {
    renderHook(() => useAgentLogs(null, true));

    expect(mockFetchAgentLogsWithMeta).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("preserves long text and detail in historical log entries without truncation", async () => {
    const longText = "A".repeat(5000);
    const longDetail = "B".repeat(5000);
    mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
      entries: [
        { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: longText, type: "text" as const },
        { timestamp: "2026-01-01T00:00:01Z", taskId: "FN-001", text: "Read", type: "tool" as const, detail: longDetail },
      ],
      total: 2,
      hasMore: false,
    });

    const { result } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2);
    });

    expect(result.current.entries[0].text).toBe(longText);
    expect(result.current.entries[0].text.length).toBe(5000);
    expect(result.current.entries[1].detail).toBe(longDetail);
    expect(result.current.entries[1].detail!.length).toBe(5000);
  });

  it("preserves long text and detail in live SSE entries without truncation", async () => {
    mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: [], total: 1, hasMore: false });

    const { result } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const longText = "X".repeat(5000);
    const longDetail = "Y".repeat(5000);
    const es = MockEventSource.instances[0];
    act(() => {
      es._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "FN-001",
        text: longText,
        type: "text",
        detail: longDetail,
      });
    });

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    expect(result.current.entries[0].text).toBe(longText);
    expect(result.current.entries[0].text.length).toBe(5000);
    expect(result.current.entries[0].detail).toBe(longDetail);
    expect(result.current.entries[0].detail!.length).toBe(5000);
  });

  describe("loadMore", () => {
    it("loadMore fetches older entries and prepends them", async () => {
      const initialLogs = [
        { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "newer", type: "text" as const },
      ];
      const olderLogs = [
        { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "older", type: "text" as const },
      ];

      mockFetchAgentLogsWithMeta
        .mockResolvedValueOnce({ entries: initialLogs, total: 2, hasMore: true })
        .mockResolvedValueOnce({ entries: olderLogs, total: 2, hasMore: false });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(1);
        expect(result.current.hasMore).toBe(true);
      });

      // Call loadMore
      await act(async () => {
        await result.current.loadMore();
      });

      // Should now have 2 entries in chronological order: older + initial
      expect(result.current.entries).toHaveLength(2);
      expect(result.current.entries[0].text).toBe("older");
      expect(result.current.entries[1].text).toBe("newer");
      expect(result.current.hasMore).toBe(false);
    });

    it("loadMore preserves chronological order with near-equal timestamps", async () => {
      const initialLogs = [
        { timestamp: "2026-01-01T00:00:01.001Z", taskId: "FN-001", text: "middle", type: "text" as const },
        { timestamp: "2026-01-01T00:00:01.002Z", taskId: "FN-001", text: "newest", type: "text" as const },
      ];
      const olderLogs = [
        { timestamp: "2026-01-01T00:00:00.999Z", taskId: "FN-001", text: "oldest-a", type: "text" as const },
        { timestamp: "2026-01-01T00:00:00.999Z", taskId: "FN-001", text: "oldest-b", type: "text" as const },
      ];

      mockFetchAgentLogsWithMeta
        .mockResolvedValueOnce({ entries: initialLogs, total: 4, hasMore: true })
        .mockResolvedValueOnce({ entries: olderLogs, total: 4, hasMore: false });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(result.current.entries.map((entry) => entry.text)).toEqual(["middle", "newest"]);
      });

      await act(async () => {
        await result.current.loadMore();
      });

      expect(result.current.entries.map((entry) => entry.text)).toEqual([
        "oldest-a",
        "oldest-b",
        "middle",
        "newest",
      ]);
    });

    /*
    FNXC:MobileTabRetention 2026-07-26-12:24:
    A user-paged buffer (550 via loadMore) is HELD at its expanded size rather than collapsed back to
    MAX_LOG_ENTRIES — capping a prepend of older pages would discard exactly what the user just asked
    for. Streaming past that ceiling drops one oldest entry per new line so the buffer stops growing.
    */
    it("holds a user-paged buffer at its size while streaming, dropping the oldest entry", async () => {
      const initialLogs = Array.from({ length: 300 }, (_, index) => ({
        timestamp: `2026-01-02T00:${String(index).padStart(2, "0")}:00Z`,
        taskId: "FN-001",
        text: `initial-${index}`,
        type: "text" as const,
      }));
      const olderLogs = Array.from({ length: 250 }, (_, index) => ({
        timestamp: `2026-01-01T00:${String(index).padStart(2, "0")}:00Z`,
        taskId: "FN-001",
        text: `older-${index}`,
        type: "text" as const,
      }));

      mockFetchAgentLogsWithMeta
        .mockResolvedValueOnce({ entries: initialLogs, total: 550, hasMore: true })
        .mockResolvedValueOnce({ entries: olderLogs, total: 550, hasMore: false });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(300);
      });

      await act(async () => {
        await result.current.loadMore();
      });

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(550);
      });

      const es = MockEventSource.instances[0];
      act(() => {
        es._emit("agent:log", {
          timestamp: "2026-01-03T00:00:00Z",
          taskId: "FN-001",
          text: "live-after-large-history",
          type: "text",
        });
      });

      await waitFor(() => {
        expect(result.current.entries.at(-1)?.text).toBe("live-after-large-history");
      });

      expect(result.current.entries).toHaveLength(550);
      expect(result.current.entries[0].text).toBe("older-1");
    });

    /*
    FNXC:AgentLogPaging 2026-07-26-15:14:
    The live-tail trim flag used to be cleared only by clear() or a task/project switch, so it was
    OR-ed into `hasMore` forever: after paging back to entry 0 the server said hasMore:false and the
    hook still reported true. The "load older" control stayed rendered and every further click
    fetched past the end and changed nothing, so the reader could not distinguish "beginning of log"
    from "broken control". `hasMore` must be true iff older entries actually remain server-side.
    */
    it("reports hasMore false once paging reaches the beginning after a live-tail trim", async () => {
      const streamedCount = 520;
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: [], total: streamedCount, hasMore: false });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      const es = MockEventSource.instances[0];
      act(() => {
        for (let index = 0; index < streamedCount; index++) {
          es._emit("agent:log", {
            timestamp: `2026-01-01T00:${String(index).padStart(2, "0")}:00Z`,
            taskId: "FN-001",
            text: `live-${index}`,
            type: "text",
          });
        }
      });

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(MAX_LOG_ENTRIES);
        expect(result.current.hasMore).toBe(true);
      });

      // The trimmed 20 entries are everything that remained; this page reaches entry 0.
      const trimmedAway = Array.from({ length: streamedCount - MAX_LOG_ENTRIES }, (_, index) => ({
        timestamp: `2026-01-01T00:${String(index).padStart(2, "0")}:00Z`,
        taskId: "FN-001",
        text: `live-${index}`,
        type: "text" as const,
      }));
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
        entries: trimmedAway,
        total: streamedCount,
        hasMore: false,
      });

      await act(async () => {
        await result.current.loadMore();
      });

      expect(mockFetchAgentLogsWithMeta).toHaveBeenLastCalledWith("FN-001", undefined, {
        limit: INITIAL_LOAD_LIMIT,
        offset: MAX_LOG_ENTRIES,
      });
      expect(result.current.entries).toHaveLength(streamedCount);
      expect(result.current.hasMore).toBe(false);
    });

    it("loadMore does not trigger when already loading more", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 200, hasMore: true });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(result.current.hasMore).toBe(true);
      });

      // Start loading more
      const loadMorePromise = act(async () => {
        await result.current.loadMore();
      });

      // While loading, try to load more again - should be ignored
      act(() => {
        result.current.loadMore();
      });

      await loadMorePromise;

      // Initial call + loadMore call (2 total), ignoring re-render calls
      expect(mockFetchAgentLogsWithMeta.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  /*
  FNXC:AgentLogResync 2026-07-26-15:02:
  Regression cover for the silent log gap. `/api/tasks/:id/logs/stream` replays nothing on open, so
  every line emitted while the channel is down (SSE error, heartbeat timeout, or the hidden-tab
  suspend introduced for mobile tab retention) used to vanish from a list that still looked
  contiguous. The invariant asserted here is surface-independent: after ANY reconnect the rendered
  list either contains the missed lines, in order and without duplicates, or shows an explicit gap
  marker. It must never imply continuity it cannot prove.
  */
  describe("reconnect resync", () => {
    const logEntry = (minute: number, text: string) => ({
      timestamp: `2026-01-01T00:${String(minute).padStart(2, "0")}:00Z`,
      taskId: "FN-001",
      text,
      type: "text" as const,
    });

    it("refetches authoritative state on reconnect and restores lines emitted while suspended", async () => {
      const history = [logEntry(0, "hist-1"), logEntry(1, "hist-2")];
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: history, total: 2, hasMore: false });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(2);
      });

      const es = MockEventSource.instances[0];
      act(() => {
        es._fire("open");
      });
      act(() => {
        es._emit("agent:log", logEntry(2, "live-3"));
      });
      expect(result.current.entries.map((entry) => entry.text)).toEqual(["hist-1", "hist-2", "live-3"]);

      // Suspended: the server kept writing, and the stream delivered none of it.
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
        entries: [...history, logEntry(2, "live-3"), logEntry(3, "missed-4"), logEntry(4, "missed-5")],
        total: 5,
        hasMore: false,
      });

      await act(async () => {
        es._fire("open");
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.entries.map((entry) => entry.text)).toEqual([
          "hist-1",
          "hist-2",
          "live-3",
          "missed-4",
          "missed-5",
        ]);
      });
      expect(new Set(result.current.entries.map((entry) => entry.text)).size).toBe(5);
      expect(result.current.entries.some(isLogGapMarker)).toBe(false);
    });

    /*
    FNXC:AgentLogResync 2026-07-26-19:40:
    This case previously asserted that the pre-suspend entries were ABSENT after a no-overlap resync
    ("the unreconcilable prefix is not silently glued onto a page it does not touch"). The
    de-duplication half of that was right; the discarding half was the defect: a reader who paged
    back five times and then backgrounded the tab lost ~600 explicitly fetched entries and their
    scroll position, replaced by the newest 100. The entries are now RETAINED below the marker, which
    is what makes the discontinuity visible in place instead of implied by absence. The
    no-blind-concatenation invariant is still asserted — the marker sits between the two windows.
    */
    it("renders an explicit gap marker when the missed window exceeds one authoritative page", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
        entries: [logEntry(0, "before-suspend")],
        total: 1,
        hasMore: false,
      });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(1);
      });

      const es = MockEventSource.instances[0];
      act(() => {
        es._fire("open");
      });

      // 400 entries were written while hidden; the newest page shares nothing with the buffer.
      const authoritativePage = Array.from({ length: INITIAL_LOAD_LIMIT }, (_, index) =>
        logEntry(index + 5, `missed-${index}`),
      );
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
        entries: authoritativePage,
        total: 401,
        hasMore: true,
      });

      await act(async () => {
        es._fire("open");
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(INITIAL_LOAD_LIMIT + 2);
      });

      // History kept, discontinuity marked in place, refetched page below it.
      expect(result.current.entries[0].text).toBe("before-suspend");
      expect(isLogGapMarker(result.current.entries[1])).toBe(true);
      expect(result.current.entries[1].text.length).toBeGreaterThan(0);
      expect(result.current.entries.slice(2).map((entry) => entry.text)).toEqual(
        authoritativePage.map((entry) => entry.text),
      );
      // The two windows are never glued together as if they touched.
      expect(result.current.entries.filter(isLogGapMarker)).toHaveLength(1);
      expect(result.current.hasMore).toBe(true);
    });

    it("does not duplicate a live entry that also comes back in the reconnect refetch", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: [], total: 0, hasMore: false });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      const es = MockEventSource.instances[0];
      act(() => {
        es._fire("open");
      });

      const refetch = createDeferred<{ entries: any[]; total: number; hasMore: boolean }>();
      mockFetchAgentLogsWithMeta.mockReturnValueOnce(refetch.promise);

      act(() => {
        es._fire("open");
      });

      // Races the in-flight refetch and is also already persisted server-side.
      act(() => {
        es._emit("agent:log", logEntry(1, "raced"));
      });

      await act(async () => {
        refetch.resolve({ entries: [logEntry(0, "page-1"), logEntry(1, "raced")], total: 2, hasMore: false });
        await refetch.promise;
      });

      await waitFor(() => {
        expect(result.current.entries.map((entry) => entry.text)).toEqual(["page-1", "raced"]);
      });
    });

    it("keeps a live entry that raced the reconnect refetch but is not in the page", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: [], total: 0, hasMore: false });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      const es = MockEventSource.instances[0];
      act(() => {
        es._fire("open");
      });

      const refetch = createDeferred<{ entries: any[]; total: number; hasMore: boolean }>();
      mockFetchAgentLogsWithMeta.mockReturnValueOnce(refetch.promise);

      act(() => {
        es._fire("open");
      });
      act(() => {
        es._emit("agent:log", logEntry(2, "raced-later"));
      });

      await act(async () => {
        refetch.resolve({ entries: [logEntry(0, "page-1")], total: 1, hasMore: false });
        await refetch.promise;
      });

      await waitFor(() => {
        expect(result.current.entries.map((entry) => entry.text)).toEqual(["page-1", "raced-later"]);
      });
    });

    /*
    FNXC:AgentLogPaging 2026-07-26-19:48:
    P2: nothing used to arbitrate loadMore against a reconnect resync. loadMore captures its offset
    from the rendered buffer; a resync landing while that fetch is in flight replaces the buffer, and
    prepending the offset page onto the replacement produced `[entries 500-600][newest 100]` — a hole
    with no marker, and every later offset wrong. The stale page must be DISCARDED, not spliced.
    */
    it("discards a loadMore page whose buffer was replaced by a reconnect resync", async () => {
      const initialPage = Array.from({ length: 5 }, (_, index) => logEntry(index, `hist-${index}`));
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: initialPage, total: 400, hasMore: true });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(5);
      });

      const es = MockEventSource.instances[0];
      act(() => {
        es._fire("open");
      });

      // The "load older" page is still on the radio when the socket reopens.
      const olderPage = createDeferred<{ entries: any[]; total: number; hasMore: boolean }>();
      mockFetchAgentLogsWithMeta.mockReturnValueOnce(olderPage.promise);

      let loadMorePromise: Promise<void> | undefined;
      act(() => {
        loadMorePromise = result.current.loadMore();
      });

      // Reconnect resync replaces the buffer (no overlap with the held window).
      const authoritativePage = Array.from({ length: 3 }, (_, index) => logEntry(index + 30, `fresh-${index}`));
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
        entries: authoritativePage,
        total: 403,
        hasMore: true,
      });

      await act(async () => {
        es._fire("open");
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.entries.some((entry) => entry.text === "fresh-0")).toBe(true);
      });
      const afterResync = result.current.entries.map((entry) => entry.text);

      await act(async () => {
        olderPage.resolve({
          entries: Array.from({ length: 4 }, (_, index) => logEntry(index, `stale-older-${index}`)),
          total: 400,
          hasMore: true,
        });
        await loadMorePromise;
      });

      expect(result.current.entries.map((entry) => entry.text)).toEqual(afterResync);
      expect(result.current.entries.some((entry) => entry.text.startsWith("stale-older-"))).toBe(false);
      // The affordance stays reachable so the reader can page again from the corrected offset.
      expect(result.current.hasMore).toBe(true);
    });

    /*
    FNXC:AgentLogPaging 2026-07-26-19:56:
    P2: a no-overlap resync used to replace explicitly paged-back history with the newest page.
    History is now retained below the gap marker, and each subsequent "load older" pages from the
    NEWEST contiguous block (offset = entries below the marker) so the gap fills from the bottom
    until it overlaps the retained history and the marker retires.
    */
    it("retains paged-back history below the gap marker and fills the gap from below", async () => {
      const page1 = Array.from({ length: 100 }, (_, index) => logEntry(index + 100, `mid-${index}`));
      const page0 = Array.from({ length: 100 }, (_, index) => logEntry(index, `old-${index}`));
      mockFetchAgentLogsWithMeta
        .mockResolvedValueOnce({ entries: page1, total: 1000, hasMore: true })
        .mockResolvedValueOnce({ entries: page0, total: 1000, hasMore: true });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(100);
      });
      await act(async () => {
        await result.current.loadMore();
      });
      await waitFor(() => {
        expect(result.current.entries).toHaveLength(200);
      });

      const es = MockEventSource.instances[0];
      act(() => {
        es._fire("open");
      });

      const freshPage = Array.from({ length: 100 }, (_, index) => logEntry(index + 500, `fresh-${index}`));
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: freshPage, total: 1000, hasMore: true });

      await act(async () => {
        es._fire("open");
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(301);
      });
      expect(result.current.entries[0].text).toBe("old-0");
      expect(isLogGapMarker(result.current.entries[200])).toBe(true);
      expect(result.current.entries[201].text).toBe("fresh-0");

      // Gap-fill page: overlaps the retained history by 10 entries, so the marker is proven closed.
      const gapFill = [
        ...page1.slice(90),
        ...Array.from({ length: 90 }, (_, index) => logEntry(index + 300, `gap-${index}`)),
      ];
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: gapFill, total: 1000, hasMore: true });

      await act(async () => {
        await result.current.loadMore();
      });

      // Offset is the newest contiguous block (the refetched page), not every real entry held.
      expect(mockFetchAgentLogsWithMeta).toHaveBeenLastCalledWith("FN-001", undefined, {
        limit: INITIAL_LOAD_LIMIT,
        offset: 100,
      });
      await waitFor(() => {
        expect(result.current.entries.some(isLogGapMarker)).toBe(false);
      });
      const texts = result.current.entries.map((entry) => entry.text);
      expect(new Set(texts).size).toBe(texts.length);
      expect(texts.slice(0, 3)).toEqual(["old-0", "old-1", "old-2"]);
      expect(texts.slice(-1)).toEqual(["fresh-99"]);
      expect(texts).toContain("gap-0");
    });

    /*
    FNXC:AgentLogPaging 2026-07-26-20:04:
    The server resolves `offset` against its CURRENT total, so entries persisted between the client
    reading its offset and the server reading the log shift the returned window newer. Blind
    concatenation duplicated the overlapping seam; the merge de-duplicates it.
    */
    it("does not duplicate the seam when the log grew between the offset read and the server read", async () => {
      const held = [logEntry(10, "held-a"), logEntry(11, "held-b")];
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: held, total: 20, hasMore: true });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(2);
      });

      // Shifted page: its tail is the buffer's head.
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
        entries: [logEntry(8, "older-a"), logEntry(9, "older-b"), logEntry(10, "held-a")],
        total: 21,
        hasMore: true,
      });

      await act(async () => {
        await result.current.loadMore();
      });

      expect(result.current.entries.map((entry) => entry.text)).toEqual([
        "older-a",
        "older-b",
        "held-a",
        "held-b",
      ]);
    });

    /*
    FNXC:AgentLogResync 2026-07-26-20:12:
    P2: forceReconnect fires onReconnect at teardown and again ~3s later on the successful open. A
    first resync that outlived that delay swallowed the second reconnect at the single-flight early
    return, so the lines emitted between the first fetch's snapshot and the socket reopening were
    never fetched and never streamed — and the merge left NO gap marker, rendering a real hole as
    contiguous output. A superseded reconnect must re-run the resync once the in-flight one settles.
    */
    it("re-runs the resync when a reconnect arrives while one is in flight", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
        entries: [logEntry(0, "hist-1")],
        total: 1,
        hasMore: false,
      });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(1);
      });

      const es = MockEventSource.instances[0];
      act(() => {
        es._fire("open");
      });

      const slowResync = createDeferred<{ entries: any[]; total: number; hasMore: boolean }>();
      mockFetchAgentLogsWithMeta.mockReturnValueOnce(slowResync.promise);

      act(() => {
        es._fire("open");
      });
      const callsAfterFirstReconnect = mockFetchAgentLogsWithMeta.mock.calls.length;

      // Second reconnect while the first refetch is still on the radio.
      act(() => {
        es._fire("open");
      });
      expect(mockFetchAgentLogsWithMeta.mock.calls.length).toBe(callsAfterFirstReconnect);

      // The re-run's page is the only source of the lines emitted during the second outage.
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
        entries: [logEntry(0, "hist-1"), logEntry(1, "during-outage")],
        total: 2,
        hasMore: false,
      });

      await act(async () => {
        slowResync.resolve({ entries: [logEntry(0, "hist-1")], total: 1, hasMore: false });
        await slowResync.promise;
      });

      await waitFor(() => {
        expect(result.current.entries.map((entry) => entry.text)).toEqual(["hist-1", "during-outage"]);
      });
      expect(mockFetchAgentLogsWithMeta.mock.calls.length).toBe(callsAfterFirstReconnect + 1);
    });

    /*
    FNXC:AgentLogResync 2026-07-26-20:22:
    P3: live events parked during an in-flight resync had no ceiling, so a verbose agent on a waking
    radio rebuilt exactly the unbounded array MAX_LOG_ENTRIES exists to eliminate. At the cap the
    resync is abandoned and the parked batch is flushed into the ring: bounded memory, no dropped
    lines beyond the ring's own newest-wins trim, and a fresh resync once the abandoned fetch settles.
    */
    it("bounds live events parked during a resync and flushes them into the ring", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: [], total: 0, hasMore: false });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      const es = MockEventSource.instances[0];
      act(() => {
        es._fire("open");
      });

      const stuckResync = createDeferred<{ entries: any[]; total: number; hasMore: boolean }>();
      mockFetchAgentLogsWithMeta.mockReturnValueOnce(stuckResync.promise);
      act(() => {
        es._fire("open");
      });

      const streamed = MAX_LOG_ENTRIES + 40;
      act(() => {
        for (let index = 0; index < streamed; index++) {
          es._emit("agent:log", {
            timestamp: `2026-01-01T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`,
            taskId: "FN-001",
            text: `parked-${index}`,
            type: "text",
          });
        }
      });

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(MAX_LOG_ENTRIES);
      });
      expect(result.current.entries.at(-1)?.text).toBe(`parked-${streamed - 1}`);
      expect(result.current.hasMore).toBe(true);

      // The abandoned resync's result is discarded, and a fresh one runs once it settles.
      const callsBeforeSettle = mockFetchAgentLogsWithMeta.mock.calls.length;
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: [], total: streamed, hasMore: true });
      await act(async () => {
        stuckResync.resolve({ entries: [logEntry(0, "stale-snapshot")], total: 1, hasMore: false });
        await stuckResync.promise;
      });

      expect(result.current.entries.some((entry) => entry.text === "stale-snapshot")).toBe(false);
      await waitFor(() => {
        expect(mockFetchAgentLogsWithMeta.mock.calls.length).toBe(callsBeforeSettle + 1);
      });
    });

    /*
    FNXC:AgentLogResync 2026-07-26-20:30:
    P3: the live-tail trim must never evict the gap marker. Once the buffer is at the ring ceiling,
    each streamed line drops the oldest entry; when the entry above the marker is gone the marker
    becomes the head and MUST survive every later trim, or the rendered log loses the only signal
    that output is missing above while the output stays missing.
    */
    it("never trims away the gap marker while streaming at the ring ceiling", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
        entries: [logEntry(0, "before-suspend")],
        total: 1,
        hasMore: false,
      });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(1);
      });

      const es = MockEventSource.instances[0];
      act(() => {
        es._fire("open");
      });

      const authoritativePage = Array.from({ length: 100 }, (_, index) => logEntry(index + 5, `fresh-${index}`));
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
        entries: authoritativePage,
        total: 500,
        hasMore: true,
      });
      await act(async () => {
        es._fire("open");
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current.entries.some(isLogGapMarker)).toBe(true);
      });

      act(() => {
        for (let index = 0; index < MAX_LOG_ENTRIES; index++) {
          es._emit("agent:log", {
            timestamp: `2026-02-01T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00Z`,
            taskId: "FN-001",
            text: `after-${index}`,
            type: "text",
          });
        }
      });

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(MAX_LOG_ENTRIES);
      });
      expect(isLogGapMarker(result.current.entries[0])).toBe(true);
      expect(result.current.entries.filter(isLogGapMarker)).toHaveLength(1);
      expect(result.current.entries.at(-1)?.text).toBe(`after-${MAX_LOG_ENTRIES - 1}`);
      expect(result.current.hasMore).toBe(true);
    });

    it("keeps streaming into the buffer when the reconnect refetch fails", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({
        entries: [logEntry(0, "hist-1")],
        total: 1,
        hasMore: false,
      });

      const { result } = renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(1);
      });

      const es = MockEventSource.instances[0];
      act(() => {
        es._fire("open");
      });

      mockFetchAgentLogsWithMeta.mockRejectedValueOnce(new Error("network down"));

      await act(async () => {
        es._fire("open");
        await Promise.resolve();
      });
      act(() => {
        es._emit("agent:log", logEntry(1, "after-failed-resync"));
      });

      await waitFor(() => {
        expect(result.current.entries.map((entry) => entry.text)).toEqual(["hist-1", "after-failed-resync"]);
      });
    });
  });

  describe("projectId support", () => {
    it("includes projectId in EventSource URL when provided", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: [], total: 0, hasMore: false });

      renderHook(() => useAgentLogs("FN-001", true, "proj-123"));

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
        expect(MockEventSource.instances[0].url).toBe("/api/tasks/FN-001/logs/stream?projectId=proj-123");
      });
    });

    it("includes projectId in fetchAgentLogsWithMeta call when provided", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: [], total: 0, hasMore: false });

      renderHook(() => useAgentLogs("FN-001", true, "proj-123"));

      await waitFor(() => {
        expect(mockFetchAgentLogsWithMeta).toHaveBeenCalledWith("FN-001", "proj-123", { limit: INITIAL_LOAD_LIMIT });
      });
    });

    it("does not include projectId in URL when not provided", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValueOnce({ entries: [], total: 0, hasMore: false });

      renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
        expect(MockEventSource.instances[0].url).toBe("/api/tasks/FN-001/logs/stream");
      });
    });

    it("clears entries and reports loading immediately when projectId changes", async () => {
      const secondFetch = createDeferred<{
        entries: Array<{ timestamp: string; taskId: string; text: string; type: "text" }>;
        total: number;
        hasMore: boolean;
      }>();
      mockFetchAgentLogsWithMeta
        .mockResolvedValueOnce({
          entries: [{ timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "proj-A-log", type: "text" as const }],
          total: 1,
          hasMore: false,
        })
        .mockReturnValueOnce(secondFetch.promise);

      const { result, rerender } = renderHook(
        ({ projectId }) => useAgentLogs("FN-001", true, projectId),
        { initialProps: { projectId: "proj-A" } },
      );

      await waitFor(() => {
        expect(result.current.entries.map((entry) => entry.text)).toEqual(["proj-A-log"]);
        expect(result.current.loading).toBe(false);
      });

      rerender({ projectId: "proj-B" });

      expect(result.current.entries).toEqual([]);
      expect(result.current.loading).toBe(true);

      await act(async () => {
        secondFetch.resolve({
          entries: [{ timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "proj-B-log", type: "text" as const }],
          total: 1,
          hasMore: false,
        });
        await secondFetch.promise;
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.entries.map((entry) => entry.text)).toEqual(["proj-B-log"]);
      });
    });

    it("clears entries immediately when projectId changes", async () => {
      // Set up mock to return different values based on projectId
      mockFetchAgentLogsWithMeta.mockImplementation((_taskId: string, projectId?: string) => {
        if (projectId === "proj-A") {
          return Promise.resolve({
            entries: [{ timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "proj-A-log", type: "text" as const }],
            total: 1,
            hasMore: false,
          });
        }
        if (projectId === "proj-B") {
          return Promise.resolve({
            entries: [{ timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "proj-B-log", type: "text" as const }],
            total: 1,
            hasMore: false,
          });
        }
        return Promise.resolve({ entries: [], total: 0, hasMore: false });
      });

      // Create a hook that switches project
      const { result, rerender } = renderHook(
        ({ projectId }) => useAgentLogs("FN-001", true, projectId),
        { initialProps: { projectId: "proj-A" } },
      );

      // Wait for initial entries to load
      await waitFor(() => {
        expect(result.current.entries).toHaveLength(1);
        expect(result.current.entries[0].text).toBe("proj-A-log");
      });

      // Switch to proj-B
      rerender({ projectId: "proj-B" });

      // Entries should be cleared immediately after project switch
      await waitFor(() => {
        expect(result.current.entries).toHaveLength(0);
      });

      // New fetch should start for proj-B
      await waitFor(() => {
        expect(result.current.entries).toHaveLength(1);
        expect(result.current.entries[0].text).toBe("proj-B-log");
      });
    });

    it("rejects stale SSE events after project switch", async () => {
      // Initial render with proj-A
      mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 0, hasMore: false });

      const { result, rerender } = renderHook(
        ({ projectId }) => useAgentLogs("FN-001", true, projectId),
        { initialProps: { projectId: "proj-A" } },
      );

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      const es = MockEventSource.instances[0];

      // Switch to proj-B
      rerender({ projectId: "proj-B" });

      // Wait for new connection to be established
      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
      });

      // Old connection should be closed
      expect(es.close).toHaveBeenCalled();

      // Wait for entries to be cleared
      await waitFor(() => {
        expect(result.current.entries).toHaveLength(0);
      });

      // Emit event on old connection (should be ignored)
      act(() => {
        es._emit("agent:log", {
          timestamp: "2026-01-01T00:01:00Z",
          taskId: "FN-001",
          text: "stale-event",
          type: "text",
        });
      });

      // Stale event should not appear
      expect(result.current.entries.find(e => e.text === "stale-event")).toBeUndefined();
    });

    it("creates new connection with new projectId on project switch", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 0, hasMore: false });

      const { rerender } = renderHook(
        ({ projectId }) => useAgentLogs("FN-001", true, projectId),
        { initialProps: { projectId: "proj-A" } },
      );

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
      });

      const initialCount = MockEventSource.instances.length;

      // Switch to proj-B
      rerender({ projectId: "proj-B" });

      // Wait for new connection
      await waitFor(() => {
        expect(MockEventSource.instances.length).toBeGreaterThan(initialCount);
      });

      // New connection should have correct projectId
      const newConnections = MockEventSource.instances.filter(
        es => es.url.includes("proj-B")
      );
      expect(newConnections.length).toBeGreaterThan(0);
    });
  });
});
