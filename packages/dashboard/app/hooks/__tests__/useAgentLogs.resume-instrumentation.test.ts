import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordResumeEvent = vi.fn();
const fetchAgentLogsWithMeta = vi.fn();

type SseHandlerSet = {
  url: string;
  onOpen?: () => void;
  onReconnect?: () => void;
  events?: Record<string, (event: { data: string }) => void>;
  unsubscribe: ReturnType<typeof vi.fn>;
};

const subscribeCalls: SseHandlerSet[] = [];

vi.mock("../../utils/resumeInstrumentation", () => ({
  recordResumeEvent,
}));

vi.mock("../../api", () => ({
  fetchAgentLogsWithMeta,
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: (
    url: string,
    handlers: {
      onOpen?: () => void;
      onReconnect?: () => void;
      events?: Record<string, (event: { data: string }) => void>;
    },
  ) => {
    const unsubscribe = vi.fn();
    subscribeCalls.push({
      url,
      onOpen: handlers.onOpen,
      onReconnect: handlers.onReconnect,
      events: handlers.events,
      unsubscribe,
    });
    return unsubscribe;
  },
}));

describe("useAgentLogs resume instrumentation", () => {
  beforeEach(() => {
    subscribeCalls.length = 0;
    recordResumeEvent.mockReset();
    fetchAgentLogsWithMeta.mockReset().mockResolvedValue({ entries: [], hasMore: false, total: 0 });
  });

  it("emits sse-open resume event", async () => {
    const { useAgentLogs } = await import("../useAgentLogs");

    renderHook(() => useAgentLogs("FN-123", true, "proj-1"));

    await waitFor(() => {
      expect(subscribeCalls[0]?.onOpen).toBeTypeOf("function");
    });

    act(() => {
      subscribeCalls[0]?.onOpen?.();
    });

    expect(recordResumeEvent).toHaveBeenCalledTimes(1);
    expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
      view: "useAgentLogs",
      trigger: "sse-open",
      projectId: "proj-1",
      replayAttempted: false,
      sseChannel: "/api/tasks/FN-123/logs/stream",
      detail: { taskId: "FN-123" },
    }));
  });

  it("emits sse-reconnect event and keeps agent:log handler reachable", async () => {
    const { useAgentLogs } = await import("../useAgentLogs");

    const { result } = renderHook(() => useAgentLogs("FN-123", true, "proj-1"));

    await waitFor(() => {
      expect(subscribeCalls[0]?.onReconnect).toBeTypeOf("function");
      expect(subscribeCalls[0]?.events?.["agent:log"]).toBeTypeOf("function");
    });

    act(() => {
      subscribeCalls[0]?.onReconnect?.();
    });

    expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
      view: "useAgentLogs",
      trigger: "sse-reconnect",
      projectId: "proj-1",
      /*
      FNXC:DashboardResume 2026-07-26-10:05:
      An SSE reconnect after the hidden-tab suspend now REFETCHES the authoritative log page and
      reconciles it with the buffer (useAgentLogs resyncFromServer), so the resume event honestly
      reports replayAttempted:true with the reason. It was false only while reconnect silently
      dropped whatever was emitted during the suspend window. Do not revert to false — that would
      re-assert the silent-log-gap behavior this fix removed.
      */
      replayAttempted: true,
      reason: "refetch-authoritative-log-page",
      sseChannel: "/api/tasks/FN-123/logs/stream",
      detail: { taskId: "FN-123" },
    }));

    act(() => {
      subscribeCalls[0]?.events?.["agent:log"]?.({
        data: JSON.stringify({
          timestamp: "2026-01-01T00:00:00Z",
          taskId: "FN-123",
          text: "live-log",
          type: "text",
        }),
      });
    });

    /*
    FNXC:DashboardResume 2026-07-26-10:08:
    The reconnect resync is async, and a live `agent:log` arriving while it is in flight is PARKED
    (pendingLiveRef) so the reconcile merges against a stable snapshot, then flushed after the merge.
    The entry is therefore delivered on a later microtask, not synchronously — await it rather than
    asserting on the same tick. The assertion itself is unchanged: the live line must still land, and
    exactly once.
    */
    await waitFor(() => {
      expect(result.current.entries.at(-1)?.text).toBe("live-log");
    });
    expect(result.current.entries.filter((entry) => entry.text === "live-log")).toHaveLength(1);
  });

  it("emits project-context-change and tears down prior subscription", async () => {
    const { useAgentLogs } = await import("../useAgentLogs");

    const { rerender } = renderHook(
      ({ projectId }) => useAgentLogs("FN-123", true, projectId),
      { initialProps: { projectId: "proj-a" } },
    );

    await waitFor(() => {
      expect(subscribeCalls).toHaveLength(1);
    });

    rerender({ projectId: "proj-b" });

    expect(subscribeCalls[0]?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(recordResumeEvent).toHaveBeenCalledWith(expect.objectContaining({
      view: "useAgentLogs",
      trigger: "project-context-change",
      projectId: "proj-b",
      replayAttempted: false,
      reason: "context-version-bumped",
      detail: { taskId: "FN-123" },
    }));
  });

  it("does not emit sse events when disabled", async () => {
    const { useAgentLogs } = await import("../useAgentLogs");

    renderHook(() => useAgentLogs("FN-123", false, "proj-1"));

    await Promise.resolve();

    expect(subscribeCalls).toHaveLength(0);
    expect(recordResumeEvent).not.toHaveBeenCalledWith(expect.objectContaining({ trigger: "sse-open" }));
    expect(recordResumeEvent).not.toHaveBeenCalledWith(expect.objectContaining({ trigger: "sse-reconnect" }));
  });
});
