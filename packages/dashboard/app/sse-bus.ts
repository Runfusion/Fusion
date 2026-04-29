import { appendTokenQuery } from "./auth";

// Shared EventSource multiplexer.
//
// Browsers cap HTTP/1.1 connections to a single origin at ~6. Each native
// EventSource holds a slot open indefinitely, so having many hooks/components
// each open their own /api/events connection starves the pool and makes
// every subsequent `fetch` sit pending. This module funnels every consumer
// through one EventSource per URL and fans events out via pub/sub.

type MessageListener = (event: MessageEvent) => void;
type ErrorListener = (event: Event) => void;
type OpenListener = () => void;

const HEARTBEAT_TIMEOUT_MS = 45_000;
const RECONNECT_DELAY_MS = 3_000;
const CLIENT_KEEPALIVE_INTERVAL_MS = 2_000;
const CLIENT_KEEPALIVE_TIMEOUT_MS = 1_500;
const CLIENT_ID_STORAGE_KEY = "fusion:sse-client-id";

let memoryClientId: string | null = null;

interface Subscriber {
  events: Map<string, Set<MessageListener>>;
  onOpen?: OpenListener;
  onReconnect?: OpenListener;
  onError?: ErrorListener;
}

interface Channel {
  url: string;
  es: EventSource | null;
  subscribers: Set<Subscriber>;
  nativeListeners: Map<string, (event: Event) => void>;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  keepaliveTimer: number | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  hasOpenedOnce: boolean;
  /** Set true at the start of closeChannel to prevent reconnect after teardown. */
  closed: boolean;
}

const channels = new Map<string, Channel>();

function createClientId(): string {
  const cryptoApi = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getSseClientId(): string | undefined {
  if (typeof window === "undefined") return undefined;

  if (memoryClientId) return memoryClientId;

  try {
    const stored = window.sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (stored) {
      memoryClientId = stored;
      return stored;
    }
    const created = createClientId();
    window.sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, created);
    memoryClientId = created;
    return created;
  } catch {
    memoryClientId = createClientId();
    return memoryClientId;
  }
}

function parseDashboardUrl(url: string): { parsed: URL; preserveRelativePath: boolean } | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const parsed = new URL(url, window.location.origin);
    return { parsed, preserveRelativePath: url.startsWith("/") };
  } catch {
    return undefined;
  }
}

function isLocalEventsUrl(parsed: URL): boolean {
  return parsed.origin === window.location.origin && parsed.pathname === "/api/events";
}

function appendClientIdQuery(url: string): string {
  const clientId = getSseClientId();
  if (!clientId) return url;

  const parsed = parseDashboardUrl(url);
  if (!parsed || !isLocalEventsUrl(parsed.parsed)) return url;

  parsed.parsed.searchParams.set("clientId", clientId);
  return parsed.preserveRelativePath
    ? `${parsed.parsed.pathname}${parsed.parsed.search}${parsed.parsed.hash}`
    : parsed.parsed.toString();
}

function createControlUrl(eventsUrl: string, action: "disconnect" | "keepalive"): string | undefined {
  const clientId = getSseClientId();
  if (!clientId) return undefined;

  const parsed = parseDashboardUrl(eventsUrl);
  if (!parsed || !isLocalEventsUrl(parsed.parsed)) return undefined;

  const controlUrl = new URL(`/api/events/${action}`, window.location.origin);
  controlUrl.searchParams.set("clientId", clientId);
  const projectId = parsed.parsed.searchParams.get("projectId");
  if (projectId) {
    controlUrl.searchParams.set("projectId", projectId);
  }
  return appendTokenQuery(`${controlUrl.pathname}${controlUrl.search}${controlUrl.hash}`);
}

function sendDisconnectBeacon(channel: Channel): void {
  if (typeof window === "undefined") return;

  const url = createControlUrl(channel.url, "disconnect");
  if (!url) return;

  const sendBeacon = window.navigator?.sendBeacon?.bind(window.navigator);
  if (sendBeacon && sendBeacon(url)) {
    return;
  }

  if (typeof window.fetch === "function") {
    void window.fetch(url, { method: "POST", keepalive: true }).catch(() => {
      // The next successful EventSource connection with this client id also
      // supersedes older server-side streams, so a missed unload beacon is OK.
    });
  }
}

function stopClientKeepalive(channel: Channel): void {
  if (channel.keepaliveTimer) {
    clearInterval(channel.keepaliveTimer);
    channel.keepaliveTimer = null;
  }
}

