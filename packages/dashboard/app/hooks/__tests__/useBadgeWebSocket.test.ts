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
      result.current.subscribeToBadge("KB-063");
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain("/api/ws");

    act(() => {
      MockWebSocket.instances[0].emitOpen();
    });

    expect(result.current.isConnected).toBe(true);
    expect(MockWebSocket.instances[0].sent).toContain(JSON.stringify({ type: "subscribe", taskId: "KB-063" }));
  });

  it("stores badge update snapshots from the server", async () => {
    const { result } = renderHook(() => useBadgeWebSocket());

    act(() => {
      result.current.subscribeToBadge("KB-063");
      MockWebSocket.instances[0].emitOpen();
    });

    act(() => {
      MockWebSocket.instances[0].emitMessage({
        type: "badge:updated",
        taskId: "KB-063",
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

    const update = result.current.badgeUpdates.get("KB-063");
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
      result.current.subscribeToBadge("KB-063");
      MockWebSocket.instances[0].emitOpen();
      MockWebSocket.instances[0].emitMessage({
        type: "badge:updated",
        taskId: "KB-063",
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
        taskId: "KB-063",
        issueInfo: {
          url: "https://github.com/owner/repo/issues/2",
          number: 2,
          state: "open",
          title: "Tracked issue",
        },
        timestamp: "2026-03-30T12:01:00.000Z",
      });
    });

    expect(result.current.badgeUpdates.get("KB-063")).toMatchObject({
      prInfo: { number: 1 },
      issueInfo: { number: 2 },
    });
  });

  it("preserves cached badge state and reconnects with exponential backoff after an unexpected close", async () => {
    const { result } = renderHook(() => useBadgeWebSocket());

    act(() => {
      result.current.subscribeToBadge("KB-063");
      MockWebSocket.instances[0].emitOpen();
      MockWebSocket.instances[0].emitMessage({
        type: "badge:updated",
        taskId: "KB-063",
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

    expect(result.current.badgeUpdates.has("KB-063")).toBe(true);

    act(() => {
      MockWebSocket.instances[0].emitClose(1006);
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.badgeUpdates.has("KB-063")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => {
      MockWebSocket.instances[1].emitOpen();
    });

    expect(result.current.isConnected).toBe(true);
    expect(MockWebSocket.instances[1].sent).toContain(JSON.stringify({ type: "subscribe", taskId: "KB-063" }));
  });

  it("sends unsubscribe, clears cached state, and closes the socket when the final subscription is removed", () => {
    const { result } = renderHook(() => useBadgeWebSocket());

    act(() => {
      result.current.subscribeToBadge("KB-063");
      MockWebSocket.instances[0].emitOpen();
      MockWebSocket.instances[0].emitMessage({
        type: "badge:updated",
        taskId: "KB-063",
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
      result.current.unsubscribeFromBadge("KB-063");
    });

    expect(MockWebSocket.instances[0].sent).toContain(JSON.stringify({ type: "unsubscribe", taskId: "KB-063" }));
    expect(MockWebSocket.instances[0].close).toHaveBeenCalled();
    expect(result.current.badgeUpdates.has("KB-063")).toBe(false);
  });

  it("shares a single websocket and ref-counted subscription across hook instances", () => {
    const first = renderHook(() => useBadgeWebSocket());
    const second = renderHook(() => useBadgeWebSocket());

    act(() => {
      first.result.current.subscribeToBadge("KB-063");
      second.result.current.subscribeToBadge("KB-063");
      MockWebSocket.instances[0].emitOpen();
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(
      MockWebSocket.instances[0].sent.filter((payload) => payload === JSON.stringify({ type: "subscribe", taskId: "KB-063" })),
    ).toHaveLength(1);

    act(() => {
      first.result.current.unsubscribeFromBadge("KB-063");
    });

    expect(MockWebSocket.instances[0].sent).not.toContain(JSON.stringify({ type: "unsubscribe", taskId: "KB-063" }));

    act(() => {
      second.result.current.unsubscribeFromBadge("KB-063");
    });

    expect(MockWebSocket.instances[0].sent).toContain(JSON.stringify({ type: "unsubscribe", taskId: "KB-063" }));
  });

  it("unsubscribes owned task subscriptions on unmount", () => {
    const { result, unmount } = renderHook(() => useBadgeWebSocket());

    act(() => {
      result.current.subscribeToBadge("KB-063");
      MockWebSocket.instances[0].emitOpen();
    });

    unmount();

    expect(MockWebSocket.instances[0].sent).toContain(JSON.stringify({ type: "unsubscribe", taskId: "KB-063" }));
  });
});
