import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTerminal } from "./useTerminal";

// Mock WebSocket
global.WebSocket = vi.fn() as unknown as typeof WebSocket;

describe("useTerminal", () => {
  let mockWebSocket: {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    readyState: number;
    onopen: (() => void) | null;
    onmessage: ((event: { data: string }) => void) | null;
    onclose: ((event?: { code: number }) => void) | null;
    onerror: (() => void) | null;
  };

  beforeEach(() => {
    mockWebSocket = {
      send: vi.fn(),
      close: vi.fn(),
      readyState: WebSocket.CONNECTING,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };

    (global.WebSocket as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockWebSocket);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns disconnected status when sessionId is null", () => {
    const { result } = renderHook(() => useTerminal(null));
    expect(result.current.connectionStatus).toBe("disconnected");
  });

  it("establishes WebSocket connection on valid sessionId", () => {
    renderHook(() => useTerminal("test-session-123"));

    expect(global.WebSocket).toHaveBeenCalledWith(
      expect.stringContaining("/api/terminal/ws?sessionId=test-session-123")
    );
  });

  it("shows connecting status while establishing connection", () => {
    const { result } = renderHook(() => useTerminal("test-session-123"));
    expect(result.current.connectionStatus).toBe("connecting");
  });

  it("shows connected status when WebSocket opens", async () => {
    const { result } = renderHook(() => useTerminal("test-session-123"));

    mockWebSocket.readyState = WebSocket.OPEN;
    mockWebSocket.onopen?.();

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected");
    });
  });

  it("sends input data when connected", async () => {
    const { result } = renderHook(() => useTerminal("test-session-123"));

    mockWebSocket.readyState = WebSocket.OPEN;
    mockWebSocket.onopen?.();

    await waitFor(() => {
      result.current.sendInput("ls -la");
    });

    expect(mockWebSocket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "input", data: "ls -la" })
    );
  });

  it("calls onData callback when data received", async () => {
    const { result } = renderHook(() => useTerminal("test-session-123"));
    const onDataMock = vi.fn();

    const unsub = result.current.onData(onDataMock);

    mockWebSocket.onmessage?.({
      data: JSON.stringify({ type: "data", data: "hello world" }),
    });

    expect(onDataMock).toHaveBeenCalledWith("hello world");
    unsub();
  });

  it("calls onConnect callback when connected", async () => {
    const { result } = renderHook(() => useTerminal("test-session-123"));
    const onConnectMock = vi.fn();

    const unsub = result.current.onConnect(onConnectMock);

    mockWebSocket.onmessage?.({
      data: JSON.stringify({ type: "connected", shell: "/bin/bash", cwd: "/project" }),
    });

    expect(onConnectMock).toHaveBeenCalledWith({ shell: "/bin/bash", cwd: "/project" });
    unsub();
  });

  it("calls onExit callback when session exits", async () => {
    const { result } = renderHook(() => useTerminal("test-session-123"));
    const onExitMock = vi.fn();

    const unsub = result.current.onExit(onExitMock);

    mockWebSocket.onmessage?.({
      data: JSON.stringify({ type: "exit", exitCode: 0 }),
    });

    expect(onExitMock).toHaveBeenCalledWith(0);
    unsub();
  });

  it("calls onScrollback callback when scrollback received", async () => {
    const { result } = renderHook(() => useTerminal("test-session-123"));
    const onScrollbackMock = vi.fn();

    const unsub = result.current.onScrollback(onScrollbackMock);

    mockWebSocket.onmessage?.({
      data: JSON.stringify({ type: "scrollback", data: "previous output" }),
    });

    expect(onScrollbackMock).toHaveBeenCalledWith("previous output");
    unsub();
  });

  it("does not reconnect on 4004 session not found", async () => {
    const { result } = renderHook(() => useTerminal("test-session-123"));

    mockWebSocket.onclose?.({ code: 4004 });

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("disconnected");
    });
  });
});
