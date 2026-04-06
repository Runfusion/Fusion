import { useState, useEffect, useRef, useCallback } from "react";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface UseTerminalReturn {
  /** Current WebSocket connection status */
  connectionStatus: ConnectionStatus;
  /** Send input data to the terminal */
  sendInput: (data: string) => void;
  /** Resize the terminal */
  resize: (cols: number, rows: number) => void;
  /** Register a callback for data from the terminal */
  onData: (callback: (data: string) => void) => () => void;
  /** Register a callback for terminal exit */
  onExit: (callback: (exitCode: number) => void) => () => void;
  /** Register a callback for connection events */
  onConnect: (callback: (info: { shell: string; cwd: string }) => void) => () => void;
  /** Register a callback for scrollback data */
  onScrollback: (callback: (data: string) => void) => () => void;
  /** Manually reconnect */
  reconnect: () => void;
}

interface WebSocketMessage {
  type: string;
  data?: string;
  exitCode?: number;
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** Buffered initial message types that must survive late subscriber registration */
interface BufferedMessages {
  scrollback: string | null;
  connected: { shell: string; cwd: string } | null;
  /** Accumulated data messages received before any subscriber registered */
  data: string[];
}

const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY = 1000;
const HEARTBEAT_INTERVAL = 45000; // 45 seconds — slightly longer than server's 30s interval

function createEmptyBuffer(): BufferedMessages {
  return { scrollback: null, connected: null, data: [] };
}

/**
 * React hook for managing terminal WebSocket connection.
 * 
 * Features:
 * - WebSocket connection with exponential backoff reconnect
 * - Input/output handling
 * - Resize support
 * - Heartbeat ping/pong
 * - Scrollback buffer replay on connect
 * - Early message buffering: scrollback, connected, and initial data messages
 *   are buffered and replayed to subscribers that register after the WebSocket
 *   starts receiving events (e.g. while xterm is still initializing).
 * 
 * @example
 * ```tsx
 * const { connectionStatus, sendInput, resize, onData } = useTerminal(sessionId);
 * 
 * useEffect(() => {
 *   const unsub = onData((data) => {
 *     terminal.write(data);
 *   });
 *   return unsub;
 * }, [onData]);
 * ```
 */
export function useTerminal(sessionId: string | null): UseTerminalReturn {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isManualCloseRef = useRef(false);
  
  // Callback refs to avoid re-subscriptions
  const onDataCallbacksRef = useRef<Set<(data: string) => void>>(new Set());
  const onExitCallbacksRef = useRef<Set<(exitCode: number) => void>>(new Set());
  const onConnectCallbacksRef = useRef<Set<(info: { shell: string; cwd: string }) => void>>(new Set());
  const onScrollbackCallbacksRef = useRef<Set<(data: string) => void>>(new Set());

  // Buffer for initial messages received before subscribers are registered.
  // This ensures scrollback, connected info, and early shell output are
  // delivered even if TerminalModal's xterm hasn't finished initializing.
  const initialBufferRef = useRef<BufferedMessages>(createEmptyBuffer());

  // Register callbacks — replay buffered data to late subscribers
  const onData = useCallback((callback: (data: string) => void) => {
    onDataCallbacksRef.current.add(callback);
    // Replay buffered data messages
    const buffer = initialBufferRef.current;
    if (buffer.data.length > 0) {
      buffer.data.forEach((d) => callback(d));
      // Clear after replay to prevent stale re-delivery if a new subscriber
      // registers later (e.g. due to a re-render or reconnect).
      buffer.data = [];
    }
    return () => onDataCallbacksRef.current.delete(callback);
  }, []);

  const onExit = useCallback((callback: (exitCode: number) => void) => {
    onExitCallbacksRef.current.add(callback);
    return () => onExitCallbacksRef.current.delete(callback);
  }, []);

  const onConnect = useCallback((callback: (info: { shell: string; cwd: string }) => void) => {
    onConnectCallbacksRef.current.add(callback);
    // Replay buffered connected info
    const buffer = initialBufferRef.current;
    if (buffer.connected) {
      callback(buffer.connected);
      // Clear after replay to prevent stale re-delivery to subsequent subscribers
      buffer.connected = null;
    }
    return () => onConnectCallbacksRef.current.delete(callback);
  }, []);

  const onScrollback = useCallback((callback: (data: string) => void) => {
    onScrollbackCallbacksRef.current.add(callback);
    // Replay buffered scrollback
    const buffer = initialBufferRef.current;
    if (buffer.scrollback) {
      callback(buffer.scrollback);
      // Clear after replay to prevent stale re-delivery to subsequent subscribers
      buffer.scrollback = null;
    }
    return () => onScrollbackCallbacksRef.current.delete(callback);
  }, []);

  // Send input to terminal
  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    }
  }, []);

  // Resize terminal
  const resize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }, []);

  // Cleanup function
  const cleanup = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }

    if (wsRef.current) {
      isManualCloseRef.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }

    // Clear buffers on cleanup
    initialBufferRef.current = createEmptyBuffer();
  }, []);

  // Connect function
  const connect = useCallback(() => {
    if (!sessionId) {
      setConnectionStatus("disconnected");
      return;
    }

    // Don't connect if already connected
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    // Clean up any existing connection
    if (wsRef.current) {
      isManualCloseRef.current = true;
      wsRef.current.close();
    }

    isManualCloseRef.current = false;
    setConnectionStatus("connecting");

    // Build WebSocket URL
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/terminal/ws?sessionId=${encodeURIComponent(sessionId)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Reset buffer ONLY when connection is established — ensures any
      // late-arriving messages from a previous session are discarded and
      // the new session's scrollback/data is captured in a fresh buffer.
      initialBufferRef.current = createEmptyBuffer();
      setConnectionStatus("connected");
      reconnectAttemptsRef.current = 0;

      // Start heartbeat
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }

      heartbeatIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, HEARTBEAT_INTERVAL);
    };

    ws.onmessage = (event) => {
      try {
        const msg: WebSocketMessage = JSON.parse(event.data);
        const buffer = initialBufferRef.current;

        switch (msg.type) {
          case "data":
            if (msg.data) {
              // Buffer data when no subscribers are registered yet
              if (onDataCallbacksRef.current.size === 0) {
                buffer.data.push(msg.data!);
              }
              onDataCallbacksRef.current.forEach((cb) => cb(msg.data!));
            }
            break;
          case "scrollback":
            if (msg.data) {
              // Buffer scrollback for late subscribers
              buffer.scrollback = msg.data;
              onScrollbackCallbacksRef.current.forEach((cb) => cb(msg.data!));
            }
            break;
          case "connected":
            if (msg.shell && msg.cwd) {
              // Buffer connected info for late subscribers
              buffer.connected = { shell: msg.shell!, cwd: msg.cwd! };
              onConnectCallbacksRef.current.forEach((cb) => 
                cb({ shell: msg.shell!, cwd: msg.cwd! })
              );
            }
            break;
          case "exit":
            if (msg.exitCode !== undefined) {
              onExitCallbacksRef.current.forEach((cb) => cb(msg.exitCode!));
            }
            break;
          case "ping":
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "pong" }));
            }
            break;
          case "pong":
            // Heartbeat response
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = (event) => {
      wsRef.current = null;
      
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }

      // Don't reconnect if manually closed
      if (isManualCloseRef.current) {
        setConnectionStatus("disconnected");
        return;
      }

      // Don't reconnect for certain close codes
      if (event.code === 4000 || event.code === 4004) {
        setConnectionStatus("disconnected");
        return;
      }

      // Attempt reconnect with exponential backoff
      reconnectAttemptsRef.current++;
      
      if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
        setConnectionStatus("disconnected");
        return;
      }

      const delay = INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttemptsRef.current - 1);
      setConnectionStatus("reconnecting");

      reconnectTimeoutRef.current = setTimeout(() => {
        if (!isManualCloseRef.current) {
          connect();
        }
      }, Math.min(delay, 16000));
    };

    ws.onerror = () => {
      // Errors are handled by onclose
    };
  }, [sessionId]);

  // Manual reconnect
  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    cleanup();
    connect();
  }, [cleanup, connect]);

  // Connect when sessionId changes
  useEffect(() => {
    if (sessionId) {
      connect();
    } else {
      cleanup();
      setConnectionStatus("disconnected");
    }

    return cleanup;
  }, [sessionId, connect, cleanup]);

  return {
    connectionStatus,
    sendInput,
    resize,
    onData,
    onExit,
    onConnect,
    onScrollback,
    reconnect,
  };
}
