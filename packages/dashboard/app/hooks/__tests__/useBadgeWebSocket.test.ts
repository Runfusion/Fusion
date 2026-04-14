import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { __resetBadgeWebSocketStoreForTests, useBadgeWebSocket } from "../useBadgeWebSocket";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000 } as CloseEvent);
  });
  send = vi.fn((payload: string) => {
    this.sent.push(payload);
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  emitClose(code: number = 1006): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code } as CloseEvent);
  }
}

describe("useBadgeWebSocket", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    __resetBadgeWebSocketStoreForTests();
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    __resetBadgeWebSocketStoreForTests();
    vi.useRealTimers();
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = originalWebSocket;
  });

  it("connects when the first badge subscription is added", async () => {
    const { result } = renderHook(() => useBadgeWebSocket());

    act(() => {
      result.current.subscribeToBadge("FN-063");
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain("/api/ws");

    act(() => {
      MockWebSocket.instances[0].emitOpen();
    });

    expect(result.current.isConnected).toBe(true);
    expect(MockWebSocket.instances[0].sent).toContain(JSON.stringify({ type: "subscribe", taskId: "FN-063" }));
  });

  it("stores badge update snapshots from the server", async () => {
    const { result } = renderHook(() => useBadgeWebSocket());

    act(() => {
      result.current.subscribeToBadge("FN-063");
      MockWebSocket.instances[0].emitOpen();
    });

    act(() => {
      MockWebSocket.instances[0].emitMessage({
        type: "badge:updated",
        taskId: "FN-063",
        prInfo: null,
        issueInfo: {
          url: "https://github.com/owner/repo/issues/2",
          number: 2,
          state: "closed",
          title: "Tracked issue",
          stateReason: "completed",
        },
        timestamp: "2026-03-30T12:00:00.000Z",
      });
    });

    const update = result.current.badgeUpdates.get("FN-063");
    expect(update).toMatchObject({
      prInfo: null,
      issueInfo: {
        number: 2,
        stateReason: "completed",
      },
    });
  });

  it("preserves existing badge state for partial update payloads", () => {
    const { result } = renderHook(() => useBadgeWebSocket());

    act(() => {
      result.current.subscribeToBadge("FN-063");
      MockWebSocket.instances[0].emitOpen();
      MockWebSocket.instances[0].emitMessage({
        type: "badge:updated",
        taskId: "FN-063",
        prInfo: {
          url: "https://github.com/owner/repo/pull/1",
          number: 1,
          status: "open",
          title: "Tracked PR",
          headBranch: "feature/test",
          baseBranch: "main",
          commentCount: 0,
        },
        timestamp: "2026-03-30T12:00:00.000Z",
      });
      MockWebSocket.instances[0].emitMessage({
        type: "badge:updated",
        taskId: "FN-063",
        issueInfo: {
          url: "https://github.com/owner/repo/issues/2",
          number: 2,
          state: "open",
          title: "Tracked issue",
        },
        timestamp: "2026-03-30T12:01:00.000Z",
      });
    });

    expect(result.current.badgeUpdates.get("FN-063")).toMatchObject({
      prInfo: { number: 1 },
      issueInfo: { number: 2 },
    });
  });

  it("preserves cached badge state and reconnects with exponential backoff after an unexpected close", async () => {
    const { result } = renderHook(() => useBadgeWebSocket());

    act(() => {
      result.current.subscribeToBadge("FN-063");
      MockWebSocket.instances[0].emitOpen();
      MockWebSocket.instances[0].emitMessage({
        type: "badge:updated",
        taskId: "FN-063",
        prInfo: {
          url: "https://github.com/owner/repo/pull/1",
          number: 1,
          status: "open",
          title: "Tracked PR",
          headBranch: "feature/test",
          baseBranch: "main",
          commentCount: 0,
        },
        timestamp: "2026-03-30T12:00:00.000Z",
      });
    });

    expect(result.current.badgeUpdates.has("FN-063")).toBe(true);

    act(() => {
      MockWebSocket.instances[0].emitClose(1006);
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.badgeUpdates.has("FN-063")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => {
      MockWebSocket.instances[1].emitOpen();
    });

    expect(result.current.isConnected).toBe(true);
    expect(MockWebSocket.instances[1].sent).toContain(JSON.stringify({ type: "subscribe", taskId: "FN-063" }));
  });

  it("sends unsubscribe, clears cached state, and closes the socket when the final subscription is removed", () => {
    const { result } = renderHook(() => useBadgeWebSocket());

    act(() => {
      result.current.subscribeToBadge("FN-063");
      MockWebSocket.instances[0].emitOpen();
      MockWebSocket.instances[0].emitMessage({
        type: "badge:updated",
        taskId: "FN-063",
        prInfo: {
          url: "https://github.com/owner/repo/pull/1",
          number: 1,
          status: "open",
          title: "Tracked PR",
          headBranch: "feature/test",
          baseBranch: "main",
          commentCount: 0,
        },
        timestamp: "2026-03-30T12:00:00.000Z",
      });
    });

    act(() => {
      result.current.unsubscribeFromBadge("FN-063");
    });

    expect(MockWebSocket.instances[0].sent).toContain(JSON.stringify({ type: "unsubscribe", taskId: "FN-063" }));
    expect(MockWebSocket.instances[0].close).toHaveBeenCalled();
    expect(result.current.badgeUpdates.has("FN-063")).toBe(false);
  });

  it("shares a single websocket and ref-counted subscription across hook instances", () => {
    const first = renderHook(() => useBadgeWebSocket());
    const second = renderHook(() => useBadgeWebSocket());

    act(() => {
      first.result.current.subscribeToBadge("FN-063");
      second.result.current.subscribeToBadge("FN-063");
      MockWebSocket.instances[0].emitOpen();
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(
      MockWebSocket.instances[0].sent.filter((payload) => payload === JSON.stringify({ type: "subscribe", taskId: "FN-063" })),
    ).toHaveLength(1);

    act(() => {
      first.result.current.unsubscribeFromBadge("FN-063");
    });

    expect(MockWebSocket.instances[0].sent).not.toContain(JSON.stringify({ type: "unsubscribe", taskId: "FN-063" }));

    act(() => {
      second.result.current.unsubscribeFromBadge("FN-063");
    });

    expect(MockWebSocket.instances[0].sent).toContain(JSON.stringify({ type: "unsubscribe", taskId: "FN-063" }));
  });

  it("unsubscribes owned task subscriptions on unmount", () => {
    const { result, unmount } = renderHook(() => useBadgeWebSocket());

    act(() => {
      result.current.subscribeToBadge("FN-063");
      MockWebSocket.instances[0].emitOpen();
    });

    unmount();

    expect(MockWebSocket.instances[0].sent).toContain(JSON.stringify({ type: "unsubscribe", taskId: "FN-063" }));
  });

  describe("projectId support", () => {
    it("includes projectId in WebSocket URL when provided", () => {
      const { result } = renderHook(() => useBadgeWebSocket("proj-123"));

      act(() => {
        result.current.subscribeToBadge("FN-063");
      });

      expect(MockWebSocket.instances).toHaveLength(1);
      expect(MockWebSocket.instances[0].url).toContain("/api/ws");
      expect(MockWebSocket.instances[0].url).toContain("projectId=proj-123");
    });

    it("connects without projectId when not provided", () => {
      const { result } = renderHook(() => useBadgeWebSocket());

      act(() => {
        result.current.subscribeToBadge("FN-063");
      });

      expect(MockWebSocket.instances).toHaveLength(1);
      expect(MockWebSocket.instances[0].url).toBe(`${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/ws`);
    });

    it("reconnects with new projectId when projectId changes", async () => {
      const { result, rerender } = renderHook(
        ({ projectId }: { projectId?: string }) => useBadgeWebSocket(projectId),
        { initialProps: { projectId: "proj-A" } },
      );

      // Subscribe to a badge
      act(() => {
        result.current.subscribeToBadge("FN-063");
        MockWebSocket.instances[0].emitOpen();
      });

      expect(MockWebSocket.instances[0].url).toContain("projectId=proj-A");

      // Update projectId to proj-B
      rerender({ projectId: "proj-B" });

      // Old socket should be closed
      expect(MockWebSocket.instances[0].close).toHaveBeenCalled();

      // Wait for reconnect timer
      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      // New socket should connect with new projectId
      expect(MockWebSocket.instances).toHaveLength(2);
      expect(MockWebSocket.instances[1].url).toContain("projectId=proj-B");
    });

    it("re-subscribes to badges after project change", async () => {
      const { result, rerender } = renderHook(
        ({ projectId }: { projectId?: string }) => useBadgeWebSocket(projectId),
        { initialProps: { projectId: "proj-A" } },
      );

      // Subscribe to a badge
      act(() => {
        result.current.subscribeToBadge("FN-063");
        MockWebSocket.instances[0].emitOpen();
      });

      // Record the subscribe message from initial connection
      const initialSubscribe = MockWebSocket.instances[0].sent.filter(
        (p) => p === JSON.stringify({ type: "subscribe", taskId: "FN-063" }),
      ).length;

      // Change project - this immediately creates a new socket (no timer needed)
      rerender({ projectId: "proj-B" });

      // The new socket is created synchronously, emit open so onopen fires
      act(() => {
        MockWebSocket.instances[1].emitOpen();
      });

      // Subscribe should be sent again for the new connection
      const newSubscribe = MockWebSocket.instances[1].sent.filter(
        (p) => p === JSON.stringify({ type: "subscribe", taskId: "FN-063" }),
      ).length;

      expect(newSubscribe).toBeGreaterThanOrEqual(1);
    });

    it("clears badge updates on project change", async () => {
      const { result, rerender } = renderHook(
        ({ projectId }: { projectId?: string }) => useBadgeWebSocket(projectId),
        { initialProps: { projectId: "proj-A" } },
      );

      // Subscribe and receive badge update
      act(() => {
        result.current.subscribeToBadge("FN-063");
        MockWebSocket.instances[0].emitOpen();
        MockWebSocket.instances[0].emitMessage({
          type: "badge:updated",
          taskId: "FN-063",
          prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "open", title: "Test PR", headBranch: "feat", baseBranch: "main", commentCount: 0 },
          timestamp: "2026-03-30T12:00:00.000Z",
        });
      });

      expect(result.current.badgeUpdates.has("FN-063")).toBe(true);

      // Change project
      rerender({ projectId: "proj-B" });

      // Wait for reconnect
      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      // Badge updates should be cleared
      expect(result.current.badgeUpdates.has("FN-063")).toBe(false);
    });
  });
});
