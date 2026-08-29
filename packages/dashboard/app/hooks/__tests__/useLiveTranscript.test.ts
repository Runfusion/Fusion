import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useLiveTranscript } from "../useLiveTranscript";

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
});

afterEach(() => {
  // Close all instances
  for (const instance of MockEventSource.instances) {
    instance.close();
  }
  MockEventSource.instances = [];
  (globalThis as any).EventSource = originalEventSource;
});

describe("useLiveTranscript", () => {
  it("does not connect when taskId is undefined", () => {
    renderHook(() => useLiveTranscript(undefined));

    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("opens SSE connection when taskId is provided", async () => {
    renderHook(() => useLiveTranscript("FN-001"));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    expect(MockEventSource.instances[0].url).toBe("/api/tasks/FN-001/logs/stream");
  });

  it("includes projectId in EventSource URL when provided", async () => {
    renderHook(() => useLiveTranscript("FN-001", "proj-123"));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    expect(MockEventSource.instances[0].url).toBe("/api/tasks/FN-001/logs/stream?projectId=proj-123");
  });

  it("does not include projectId in URL when not provided", async () => {
    renderHook(() => useLiveTranscript("FN-001"));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    expect(MockEventSource.instances[0].url).toBe("/api/tasks/FN-001/logs/stream");
  });

  it("closes SSE connection on unmount", async () => {
    const { unmount } = renderHook(() => useLiveTranscript("FN-001"));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const es = MockEventSource.instances[0];
    unmount();

    expect(es.close).toHaveBeenCalled();
  });

  it("appends SSE entries to transcript", async () => {
    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es._emit("agent:log", {
        type: "text",
        text: "Hello, world!",
        timestamp: "2026-01-01T00:01:00Z",
      });
    });

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
      expect(result.current.entries[0].text).toBe("Hello, world!");
    });
  });

  it("handles legacy content field as fallback", async () => {
    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const es = MockEventSource.instances[0];
    act(() => {
      es._emit("agent:log", {
        type: "text",
        content: "Legacy content",
        timestamp: "2026-01-01T00:01:00Z",
      });
    });

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
      expect(result.current.entries[0].text).toBe("Legacy content");
    });
  });

  it("updates isConnected state based on SSE connection", async () => {
    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    // isConnected starts as false; it's updated when SSE emits open/error events
    expect(result.current.isConnected).toBe(false);

    // Simulate SSE open event
    const es = MockEventSource.instances[0];
    act(() => {
      es._emit("open", {});
    });

    await waitFor(() => {
      expect(result.current.isConnected).toBe(true);
    });
  });

  it("skips malformed SSE events", async () => {
    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const es = MockEventSource.instances[0];
    act(() => {
      // Directly call the listener with malformed data (bypasses JSON.stringify)
      const handler = es.listeners["agent:log"][0];
      handler({ data: "{ invalid json" }); // Invalid JSON - missing closing brace
    });

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(0);
    });
  });

  it("handles valid JSON without text field gracefully", async () => {
    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    await waitFor(() => {
      expect(MockEventSource.instances).toHaveLength(1);
    });

    const es = MockEventSource.instances[0];
    act(() => {
      // Valid JSON but missing text/content fields
      es._emit("agent:log", { type: "text" });
    });

    await waitFor(() => {
      // Entry is added but with empty text (graceful degradation)
      expect(result.current.entries).toHaveLength(1);
      expect(result.current.entries[0].text).toBe("");
    });
  });

  describe("project context isolation", () => {
    it("clears entries immediately when projectId changes", async () => {
      const { result, rerender } = renderHook(
        ({ projectId }) => useLiveTranscript("FN-001", projectId),
        { initialProps: { projectId: "proj-A" } },
      );

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      // Add some entries
      const es = MockEventSource.instances[0];
      act(() => {
        es._emit("agent:log", {
          type: "text",
          text: "proj-A entry",
          timestamp: "2026-01-01T00:01:00Z",
        });
      });

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(1);
        expect(result.current.entries[0].text).toBe("proj-A entry");
      });

      // Switch to proj-B
      rerender({ projectId: "proj-B" });

      // Entries should be cleared immediately after project switch
      await waitFor(() => {
        expect(result.current.entries).toHaveLength(0);
      });
    });

    it("creates new connection with correct projectId on project switch", async () => {
      const { rerender } = renderHook(
        ({ projectId }) => useLiveTranscript("FN-001", projectId),
        { initialProps: { projectId: "proj-A" } },
      );

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      const initialEs = MockEventSource.instances[0];
      expect(initialEs.url).toContain("proj-A");

      // Switch to proj-B
      rerender({ projectId: "proj-B" });

      // Wait for new connection
      await waitFor(() => {
        // Old connection closed, new one opened
        expect(initialEs.close).toHaveBeenCalled();
        const newConnections = MockEventSource.instances.filter(
          es => es.url.includes("proj-B")
        );
        expect(newConnections.length).toBe(1);
        expect(newConnections[0].url).toBe("/api/tasks/FN-001/logs/stream?projectId=proj-B");
      });
    });

    it("rejects stale SSE events after project switch", async () => {
      const { result, rerender } = renderHook(
        ({ projectId }) => useLiveTranscript("FN-001", projectId),
        { initialProps: { projectId: "proj-A" } },
      );

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      const es = MockEventSource.instances[0];

      // Switch to proj-B
      rerender({ projectId: "proj-B" });

      // Wait for entries to be cleared
      await waitFor(() => {
        expect(result.current.entries).toHaveLength(0);
      });

      // Emit event on old connection (should be ignored)
      act(() => {
        es._emit("agent:log", {
          type: "text",
          text: "stale-event",
          timestamp: "2026-01-01T00:01:00Z",
        });
      });

      // Stale event should not appear
      expect(result.current.entries.find(e => e.text === "stale-event")).toBeUndefined();
    });

    it("clears entries immediately when taskId changes", async () => {
      const { result, rerender } = renderHook(
        ({ taskId }) => useLiveTranscript(taskId, "proj-A"),
        { initialProps: { taskId: "FN-001" } },
      );

      await waitFor(() => {
        expect(MockEventSource.instances).toHaveLength(1);
      });

      // Add some entries
      const es = MockEventSource.instances[0];
      act(() => {
        es._emit("agent:log", {
          type: "text",
          text: "FN-001 entry",
          timestamp: "2026-01-01T00:01:00Z",
        });
      });

      await waitFor(() => {
        expect(result.current.entries).toHaveLength(1);
      });

      // Switch to different task
      rerender({ taskId: "FN-002" });

      // Entries should be cleared immediately after task switch
      await waitFor(() => {
        expect(result.current.entries).toHaveLength(0);
      });
    });
  });
});
