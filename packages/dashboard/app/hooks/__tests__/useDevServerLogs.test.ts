import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_LOG_ENTRIES, useDevServerLogs } from "../useDevServerLogs";
import { fetchDevServerLogHistory, getDevServerLogsStreamUrl } from "../../api";
import { subscribeSse } from "../../sse-bus";

vi.mock("../../api", () => ({
  fetchDevServerLogHistory: vi.fn().mockResolvedValue({ lines: [], totalLines: 0 }),
  getDevServerLogsStreamUrl: vi.fn((projectId?: string) =>
    projectId
      ? `/api/dev-server/logs/stream?projectId=${encodeURIComponent(projectId)}`
      : "/api/dev-server/logs/stream"
  ),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn(),
}));

const mockFetchDevServerLogHistory = vi.mocked(fetchDevServerLogHistory);
const mockGetDevServerLogsStreamUrl = vi.mocked(getDevServerLogsStreamUrl);
const mockSubscribeSse = vi.mocked(subscribeSse);

type SubscriptionRecord = {
  url: string;
  options: {
    events?: Record<string, (event: MessageEvent) => void>;
    onReconnect?: () => void;
  };
  unsubscribe: ReturnType<typeof vi.fn>;
};

const subscriptions: SubscriptionRecord[] = [];

function emit(subscription: SubscriptionRecord, eventName: string, payload: unknown): void {
  const handler = subscription.options.events?.[eventName];
  if (!handler) {
    throw new Error(`No handler registered for event: ${eventName}`);
  }

  act(() => {
    handler({ data: JSON.stringify(payload) } as MessageEvent);
  });
}

beforeEach(() => {
  subscriptions.length = 0;
  vi.clearAllMocks();

  mockFetchDevServerLogHistory.mockResolvedValue({ lines: [], totalLines: 0 });

  mockSubscribeSse.mockImplementation((url, options = {}) => {
    const unsubscribe = vi.fn();
    subscriptions.push({
      url,
      options,
      unsubscribe,
    });
    return unsubscribe;
  });
});

