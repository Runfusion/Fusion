import { useState, useEffect, useRef, useCallback } from "react";
import { appendTokenQuery } from "../auth";

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
  /**
   * Register a callback for session-invalid events.
   * Fires when the WebSocket closes with code 4004 (session-not-found),
   * meaning the server no longer recognizes the session. The caller should
   * create a new session rather than attempting reconnect.
   */
  onSessionInvalid: (callback: () => void) => () => void;
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
 * - Project-context isolation: stale WebSocket callbacks from prior project/session
 *   contexts cannot update current UI state. Uses context version guards to reject
 *   events from outdated connections.
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
export function useTerminal(sessionId: string | null, projectId?: string): UseTerminalReturn {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");

  // Track context version to detect stale WebSocket callbacks after project/session switches.
  // Incremented whenever projectId or sessionId changes, invalidating any callbacks
  // from WebSocket connections that belong to the previous context.
  const contextVersionRef = useRef(0);

  // Track previous values to detect context changes
  const previousSessionIdRef = useRef<string | null>(sessionId);
  const previousProjectIdRef = useRef<string | undefined>(projectId);
  const contextChangedSinceLastEffectRef = useRef(false);

  /*
   * FNXC:Terminal 2026-07-11-18:42:
   * Context changes must invalidate stale WebSocket callbacks during render, before effects run, but the effect consumes a ref flag instead of depending on the transient boolean. Depending on that boolean makes React run cleanup again when it flips back to false after a status update, tearing down the replacement socket during context-switch/reconnect races.
   */
  const contextChanged =
    previousSessionIdRef.current !== sessionId ||
    previousProjectIdRef.current !== projectId;

  if (contextChanged) {
    previousSessionIdRef.current = sessionId;
    previousProjectIdRef.current = projectId;
    contextVersionRef.current++;
    contextChangedSinceLastEffectRef.current = true;
  }
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isManualCloseRef = useRef(false);
  const hasEverConnectedRef = useRef(false);
  
  // Callback refs to avoid re-subscriptions
  const onDataCallbacksRef = useRef<Set<(data: string) => void>>(new Set());
  const onExitCallbacksRef = useRef<Set<(exitCode: number) => void>>(new Set());
  const onConnectCallbacksRef = useRef<Set<(info: { shell: string; cwd: string }) => void>>(new Set());
  const onScrollbackCallbacksRef = useRef<Set<(data: string) => void>>(new Set());
  const onSessionInvalidCallbacksRef = useRef<Set<() => void>>(new Set());

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

  /**
   * Register a callback for session-invalid events.
   * Fires when the server closes the WebSocket with code 4004, indicating
   * the session no longer exists. Unlike transient disconnects, this is a
   * permanent condition that requires creating a new session to recover.
   */
  const onSessionInvalid = useCallback((callback: () => void) => {
    onSessionInvalidCallbacksRef.current.add(callback);
    return () => onSessionInvalidCallbacksRef.current.delete(callback);
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

  // Internal cleanup for context changes: closes WebSocket WITHOUT marking as
  // manual close, so onclose handler doesn't interfere with the context transition.
  // Does NOT reset isManualCloseRef to preserve the flag for the calling context.
  const closeWebSocketForContextChange = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }

    if (wsRef.current) {
      // Remove listeners to prevent stale onclose from interfering
      // with the context transition
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    // Clear buffers on context change to prevent stale replay
    initialBufferRef.current = createEmptyBuffer();
    hasEverConnectedRef.current = false;
  }, []);

  // Cleanup function (used for unmount and manual reconnect)
  // Marks the close as intentional so onclose handler doesn't reconnect.
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
      // Null handlers before close so any in-flight `onopen`/`onmessage`
      // from a still-connecting socket can't fire on the shared callback
      // Set after we've moved on. Without this, a new tab's reconnect
      // cycle leaves a ghost socket whose onmessage doubles every output
      // chunk (the echoed keystroke shows up twice → "aa" per 'a').
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    // Clear buffers on cleanup
    initialBufferRef.current = createEmptyBuffer();
  }, []);

  // Connect function
  const connect = useCallback((nextStatus: ConnectionStatus = "connecting") => {
    if (!sessionId) {
      setConnectionStatus("disconnected");
      return;
    }

    // Don't connect if already connected
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    // Clean up any existing connection. Null handlers before close so a
    // still-connecting socket can't fire onopen/onmessage on the shared
    // callback Set after we've moved on (would double output).
    if (wsRef.current) {
      isManualCloseRef.current = true;
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    isManualCloseRef.current = false;
    setConnectionStatus(nextStatus);

    // Capture the context version at connection start. Stale callbacks from
    // previous project/session contexts will be rejected by comparing against
    // the current contextVersionRef.current value.
    const contextVersionAtConnect = contextVersionRef.current;

    // Build WebSocket URL with optional projectId for multi-project support
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let wsUrl = `${protocol}//${window.location.host}/api/terminal/ws?sessionId=${encodeURIComponent(sessionId)}`;
    if (projectId) {
      wsUrl += `&projectId=${encodeURIComponent(projectId)}`;
    }

    // Carry the bearer token on the URL — WebSocket `new WebSocket` can't set
    // an Authorization header. `appendTokenQuery` adds `fn_token=<token>`
    // when auth is active and returns the URL unchanged otherwise.
    const ws = new WebSocket(appendTokenQuery(wsUrl));
    wsRef.current = ws;

    ws.onopen = () => {
      // Reject stale events from previous context
      if (contextVersionRef.current !== contextVersionAtConnect) {
        ws.close();
        return;
      }

      // Reset buffer ONLY when connection is established — ensures any
      // late-arriving messages from a previous session are discarded and
      // the new session's scrollback/data is captured in a fresh buffer.
      initialBufferRef.current = createEmptyBuffer();
      hasEverConnectedRef.current = true;
      setConnectionStatus("connected");
      reconnectAttemptsRef.current = 0;

      // Start heartbeat
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }

      heartbeatIntervalRef.current = setInterval(() => {
        // Reject stale heartbeat from previous context
        if (contextVersionRef.current !== contextVersionAtConnect) {
          return;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, HEARTBEAT_INTERVAL);
    };

    ws.onmessage = (event) => {
      // Reject stale events from previous context
      if (contextVersionRef.current !== contextVersionAtConnect) {
        return;
      }

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
              // Buffer scrollback only when no subscribers are registered yet
              if (onScrollbackCallbacksRef.current.size === 0) {
                buffer.scrollback = msg.data;
              } else {
                onScrollbackCallbacksRef.current.forEach((cb) => cb(msg.data!));
                buffer.scrollback = null;
              }
            }
            break;
          case "connected":
            if (msg.shell && msg.cwd) {
              const connectedInfo = { shell: msg.shell!, cwd: msg.cwd! };
              // Buffer connected info only when no subscribers are registered yet
              if (onConnectCallbacksRef.current.size === 0) {
                buffer.connected = connectedInfo;
              } else {
                onConnectCallbacksRef.current.forEach((cb) => cb(connectedInfo));
                buffer.connected = null;
              }
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
      // Reject stale close events from previous context
      if (contextVersionRef.current !== contextVersionAtConnect) {
        return;
      }

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

        // Code 4004 means the server doesn't recognize the session — it's
        // permanently invalid. Notify subscribers so they can create a new
        // session rather than retrying the stale one.
        if (event.code === 4004) {
          onSessionInvalidCallbacksRef.current.forEach((cb) => cb());
        }
        return;
      }

      /**
       * FNXC:Terminal 2026-07-11-18:20:
       * FN-7824: A cold first launch can close the WebSocket before the backend is ready often enough to exhaust the normal reconnect budget. Never-opened sockets must keep retrying with capped backoff and stay in the reconnecting affordance so operators do not need a manual Reconnect click. Sockets that have opened at least once are real mid-session drops and keep the bounded give-up behavior, while permanent 4000/4004 closes remain terminal above.
       */
      const isInitialConnect = !hasEverConnectedRef.current;

      // Attempt reconnect with exponential backoff
      reconnectAttemptsRef.current++;
      
      if (!isInitialConnect && reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
        setConnectionStatus("disconnected");
        return;
      }

      const delay = INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttemptsRef.current - 1);
      setConnectionStatus("reconnecting");

      // Capture the version at reconnect scheduling time to detect if context
      // changed while the timeout was pending
      const contextVersionAtSchedule = contextVersionRef.current;

      reconnectTimeoutRef.current = setTimeout(() => {
        // Reject reconnect if context changed while timeout was pending
        if (contextVersionRef.current !== contextVersionAtSchedule) {
          return;
        }
        if (!isManualCloseRef.current) {
          connect("reconnecting");
        }
      }, Math.min(delay, 16000));
    };

    ws.onerror = () => {
      // Errors are handled by onclose
    };
  }, [sessionId, projectId]);

  // Manual reconnect
  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    hasEverConnectedRef.current = false;
    cleanup();
    connect();
  }, [cleanup, connect]);

  // Connect when sessionId or projectId changes
  // Handle context change: close existing WebSocket, cancel timers, reset state
  useEffect(() => {
    // If context changed, perform cleanup before connecting to new context.
    if (contextChangedSinceLastEffectRef.current) {
      contextChangedSinceLastEffectRef.current = false;
      // Use internal cleanup that doesn't mark as manual close,
      // allowing proper context transition without stale onclose interference
      closeWebSocketForContextChange();

      // Reset transient state
      reconnectAttemptsRef.current = 0;
      hasEverConnectedRef.current = false;
      setConnectionStatus("disconnected");
    }

    if (sessionId) {
      connect();
    } else {
      hasEverConnectedRef.current = false;
      setConnectionStatus("disconnected");
    }

    return cleanup;
  }, [sessionId, projectId, connect, cleanup, closeWebSocketForContextChange]);

  return {
    connectionStatus,
    sendInput,
    resize,
    onData,
    onExit,
    onConnect,
    onScrollback,
    reconnect,
    onSessionInvalid,
  };
}