function sendClientKeepalive(channel: Channel): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;

  const url = createControlUrl(channel.url, "keepalive");
  if (!url) return;

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeout = controller
    ? window.setTimeout(() => controller.abort(), CLIENT_KEEPALIVE_TIMEOUT_MS)
    : null;

  void window.fetch(url, {
    method: "POST",
    cache: "no-store",
    signal: controller?.signal,
  }).catch(() => {
    // If this page is suspended or the network drops, the server-side stale
    // timer will reap the stream and EventSource will reconnect later.
  }).finally(() => {
    if (timeout !== null) {
      window.clearTimeout(timeout);
    }
  });
}

function startClientKeepalive(channel: Channel): void {
  stopClientKeepalive(channel);
  if (!createControlUrl(channel.url, "keepalive")) return;

  sendClientKeepalive(channel);
  channel.keepaliveTimer = window.setInterval(() => {
    sendClientKeepalive(channel);
  }, CLIENT_KEEPALIVE_INTERVAL_MS);
}

// Close every EventSource when the page is unloading. Without this,
// browsers keep the underlying TCP sockets open in their HTTP/1.1
// keep-alive pool even though the JS EventSource object is gone —
// the server never sees a close, connections pile up, and within a
// few refreshes the browser hits its 6-connection-per-origin limit
// and every subsequent fetch stalls. Using `pagehide` (fires reliably
// on bfcache navigations too) plus `beforeunload` as a fallback.
if (typeof window !== "undefined") {
  const closeAllChannels = () => {
    for (const channel of Array.from(channels.values())) {
      if (channel.closed) continue;
      stopClientKeepalive(channel);
      sendDisconnectBeacon(channel);
      if (channel.es) {
        try {
          channel.es.close();
        } catch {
          // ignore
        }
        channel.es = null;
      }
      channel.closed = true;
    }
  };
  const reopenPersistedChannels = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    for (const channel of Array.from(channels.values())) {
      if (channel.subscribers.size === 0) continue;
      channel.closed = false;
      openChannel(channel);
    }
  };
  window.addEventListener("pagehide", closeAllChannels);
  window.addEventListener("beforeunload", closeAllChannels);
  window.addEventListener("pageshow", reopenPersistedChannels);
}

function resetHeartbeat(channel: Channel): void {
  if (channel.heartbeatTimer) clearTimeout(channel.heartbeatTimer);
  channel.heartbeatTimer = setTimeout(() => {
    forceReconnect(channel);
  }, HEARTBEAT_TIMEOUT_MS);
}

function forceReconnect(channel: Channel): void {
  if (channel.heartbeatTimer) {
    clearTimeout(channel.heartbeatTimer);
    channel.heartbeatTimer = null;
  }
  if (channel.es) {
    channel.es.close();
    channel.es = null;
  }
  stopClientKeepalive(channel);
  channel.nativeListeners.clear();

  if (channel.closed) return;
  if (channel.subscribers.size === 0 || channel.reconnectTimer) return;

  // Guard against calling onReconnect callbacks for a channel that has been
  // closed while the heartbeat timer fired. This prevents stale SSE events from
  // firing into unsubscribed/mounted-out consumers during rapid view switches.
  const ch = channels.get(channel.url);
  if (!ch || ch !== channel) return;

  // A teardown means events may have been missed while the stream was
  // down. Signal resync to each subscriber so they can refetch
  // authoritative state.
  for (const sub of channel.subscribers) sub.onReconnect?.();

  channel.reconnectTimer = setTimeout(() => {
    channel.reconnectTimer = null;
    if (channel.closed) return;
    // Re-check after timer fires — the channel may have been closed or
    // the subscription count changed during the delay.
    const current = channels.get(channel.url);
    if (current && current === channel && channel.subscribers.size > 0) {
      openChannel(channel);
    }
  }, RECONNECT_DELAY_MS);
}