describe("useDevServerLogs", () => {
  it("loads initial history on mount when enabled", async () => {
    mockFetchDevServerLogHistory.mockResolvedValueOnce({
      lines: [{ id: 1, text: "Server started", stream: "stdout", timestamp: "2026-04-19T10:30:00Z" }],
      totalLines: 1,
    });

    const { result } = renderHook(() => useDevServerLogs("proj-1", true));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
      expect(result.current.entries[0]?.text).toBe("Server started");
    });

    expect(result.current.total).toBe(1);
    expect(result.current.hasMore).toBe(false);
    expect(mockFetchDevServerLogHistory).toHaveBeenCalledWith({ maxLines: 100 }, "proj-1");
    expect(mockGetDevServerLogsStreamUrl).toHaveBeenCalledWith("proj-1");
  });

  it("subscribes to SSE stream and appends live entries", async () => {
    mockFetchDevServerLogHistory.mockResolvedValueOnce({
      lines: [{ id: 1, text: "Boot", stream: "stdout", timestamp: "2026-04-19T10:30:00Z" }],
      totalLines: 1,
    });

    const { result } = renderHook(() => useDevServerLogs("proj-1", true));

    await waitFor(() => {
      expect(subscriptions).toHaveLength(1);
    });

    const sub = subscriptions[0]!;
    expect(sub.url).toContain("/api/dev-server/logs/stream");

    emit(sub, "dev-server:log", {
      id: 2,
      text: "Compiled successfully",
      stream: "stdout",
      timestamp: "2026-04-19T10:31:00Z",
    });

    emit(sub, "log", {
      line: "Legacy log line",
      stream: "stderr",
      timestamp: "2026-04-19T10:31:01Z",
    });

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.text)).toEqual([
        "Boot",
        "Compiled successfully",
        "Legacy log line",
      ]);
    });

    expect(result.current.entries[2]?.stream).toBe("stderr");
  });

  it("handles history SSE events for legacy string payloads", async () => {
    const { result } = renderHook(() => useDevServerLogs("proj-legacy", true));

    await waitFor(() => {
      expect(subscriptions).toHaveLength(1);
    });

    emit(subscriptions[0]!, "history", { lines: ["line 1", "line 2"] });

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2);
    });

    expect(result.current.entries[0]).toMatchObject({ id: 1, text: "line 1", stream: "stdout" });
    expect(result.current.entries[1]).toMatchObject({ id: 2, text: "line 2", stream: "stdout" });
  });

  it("caps entries at MAX_LOG_ENTRIES", async () => {
    const initial = Array.from({ length: MAX_LOG_ENTRIES }, (_, index) => ({
      id: index + 1,
      text: `line-${index + 1}`,
      stream: "stdout" as const,
      timestamp: "",
    }));

    mockFetchDevServerLogHistory.mockResolvedValueOnce({
      lines: initial,
      totalLines: MAX_LOG_ENTRIES,
    });

    const { result } = renderHook(() => useDevServerLogs("proj-cap", true));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(MAX_LOG_ENTRIES);
    });

    const sub = subscriptions[0]!;

    for (let index = 0; index < 5; index += 1) {
      emit(sub, "dev-server:log", {
        id: MAX_LOG_ENTRIES + index + 1,
        text: `new-${index}`,
        stream: "stdout",
        timestamp: "",
      });
    }

    expect(result.current.entries).toHaveLength(MAX_LOG_ENTRIES);
    expect(result.current.entries[0]?.id).toBe(6);
    expect(result.current.entries[MAX_LOG_ENTRIES - 1]?.id).toBe(MAX_LOG_ENTRIES + 5);
  });

  it("deduplicates entries by id", async () => {
    mockFetchDevServerLogHistory.mockResolvedValueOnce({
      lines: [{ id: 1, text: "first", stream: "stdout", timestamp: "" }],
      totalLines: 1,
    });

    const { result } = renderHook(() => useDevServerLogs("proj-dedupe", true));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    const sub = subscriptions[0]!;

    emit(sub, "dev-server:log", { id: 2, text: "live", stream: "stdout", timestamp: "" });
    emit(sub, "dev-server:log", { id: 2, text: "live duplicate", stream: "stdout", timestamp: "" });

    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries[1]?.text).toBe("live");
  });

  it("clears entries and opens new subscription on project change", async () => {
    mockFetchDevServerLogHistory.mockImplementation((_, projectId) => {
      if (projectId === "A") {
        return Promise.resolve({
          lines: [{ id: 1, text: "A-log", stream: "stdout", timestamp: "" }],
          totalLines: 1,
        });
      }

      return Promise.resolve({
        lines: [{ id: 10, text: "B-log", stream: "stdout", timestamp: "" }],
        totalLines: 1,
      });
    });

    const { result, rerender } = renderHook(
      ({ projectId }) => useDevServerLogs(projectId, true),
      { initialProps: { projectId: "A" } },
    );

    await waitFor(() => {
      expect(result.current.entries[0]?.text).toBe("A-log");
    });

    const oldSub = subscriptions[0]!;

    rerender({ projectId: "B" });

    expect(result.current.entries).toEqual([]);

    await waitFor(() => {
      expect(result.current.entries[0]?.text).toBe("B-log");
    });

    expect(subscriptions).toHaveLength(2);

    emit(oldSub, "dev-server:log", {
      id: 2,
      text: "stale-A",
      stream: "stdout",
      timestamp: "",
    });

    expect(result.current.entries.map((entry) => entry.text)).not.toContain("stale-A");
  });

  it("unsubscribes from SSE on unmount", async () => {
    const { unmount } = renderHook(() => useDevServerLogs("proj-unmount", true));

    await waitFor(() => {
      expect(subscriptions).toHaveLength(1);
    });

    const unsubscribe = subscriptions[0]!.unsubscribe;

    unmount();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("loadMore fetches older entries and prepends them", async () => {
    mockFetchDevServerLogHistory
      .mockResolvedValueOnce({
        lines: Array.from({ length: 100 }, (_, index) => ({
          id: index + 101,
          text: `new-${index + 101}`,
          stream: "stdout" as const,
          timestamp: "",
        })),
        totalLines: 200,
      })
      .mockResolvedValueOnce({
        lines: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          text: `old-${index + 1}`,
          stream: "stdout" as const,
          timestamp: "",
        })),
        totalLines: 200,
      });

    const { result } = renderHook(() => useDevServerLogs("proj-load", true));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(100);
      expect(result.current.hasMore).toBe(true);
    });

    await act(async () => {
      await result.current.loadMore();
    });

    expect(mockFetchDevServerLogHistory).toHaveBeenNthCalledWith(2, { maxLines: 100, offset: 100 }, "proj-load");
    expect(result.current.entries).toHaveLength(200);
    expect(result.current.entries[0]?.id).toBe(1);
    expect(result.current.entries[199]?.id).toBe(200);
  });

  it("does not fetch when disabled", () => {
    const { result } = renderHook(() => useDevServerLogs("proj-disabled", false));

    expect(mockFetchDevServerLogHistory).not.toHaveBeenCalled();
    expect(mockSubscribeSse).not.toHaveBeenCalled();
    expect(result.current.entries).toEqual([]);
  });

  it("clear callback removes all entries", async () => {
    mockFetchDevServerLogHistory.mockResolvedValueOnce({
      lines: [{ id: 1, text: "one", stream: "stdout", timestamp: "" }],
      totalLines: 1,
    });

    const { result } = renderHook(() => useDevServerLogs("proj-clear", true));

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    act(() => {
      result.current.clear();
    });

    expect(result.current.entries).toEqual([]);
  });

  it("fetches reconnect catch-up using lastEventId", async () => {
    mockFetchDevServerLogHistory
      .mockResolvedValueOnce({
        lines: [{ id: 1, text: "one", stream: "stdout", timestamp: "" }],
        totalLines: 2,
      })
      .mockResolvedValueOnce({
        lines: [{ id: 3, text: "three", stream: "stdout", timestamp: "" }],
        totalLines: 3,
      });

    const { result } = renderHook(() => useDevServerLogs("proj-reconnect", true));

    await waitFor(() => {
      expect(subscriptions).toHaveLength(1);
    });

    emit(subscriptions[0]!, "dev-server:log", {
      id: 2,
      text: "two",
      stream: "stdout",
      timestamp: "",
    });

    await act(async () => {
      subscriptions[0]!.options.onReconnect?.();
    });

    await waitFor(() => {
      expect(mockFetchDevServerLogHistory).toHaveBeenNthCalledWith(
        2,
        { lastEventId: 2, maxLines: 50 },
        "proj-reconnect",
      );
    });

    expect(result.current.entries.map((entry) => entry.id)).toEqual([1, 2, 3]);
  });
});
