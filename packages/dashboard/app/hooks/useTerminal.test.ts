import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTerminal } from "./useTerminal";

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
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send = vi.fn((payload: string) => {
    this.sent.push(payload);
  });

  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  });

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }

  emitClose(code: number): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

describe("useTerminal", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = originalWebSocket;
    vi.clearAllMocks();
  });

  it("returns disconnected status when sessionId is null", () => {
    const { result } = renderHook(() => useTerminal(null));
    expect(result.current.connectionStatus).toBe("disconnected");
  });

  it("establishes a websocket connection for a valid sessionId", () => {
    const { result } = renderHook(() => useTerminal("test-session-123"));

    expect(result.current.connectionStatus).toBe("connecting");
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain("/api/terminal/ws?sessionId=test-session-123");
  });

  describe("projectId support", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("includes projectId in WebSocket URL when provided", () => {
      const { result } = renderHook(() => useTerminal("test-session-123", "proj-456"));

      expect(result.current.connectionStatus).toBe("connecting");
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(MockWebSocket.instances[0].url).toContain("/api/terminal/ws?sessionId=test-session-123");
      expect(MockWebSocket.instances[0].url).toContain("projectId=proj-456");
    });

    it("does not include projectId in URL when not provided", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));

      expect(result.current.connectionStatus).toBe("connecting");
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(MockWebSocket.instances[0].url).toBe(
        `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/terminal/ws?sessionId=test-session-123`,
      );
    });

    it("updates URL when projectId changes", () => {
      const { result, rerender } = renderHook(
        ({ sessionId, projectId }: { sessionId: string | null; projectId?: string }) =>
          useTerminal(sessionId, projectId),
        { initialProps: { sessionId: "test-session-123", projectId: "proj-A" } },
      );

      expect(MockWebSocket.instances[0].url).toContain("projectId=proj-A");

      // Change projectId
      rerender({ sessionId: "test-session-123", projectId: "proj-B" });

      // Wait for reconnect
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      // New WebSocket should have new projectId
      expect(MockWebSocket.instances).toHaveLength(2);
      expect(MockWebSocket.instances[1].url).toContain("projectId=proj-B");
    });
  });

  it("reports connected status when the websocket opens", () => {
    const { result } = renderHook(() => useTerminal("test-session-123"));

    act(() => {
      MockWebSocket.instances[0].emitOpen();
    });

    expect(result.current.connectionStatus).toBe("connected");
  });

  it("sends terminal input when connected", () => {
    const { result } = renderHook(() => useTerminal("test-session-123"));

    act(() => {
      MockWebSocket.instances[0].emitOpen();
      result.current.sendInput("ls -la");
    });

    expect(MockWebSocket.instances[0].send).toHaveBeenCalledWith(JSON.stringify({ type: "input", data: "ls -la" }));
  });

  it("forwards websocket messages to registered callbacks", () => {
    const { result } = renderHook(() => useTerminal("test-session-123"));
    const onData = vi.fn();
    const onConnect = vi.fn();
    const onExit = vi.fn();
    const onScrollback = vi.fn();

    const unsubData = result.current.onData(onData);
    const unsubConnect = result.current.onConnect(onConnect);
    const unsubExit = result.current.onExit(onExit);
    const unsubScrollback = result.current.onScrollback(onScrollback);

    act(() => {
      MockWebSocket.instances[0].emitMessage({ type: "connected", shell: "/bin/bash", cwd: "/project" });
      MockWebSocket.instances[0].emitMessage({ type: "data", data: "hello world" });
      MockWebSocket.instances[0].emitMessage({ type: "scrollback", data: "previous output" });
      MockWebSocket.instances[0].emitMessage({ type: "exit", exitCode: 0 });
    });

    expect(onConnect).toHaveBeenCalledWith({ shell: "/bin/bash", cwd: "/project" });
    expect(onData).toHaveBeenCalledWith("hello world");
    expect(onScrollback).toHaveBeenCalledWith("previous output");
    expect(onExit).toHaveBeenCalledWith(0);

    unsubData();
    unsubConnect();
    unsubExit();
    unsubScrollback();
  });

  it("responds with pong when server sends ping", () => {
    renderHook(() => useTerminal("test-session-123"));
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.emitOpen();
    });

    act(() => {
      ws.emitMessage({ type: "ping" });
    });

    const pongSent = ws.sent.find((m) => JSON.parse(m).type === "pong");
    expect(pongSent).toBeDefined();
    expect(JSON.parse(pongSent!)).toEqual({ type: "pong" });
  });

  it("does not send pong when websocket is not open", () => {
    renderHook(() => useTerminal("test-session-123"));
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.emitOpen();
    });

    // Simulate WS in CLOSING state
    ws.readyState = MockWebSocket.CLOSING;

    act(() => {
      ws.emitMessage({ type: "ping" });
    });

    const pongMessages = ws.sent.filter((m) => JSON.parse(m).type === "pong");
    expect(pongMessages).toHaveLength(0);
  });

  it("stays connected after receiving a ping", () => {
    const { result } = renderHook(() => useTerminal("test-session-123"));
    const ws = MockWebSocket.instances[0];

    act(() => {
      ws.emitOpen();
    });

    expect(result.current.connectionStatus).toBe("connected");

    act(() => {
      ws.emitMessage({ type: "ping" });
    });

    expect(result.current.connectionStatus).toBe("connected");
  });

  it("does not reconnect for terminal-not-found closes", () => {
    const { result } = renderHook(() => useTerminal("test-session-123"));

    act(() => {
      MockWebSocket.instances[0].emitClose(4004);
    });

    expect(result.current.connectionStatus).toBe("disconnected");
  });

  describe("onSessionInvalid callback", () => {
    it("fires onSessionInvalid callbacks when WebSocket closes with code 4004", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));
      const onSessionInvalid = vi.fn();

      act(() => {
        result.current.onSessionInvalid(onSessionInvalid);
      });

      act(() => {
        MockWebSocket.instances[0].emitClose(4004);
      });

      expect(onSessionInvalid).toHaveBeenCalledTimes(1);
    });

    it("does NOT fire onSessionInvalid for close code 4000", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));
      const onSessionInvalid = vi.fn();

      act(() => {
        result.current.onSessionInvalid(onSessionInvalid);
      });

      act(() => {
        MockWebSocket.instances[0].emitClose(4000);
      });

      expect(onSessionInvalid).not.toHaveBeenCalled();
    });

    it("does NOT fire onSessionInvalid for normal close codes", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));
      const onSessionInvalid = vi.fn();

      act(() => {
        result.current.onSessionInvalid(onSessionInvalid);
      });

      act(() => {
        MockWebSocket.instances[0].emitClose(1000);
      });

      expect(onSessionInvalid).not.toHaveBeenCalled();
    });

    it("unsubscribes correctly", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));
      const onSessionInvalid = vi.fn();

      const unsub = result.current.onSessionInvalid(onSessionInvalid);

      // Unsubscribe
      act(() => {
        unsub();
      });

      act(() => {
        MockWebSocket.instances[0].emitClose(4004);
      });

      // Should NOT have been called after unsubscribe
      expect(onSessionInvalid).not.toHaveBeenCalled();
    });

    it("fires for multiple subscribers", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      act(() => {
        result.current.onSessionInvalid(cb1);
        result.current.onSessionInvalid(cb2);
      });

      act(() => {
        MockWebSocket.instances[0].emitClose(4004);
      });

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  describe("early message buffering", () => {
    it("replays buffered scrollback to late subscribers", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));

      // Send scrollback BEFORE any subscriber is registered
      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "scrollback", data: "previous output" });
      });

      const onScrollback = vi.fn();
      act(() => {
        result.current.onScrollback(onScrollback);
      });

      // The late subscriber should receive the buffered scrollback
      expect(onScrollback).toHaveBeenCalledWith("previous output");
    });

    it("replays buffered connected info to late subscribers", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));

      // Send connected info BEFORE any subscriber is registered
      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "connected", shell: "/bin/zsh", cwd: "/home/user" });
      });

      const onConnect = vi.fn();
      act(() => {
        result.current.onConnect(onConnect);
      });

      // The late subscriber should receive the buffered connected info
      expect(onConnect).toHaveBeenCalledWith({ shell: "/bin/zsh", cwd: "/home/user" });
    });

    it("replays buffered data messages to late subscribers", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));

      // Send data messages BEFORE any subscriber is registered
      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "data", data: "prompt$ " });
        MockWebSocket.instances[0].emitMessage({ type: "data", data: "more output" });
      });

      const onData = vi.fn();
      act(() => {
        result.current.onData(onData);
      });

      // The late subscriber should receive all buffered data messages in order
      expect(onData).toHaveBeenCalledTimes(2);
      expect(onData).toHaveBeenNthCalledWith(1, "prompt$ ");
      expect(onData).toHaveBeenNthCalledWith(2, "more output");
    });

    it("does not double-deliver messages to early subscribers", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));

      const onScrollback = vi.fn();
      const onConnect = vi.fn();
      const onData = vi.fn();

      // Register subscribers BEFORE messages arrive
      act(() => {
        result.current.onScrollback(onScrollback);
        result.current.onConnect(onConnect);
        result.current.onData(onData);
      });

      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "scrollback", data: "scrollback data" });
        MockWebSocket.instances[0].emitMessage({ type: "connected", shell: "/bin/bash", cwd: "/project" });
        MockWebSocket.instances[0].emitMessage({ type: "data", data: "hello" });
      });

      // Each callback should be called exactly once (no replay double-count)
      expect(onScrollback).toHaveBeenCalledTimes(1);
      expect(onConnect).toHaveBeenCalledTimes(1);
      expect(onData).toHaveBeenCalledTimes(1);
    });

    it("clears buffered scrollback after first replay to prevent duplicate delivery", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));

      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "scrollback", data: "buf" });
      });

      const sub1 = vi.fn();
      const sub2 = vi.fn();

      // First subscriber gets the buffered scrollback
      act(() => {
        result.current.onScrollback(sub1);
      });
      expect(sub1).toHaveBeenCalledWith("buf");

      // Second subscriber does NOT get the stale buffer — it was already
      // delivered to sub1, so replaying it would cause duplicate output.
      act(() => {
        result.current.onScrollback(sub2);
      });
      expect(sub2).not.toHaveBeenCalled();

      // New live messages should go to both subscribers
      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "scrollback", data: "live-update" });
      });

      expect(sub1).toHaveBeenCalledTimes(2); // buffer + live
      expect(sub2).toHaveBeenCalledTimes(1); // live only
    });

    it("clears buffer on reconnect so stale data is not replayed", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));

      // First connection receives messages
      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "scrollback", data: "old data" });
        MockWebSocket.instances[0].emitMessage({ type: "connected", shell: "/bin/bash", cwd: "/old" });
      });

      // Reconnect — this creates a new WebSocket
      act(() => {
        result.current.reconnect();
      });

      // Second connection (new MockWebSocket instance at index 1)
      // The reconnect closes the old ws and opens a new one
      const newWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];

      const onScrollback = vi.fn();
      const onConnect = vi.fn();

      act(() => {
        result.current.onScrollback(onScrollback);
        result.current.onConnect(onConnect);
      });

      // Subscribers registered on the new connection should NOT get old buffer
      expect(onScrollback).not.toHaveBeenCalled();
      expect(onConnect).not.toHaveBeenCalled();
    });
  });

  describe("first-paint regression — prompt delivery", () => {
    it("delivers scrollback, connected, and data messages to subscribers even when they register late", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));

      // Simulate the messages arriving before any subscriber (xterm not ready)
      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "scrollback", data: "shell-prompt$ " });
        MockWebSocket.instances[0].emitMessage({ type: "connected", shell: "/bin/zsh", cwd: "/project" });
        MockWebSocket.instances[0].emitMessage({ type: "data", data: "echo hello\n" });
      });

      const onScrollback = vi.fn();
      const onConnect = vi.fn();
      const onData = vi.fn();

      act(() => {
        result.current.onScrollback(onScrollback);
        result.current.onConnect(onConnect);
        result.current.onData(onData);
      });

      // All three message types should be replayed to late subscribers
      expect(onScrollback).toHaveBeenCalledWith("shell-prompt$ ");
      expect(onConnect).toHaveBeenCalledWith({ shell: "/bin/zsh", cwd: "/project" });
      expect(onData).toHaveBeenCalledWith("echo hello\n");
    });

    it("does not lose prompt when data arrives after scrollback before subscriber", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));

      // Simulate the exact startup race:
      // 1. Scrollback arrives (may include partial prompt)
      // 2. Data arrives with the rest of the prompt
      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "scrollback", data: "user@host" });
        MockWebSocket.instances[0].emitMessage({ type: "data", data: " ~/project $ " });
      });

      const onScrollback = vi.fn();
      const onData = vi.fn();

      act(() => {
        result.current.onScrollback(onScrollback);
        result.current.onData(onData);
      });

      // Both messages should be delivered (no loss)
      expect(onScrollback).toHaveBeenCalledWith("user@host");
      expect(onData).toHaveBeenCalledWith(" ~/project $ ");
    });
  });

  describe("first-paint regression — no duplicate output", () => {
    it("does not replay scrollback to second subscriber to prevent duplicate terminal output", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));

      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "scrollback", data: "prompt$ " });
      });

      const sub1 = vi.fn();
      act(() => {
        result.current.onScrollback(sub1);
      });
      expect(sub1).toHaveBeenCalledWith("prompt$ ");

      // Second subscriber does NOT get the replay (prevents duplicate output)
      const sub2 = vi.fn();
      act(() => {
        result.current.onScrollback(sub2);
      });
      expect(sub2).not.toHaveBeenCalled();

      // But live messages go to both
      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "scrollback", data: "new!" });
      });
      expect(sub1).toHaveBeenCalledTimes(2);
      expect(sub2).toHaveBeenCalledTimes(1);
      expect(sub2).toHaveBeenCalledWith("new!");
    });

    it("does not replay data to second subscriber to prevent duplicate terminal output", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));

      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "data", data: "output" });
      });

      const sub1 = vi.fn();
      act(() => {
        result.current.onData(sub1);
      });
      expect(sub1).toHaveBeenCalledWith("output");

      // Second subscriber does NOT get the stale buffer
      const sub2 = vi.fn();
      act(() => {
        result.current.onData(sub2);
      });
      expect(sub2).not.toHaveBeenCalled();

      // But live messages go to both
      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "data", data: "live" });
      });
      expect(sub1).toHaveBeenCalledTimes(2);
      expect(sub2).toHaveBeenCalledTimes(1);
      expect(sub2).toHaveBeenCalledWith("live");
    });

    it("does not replay connected info to second subscriber to prevent duplicate tab title update", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));

      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "connected", shell: "/bin/bash", cwd: "/home" });
      });

      const sub1 = vi.fn();
      act(() => {
        result.current.onConnect(sub1);
      });
      expect(sub1).toHaveBeenCalledWith({ shell: "/bin/bash", cwd: "/home" });

      // Second subscriber does NOT get stale connected info
      const sub2 = vi.fn();
      act(() => {
        result.current.onConnect(sub2);
      });
      expect(sub2).not.toHaveBeenCalled();
    });
  });

  describe("reconnect — scrollback replay on new connection", () => {
    it("delivers fresh scrollback on reconnect without stale data", () => {
      const { result } = renderHook(() => useTerminal("test-session-123"));

      // First connection — send some data
      act(() => {
        MockWebSocket.instances[0].emitMessage({ type: "scrollback", data: "old prompt$ " });
        MockWebSocket.instances[0].emitMessage({ type: "connected", shell: "/bin/zsh", cwd: "/old" });
      });

      // Register subscriber on old connection
      const onScrollback = vi.fn();
      const onConnect = vi.fn();
      act(() => {
        result.current.onScrollback(onScrollback);
        result.current.onConnect(onConnect);
      });

      // Old buffer was delivered
      expect(onScrollback).toHaveBeenCalledWith("old prompt$ ");

      // Reconnect — creates new WebSocket, clears buffers
      act(() => {
        result.current.reconnect();
      });

      const newWs = MockWebSocket.instances[MockWebSocket.instances.length - 1];

      // New connection sends fresh scrollback
      act(() => {
        newWs.emitMessage({ type: "scrollback", data: "new prompt$ " });
        newWs.emitMessage({ type: "connected", shell: "/bin/zsh", cwd: "/new" });
      });

      // Existing subscriber gets new live data
      expect(onScrollback).toHaveBeenCalledTimes(2); // old buffer + new live
      expect(onScrollback).toHaveBeenLastCalledWith("new prompt$ ");
      expect(onConnect).toHaveBeenCalledTimes(2); // old buffer + new live
      expect(onConnect).toHaveBeenLastCalledWith({ shell: "/bin/zsh", cwd: "/new" });
    });
  });

  describe("heartbeat interval", () => {
    it("sends client ping at 45-second interval (not 30s)", () => {
      vi.useFakeTimers();
      renderHook(() => useTerminal("heartbeat-test"));
      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.emitOpen();
      });

      // Clear any messages sent during open
      ws.sent.length = 0;

      // At 30 seconds, no ping should be sent yet (old interval was 30s)
      act(() => {
        vi.advanceTimersByTime(30000);
      });

      const pingsAt30s = ws.sent.filter((m) => {
        try { return JSON.parse(m).type === "ping"; } catch { return false; }
      });
      expect(pingsAt30s).toHaveLength(0);

      // At 45 seconds, the first ping should be sent
      act(() => {
        vi.advanceTimersByTime(15000);
      });

      const pingsAt45s = ws.sent.filter((m) => {
        try { return JSON.parse(m).type === "ping"; } catch { return false; }
      });
      expect(pingsAt45s).toHaveLength(1);

      // At 90 seconds, second ping should be sent
      act(() => {
        vi.advanceTimersByTime(45000);
      });

      const pingsAt90s = ws.sent.filter((m) => {
        try { return JSON.parse(m).type === "ping"; } catch { return false; }
      });
      expect(pingsAt90s).toHaveLength(2);

      vi.useRealTimers();
    });
  });
});
