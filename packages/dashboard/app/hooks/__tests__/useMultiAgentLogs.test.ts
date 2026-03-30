import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MAX_LOG_ENTRIES, useMultiAgentLogs } from "../useMultiAgentLogs";
import { fetchAgentLogs } from "../../api";

// Mock the api module
vi.mock("../../api", () => ({
  fetchAgentLogs: vi.fn().mockResolvedValue([]),
}));

const mockFetchAgentLogs = vi.mocked(fetchAgentLogs);

// Mock EventSource - track instances per hook render, not globally
class MockEventSource {
  url: string;
  listeners: Record<string, ((e: { data: string }) => void)[]> = {};
  readyState = 0;
  close = vi.fn(() => {
    this.readyState = 2;
  });

  constructor(url: string) {
    this.url = url;
    this.readyState = 1;
  }

  addEventListener(event: string, fn: (e: { data: string }) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  removeEventListener(event: string, fn: (e: { data: string }) => void) {
    this.listeners[event] = (this.listeners[event] || []).filter((listener) => listener !== fn);
  }

  // Helper to simulate a server event
  _emit(event: string, data?: unknown) {
    for (const fn of this.listeners[event] || []) {
      fn(data === undefined ? ({ } as { data: string }) : { data: JSON.stringify(data) });
    }
  }
}

const originalEventSource = globalThis.EventSource;

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
  mockFetchAgentLogs.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
});

function getActiveConnections(): MockEventSource[] {
  // Get all MockEventSource instances that haven't been closed
  // We need to track this ourselves since the mock is recreated each time
  const allSources: MockEventSource[] = [];
  
  // Hook into the constructor to track instances
  const OriginalMock = MockEventSource;
  const instances: MockEventSource[] = [];
  
  // Override to capture instances
  (globalThis as unknown as Record<string, unknown>).EventSource = class extends MockEventSource {
    constructor(url: string) {
      super(url);
      instances.push(this);
    }
  };
  
  return instances;
}

