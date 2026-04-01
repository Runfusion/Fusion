import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MAX_LOG_ENTRIES, useAgentLogs } from "../useAgentLogs";
import { fetchAgentLogs } from "../../api";

// Mock the api module
vi.mock("../../api", () => ({
  fetchAgentLogs: vi.fn().mockResolvedValue([]),
}));

const mockFetchAgentLogs = vi.mocked(fetchAgentLogs);

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
}

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as any).EventSource = MockEventSource;
  mockFetchAgentLogs.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  (globalThis as any).EventSource = originalEventSource;
});

describe("useAgentLogs", () => {
  it("does not fetch or connect when enabled=false", () => {
    const { result } = renderHook(() => useAgentLogs("FN-001", false));

    expect(mockFetchAgentLogs).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);
    expect(result.current.entries).toEqual([]);
  });

  it("fetches historical logs and opens SSE when enabled=true", async () => {
    const historicalLogs = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "old", type: "text" as const },
    ];
    mockFetchAgentLogs.mockResolvedValueOnce(historicalLogs);

    const { result } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(result.current.entries).toEqual(historicalLogs);
    });

    expect(mockFetchAgentLogs).toHaveBeenCalledWith("FN-001");
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe("/api/tasks/KB-001/logs/stream");
  });

  it("appends live SSE entries to historical entries", async () => {
    mockFetchAgentLogs.mockResolvedValueOnce([
      { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "old", type: "text" as const },
    ]);

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

  it("closes SSE when enabled changes to false", async () => {
    mockFetchAgentLogs.mockResolvedValueOnce([]);

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
    mockFetchAgentLogs.mockResolvedValueOnce([]);

    const { unmount } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const es = MockEventSource.instances[0];

    unmount();

    expect(es.close).toHaveBeenCalled();
  });

  it("truncates oversized historical logs to the most recent entries", async () => {
    const historicalLogs = Array.from({ length: MAX_LOG_ENTRIES + 25 }, (_, index) => ({
      timestamp: `2026-01-01T00:${String(index).padStart(2, "0")}:00Z`,
      taskId: "FN-001",
      text: `entry-${index}`,
      type: "text" as const,
    }));
    mockFetchAgentLogs.mockResolvedValueOnce(historicalLogs);

    const { result } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(MAX_LOG_ENTRIES);
    });

    expect(result.current.entries[0].text).toBe("entry-25");
    expect(result.current.entries.at(-1)?.text).toBe(`entry-${MAX_LOG_ENTRIES + 24}`);
  });

  it("truncates live SSE entries to the most recent entries", async () => {
    mockFetchAgentLogs.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useAgentLogs("FN-001", true));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const es = MockEventSource.instances[0];
    act(() => {
      for (let index = 0; index < MAX_LOG_ENTRIES + 20; index++) {
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

    expect(result.current.entries[0].text).toBe("live-20");
    expect(result.current.entries.at(-1)?.text).toBe(`live-${MAX_LOG_ENTRIES + 19}`);
  });

  it("does not fetch when taskId is null", () => {
    renderHook(() => useAgentLogs(null, true));

    expect(mockFetchAgentLogs).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
