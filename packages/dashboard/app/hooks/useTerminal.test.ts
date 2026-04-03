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
});
