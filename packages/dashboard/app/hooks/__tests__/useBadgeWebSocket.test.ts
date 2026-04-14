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
    // Check payload contains required fields (projectId may be null or omitted)
    const subscribeMsg = MockWebSocket.instances[0].sent.find((p) => {
      const parsed = JSON.parse(p);
      return parsed.type === "subscribe" && parsed.taskId === "FN-063";
    });
    expect(subscribeMsg).toBeDefined();
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

    const update = result.current.badgeUpdates.get("default:FN-063");
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

    expect(result.current.badgeUpdates.get("default:FN-063")).toMatchObject({
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

    // With scoped keys, badge data is stored under "default:FN-063"
    expect(result.current.badgeUpdates.has("default:FN-063")).toBe(true);

    act(() => {
      MockWebSocket.instances[0].emitClose(1006);
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.badgeUpdates.has("default:FN-063")).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => {
      MockWebSocket.instances[1].emitOpen();
    });

    expect(result.current.isConnected).toBe(true);
    // Check payload contains required fields (projectId may be null or omitted)
    const subscribeMsg = MockWebSocket.instances[1].sent.find((p) => {
      const parsed = JSON.parse(p);
      return parsed.type === "subscribe" && parsed.taskId === "FN-063";
    });
    expect(subscribeMsg).toBeDefined();
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

    // Check unsubscribe payload contains required fields (projectId may be null or omitted)
    const unsubscribeMsg = MockWebSocket.instances[0].sent.find((p) => {
      const parsed = JSON.parse(p);
      return parsed.type === "unsubscribe" && parsed.taskId === "FN-063";
    });
    expect(unsubscribeMsg).toBeDefined();
    expect(MockWebSocket.instances[0].close).toHaveBeenCalled();
    expect(result.current.badgeUpdates.has("default:FN-063")).toBe(false);
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
    // Check exactly one subscribe message was sent
    const subscribeMsgs = MockWebSocket.instances[0].sent.filter((payload) => {
      const parsed = JSON.parse(payload);
      return parsed.type === "subscribe" && parsed.taskId === "FN-063";
    });
    expect(subscribeMsgs).toHaveLength(1);

    act(() => {
      first.result.current.unsubscribeFromBadge("FN-063");
    });

    // No unsubscribe yet (still one subscription)
    const unsubscribeAfterFirst = MockWebSocket.instances[0].sent.filter((payload) => {
      const parsed = JSON.parse(payload);
      return parsed.type === "unsubscribe" && parsed.taskId === "FN-063";
    });
    expect(unsubscribeAfterFirst).toHaveLength(0);

    act(() => {
      second.result.current.unsubscribeFromBadge("FN-063");
    });

    // Now unsubscribe should be sent (all subscriptions removed)
    const unsubscribeAfterSecond = MockWebSocket.instances[0].sent.filter((payload) => {
      const parsed = JSON.parse(payload);
      return parsed.type === "unsubscribe" && parsed.taskId === "FN-063";
    });
    expect(unsubscribeAfterSecond).toHaveLength(1);
  });

  it("unsubscribes owned task subscriptions on unmount", () => {
    const { result, unmount } = renderHook(() => useBadgeWebSocket());

    act(() => {
      result.current.subscribeToBadge("FN-063");
      MockWebSocket.instances[0].emitOpen();
    });

    unmount();

    // Check unsubscribe payload was sent
    const unsubscribeMsg = MockWebSocket.instances[0].sent.find((p) => {
      const parsed = JSON.parse(p);
      return parsed.type === "unsubscribe" && parsed.taskId === "FN-063";
    });
    expect(unsubscribeMsg).toBeDefined();
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
        (p) => {
          const parsed = JSON.parse(p);
          return parsed.type === "subscribe" && parsed.taskId === "FN-063";
        },
      ).length;

      // Change project - this immediately creates a new socket (no timer needed)
      rerender({ projectId: "proj-B" });

      // The new socket is created synchronously, emit open so onopen fires
      act(() => {
        MockWebSocket.instances[1].emitOpen();
      });

      // Subscribe should be sent again for the new connection
      const newSubscribe = MockWebSocket.instances[1].sent.filter(
        (p) => {
          const parsed = JSON.parse(p);
          return parsed.type === "subscribe" && parsed.taskId === "FN-063";
        },
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

      // With scoped keys, badge data is stored under "proj-A:FN-063"
      expect(result.current.badgeUpdates.has("proj-A:FN-063")).toBe(true);

      // Change project
      rerender({ projectId: "proj-B" });

      // Wait for reconnect
      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      // Badge updates should be cleared (including old project key)
      expect(result.current.badgeUpdates.has("proj-A:FN-063")).toBe(false);
    });

    it("isolates badge updates across projects with same task ID", async () => {
      // Two hooks watching the same task ID in different projects
      // Note: The singleton store only maintains one active projectId,
      // so we test isolation by verifying scoped key storage works correctly
      const { result: resultA, rerender: rerenderA } = renderHook(
        ({ projectId }: { projectId?: string }) => useBadgeWebSocket(projectId),
        { initialProps: { projectId: "proj-A" } },
      );

      // Subscribe to FN-063 in project A
      act(() => {
        resultA.current.subscribeToBadge("FN-063");
        MockWebSocket.instances[0].emitOpen();
      });

      // Verify badge update is stored with scoped key
      act(() => {
        MockWebSocket.instances[0].emitMessage({
          type: "badge:updated",
          taskId: "FN-063",
          prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "merged", title: "Merged PR", headBranch: "feat", baseBranch: "main", commentCount: 0 },
          timestamp: "2026-03-30T12:00:00.000Z",
        });
      });

      expect(resultA.current.badgeUpdates.get("proj-A:FN-063")?.prInfo?.status).toBe("merged");

      // Now switch to project B (simulates a different component/context)
      // After this, the store's projectId is "proj-B"
      rerenderA({ projectId: "proj-B" });

      // Wait for reconnect
      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      // Old project's cache should be cleared
      expect(resultA.current.badgeUpdates.has("proj-A:FN-063")).toBe(false);

      // Subscribe to the same task ID in the new project
      act(() => {
        resultA.current.subscribeToBadge("FN-063");
        MockWebSocket.instances[1].emitOpen();
      });

      // Simulate badge update for project-B's FN-063 with different status
      act(() => {
        MockWebSocket.instances[1].emitMessage({
          type: "badge:updated",
          taskId: "FN-063",
          prInfo: { url: "https://github.com/owner/repo/pull/2", number: 2, status: "open", title: "Open PR", headBranch: "feat2", baseBranch: "main", commentCount: 0 },
          timestamp: "2026-03-30T12:01:00.000Z",
        });
      });

      // Project B should have its own update
      expect(resultA.current.badgeUpdates.get("proj-B:FN-063")?.prInfo?.status).toBe("open");
      // Project A's data should not be present (overwritten by project switch)
      expect(resultA.current.badgeUpdates.get("proj-A:FN-063")).toBeUndefined();
    });

    it("includes projectId in subscribe payload when project is set", () => {
      const { result } = renderHook(() => useBadgeWebSocket("proj-abc"));

      act(() => {
        result.current.subscribeToBadge("FN-999");
        MockWebSocket.instances[0].emitOpen();
      });

      // Find subscribe message and verify projectId is included
      const subscribeMsg = MockWebSocket.instances[0].sent.find((p) => {
        const parsed = JSON.parse(p);
        return parsed.type === "subscribe" && parsed.taskId === "FN-999";
      });
      expect(subscribeMsg).toBeDefined();
      const parsed = JSON.parse(subscribeMsg!);
      expect(parsed.projectId).toBe("proj-abc");
    });

    it("includes projectId in unsubscribe payload when project is set", () => {
      const { result } = renderHook(() => useBadgeWebSocket("proj-xyz"));

      act(() => {
        result.current.subscribeToBadge("FN-888");
        MockWebSocket.instances[0].emitOpen();
      });

      // Clear sent messages and unsubscribe
      MockWebSocket.instances[0].sent = [];

      act(() => {
        result.current.unsubscribeFromBadge("FN-888");
      });

      // Find unsubscribe message and verify projectId is included
      const unsubscribeMsg = MockWebSocket.instances[0].sent.find((p) => {
        const parsed = JSON.parse(p);
        return parsed.type === "unsubscribe" && parsed.taskId === "FN-888";
      });
      expect(unsubscribeMsg).toBeDefined();
      const parsed = JSON.parse(unsubscribeMsg!);
      expect(parsed.projectId).toBe("proj-xyz");
    });

    it("clears badge updates immediately on project switch (before reconnect)", () => {
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
          prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "merged", title: "PR1", headBranch: "feat", baseBranch: "main", commentCount: 0 },
          timestamp: "2026-03-30T12:00:00.000Z",
        });
      });

      // Badge data should exist
      expect(result.current.badgeUpdates.get("proj-A:FN-063")?.prInfo?.status).toBe("merged");

      // Switch project - this should clear badge data BEFORE reconnect
      // We do NOT advance timers for reconnect, just verify immediate clear
      rerender({ projectId: "proj-B" });

      // Badge data should be cleared immediately (not waiting for reconnect)
      expect(result.current.badgeUpdates.has("proj-A:FN-063")).toBe(false);
      expect(result.current.badgeUpdates.has("proj-B:FN-063")).toBe(false);
    });

    it("ignores messages from old context after project switch (context version guard)", () => {
      const { result, rerender } = renderHook(
        ({ projectId }: { projectId?: string }) => useBadgeWebSocket(projectId),
        { initialProps: { projectId: "proj-A" } },
      );

      // Subscribe in project A
      act(() => {
        result.current.subscribeToBadge("FN-063");
        MockWebSocket.instances[0].emitOpen();
      });

      // Send a message on project A socket first to establish baseline
      act(() => {
        MockWebSocket.instances[0].emitMessage({
          type: "badge:updated",
          taskId: "FN-063",
          prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "merged", title: "Merged PR", headBranch: "feat", baseBranch: "main", commentCount: 0 },
          timestamp: "2026-03-30T12:00:00.000Z",
        });
      });

      // Verify data exists
      expect(result.current.badgeUpdates.get("proj-A:FN-063")?.prInfo?.status).toBe("merged");

      // Switch to project B - flush useEffect to ensure setProjectId runs
      rerender({ projectId: "proj-B" });
      act(() => {
        vi.runAllTimers(); // Flush all pending timers/effects
      });

      // Open the new socket
      act(() => {
        MockWebSocket.instances[1].emitOpen();
      });

      // Send message on OLD socket (proj-A) - should be ignored due to context version
      act(() => {
        MockWebSocket.instances[0].emitMessage({
          type: "badge:updated",
          taskId: "FN-063",
          prInfo: { url: "https://github.com/owner/repo/pull/99", number: 99, status: "stale-from-old", title: "Stale PR", headBranch: "feat", baseBranch: "main", commentCount: 0 },
          timestamp: "2026-03-30T12:05:00.000Z",
        });
      });

      // Badge data should still be empty (old message was rejected)
      expect(result.current.badgeUpdates.get("proj-B:FN-063")).toBeUndefined();

      // Send message on NEW socket (proj-B) - should work
      act(() => {
        MockWebSocket.instances[1].emitMessage({
          type: "badge:updated",
          taskId: "FN-063",
          prInfo: { url: "https://github.com/owner/repo/pull/2", number: 2, status: "open", title: "Good PR", headBranch: "feat", baseBranch: "main", commentCount: 0 },
          timestamp: "2026-03-30T12:06:00.000Z",
        });
      });

      // Now badge data should exist from the new socket
      expect(result.current.badgeUpdates.get("proj-B:FN-063")?.prInfo?.status).toBe("open");
    });

    it("ignores reconnect timer from old context after project switch", () => {
      const { result, rerender } = renderHook(
        ({ projectId }: { projectId?: string }) => useBadgeWebSocket(projectId),
        { initialProps: { projectId: "proj-A" } },
      );

      // Subscribe and close socket to trigger reconnect timer
      act(() => {
        result.current.subscribeToBadge("FN-063");
        MockWebSocket.instances[0].emitOpen();
        MockWebSocket.instances[0].emitClose(1006); // Abnormal close triggers reconnect
      });

      // Before advancing timers, switch to project B
      rerender({ projectId: "proj-B" });
      act(() => {
        vi.runAllTimers(); // Flush all pending timers including reconnect
      });

      // The old context reconnect timer should have been skipped
      // We should have at most 2 sockets: old (closed) + new (for project B)
      // The reconnect for project A should NOT have been created
      expect(MockWebSocket.instances.length).toBeLessThanOrEqual(2);
    });

    it("ignores badge message with mismatched projectId from server (FN-1745+ behavior)", () => {
      const { result } = renderHook(() => useBadgeWebSocket("proj-A"));

      act(() => {
        result.current.subscribeToBadge("FN-063");
        MockWebSocket.instances[0].emitOpen();
      });

      // Simulate message from server with different projectId (cross-project leak attempt)
      act(() => {
        MockWebSocket.instances[0].emitMessage({
          type: "badge:updated",
          taskId: "FN-063",
          projectId: "proj-B", // Different project
          prInfo: { url: "https://github.com/owner/repo/pull/999", number: 999, status: "malicious", title: "Malicious PR", headBranch: "feat", baseBranch: "main", commentCount: 0 },
          timestamp: "2026-03-30T12:00:00.000Z",
        });
      });

      // Message with mismatched projectId should be ignored
      // The badge data should not be updated
      const badgeData = result.current.badgeUpdates.get("proj-A:FN-063");
      expect(badgeData?.prInfo?.status).toBeUndefined();
    });

    it("accepts badge message with matching projectId from server", () => {
      const { result } = renderHook(() => useBadgeWebSocket("proj-A"));

      act(() => {
        result.current.subscribeToBadge("FN-063");
        MockWebSocket.instances[0].emitOpen();
      });

      // Simulate message from server with matching projectId
      act(() => {
        MockWebSocket.instances[0].emitMessage({
          type: "badge:updated",
          taskId: "FN-063",
          projectId: "proj-A", // Same project
          prInfo: { url: "https://github.com/owner/repo/pull/1", number: 1, status: "open", title: "Good PR", headBranch: "feat", baseBranch: "main", commentCount: 0 },
          timestamp: "2026-03-30T12:00:00.000Z",
        });
      });

      // Message with matching projectId should be accepted
      const badgeData = result.current.badgeUpdates.get("proj-A:FN-063");
      expect(badgeData?.prInfo?.status).toBe("open");
    });
  });
});