describe("useMultiAgentLogs", () => {
  it("initializes with empty entries for all provided task IDs", () => {
    const { result } = renderHook(() => useMultiAgentLogs(["KB-001", "KB-002"]));

    expect(result.current["KB-001"]).toBeDefined();
    expect(result.current["KB-001"].entries).toEqual([]);
    expect(result.current["KB-001"].loading).toBe(true);
    
    expect(result.current["KB-002"]).toBeDefined();
    expect(result.current["KB-002"].entries).toEqual([]);
    expect(result.current["KB-002"].loading).toBe(true);
  });

  it("returns empty object when no task IDs provided", () => {
    const { result } = renderHook(() => useMultiAgentLogs([]));

    expect(Object.keys(result.current)).toHaveLength(0);
  });

  it("fetches historical logs for each task on mount", async () => {
    const logs1 = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "KB-001", text: "log1", type: "text" as const },
    ];
    const logs2 = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "KB-002", text: "log2", type: "text" as const },
    ];
    
    mockFetchAgentLogs.mockImplementation((taskId) => {
      if (taskId === "KB-001") return Promise.resolve(logs1);
      if (taskId === "KB-002") return Promise.resolve(logs2);
      return Promise.resolve([]);
    });

    const { result } = renderHook(() => useMultiAgentLogs(["KB-001", "KB-002"]));

    await waitFor(() => {
      expect(result.current["KB-001"].entries).toEqual(logs1);
      expect(result.current["KB-002"].entries).toEqual(logs2);
    });

    expect(mockFetchAgentLogs).toHaveBeenCalledWith("KB-001");
    expect(mockFetchAgentLogs).toHaveBeenCalledWith("KB-002");
  });

  it("opens SSE EventSource for each task ID", async () => {
    mockFetchAgentLogs.mockResolvedValue([]);

    const instances: MockEventSource[] = [];
    
    // Override to capture instances
    (globalThis as unknown as Record<string, unknown>).EventSource = class extends MockEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    };

    renderHook(() => useMultiAgentLogs(["KB-001", "KB-002"]));

    await waitFor(() => {
      // Filter to unique URLs (Strict Mode may create duplicates)
      const urls = [...new Set(instances.map((es) => es.url))];
      expect(urls).toContain("/api/tasks/KB-001/logs/stream");
      expect(urls).toContain("/api/tasks/KB-002/logs/stream");
    });
  });

  it("merges live SSE events with historical entries", async () => {
    const historical = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "KB-001", text: "old", type: "text" as const },
    ];
    // Use mockResolvedValue (not Once) to handle Strict Mode double-run
    mockFetchAgentLogs.mockResolvedValue(historical);

    const instances: MockEventSource[] = [];
    (globalThis as unknown as Record<string, unknown>).EventSource = class extends MockEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    };

    const { result } = renderHook(() => useMultiAgentLogs(["KB-001"]));

    await waitFor(() => {
      expect(result.current["KB-001"].entries).toHaveLength(1);
    });

    const es = instances.find((e) => e.url.includes("KB-001"));
    expect(es).toBeDefined();

    act(() => {
      es!._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "KB-001",
        text: "new",
        type: "text",
      });
    });

    await waitFor(() => {
      expect(result.current["KB-001"].entries).toHaveLength(2);
    });

    expect(result.current["KB-001"].entries[1].text).toBe("new");
  });

  it("closes all SSE connections on unmount (memory leak prevention)", async () => {
    mockFetchAgentLogs.mockResolvedValue([]);

    const instances: MockEventSource[] = [];
    (globalThis as unknown as Record<string, unknown>).EventSource = class extends MockEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    };

    const { unmount } = renderHook(() => useMultiAgentLogs(["KB-001", "KB-002"]));

    // Wait for connections to be established
    await waitFor(() => {
      expect(instances.length).toBeGreaterThanOrEqual(2);
    });

    // Get unique instances by URL (handling Strict Mode duplicates)
    const uniqueByUrl = new Map<string, MockEventSource>();
    for (const es of instances) {
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
    mockFetchAgentLogs.mockResolvedValue([]);

    const instances: MockEventSource[] = [];
    (globalThis as unknown as Record<string, unknown>).EventSource = class extends MockEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    };

    const { rerender } = renderHook(
      ({ taskIds }: { taskIds: string[] }) => useMultiAgentLogs(taskIds),
      { initialProps: { taskIds: ["KB-001", "KB-002"] } },
    );

    await waitFor(() => {
      expect(instances.length).toBeGreaterThanOrEqual(2);
    });

    // Get the last connection for each URL
    const getConnection = (taskId: string) => {
      const url = `/api/tasks/${taskId}/logs/stream`;
      const matching = instances.filter((e) => e.url === url);
      return matching[matching.length - 1];
    };

    const es1 = getConnection("KB-001");
    const es2 = getConnection("KB-002");

    rerender({ taskIds: ["KB-001"] });

    await waitFor(() => {
      expect(es2.close).toHaveBeenCalled();
    });

    expect(es1.close).not.toHaveBeenCalled();
  });

  it("opens new connection when task ID added to array", async () => {
    mockFetchAgentLogs.mockResolvedValue([]);

    const instances: MockEventSource[] = [];
    (globalThis as unknown as Record<string, unknown>).EventSource = class extends MockEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    };

    const { rerender } = renderHook(
      ({ taskIds }: { taskIds: string[] }) => useMultiAgentLogs(taskIds),
      { initialProps: { taskIds: ["KB-001"] } },
    );

    await waitFor(() => {
      expect(instances.length).toBeGreaterThanOrEqual(1);
    });

    rerender({ taskIds: ["KB-001", "KB-002"] });

    await waitFor(() => {
      const urls = [...new Set(instances.map((es) => es.url))];
      expect(urls).toContain("/api/tasks/KB-002/logs/stream");
    });
  });

  it("provides per-task clear function that resets entries", async () => {
    const logs = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "KB-001", text: "log1", type: "text" as const },
      { timestamp: "2026-01-01T00:01:00Z", taskId: "KB-001", text: "log2", type: "text" as const },
    ];
    // Use mockResolvedValue (not Once) to handle Strict Mode double-run
    mockFetchAgentLogs.mockResolvedValue(logs);

    const { result } = renderHook(() => useMultiAgentLogs(["KB-001", "KB-002"]));

    await waitFor(() => {
      expect(result.current["KB-001"].entries).toHaveLength(2);
    });

    // Clear only KB-001
    act(() => {
      result.current["KB-001"].clear();
    });

    await waitFor(() => {
      expect(result.current["KB-001"].entries).toHaveLength(0);
    });
  });

  it("handles errors gracefully when fetching historical logs", async () => {
    mockFetchAgentLogs.mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useMultiAgentLogs(["KB-001"]));

    await waitFor(() => {
      expect(result.current["KB-001"].loading).toBe(false);
    });

    expect(result.current["KB-001"].entries).toEqual([]);
  });

  it("does not create duplicate connections while historical fetch is still pending", async () => {
    let resolveFetch: ((value: never[]) => void) | undefined;
    mockFetchAgentLogs.mockImplementation(
      () => new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const instances: MockEventSource[] = [];
    (globalThis as unknown as Record<string, unknown>).EventSource = class extends MockEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    };

    const { rerender } = renderHook(
      ({ taskIds }: { taskIds: string[] }) => useMultiAgentLogs(taskIds),
      { initialProps: { taskIds: ["KB-001"] } },
    );

    await waitFor(() => {
      expect(instances.filter((es) => es.url === "/api/tasks/KB-001/logs/stream")).toHaveLength(1);
    });

    rerender({ taskIds: ["KB-001"] });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(instances.filter((es) => es.url === "/api/tasks/KB-001/logs/stream")).toHaveLength(1);

    resolveFetch?.([]);

    await waitFor(() => {
      expect(mockFetchAgentLogs).toHaveBeenCalledTimes(1);
    });
  });

  it("closes a task connection when its stream emits an error", async () => {
    mockFetchAgentLogs.mockResolvedValue([]);

    const instances: MockEventSource[] = [];
    (globalThis as unknown as Record<string, unknown>).EventSource = class extends MockEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    };

    renderHook(() => useMultiAgentLogs(["KB-001"]));

    await waitFor(() => {
      expect(instances).toHaveLength(1);
    });

    const es = instances[0];

    act(() => {
      es._emit("error");
    });

    expect(es.close).toHaveBeenCalledTimes(1);
  });

  it("truncates oversized historical logs per task to the most recent entries", async () => {
    const oversized = Array.from({ length: MAX_LOG_ENTRIES + 10 }, (_, index) => ({
      timestamp: `2026-01-01T00:${String(index).padStart(2, "0")}:00Z`,
      taskId: "KB-001",
      text: `entry-${index}`,
      type: "text" as const,
    }));

    mockFetchAgentLogs.mockResolvedValue(oversized);

    const { result } = renderHook(() => useMultiAgentLogs(["KB-001"]));

    await waitFor(() => {
      expect(result.current["KB-001"].entries).toHaveLength(MAX_LOG_ENTRIES);
    });

    expect(result.current["KB-001"].entries[0].text).toBe("entry-10");
    expect(result.current["KB-001"].entries.at(-1)?.text).toBe(`entry-${MAX_LOG_ENTRIES + 9}`);
  });

  it("preserves streamed entries that arrive before historical fetch resolves", async () => {
    let resolveFetch: ((value: Array<{ timestamp: string; taskId: string; text: string; type: "text" }>) => void) | undefined;
    mockFetchAgentLogs.mockImplementation(
      () => new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const instances: MockEventSource[] = [];
    (globalThis as unknown as Record<string, unknown>).EventSource = class extends MockEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    };

    const { result } = renderHook(() => useMultiAgentLogs(["KB-001"]));

    await waitFor(() => {
      expect(instances).toHaveLength(1);
    });

    act(() => {
      instances[0]._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "KB-001",
        text: "live-before-history",
        type: "text",
      });
    });

    act(() => {
      resolveFetch?.([
        {
          timestamp: "2026-01-01T00:00:00Z",
          taskId: "KB-001",
          text: "historical",
          type: "text",
        },
      ]);
    });

    await waitFor(() => {
      expect(result.current["KB-001"].entries).toHaveLength(2);
    });

    expect(result.current["KB-001"].entries[0].text).toBe("historical");
    expect(result.current["KB-001"].entries[1].text).toBe("live-before-history");
  });

  it("truncates live SSE entries per task to the most recent entries", async () => {
    mockFetchAgentLogs.mockResolvedValue([]);

    const instances: MockEventSource[] = [];
    (globalThis as unknown as Record<string, unknown>).EventSource = class extends MockEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    };

    const { result } = renderHook(() => useMultiAgentLogs(["KB-001"]));

    await waitFor(() => {
      expect(instances).toHaveLength(1);
    });

    act(() => {
      for (let index = 0; index < MAX_LOG_ENTRIES + 15; index++) {
        instances[0]._emit("agent:log", {
          timestamp: `2026-01-01T00:${String(index).padStart(2, "0")}:00Z`,
          taskId: "KB-001",
          text: `live-${index}`,
          type: "text",
        });
      }
    });

    await waitFor(() => {
      expect(result.current["KB-001"].entries).toHaveLength(MAX_LOG_ENTRIES);
    });

    expect(result.current["KB-001"].entries[0].text).toBe("live-15");
    expect(result.current["KB-001"].entries.at(-1)?.text).toBe(`live-${MAX_LOG_ENTRIES + 14}`);
  });

  it("handles SSE events for multiple tasks independently", async () => {
    const logs1 = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "KB-001", text: "task1-old", type: "text" as const },
    ];
    const logs2 = [
      { timestamp: "2026-01-01T00:00:00Z", taskId: "KB-002", text: "task2-old", type: "text" as const },
    ];
    
    mockFetchAgentLogs.mockImplementation((taskId) => {
      if (taskId === "KB-001") return Promise.resolve(logs1);
      if (taskId === "KB-002") return Promise.resolve(logs2);
      return Promise.resolve([]);
    });

    const instances: MockEventSource[] = [];
    (globalThis as unknown as Record<string, unknown>).EventSource = class extends MockEventSource {
      constructor(url: string) {
        super(url);
        instances.push(this);
      }
    };

    const { result } = renderHook(() => useMultiAgentLogs(["KB-001", "KB-002"]));

    await waitFor(() => {
      expect(result.current["KB-001"].entries).toHaveLength(1);
      expect(result.current["KB-002"].entries).toHaveLength(1);
    });

    // Get the last connection for each URL
    const getConnection = (taskId: string) => {
      const url = `/api/tasks/${taskId}/logs/stream`;
      const matching = instances.filter((e) => e.url === url);
      return matching[matching.length - 1];
    };

    const es1 = getConnection("KB-001");
    const es2 = getConnection("KB-002");
    expect(es1).toBeDefined();
    expect(es2).toBeDefined();

    act(() => {
      es1._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "KB-001",
        text: "task1-new",
        type: "text",
      });
    });

    await waitFor(() => {
      expect(result.current["KB-001"].entries).toHaveLength(2);
      expect(result.current["KB-002"].entries).toHaveLength(1);
    });

    act(() => {
      es2._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "KB-002",
        text: "task2-new",
        type: "text",
      });
    });

    await waitFor(() => {
      expect(result.current["KB-001"].entries).toHaveLength(2);
      expect(result.current["KB-002"].entries).toHaveLength(2);
    });

    expect(result.current["KB-001"].entries[1].text).toBe("task1-new");
    expect(result.current["KB-002"].entries[1].text).toBe("task2-new");
  });
});
