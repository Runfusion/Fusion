/**
 * EventSource Mock Cleanup Requirements:
 * 
 * This test file uses a MockEventSource class that tracks all instances in a static
 * `instances` array. To prevent test isolation issues, we must ensure:
 * 
 * 1. `MockEventSource.instances` is reset to empty before each test
 * 2. Any lingering EventSource instances are closed and removed after each test
 * 3. Fake timers are restored to real timers after each test (in case a test failed
 *    before it could restore them)
 * 
 * Without proper cleanup, fake timers from one test can leak to subsequent tests,
 * causing `waitFor()` calls to hang indefinitely.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MAX_LOG_ENTRIES, useMultiAgentLogs } from "../useMultiAgentLogs";
import { isLogGapMarker } from "../logStreamReconcile";
import { fetchAgentLogsWithMeta } from "../../api";
import { MockEventSource } from "../../../vitest.setup";

// Mock the api module
vi.mock("../../api", () => ({
  fetchAgentLogsWithMeta: vi.fn().mockResolvedValue({ entries: [], total: 0, hasMore: false }),
}));

const mockFetchAgentLogsWithMeta = vi.mocked(fetchAgentLogsWithMeta);

const INITIAL_LOAD_LIMIT = 100;

// Helper to get the last connection for a specific task ID
function getConnection(taskId: string): MockEventSource | undefined {
  const url = `/api/tasks/${taskId}/logs/stream`;
  const matching = MockEventSource.instances.filter((e) => e.url === url);
  return matching[matching.length - 1];
}

// Helper to get all connections for a task ID
function getConnections(taskId: string): MockEventSource[] {
  const url = `/api/tasks/${taskId}/logs/stream`;
  return MockEventSource.instances.filter((e) => e.url === url);
}

beforeEach(() => {
  MockEventSource.instances = [];
  mockFetchAgentLogsWithMeta.mockReset().mockResolvedValue({ entries: [], total: 0, hasMore: false });
  
  // Ensure we start with real timers for every test
  vi.useRealTimers();
});

afterEach(() => {
  // Close all lingering EventSource instances to clear reconnect timers
  for (const instance of MockEventSource.instances) {
    instance.close();
  }
  MockEventSource.instances = [];
  
  // Safety: ensure real timers are restored even if a test failed
  vi.useRealTimers();
});

describe("useMultiAgentLogs", () => {
  it("initializes with empty entries for all provided task IDs", () => {
    const { result } = renderHook(() => useMultiAgentLogs(["FN-001", "FN-002"]));

    expect(result.current["FN-001"]).toBeDefined();
    expect(result.current["FN-001"].entries).toEqual([]);
    expect(result.current["FN-001"].loading).toBe(true);
    
    expect(result.current["FN-002"]).toBeDefined();
    expect(result.current["FN-002"].entries).toEqual([]);
    expect(result.current["FN-002"].loading).toBe(true);
  });

  it("returns empty object when no task IDs provided", () => {
    const { result } = renderHook(() => useMultiAgentLogs([]));

    expect(Object.keys(result.current)).toHaveLength(0);
  });

  it("fetches historical logs for each task on mount", async () => {
    const logs1 = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "log1", type: "text" as const },
    ];
    const logs2 = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-002", text: "log2", type: "text" as const },
    ];
    
    mockFetchAgentLogsWithMeta.mockImplementation((taskId) => {
      if (taskId === "FN-001") return Promise.resolve({ entries: logs1, total: logs1.length, hasMore: false });
      if (taskId === "FN-002") return Promise.resolve({ entries: logs2, total: logs2.length, hasMore: false });
      return Promise.resolve({ entries: [], total: 0, hasMore: false });
    });

    const { result } = renderHook(() => useMultiAgentLogs(["FN-001", "FN-002"]));

    await waitFor(() => {
      expect(result.current["FN-001"].entries).toEqual(logs1);
      expect(result.current["FN-002"].entries).toEqual(logs2);
    });

    expect(mockFetchAgentLogsWithMeta).toHaveBeenCalledWith("FN-001", undefined, { limit: INITIAL_LOAD_LIMIT });
    expect(mockFetchAgentLogsWithMeta).toHaveBeenCalledWith("FN-002", undefined, { limit: INITIAL_LOAD_LIMIT });
  });

  it("opens SSE EventSource for each task ID", async () => {
    mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 0, hasMore: false });

    renderHook(() => useMultiAgentLogs(["FN-001", "FN-002"]));

    await waitFor(() => {
      // Filter to unique URLs (Strict Mode may create duplicates)
      const urls = [...new Set(MockEventSource.instances.map((es) => es.url))];
      expect(urls).toContain("/api/tasks/FN-001/logs/stream");
      expect(urls).toContain("/api/tasks/FN-002/logs/stream");
    });
  });

  it("merges live SSE events with historical entries", async () => {
    const historical = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "old", type: "text" as const },
    ];
    // Use mockResolvedValue (not Once) to handle Strict Mode double-run
    mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: historical, total: historical.length, hasMore: false });

    const { result } = renderHook(() => useMultiAgentLogs(["FN-001"]));

    await waitFor(() => {
      expect(result.current["FN-001"].entries).toHaveLength(1);
    });

    const es = getConnection("FN-001");
    expect(es).toBeDefined();

    act(() => {
      es!._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "FN-001",
        text: "new",
        type: "text",
      });
    });

    await waitFor(() => {
      expect(result.current["FN-001"].entries).toHaveLength(2);
    });

    expect(result.current["FN-001"].entries[1].text).toBe("new");
  });

  it("closes all SSE connections on unmount (memory leak prevention)", async () => {
    mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 0, hasMore: false });

    const { unmount } = renderHook(() => useMultiAgentLogs(["FN-001", "FN-002"]));

    // Wait for connections to be established
    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);
    });

    // Get unique instances by URL (handling Strict Mode duplicates)
    const uniqueByUrl = new Map<string, MockEventSource>();
    for (const es of MockEventSource.instances) {
      if (!uniqueByUrl.has(es.url) || !es.close.mock?.calls?.length) {
        uniqueByUrl.set(es.url, es);
      }
    }
    const finalInstances = Array.from(uniqueByUrl.values());

    unmount();

    // Verify all final connections are closed
    for (const es of finalInstances) {
      expect(es.close).toHaveBeenCalled();
    }
  });

  it("closes specific connection when task ID removed from array", async () => {
    mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 0, hasMore: false });

    const { rerender } = renderHook(
      ({ taskIds }: { taskIds: string[] }) => useMultiAgentLogs(taskIds),
      { initialProps: { taskIds: ["FN-001", "FN-002"] } },
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2);
    });

    const es1 = getConnection("FN-001");
    const es2 = getConnection("FN-002");

    rerender({ taskIds: ["FN-001"] });

    await waitFor(() => {
      expect(es2!.close).toHaveBeenCalled();
    });

    expect(es1!.close).not.toHaveBeenCalled();
  });

  it("opens new connection when task ID added to array", async () => {
    mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 0, hasMore: false });

    const { rerender } = renderHook(
      ({ taskIds }: { taskIds: string[] }) => useMultiAgentLogs(taskIds),
      { initialProps: { taskIds: ["FN-001"] } },
    );

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
    });

    rerender({ taskIds: ["FN-001", "FN-002"] });

    await waitFor(() => {
      const urls = [...new Set(MockEventSource.instances.map((es) => es.url))];
      expect(urls).toContain("/api/tasks/FN-002/logs/stream");
    });
  });

  it("provides per-task clear function that resets entries", async () => {
    const logs = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "log1", type: "text" as const },
      { timestamp: "2026-01-01T00:01:00Z", taskId: "FN-001", text: "log2", type: "text" as const },
    ];
    // Use mockResolvedValue (not Once) to handle Strict Mode double-run
    mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: logs, total: logs.length, hasMore: false });

    const { result } = renderHook(() => useMultiAgentLogs(["FN-001", "FN-002"]));

    await waitFor(() => {
      expect(result.current["FN-001"].entries).toHaveLength(2);
    });

    // Clear only FN-001
    act(() => {
      result.current["FN-001"].clear();
    });

    await waitFor(() => {
      expect(result.current["FN-001"].entries).toHaveLength(0);
    });
  });

  it("handles errors gracefully when fetching historical logs", async () => {
    mockFetchAgentLogsWithMeta.mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useMultiAgentLogs(["FN-001"]));

    await waitFor(() => {
      expect(result.current["FN-001"].loading).toBe(false);
    });

    expect(result.current["FN-001"].entries).toEqual([]);
  });

  it("does not create duplicate connections while historical fetch is still pending", async () => {
    let resolveFetch: ((value: { entries: never[]; total: number; hasMore: boolean }) => void) | undefined;
    mockFetchAgentLogsWithMeta.mockImplementation(
      () => new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { rerender } = renderHook(
      ({ taskIds }: { taskIds: string[] }) => useMultiAgentLogs(taskIds),
      { initialProps: { taskIds: ["FN-001"] } },
    );

    await waitFor(() => {
      // Allow for Strict Mode double-rendering
      expect(getConnections("FN-001").length).toBeGreaterThanOrEqual(1);
    });

    const initialCount = getConnections("FN-001").length;

    rerender({ taskIds: ["FN-001"] });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should not create additional connections on rerender with same IDs
    expect(getConnections("FN-001").length).toBe(initialCount);

    resolveFetch?.({ entries: [], total: 0, hasMore: false });

    await waitFor(() => {
      expect(mockFetchAgentLogsWithMeta).toHaveBeenCalledTimes(1);
    });
  });

  it("closes a task connection when its stream emits an error", async () => {
    mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 0, hasMore: false });

    renderHook(() => useMultiAgentLogs(["FN-001"]));

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
    });

    const es = getConnection("FN-001");
    expect(es).toBeDefined();

    act(() => {
      es!._emit("error");
    });

    expect(es!.close).toHaveBeenCalledTimes(1);
  });

  it("truncates oversized historical logs per task to the most recent entries", async () => {
    const oversized = Array.from({ length: MAX_LOG_ENTRIES + 10 }, (_, index) => ({
      timestamp: `2026-01-01T00:${String(index).padStart(2, "0")}:00Z`,
      taskId: "FN-001",
      text: `entry-${index}`,
      type: "text" as const,
    }));

    mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: oversized, total: oversized.length, hasMore: false });

    const { result } = renderHook(() => useMultiAgentLogs(["FN-001"]));

    await waitFor(() => {
      expect(result.current["FN-001"].entries).toHaveLength(MAX_LOG_ENTRIES);
    });

    expect(result.current["FN-001"].entries[0].text).toBe("entry-10");
    expect(result.current["FN-001"].entries.at(-1)?.text).toBe(`entry-${MAX_LOG_ENTRIES + 9}`);
  });

  it("preserves streamed entries that arrive before historical fetch resolves", async () => {
    let resolveFetch: ((value: { entries: Array<{ timestamp: string; taskId: string; text: string; type: "text" }>; total: number; hasMore: boolean }) => void) | undefined;
    mockFetchAgentLogsWithMeta.mockImplementation(
      () => new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { result } = renderHook(() => useMultiAgentLogs(["FN-001"]));

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
    });

    const es = getConnection("FN-001");
    expect(es).toBeDefined();

    act(() => {
      es!._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "FN-001",
        text: "live-before-history",
        type: "text",
      });
    });

    act(() => {
      resolveFetch?.({
        entries: [
          {
            timestamp: "2026-01-01T00:00:00Z",
            taskId: "FN-001",
            text: "historical",
            type: "text",
          },
        ],
        total: 2,
        hasMore: false,
      });
    });

    await waitFor(() => {
      expect(result.current["FN-001"].entries).toHaveLength(2);
    });

    expect(result.current["FN-001"].entries[0].text).toBe("historical");
    expect(result.current["FN-001"].entries[1].text).toBe("live-before-history");
  });

  it("truncates live SSE entries per task to the most recent entries", async () => {
    mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: MAX_LOG_ENTRIES + 15, hasMore: false });

    const { result } = renderHook(() => useMultiAgentLogs(["FN-001"]));

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
    });

    const es = getConnection("FN-001");
    expect(es).toBeDefined();

    act(() => {
      for (let index = 0; index < MAX_LOG_ENTRIES + 15; index++) {
        es!._emit("agent:log", {
          timestamp: `2026-01-01T00:${String(index).padStart(2, "0")}:00Z`,
          taskId: "FN-001",
          text: `live-${index}`,
          type: "text",
        });
      }
    });

    await waitFor(() => {
      expect(result.current["FN-001"].entries).toHaveLength(MAX_LOG_ENTRIES);
    });

    expect(result.current["FN-001"].entries[0].text).toBe("live-15");
    expect(result.current["FN-001"].entries.at(-1)?.text).toBe(`live-${MAX_LOG_ENTRIES + 14}`);
  });

  it("handles SSE events for multiple tasks independently", async () => {
    const logs1 = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "task1-old", type: "text" as const },
    ];
    const logs2 = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-002", text: "task2-old", type: "text" as const },
    ];
    
    mockFetchAgentLogsWithMeta.mockImplementation((taskId) => {
      if (taskId === "FN-001") return Promise.resolve({ entries: logs1, total: logs1.length, hasMore: false });
      if (taskId === "FN-002") return Promise.resolve({ entries: logs2, total: logs2.length, hasMore: false });
      return Promise.resolve({ entries: [], total: 0, hasMore: false });
    });

    const { result } = renderHook(() => useMultiAgentLogs(["FN-001", "FN-002"]));

    await waitFor(() => {
      expect(result.current["FN-001"].entries).toHaveLength(1);
      expect(result.current["FN-002"].entries).toHaveLength(1);
    });

    const es1 = getConnection("FN-001");
    const es2 = getConnection("FN-002");
    expect(es1).toBeDefined();
    expect(es2).toBeDefined();

    act(() => {
      es1!._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "FN-001",
        text: "task1-new",
        type: "text",
      });
    });

    await waitFor(() => {
      expect(result.current["FN-001"].entries).toHaveLength(2);
      expect(result.current["FN-002"].entries).toHaveLength(1);
    });

    act(() => {
      es2!._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "FN-002",
        text: "task2-new",
        type: "text",
      });
    });

    await waitFor(() => {
      expect(result.current["FN-001"].entries).toHaveLength(2);
      expect(result.current["FN-002"].entries).toHaveLength(2);
    });

    expect(result.current["FN-001"].entries[1].text).toBe("task1-new");
    expect(result.current["FN-002"].entries[1].text).toBe("task2-new");
  });

  it("preserves long text and detail in historical log entries without truncation", async () => {
    const longText = "A".repeat(5000);
    const longDetail = "B".repeat(5000);
    mockFetchAgentLogsWithMeta.mockResolvedValue({
      entries: [
        { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: longText, type: "text" as const },
        { timestamp: "2026-01-01T00:00:01Z", taskId: "FN-001", text: "Read", type: "tool" as const, detail: longDetail },
      ],
      total: 2,
      hasMore: false,
    });

    const { result } = renderHook(() => useMultiAgentLogs(["FN-001"]));

    await waitFor(() => {
      expect(result.current["FN-001"].entries).toHaveLength(2);
    });

    expect(result.current["FN-001"].entries[0].text).toBe(longText);
    expect(result.current["FN-001"].entries[0].text.length).toBe(5000);
    expect(result.current["FN-001"].entries[1].detail).toBe(longDetail);
    expect(result.current["FN-001"].entries[1].detail!.length).toBe(5000);
  });

  it("preserves long text and detail in live SSE entries without truncation", async () => {
    mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 1, hasMore: false });

    const { result } = renderHook(() => useMultiAgentLogs(["FN-001"]));

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
    });

    const es = getConnection("FN-001");
    expect(es).toBeDefined();

    const longText = "X".repeat(5000);
    const longDetail = "Y".repeat(5000);
    act(() => {
      es!._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "FN-001",
        text: longText,
        type: "text",
        detail: longDetail,
      });
    });

    await waitFor(() => {
      expect(result.current["FN-001"].entries).toHaveLength(1);
    });

    expect(result.current["FN-001"].entries[0].text).toBe(longText);
    expect(result.current["FN-001"].entries[0].text.length).toBe(5000);
    expect(result.current["FN-001"].entries[0].detail).toBe(longDetail);
    expect(result.current["FN-001"].entries[0].detail!.length).toBe(5000);
  });

  describe("projectId support", () => {
    it("includes projectId in EventSource URL when provided", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 0, hasMore: false });

      renderHook(() => useMultiAgentLogs(["FN-001", "FN-002"], "proj-123"));

      await waitFor(() => {
        const urls = [...new Set(MockEventSource.instances.map((es) => es.url))];
        expect(urls).toContain("/api/tasks/FN-001/logs/stream?projectId=proj-123");
        expect(urls).toContain("/api/tasks/FN-002/logs/stream?projectId=proj-123");
      });
    });

    it("includes projectId in fetchAgentLogsWithMeta call when provided", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 0, hasMore: false });

      renderHook(() => useMultiAgentLogs(["FN-001"], "proj-123"));

      await waitFor(() => {
        expect(mockFetchAgentLogsWithMeta).toHaveBeenCalledWith("FN-001", "proj-123", { limit: INITIAL_LOAD_LIMIT });
      });
    });

    it("does not include projectId in URL when not provided", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 0, hasMore: false });

      renderHook(() => useMultiAgentLogs(["FN-001"]));

      await waitFor(() => {
        const urls = [...new Set(MockEventSource.instances.map((es) => es.url))];
        expect(urls).toContain("/api/tasks/FN-001/logs/stream");
      });
    });

    it("creates new EventSource when taskIds change with projectId", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 0, hasMore: false });

      const { rerender } = renderHook(
        ({ taskIds, projectId }: { taskIds: string[]; projectId?: string }) =>
          useMultiAgentLogs(taskIds, projectId),
        { initialProps: { taskIds: ["FN-001"], projectId: "proj-A" } },
      );

      await waitFor(() => {
        const urls = [...new Set(MockEventSource.instances.map((es) => es.url))];
        expect(urls).toContain("/api/tasks/FN-001/logs/stream?projectId=proj-A");
      });

      const initialCount = MockEventSource.instances.length;

      // Add a new taskId
      rerender({ taskIds: ["FN-001", "FN-002"], projectId: "proj-A" });

      // Wait for new connection
      await waitFor(() => {
        const urls = [...new Set(MockEventSource.instances.map((es) => es.url))];
        expect(urls).toContain("/api/tasks/FN-002/logs/stream?projectId=proj-A");
      });
      expect(MockEventSource.instances.length).toBeGreaterThan(initialCount);
    });

    it("fetches with correct projectId based on when effect runs", async () => {
      // This test verifies that projectId is used at the time the effect runs
      mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 0, hasMore: false });

      // Render with projectId proj-A
      const { result: result1 } = renderHook(
        ({ taskIds, projectId }: { taskIds: string[]; projectId?: string }) =>
          useMultiAgentLogs(taskIds, projectId),
        { initialProps: { taskIds: ["FN-001"], projectId: "proj-A" } },
      );

      // Wait for initial fetch
      await waitFor(() => {
        expect(result1.current["FN-001"]).toBeDefined();
      });

      // Capture calls made so far
      const initialCallCount = mockFetchAgentLogsWithMeta.mock.calls.length;

      // Create new hook instance with proj-B
      const { result: result2, rerender: rerender2 } = renderHook(
        ({ taskIds, projectId }: { taskIds: string[]; projectId?: string }) =>
          useMultiAgentLogs(taskIds, projectId),
        { initialProps: { taskIds: ["FN-001"], projectId: "proj-B" } },
      );

      // Wait for fetch
      await waitFor(() => {
        expect(result2.current["FN-001"]).toBeDefined();
      });

      // The new hook should have made a fetch with proj-B
      expect(mockFetchAgentLogsWithMeta.mock.calls.length).toBeGreaterThan(initialCallCount);
      const lastCall = mockFetchAgentLogsWithMeta.mock.calls.at(-1);
      expect(lastCall?.[1]).toBe("proj-B");
    });
  });

  /*
  FNXC:AgentLogResync 2026-07-26-17:45:
  Regression cover for the silent log gap on the MULTI-agent surface. `/api/tasks/:id/logs/stream`
  replays nothing on open, so every line emitted while the channel is down (SSE error, heartbeat
  timeout, or the hidden-tab suspend added for mobile tab retention) used to vanish from a list that
  still rendered as contiguous. useAgentLogs was fixed first; this hook subscribes to the SAME
  live-only channel and must hold the SAME invariant: after any reconnect the rendered list either
  contains the missed lines, in order and without duplicates, or shows an explicit gap marker.
  */
  describe("reconnect resync", () => {
    const logEntry = (minute: number, text: string) => ({
      timestamp: `2026-01-01T00:${String(minute).padStart(2, "0")}:00Z`,
      taskId: "FN-001",
      text,
      type: "text" as const,
    });

    /** Payload-less transport event; the sse-bus turns a channel's SECOND `open` into onReconnect. */
    function fireOpen(es: MockEventSource) {
      es._emit("open");
    }

    it("recovers lines emitted while the stream was suspended, in order and without duplicates", async () => {
      const history = [logEntry(0, "hist-1"), logEntry(1, "hist-2")];
      mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: history, total: 2, hasMore: false });

      const { result } = renderHook(() => useMultiAgentLogs(["FN-001"]));

      await waitFor(() => {
        expect(result.current["FN-001"].entries).toHaveLength(2);
      });

      const es = getConnection("FN-001")!;
      act(() => {
        fireOpen(es);
      });
      act(() => {
        es._emit("agent:log", logEntry(2, "live-3"));
      });
      expect(result.current["FN-001"].entries.map((entry) => entry.text)).toEqual([
        "hist-1",
        "hist-2",
        "live-3",
      ]);

      // Suspended: the server kept writing and the stream delivered none of it.
      mockFetchAgentLogsWithMeta.mockResolvedValue({
        entries: [...history, logEntry(2, "live-3"), logEntry(3, "missed-4"), logEntry(4, "missed-5")],
        total: 5,
        hasMore: false,
      });

      await act(async () => {
        fireOpen(es);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current["FN-001"].entries.map((entry) => entry.text)).toEqual([
          "hist-1",
          "hist-2",
          "live-3",
          "missed-4",
          "missed-5",
        ]);
      });
      expect(new Set(result.current["FN-001"].entries.map((entry) => entry.text)).size).toBe(5);
      expect(result.current["FN-001"].entries.some(isLogGapMarker)).toBe(false);
    });

    it("splices the reconnect page onto paged-back history instead of replacing the buffer", async () => {
      // 150 entries held (100 initial + one "load older" page). The reconnect page is the newest 100
      // plus 2 lines emitted while suspended; the 50 oldest must survive the merge.
      const all = Array.from({ length: 152 }, (_, index) => logEntry(index, `entry-${index}`));
      const held = all.slice(0, 150);
      mockFetchAgentLogsWithMeta.mockResolvedValue({
        entries: held.slice(50),
        total: 150,
        hasMore: true,
      });

      const { result } = renderHook(() => useMultiAgentLogs(["FN-001"]));

      await waitFor(() => {
        expect(result.current["FN-001"].entries).toHaveLength(100);
      });

      mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: held.slice(0, 50), total: 150, hasMore: false });
      await act(async () => {
        await result.current["FN-001"].loadMore();
      });

      await waitFor(() => {
        expect(result.current["FN-001"].entries).toHaveLength(150);
      });

      const es = getConnection("FN-001")!;
      act(() => {
        fireOpen(es);
      });

      mockFetchAgentLogsWithMeta.mockResolvedValue({
        entries: all.slice(52),
        total: 152,
        hasMore: true,
      });

      await act(async () => {
        fireOpen(es);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current["FN-001"].entries).toHaveLength(152);
      });
      const texts = result.current["FN-001"].entries.map((entry) => entry.text);
      expect(texts).toEqual(all.map((entry) => entry.text));
      expect(new Set(texts).size).toBe(152);
      expect(result.current["FN-001"].entries.some(isLogGapMarker)).toBe(false);
    });

    it("renders an explicit gap marker when the missed window exceeds one authoritative page", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValue({
        entries: [logEntry(0, "before-suspend")],
        total: 1,
        hasMore: false,
      });

      const { result } = renderHook(() => useMultiAgentLogs(["FN-001"]));

      await waitFor(() => {
        expect(result.current["FN-001"].entries).toHaveLength(1);
      });

      const es = getConnection("FN-001")!;
      act(() => {
        fireOpen(es);
      });

      // The newest page shares nothing with the buffer: more than one page was missed.
      const authoritativePage = Array.from({ length: INITIAL_LOAD_LIMIT }, (_, index) =>
        logEntry(index + 5, `missed-${index}`),
      );
      mockFetchAgentLogsWithMeta.mockResolvedValue({
        entries: authoritativePage,
        total: 401,
        hasMore: true,
      });

      await act(async () => {
        fireOpen(es);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current["FN-001"].entries).toHaveLength(INITIAL_LOAD_LIMIT + 1);
      });

      const entries = result.current["FN-001"].entries;
      expect(isLogGapMarker(entries[0])).toBe(true);
      expect(entries[0].text.length).toBeGreaterThan(0);
      expect(entries.slice(1).map((entry) => entry.text)).toEqual(
        authoritativePage.map((entry) => entry.text),
      );
      // The unreconcilable prefix is not silently glued onto a page it does not touch.
      expect(entries.some((entry) => entry.text === "before-suspend")).toBe(false);
      expect(result.current["FN-001"].hasMore).toBe(true);
    });

    it("does not duplicate a live entry that races the reconnect refetch", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: [], total: 0, hasMore: false });

      const { result } = renderHook(() => useMultiAgentLogs(["FN-001"]));

      await waitFor(() => {
        expect(result.current["FN-001"].loading).toBe(false);
      });

      const es = getConnection("FN-001")!;
      act(() => {
        fireOpen(es);
      });

      const raced = logEntry(1, "raced");
      let resolveResync: ((value: { entries: typeof raced[]; total: number; hasMore: boolean }) => void) | undefined;
      mockFetchAgentLogsWithMeta.mockImplementation(
        () => new Promise((resolve) => {
          resolveResync = resolve as typeof resolveResync;
        }),
      );

      act(() => {
        fireOpen(es);
      });
      // Arrives while the authoritative refetch is still in flight, and is also in that page.
      act(() => {
        es._emit("agent:log", raced);
      });

      await act(async () => {
        resolveResync?.({ entries: [logEntry(0, "hist-1"), raced], total: 2, hasMore: false });
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(result.current["FN-001"].entries.map((entry) => entry.text)).toEqual(["hist-1", "raced"]);
      });
    });

    it("pages older entries in below the gap marker and retires it", async () => {
      mockFetchAgentLogsWithMeta.mockResolvedValue({
        entries: [logEntry(0, "before-suspend")],
        total: 1,
        hasMore: false,
      });

      const { result } = renderHook(() => useMultiAgentLogs(["FN-001"]));

      await waitFor(() => {
        expect(result.current["FN-001"].entries).toHaveLength(1);
      });

      const es = getConnection("FN-001")!;
      act(() => {
        fireOpen(es);
      });

      const authoritativePage = [logEntry(9, "newest-1"), logEntry(10, "newest-2")];
      mockFetchAgentLogsWithMeta.mockResolvedValue({
        entries: authoritativePage,
        total: 12,
        hasMore: true,
      });

      await act(async () => {
        fireOpen(es);
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(isLogGapMarker(result.current["FN-001"].entries[0])).toBe(true);
      });

      const older = [logEntry(7, "older-1"), logEntry(8, "older-2")];
      mockFetchAgentLogsWithMeta.mockResolvedValue({ entries: older, total: 12, hasMore: false });

      await act(async () => {
        await result.current["FN-001"].loadMore();
      });

      await waitFor(() => {
        expect(result.current["FN-001"].entries.map((entry) => entry.text)).toEqual([
          "older-1",
          "older-2",
          "newest-1",
          "newest-2",
        ]);
      });
      // Offset must count REAL entries only; the client-only marker would shift the page by one.
      expect(mockFetchAgentLogsWithMeta).toHaveBeenLastCalledWith("FN-001", undefined, {
        limit: INITIAL_LOAD_LIMIT,
        offset: 2,
      });
      expect(result.current["FN-001"].entries.some(isLogGapMarker)).toBe(false);
      expect(result.current["FN-001"].hasMore).toBe(false);
    });
  });
});
