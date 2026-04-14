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

    expect(mockFetchAgentLogs).toHaveBeenCalledWith("FN-001", undefined, { limit: 500 });
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe("/api/tasks/FN-001/logs/stream");
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

  it("preserves long text and detail in historical log entries without truncation", async () => {
    const longText = "A".repeat(5000);
    const longDetail = "B".repeat(5000);
    mockFetchAgentLogs.mockResolvedValueOnce([
      { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: longText, type: "text" as const },
      { timestamp: "2026-01-01T00:00:01Z", taskId: "FN-001", text: "Read", type: "tool" as const, detail: longDetail },
    ]);

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
    mockFetchAgentLogs.mockResolvedValueOnce([]);

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

  describe("projectId support", () => {
    it("includes projectId in EventSource URL when provided", async () => {
      mockFetchAgentLogs.mockResolvedValueOnce([]);

      renderHook(() => useAgentLogs("FN-001", true, "proj-123"));

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
        expect(MockEventSource.instances[0].url).toBe("/api/tasks/FN-001/logs/stream?projectId=proj-123");
      });
    });

    it("includes projectId in fetchAgentLogs call when provided", async () => {
      mockFetchAgentLogs.mockResolvedValueOnce([]);

      renderHook(() => useAgentLogs("FN-001", true, "proj-123"));

      await waitFor(() => {
        expect(mockFetchAgentLogs).toHaveBeenCalledWith("FN-001", "proj-123", { limit: 500 });
      });
    });

    it("does not include projectId in URL when not provided", async () => {
      mockFetchAgentLogs.mockResolvedValueOnce([]);

      renderHook(() => useAgentLogs("FN-001", true));

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
        expect(MockEventSource.instances[0].url).toBe("/api/tasks/FN-001/logs/stream");
      });
    });

    it("clears entries immediately when projectId changes", async () => {
      // Set up mock to return different values based on projectId
      mockFetchAgentLogs.mockImplementation((_taskId: string, projectId?: string) => {
        if (projectId === "proj-A") {
          return Promise.resolve([
            { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "proj-A-log", type: "text" as const },
          ]);
        }
        if (projectId === "proj-B") {
          return Promise.resolve([
            { timestamp: "2026-01-01T00:00:00Z", taskId: "FN-001", text: "proj-B-log", type: "text" as const },
          ]);
        }
        return Promise.resolve([]);
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
      mockFetchAgentLogs.mockResolvedValue([]);

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
      mockFetchAgentLogs.mockResolvedValue([]);

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
