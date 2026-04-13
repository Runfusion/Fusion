import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useLiveTranscript } from "../useLiveTranscript";

// Mock EventSource is provided by vitest.setup.ts

describe("useLiveTranscript", () => {
  beforeEach(() => {
    // Reset mock instances between tests
    vi.clearAllMocks();
  });

  it("renders entries with canonical `text` field from SSE", async () => {
    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(0);
    });

    // Simulate SSE event with `text` field (matching AgentLogEntry)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es = (globalThis as any).EventSource;
    const instance = es.instances[0];
    act(() => {
      instance._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "FN-001",
        text: "Hello from agent",
        type: "text",
      });
    });

    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].text).toBe("Hello from agent");
  });

  it("normalizes legacy `content` field to `text` for backward compatibility", async () => {
    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(0);
    });

    // Simulate legacy SSE event with `content` field instead of `text`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es = (globalThis as any).EventSource;
    const instance = es.instances[0];
    act(() => {
      instance._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "FN-001",
        content: "Legacy content text",
        type: "text",
      });
    });

    expect(result.current.entries).toHaveLength(1);
    // Legacy `content` should be normalized to `text`
    expect(result.current.entries[0].text).toBe("Legacy content text");
  });

  it("prefers `text` over `content` when both are present", async () => {
    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(0);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es = (globalThis as any).EventSource;
    const instance = es.instances[0];
    act(() => {
      instance._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "FN-001",
        text: "Primary text",
        content: "Legacy content",
        type: "text",
      });
    });

    expect(result.current.entries).toHaveLength(1);
    // `text` takes precedence
    expect(result.current.entries[0].text).toBe("Primary text");
    // Original `content` is preserved for reference
    expect(result.current.entries[0].content).toBe("Legacy content");
  });

  it("includes projectId in stream URL when provided", async () => {
    renderHook(() => useLiveTranscript("FN-001", "project-abc"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es = (globalThis as any).EventSource;
    expect(es.instances).toHaveLength(1);
    expect(es.instances[0].url).toContain("projectId=project-abc");
  });

  it("does not include projectId in URL when not provided", async () => {
    renderHook(() => useLiveTranscript("FN-001"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es = (globalThis as any).EventSource;
    expect(es.instances).toHaveLength(1);
    expect(es.instances[0].url).not.toContain("projectId");
  });

  it("clears entries when taskId is undefined", async () => {
    const { result, rerender } = renderHook(
      ({ taskId }) => useLiveTranscript(taskId),
      { initialProps: { taskId: "FN-001" as string | undefined } }
    );

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(0);
    });

    // Add an entry first
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es = (globalThis as any).EventSource;
    const instance = es.instances[0];
    act(() => {
      instance._emit("agent:log", {
        timestamp: "2026-01-01T00:01:00Z",
        taskId: "FN-001",
        text: "Some text",
        type: "text",
      });
    });

    expect(result.current.entries).toHaveLength(1);

    // Now clear the taskId
    rerender({ taskId: undefined });

    expect(result.current.entries).toHaveLength(0);
  });

  it("closes EventSource on unmount", async () => {
    const { unmount } = renderHook(() => useLiveTranscript("FN-001"));

    await waitFor(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((globalThis as any).EventSource.instances).toHaveLength(1);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es = (globalThis as any).EventSource;
    const instance = es.instances[0];
    const closeSpy = vi.spyOn(instance, "close");

    unmount();

    expect(closeSpy).toHaveBeenCalled();
  });

  it("sets isConnected to true on SSE open", async () => {
    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    expect(result.current.isConnected).toBe(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es = (globalThis as any).EventSource;
    const instance = es.instances[0];

    act(() => {
      instance._emit("open");
    });

    expect(result.current.isConnected).toBe(true);
  });

  it("skips malformed SSE events without crashing", async () => {
    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(0);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es = (globalThis as any).EventSource;
    const instance = es.instances[0];

    // Send malformed JSON
    act(() => {
      instance._emit("agent:log", null);
    });

    // Should not crash, entries should remain empty
    expect(result.current.entries).toHaveLength(0);
  });

  it("preserves timestamp and type fields from SSE payload", async () => {
    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(0);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es = (globalThis as any).EventSource;
    const instance = es.instances[0];
    act(() => {
      instance._emit("agent:log", {
        timestamp: "2026-01-01T12:00:00Z",
        taskId: "FN-001",
        text: "Thinking...",
        type: "thinking",
      });
    });

    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].timestamp).toBe("2026-01-01T12:00:00Z");
    expect(result.current.entries[0].type).toBe("thinking");
    expect(result.current.entries[0].text).toBe("Thinking...");
  });
});