function openChannel(channel: Channel): void {
  if (channel.es) return;
  if (channel.closed) return;
  if (channel.reconnectTimer) {
    clearTimeout(channel.reconnectTimer);
    channel.reconnectTimer = null;
  }

  // EventSource can't set custom headers, so the bearer token must ride on
  // the URL as `fn_token=<token>`. `appendTokenQuery` is a no-op when no
  // token is configured.
  const es = new EventSource(appendTokenQuery(appendClientIdQuery(channel.url)));
  channel.es = es;
  startClientKeepalive(channel);

  es.addEventListener("open", () => {
    resetHeartbeat(channel);
    const reconnect = channel.hasOpenedOnce;
    channel.hasOpenedOnce = true;
    for (const sub of channel.subscribers) {
      sub.onOpen?.();
      if (reconnect) sub.onReconnect?.();
    }
  });

  es.addEventListener("error", (event) => {
    for (const sub of channel.subscribers) sub.onError?.(event);
    // Any error triggers a forced reconnect cycle — matches the pre-bus
    // behavior in useTasks and ensures the stream recovers even when
    // EventSource's own retry has stalled.
    forceReconnect(channel);
  });

  // Unnamed `message` events and server "heartbeat" events both count as
  // liveness signals, regardless of whether a subscriber registered them.
  es.addEventListener("message", () => resetHeartbeat(channel));
  es.addEventListener("heartbeat", () => resetHeartbeat(channel));

  reattachNativeListeners(channel);
  resetHeartbeat(channel);
}

function reattachNativeListeners(channel: Channel): void {
  if (!channel.es) return;
  const types = new Set<string>();
  for (const sub of channel.subscribers) {
    for (const type of sub.events.keys()) types.add(type);
  }
  for (const type of types) {
    if (channel.nativeListeners.has(type)) continue;
    const listener = (event: Event) => {
      resetHeartbeat(channel);
      const msg = event as MessageEvent;
      for (const sub of channel.subscribers) {
        const handlers = sub.events.get(type);
        if (!handlers) continue;
        for (const handler of handlers) handler(msg);
      }
    };
    channel.nativeListeners.set(type, listener);
    channel.es.addEventListener(type, listener);
  }
}

function closeChannel(channel: Channel): void {
  channel.closed = true;
  if (channel.heartbeatTimer) clearTimeout(channel.heartbeatTimer);
  stopClientKeepalive(channel);
  if (channel.reconnectTimer) clearTimeout(channel.reconnectTimer);
  if (channel.es) channel.es.close();
  channel.es = null;
  channel.nativeListeners.clear();
  channels.delete(channel.url);
}

export interface SseSubscription {
  /** Map of named SSE event type → handler. */
  events?: Record<string, MessageListener>;
  /** Fires on every successful open (initial + reconnect). */
  onOpen?: OpenListener;
  /** Fires only on reconnects (not the initial open). Use for resync-on-recovery. */
  onReconnect?: OpenListener;
  /** Forwarded EventSource error events. */
  onError?: ErrorListener;
}

/**
 * Subscribe to an SSE URL. All subscribers of the same URL share a single
 * underlying EventSource. Returns an unsubscribe function; when the last
 * subscriber unsubscribes, the connection is closed.
 */
export function subscribeSse(url: string, sub: SseSubscription = {}): () => void {
  let channel = channels.get(url);
  if (!channel) {
    channel = {
      url,
      es: null,
      subscribers: new Set(),
      nativeListeners: new Map(),
      heartbeatTimer: null,
      keepaliveTimer: null,
      reconnectTimer: null,
      hasOpenedOnce: false,
      closed: false,
    };
    channels.set(url, channel);
  }

  const subscriber: Subscriber = {
    events: new Map(),
    onOpen: sub.onOpen,
    onReconnect: sub.onReconnect,
    onError: sub.onError,
  };
  if (sub.events) {
    for (const [type, handler] of Object.entries(sub.events)) {
      let handlers = subscriber.events.get(type);
      if (!handlers) {
        handlers = new Set();
        subscriber.events.set(type, handlers);
      }
      handlers.add(handler);
    }
  }

  channel.subscribers.add(subscriber);
  const wasAlreadyOpen = !!channel.es && channel.hasOpenedOnce;
  openChannel(channel);
  reattachNativeListeners(channel);

  // Subscribers joining a channel that already opened never see another
  // `open` event from EventSource, so fire onOpen for them on a microtask
  // (microtask, not sync, so the caller finishes wiring before state
  // updates land).
  if (wasAlreadyOpen) {
    queueMicrotask(() => {
      if (channel.subscribers.has(subscriber)) {
        subscriber.onOpen?.();
      }
    });
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const ch = channels.get(url);
    if (!ch) return;
    ch.subscribers.delete(subscriber);
    if (ch.subscribers.size === 0) closeChannel(ch);
  };
}

/** Test-only: tear down every open channel. */
export function __resetSseBus(): void {
  for (const channel of Array.from(channels.values())) closeChannel(channel);
  memoryClientId = null;
}

/** Test-only: inspect the number of live channels. */
export function __sseBusChannelCount(): number {
  return channels.size;
}
