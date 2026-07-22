/**
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Resilient EventSource client peeled from legacy.ts for shared SSE reconnect semantics.
 */
import { appendTokenQuery } from "../../auth";

export type StreamConnectionState = "connected" | "reconnecting";

// Track every live createResilientEventSource instance so we can close their
// underlying EventSource sockets on page unload. Without this, Chrome holds
// the HTTP/1.1 sockets open in its keep-alive pool across refreshes, exhausts
// its 6-per-origin limit after ~3 refreshes, and every new fetch stalls —
// leaving the dashboard frozen on "Initializing...". sse-bus.ts has its own
// handler; this one covers the parallel EventSource path in api.ts.
const activeResilientEventSources = new Set<{ close: () => void }>();
if (typeof window !== "undefined") {
  const closeAll = () => {
    for (const handle of Array.from(activeResilientEventSources)) {
      try { handle.close(); } catch { /* best effort */ }
    }
  };
  window.addEventListener("pagehide", closeAll);
  window.addEventListener("beforeunload", closeAll);
}

export interface ResilientEventSourceOptions {
  maxReconnectAttempts?: number;
  onConnectionStateChange?: (state: StreamConnectionState) => void;
  onFatalError?: (message: string) => void;
}

export interface ResilientEventHandlers {
  onOpen?: () => void;
  onMessage?: (event: MessageEvent) => void;
  events?: Record<string, (event: MessageEvent) => void>;
}

function appendLastEventId(url: string, lastEventId: number | null): string {
  if (lastEventId === null || lastEventId <= 0) {
    return url;
  }

  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}lastEventId=${encodeURIComponent(String(lastEventId))}`;
}

export function createResilientEventSource(
  url: string,
  handlers: ResilientEventHandlers,
  options: ResilientEventSourceOptions = {},
): { close: () => void; isConnected: () => boolean } {
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
  let eventSource: EventSource | null = null;
  let closedByUser = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSeenEventId: number | null = null;
  let reconnectingNotified = false;

  const shouldDispatch = (event: MessageEvent): boolean => {
    const rawId = event.lastEventId;
    if (!rawId) {
      return true;
    }

    const parsedId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(parsedId)) {
      return true;
    }

    if (lastSeenEventId !== null && parsedId <= lastSeenEventId) {
      return false;
    }

    lastSeenEventId = parsedId;
    return true;
  };

  const connect = (): void => {
    if (closedByUser) return;

    const nextUrl = appendLastEventId(url, lastSeenEventId);
    // EventSource can't set headers — carry the bearer token via `fn_token=`.
    const source = new EventSource(appendTokenQuery(nextUrl));
    eventSource = source;

    source.onopen = () => {
      reconnectAttempts = 0;
      reconnectingNotified = false;
      options.onConnectionStateChange?.("connected");
      handlers.onOpen?.();
    };

    source.onmessage = (event) => {
      const messageEvent = event as MessageEvent;
      if (!shouldDispatch(messageEvent)) return;
      handlers.onMessage?.(messageEvent);
    };

    for (const [eventName, handler] of Object.entries(handlers.events ?? {})) {
      source.addEventListener(eventName, (event: Event) => {
        const messageEvent = event as MessageEvent;
        if (!shouldDispatch(messageEvent)) return;
        handler(messageEvent);
      });
    }

    source.onerror = () => {
      if (closedByUser || eventSource !== source) return;

      const readyState = source.readyState;
      if (readyState === EventSource.CONNECTING) {
        if (!reconnectingNotified) {
          reconnectingNotified = true;
          options.onConnectionStateChange?.("reconnecting");
        }
        return;
      }

      source.close();
      if (eventSource === source) {
        eventSource = null;
      }

      if (reconnectAttempts >= maxReconnectAttempts) {
        options.onFatalError?.("Connection lost");
        return;
      }

      reconnectingNotified = true;
      options.onConnectionStateChange?.("reconnecting");
      reconnectAttempts += 1;

      const delayMs = Math.min(1000 * 2 ** (reconnectAttempts - 1), 30000);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delayMs);
    };
  };

  connect();

  const handle = {
    close: () => {
      closedByUser = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      eventSource?.close();
      activeResilientEventSources.delete(handle);
    },
    isConnected: () => !closedByUser && eventSource?.readyState === EventSource.OPEN,
  };
  activeResilientEventSources.add(handle);
  return handle;
}

