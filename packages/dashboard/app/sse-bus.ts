import { appendTokenQuery } from "./auth";
import { visibleEdgeStaggerDelayMs } from "./hooks/visibilitySuspension";
import { pushTrace } from "./utils/dashboardTraceBuffer";
import { recordResumeEvent } from "./utils/resumeInstrumentation";

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
/*
 * FNXC:DashboardSSE 2026-06-23-15:08:
 * Dashboard SSE keepalive exists only to let the server reap abandoned browser streams. It must not create a visible storm of regular HTTP connections when the engine is off, so keep the liveness probe infrequent and let the server stale window absorb brief tab/network stalls.
 */
const CLIENT_KEEPALIVE_INTERVAL_MS = 30_000;
const CLIENT_KEEPALIVE_TIMEOUT_MS = 5_000;
const VISIBILITY_REOPEN_DEDUPE_MS = 1_000;
const CLIENT_ID_STORAGE_KEY = "fusion:sse-client-id";

/*
FNXC:DashboardSSE 2026-07-26-10:05:
Mobile browsers (iOS Safari tabs and installed PWAs, Chrome Android) discard a backgrounded page when it keeps doing network/timer work, which the operator sees as a full white-splash reload on returning to the dashboard. An open EventSource plus its 30s keepalive probe and 45s heartbeat-timeout reconnect churn keeps the tab permanently "active", so the page is a prime discard candidate.
The bus therefore goes fully quiet while the document is hidden: after this grace delay it tears the sockets and timers down exactly like the pagehide path. The delay must be long enough that a quick app-switch (glance at a notification, copy a token) does not thrash reconnects, and short enough that a backgrounded tab is idle well before the OS starts reclaiming it — 60s satisfies both.
Exported so tests and future tuning share one source of truth.
*/
export const SSE_HIDDEN_SUSPEND_DELAY_MS = 60_000;

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
  /**
   * FNXC:DashboardSSE 2026-07-26-10:12:
   * Set while the tab has been hidden past SSE_HIDDEN_SUSPEND_DELAY_MS. Distinct from `closed`:
   * the socket and every timer are gone, but the subscriber set is intact and the channel stays
   * registered, so the visibilitychange reopen path can bring it back for the same consumers.
   * `openChannel` refuses to run while it is set so nothing (reconnect timers, late subscribes)
   * can re-establish traffic behind the suspend.
   *
   * FNXC:DashboardSSE 2026-07-26-16:20:
   * CORRECTION of the claim previously written here. This flag alone did NOT stop "late subscribes"
   * re-establishing traffic, and asserting that it did hid a real hole: `closeChannel` deletes the
   * channel when the last subscriber leaves, so a later `subscribeSse` for the same URL builds a
   * fresh channel with `suspended: false` and opens a socket plus a 30s keepalive for the rest of
   * the hidden window. Per-channel state cannot survive channel recreation. The authority is now
   * the module-level `isHiddenSuspendElapsed()` condition below; this flag is only the per-channel
   * record of "this channel was torn down by the suspend", used by the resume paths.
   */
  suspended: boolean;
  /**
   * FNXC:DashboardSSE 2026-07-26-16:20:
   * Pending staggered onReconnect fan-out timers (see `fanOutReconnect`). Tracked per channel so
   * teardown/suspend/close can cancel them: a hidden tab must hold NO armed timer, and a cancelled
   * reconnect must not deliver a resync signal into subscribers of a channel that no longer exists.
   */
  reconnectFanoutTimers: Set<ReturnType<typeof setTimeout>>;
}

const channels = new Map<string, Channel>();
let lastVisibilityReopenAt = 0;
let hiddenSuspendTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * FNXC:DashboardSSE 2026-07-26-16:20:
 * Timestamp of the transition into `hidden`, i.e. the anchor the suspend threshold is measured from.
 * Module-level (not per-channel) because it must survive a channel being destroyed and rebuilt by a
 * subscribe/unsubscribe cycle inside the hidden window.
 */
let hiddenSinceMs: number | null = null;

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

async function probeClientKeepalive(channel: Channel): Promise<"ok" | "definite-dead" | "inconclusive"> {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return "inconclusive";

  const url = createControlUrl(channel.url, "keepalive");
  if (!url) return "inconclusive";

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeout = controller
    ? window.setTimeout(() => controller.abort(), CLIENT_KEEPALIVE_TIMEOUT_MS)
    : null;

  try {
    const res = await window.fetch(url, {
      method: "POST",
      cache: "no-store",
      signal: controller?.signal,
    });
    return res.ok ? "ok" : "definite-dead";
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    return aborted ? "inconclusive" : "definite-dead";
  } finally {
    if (timeout !== null) {
      window.clearTimeout(timeout);
    }
  }
}

function sendClientKeepalive(channel: Channel): void {
  void probeClientKeepalive(channel);
}

function startClientKeepalive(channel: Channel): void {
  stopClientKeepalive(channel);
  if (!createControlUrl(channel.url, "keepalive")) return;

  sendClientKeepalive(channel);
  channel.keepaliveTimer = window.setInterval(() => {
    sendClientKeepalive(channel);
  }, CLIENT_KEEPALIVE_INTERVAL_MS);
}

/*
 * Close every EventSource when the page is unloading. Without this,
 * browsers keep the underlying TCP sockets open in their HTTP/1.1
 * keep-alive pool even though the JS EventSource object is gone —
 * the server never sees a close, connections pile up, and within a
 * few refreshes the browser hits its 6-connection-per-origin limit
 * and every subsequent fetch stalls. `pagehide` fires reliably on
 * bfcache navigations too, so it alone covers the teardown.
 *
 * FNXC:DashboardSSE 2026-07-26-10:20:
 * The companion `beforeunload` listener was REMOVED and must not be re-added. Registering a
 * beforeunload handler disqualifies the page from Safari's page cache / bfcache, so the mobile
 * dashboard paid a full cold restore (white splash, 2.8MB entry chunk re-parse) on every back
 * navigation and tab restore in exchange for nothing: `pagehide` already fires in every case
 * `beforeunload` does, including the unload path, and it is the only one of the two that fires
 * when the page is frozen into bfcache. Restore performance is the point of this deletion.
 */
/*
FNXC:DashboardSSE 2026-07-26-16:20:
Hidden-suspend authority, module-level rather than per-channel.

Requirement: once the document has been hidden past SSE_HIDDEN_SUSPEND_DELAY_MS the page must hold no
EventSource and no armed timer, because that background work is what makes a mobile browser discard the
tab (the operator sees a white-splash reload). The previous implementation enforced this with a
per-channel `suspended` flag armed by a single hidden-transition timer. Two gaps followed, both silent:
1. `hiddenSuspendTimer` is nulled when it fires, and only a hidden TRANSITION re-arms it — which cannot
   happen again while the tab is already hidden. A channel first subscribed during the hidden window was
   therefore created with `suspended: false` and opened a live socket + keepalive for the rest of it.
2. `closeChannel` deletes the channel at zero subscribers, so the flag itself is discarded by any
   subscribe/unsubscribe cycle.
Both are fixed by deriving suspension from `document.visibilityState` plus elapsed hidden time, which no
channel lifecycle event can reset, and by letting `openChannel` re-arm the grace timer when it opens a
channel during the grace window (so a channel born mid-window is still torn down at the threshold).
*/
function isHiddenSuspendElapsed(): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState !== "hidden") return false;
  if (hiddenSinceMs === null) return false;
  return Date.now() - hiddenSinceMs >= SSE_HIDDEN_SUSPEND_DELAY_MS;
}

/*
FNXC:DashboardSSE 2026-07-26-10:28:
Hidden-tab suspend. Only tears the transport down if the document is STILL hidden when the grace
timer expires, so app-switching away for a few seconds costs nothing. Subscribers and channel
registration survive; the module-level hidden condition blocks any reopen until the tab is visible.
*/
function suspendChannelsWhileHidden(): void {
  hiddenSuspendTimer = null;
  if (typeof document === "undefined" || document.visibilityState === "visible") return;

  const suspendable = Array.from(channels.values()).filter((c) => !c.closed && !c.suspended);
  if (suspendable.length === 0) return;

  console.info("[sse-bus] suspend-hidden", { channelCount: suspendable.length });
  pushTrace("sse-bus", "suspend-hidden", { channelCount: suspendable.length });
  for (const channel of suspendable) {
    tearDownChannelTransport(channel);
    channel.suspended = true;
  }
}

/** Arm (or re-arm) the grace timer for the REMAINDER of the current hidden window. */
function scheduleHiddenSuspend(): void {
  if (typeof document === "undefined" || document.visibilityState === "visible") return;
  if (hiddenSinceMs === null) hiddenSinceMs = Date.now();
  if (hiddenSuspendTimer) return;
  const remainingMs = Math.max(0, SSE_HIDDEN_SUSPEND_DELAY_MS - (Date.now() - hiddenSinceMs));
  hiddenSuspendTimer = setTimeout(suspendChannelsWhileHidden, remainingMs);
}

function clearHiddenSuspendState(): void {
  hiddenSinceMs = null;
  if (hiddenSuspendTimer) {
    clearTimeout(hiddenSuspendTimer);
    hiddenSuspendTimer = null;
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const closeAllChannels = () => {
    console.info("[sse-bus] pagehide", { channelCount: channels.size });
    pushTrace("sse-bus", "pagehide", { channelCount: channels.size });
    for (const channel of Array.from(channels.values())) {
      if (channel.closed) continue;
      tearDownChannelTransport(channel);
      channel.closed = true;
    }
  };

  const reopenSubscribedChannels = (event: PageTransitionEvent) => {
    console.info("[sse-bus] pageshow", { persisted: event.persisted, channelCount: channels.size });
    pushTrace("sse-bus", "pageshow", { persisted: event.persisted, channelCount: channels.size });
    recordResumeEvent({
      view: "sse-bus",
      trigger: "pageshow",
      replayAttempted: false,
      sseChannel: "all",
      detail: { persisted: event.persisted, channelCount: channels.size },
    });
    for (const channel of Array.from(channels.values())) {
      if (channel.subscribers.size === 0) continue;
      if (channel.es !== null && !channel.closed) continue;
      /*
      FNXC:DashboardSSE 2026-07-26-11:02:
      A bfcache restore can deliver `pageshow` without a preceding visibilitychange, so this path
      must also release the hidden-suspend — otherwise a page restored from bfcache would come back
      with permanently silent channels. Only release when the restored page is actually visible; a
      pageshow into a still-hidden document keeps the suspend.
      */
      if (document.visibilityState !== "hidden") {
        channel.suspended = false;
        clearHiddenSuspendState();
      }
      channel.closed = false;
      openChannel(channel);
    }
  };

  const reopenVisibleChannels = () => {
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (now - lastVisibilityReopenAt < VISIBILITY_REOPEN_DEDUPE_MS) return;
    lastVisibilityReopenAt = now;

    console.info("[sse-bus] visibilitychange", { visibilityState: document.visibilityState, channelCount: channels.size });
    pushTrace("sse-bus", "visibilitychange", { visibilityState: document.visibilityState, channelCount: channels.size });
    recordResumeEvent({
      view: "sse-bus",
      trigger: "visibility",
      replayAttempted: false,
      sseChannel: "all",
      detail: { visibilityState: document.visibilityState, channelCount: channels.size },
    });

    for (const channel of Array.from(channels.values())) {
      if (channel.subscribers.size === 0) continue;
      if (channel.suspended || channel.es === null || channel.es.readyState === EventSource.CLOSED) {
        /*
        FNXC:DashboardSSE 2026-07-26-10:34:
        Resume path for hidden-suspended channels. `suspended` must be cleared BEFORE openChannel or
        its suspend guard would refuse the reopen. Because `hasOpenedOnce` survives the suspend, the
        reopened stream's `open` handler fires each subscriber's onReconnect.

        FNXC:DashboardSSE 2026-07-26-14:05:
        CORRECTION of the claim previously written here. The old comment asserted that on reopen
        "consumers refetch authoritative state rather than trusting the gap". That was FALSE and must
        not be reintroduced: the bus cannot make a consumer resync, it can only signal. Every event
        the server emitted during the suspend window is gone — /api/events has no replay/Last-Event-ID
        buffer — so a subscriber with no `onReconnect` silently keeps whatever stale state it had. That
        cost real work: an approval raised while suspended never rendered its banner and the agent
        blocked forever on a decision nobody was shown.
        The ACTUAL contract: hidden-suspend is only safe for a channel whose every subscriber resyncs
        on reopen, and providing that resync is the SUBSCRIBER's responsibility (see SseSubscription:
        supply `onReconnect`, or declare `replaySafe: true` when the state is genuinely rebuilt from
        scratch by the stream itself).
        */
        channel.suspended = false;
        channel.closed = false;
        if (channel.es && channel.es.readyState === EventSource.CLOSED) {
          channel.es = null;
        }
        openChannel(channel);
        continue;
      }

      void probeClientKeepalive(channel).then((status) => {
        if (status === "definite-dead") {
          forceReconnect(channel, "external");
        }
      });
    }
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      clearHiddenSuspendState();
      reopenVisibleChannels();
      return;
    }
    scheduleHiddenSuspend();
  };

  window.addEventListener("pagehide", closeAllChannels);
  window.addEventListener("pageshow", reopenSubscribedChannels);
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

/**
 * FNXC:DashboardSSE 2026-07-26-10:24:
 * Shared transport teardown for pagehide and hidden-suspend: stop the keepalive interval and the
 * heartbeat/reconnect timers (a backgrounded tab must schedule NO work — pending timers are what
 * kept the page "active" and discardable), tell the server to reap the stream, and drop the socket
 * plus its native listeners. Native listeners are bound to the dead EventSource, so they must be
 * cleared or `reattachNativeListeners` would consider every event type already wired on reopen and
 * the resumed stream would deliver nothing.
 * Leaves `subscribers`, `hasOpenedOnce`, and channel registration untouched; callers decide whether
 * this was a permanent close or a resumable suspend.
 */
function tearDownChannelTransport(channel: Channel): void {
  stopClientKeepalive(channel);
  if (channel.heartbeatTimer) {
    clearTimeout(channel.heartbeatTimer);
    channel.heartbeatTimer = null;
  }
  if (channel.reconnectTimer) {
    clearTimeout(channel.reconnectTimer);
    channel.reconnectTimer = null;
  }
  cancelReconnectFanout(channel);
  sendDisconnectBeacon(channel);
  if (channel.es) {
    try {
      channel.es.close();
    } catch {
      // ignore
    }
    channel.es = null;
  }
  channel.nativeListeners.clear();
}

/*
FNXC:DashboardSSE 2026-07-26-16:20:
Staggered onReconnect fan-out.

Requirement: a reconnect must not issue every subscriber's resync fetch in one tick. ~28 subscribers now
declare `onReconnect`, and a browser allows ~6 concurrent HTTP/1.1 connections per origin. A same-tick
burst on a waking mobile radio saturates that pool, the EventSource reconnect cannot get a slot, it
errors, forceReconnect runs again, and the burst repeats every RECONNECT_DELAY_MS — the resume path
starves itself.

This is the SAME defect and the SAME remedy as the polling side's visible-edge stagger, so it uses the
SAME primitive: `visibleEdgeStaggerDelayMs` from `hooks/visibilitySuspension.ts` gives a deterministic
slot = (index % SLOTS) * STEP, derived from insertion order, no randomness, slot 0 synchronous so a
single subscriber is unchanged, and the spread bounded by the window regardless of subscriber count.

FNXC:DashboardSSE 2026-07-26-17:40:
CORRECTION — this block previously carried a private copy of the constants and the slot formula, marked
KNOWN DUPLICATION because the primitive was not yet exported. It is exported now and this file imports
it. Do NOT reintroduce local copies: the poll fan-out and the SSE fan-out burst on the SAME
visibilitychange against the SAME ~6-connection-per-origin cap, so two independently-tuned staggers
would each bound their own spread while leaving their union unbounded — which is the bug, not the fix.
A hand-copied helper that drifts from its original is the documented root cause of several defects in
this change set; one primitive, one place to tune it.
*/
function cancelReconnectFanout(channel: Channel): void {
  for (const timer of channel.reconnectFanoutTimers) clearTimeout(timer);
  channel.reconnectFanoutTimers.clear();
}

function fanOutReconnect(channel: Channel): void {
  const subs = Array.from(channel.subscribers).filter((sub) => !!sub.onReconnect);
  if (subs.length === 0) return;

  subs.forEach((sub, index) => {
    const delayMs = visibleEdgeStaggerDelayMs(index);
    if (delayMs === 0) {
      sub.onReconnect?.();
      return;
    }
    const timer = setTimeout(() => {
      channel.reconnectFanoutTimers.delete(timer);
      // Re-check at fire time: the channel may have been closed, suspended, replaced, or the
      // subscriber unmounted during the stagger window. A resync signal delivered after any of those
      // is either wasted work on a hidden tab or an update into a torn-down consumer.
      if (channel.closed || channel.suspended) return;
      if (channels.get(channel.url) !== channel) return;
      if (!channel.subscribers.has(sub)) return;
      sub.onReconnect?.();
    }, delayMs);
    channel.reconnectFanoutTimers.add(timer);
  });
}

function resetHeartbeat(channel: Channel): void {
  if (channel.heartbeatTimer) clearTimeout(channel.heartbeatTimer);
  channel.heartbeatTimer = setTimeout(() => {
    forceReconnect(channel, "heartbeat-timeout");
  }, HEARTBEAT_TIMEOUT_MS);
}

function forceReconnect(channel: Channel, cause: "heartbeat-timeout" | "error" | "external" = "external"): void {
  console.warn("[sse-bus] forceReconnect", {
    cause,
    url: channel.url,
    subscriberCount: channel.subscribers.size,
    hasOpenedOnce: channel.hasOpenedOnce,
  });
  pushTrace("sse-bus", "forceReconnect", {
    cause,
    url: channel.url,
    subscriberCount: channel.subscribers.size,
    hasOpenedOnce: channel.hasOpenedOnce,
  });
  recordResumeEvent({
    view: "sse-bus",
    trigger: "sse-reconnect",
    replayAttempted: false,
    sseChannel: channel.url,
    reason: cause,
  });
  if (channel.heartbeatTimer) {
    clearTimeout(channel.heartbeatTimer);
    channel.heartbeatTimer = null;
  }
  if (channel.es) {
    channel.es.close();
    channel.es = null;
  }
  stopClientKeepalive(channel);
  cancelReconnectFanout(channel);
  channel.nativeListeners.clear();

  // A suspended channel is deliberately quiet: never let a late error/heartbeat callback from the
  // torn-down EventSource schedule a reconnect while the tab is hidden.
  if (channel.closed || channel.suspended) return;
  if (channel.subscribers.size === 0 || channel.reconnectTimer) return;

  // Guard against reconnecting a channel that has been closed while the heartbeat timer fired.
  const ch = channels.get(channel.url);
  if (!ch || ch !== channel) return;

  /*
  FNXC:DashboardSSE 2026-07-26-16:20:
  The synchronous `for (const sub of channel.subscribers) sub.onReconnect?.()` that used to run here was
  REMOVED and must not be reinstated. It made every reconnect cycle fire onReconnect TWICE ~3s apart: once
  here, and again when the reconnect's EventSource opened (the `open` handler treats any open after the
  first as a reconnect). With expensive handlers now wired to it — AgentDetailView refetches an unbounded
  run log and replaces its whole buffer — a 1500-entry log was refetched twice per reconnect, and
  `useAgentLogs`' resyncInFlightRef only dedupes OVERLAPPING resyncs, not two 3s apart.
  The successful `open` is now the single authority, for two reasons: (1) a reconnect that never succeeds
  must not claim to have resynced, and (2) firing here put the resync burst BEFORE the EventSource had a
  connection slot, so the burst competed with the reconnect it was supposed to follow — the exact
  pool-starvation loop the staggered fan-out exists to prevent. A failed attempt errors and re-enters
  forceReconnect, so each cycle still ends in exactly one signal once the stream is actually back.
  */

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
  pushTrace("sse-bus", "openChannel", {
    url: channel.url,
    subscriberCount: channel.subscribers.size,
    hasOpenedOnce: channel.hasOpenedOnce,
    closed: channel.closed,
    hasEventSource: channel.es !== null,
  });
  recordResumeEvent({
    view: "sse-bus",
    trigger: "sse-open",
    replayAttempted: false,
    sseChannel: channel.url,
    detail: {
      subscriberCount: channel.subscribers.size,
      hasOpenedOnce: channel.hasOpenedOnce,
      closed: channel.closed,
      hasEventSource: channel.es !== null,
    },
  });
  console.info("[sse-bus] openChannel", {
    url: channel.url,
    subscriberCount: channel.subscribers.size,
    hasOpenedOnce: channel.hasOpenedOnce,
    closed: channel.closed,
  });
  if (channel.es) return;
  if (channel.closed) return;
  // Hidden-suspended: the only legitimate reopen is the visibilitychange/pageshow resume path, which
  // clears `suspended` first. Everything else (reconnect timers, a component subscribing while the tab
  // is backgrounded) must stay quiet so the page keeps no live connection while hidden.
  if (channel.suspended) return;
  /*
  FNXC:DashboardSSE 2026-07-26-16:20:
  Module-level suspend gate. A channel created DURING the hidden window (a component subscribing to a
  URL nobody held, or a subscribe/unsubscribe cycle that deleted and rebuilt the channel) starts with
  `suspended: false`, so the per-channel flag alone let it open a socket and a 30s keepalive for the
  rest of the hidden period — reinstating exactly the background work the suspend exists to remove.
  Mark it suspended so the resume paths adopt it like any other suspended channel.
  */
  if (isHiddenSuspendElapsed()) {
    channel.suspended = true;
    pushTrace("sse-bus", "openChannel-blocked-hidden", { url: channel.url });
    return;
  }
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
  // Opened inside the grace window: re-arm the suspend timer for its remainder so a channel born
  // mid-window is still torn down at the threshold (the hidden transition that armed the original
  // timer cannot fire again while the tab stays hidden).
  scheduleHiddenSuspend();

  es.addEventListener("open", () => {
    resetHeartbeat(channel);
    const reconnect = channel.hasOpenedOnce;
    channel.hasOpenedOnce = true;
    // onOpen is a cheap connection-status signal — no stagger. onReconnect triggers refetches, so it
    // goes through the staggered fan-out.
    for (const sub of channel.subscribers) sub.onOpen?.();
    if (reconnect) fanOutReconnect(channel);
  });

  es.addEventListener("error", (event) => {
    for (const sub of channel.subscribers) sub.onError?.(event);
    recordResumeEvent({
      view: "sse-bus",
      trigger: "sse-error",
      replayAttempted: false,
      sseChannel: channel.url,
      reason: "error",
    });
    // Any error triggers a forced reconnect cycle — matches the pre-bus
    // behavior in useTasks and ensures the stream recovers even when
    // EventSource's own retry has stalled.
    forceReconnect(channel, "error");
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
  pushTrace("sse-bus", "closeChannel", {
    url: channel.url,
    subscriberCount: channel.subscribers.size,
    hasOpenedOnce: channel.hasOpenedOnce,
  });
  console.info("[sse-bus] closeChannel", {
    url: channel.url,
    subscriberCount: channel.subscribers.size,
    hasOpenedOnce: channel.hasOpenedOnce,
  });
  channel.closed = true;
  if (channel.heartbeatTimer) clearTimeout(channel.heartbeatTimer);
  stopClientKeepalive(channel);
  cancelReconnectFanout(channel);
  if (channel.reconnectTimer) clearTimeout(channel.reconnectTimer);
  if (channel.es) channel.es.close();
  channel.es = null;
  channel.nativeListeners.clear();
  channels.delete(channel.url);
}

/*
FNXC:DashboardSSE 2026-07-26-14:12:
Missed-event contract for every subscriber. The stream is lossy by construction: an error/heartbeat
reconnect and the hidden-tab suspend both drop the socket, and the server keeps no replay buffer, so
events emitted while the socket is down are never delivered. A subscriber that mutates state ONLY
from event handlers therefore diverges permanently from the server.
Every subscription must declare how it survives that gap: supply `onReconnect` (refetch authoritative
state — the normal answer), or set `replaySafe: true` with a reason when the subscriber genuinely has
nothing to resync. Non-compliant subscriptions warn in dev and are reported by `__sseBusResyncAudit`.
*/
export interface SseSubscription {
  /** Map of named SSE event type → handler. */
  events?: Record<string, MessageListener>;
  /** Fires on every successful open (initial + reconnect). */
  onOpen?: OpenListener;
  /**
   * Fires only on reconnects (not the initial open), including the hidden-suspend resume.
   * Refetch authoritative state here — anything derived only from events is stale by then.
   */
  onReconnect?: OpenListener;
  /** Forwarded EventSource error events. */
  onError?: ErrorListener;
  /**
   * Explicit opt-out of the resync contract, for subscribers that hold no state a missed event
   * could corrupt (pure relays, connection-status-only consumers). Must carry a reason so the
   * exemption is reviewable rather than a silent omission.
   */
  replaySafe?: { reason: string };
}

/** Subscriptions seen without a resync path, keyed by URL. Test/diagnostics only. */
const resyncGapsByUrl = new Map<string, number>();

function auditResyncContract(url: string, sub: SseSubscription): void {
  const hasEvents = !!sub.events && Object.keys(sub.events).length > 0;
  if (!hasEvents) return;
  if (sub.onReconnect || sub.replaySafe) return;

  resyncGapsByUrl.set(url, (resyncGapsByUrl.get(url) ?? 0) + 1);
  // Dev-only: loud enough to catch a new non-resyncing subscriber during development, silent in the
  // test build so it cannot spam unrelated suites.
  if (import.meta.env?.DEV && import.meta.env?.MODE !== "test") {
    console.warn(
      "[sse-bus] subscriber has no resync path; events missed during a reconnect or hidden-tab suspend will be lost. Add onReconnect (refetch) or replaySafe: { reason }.",
      { url, events: Object.keys(sub.events ?? {}) },
    );
  }
}

/** Test-only: URLs whose subscribers declared neither onReconnect nor replaySafe. */
export function __sseBusResyncAudit(): Record<string, number> {
  return Object.fromEntries(resyncGapsByUrl);
}

/**
 * Subscribe to an SSE URL. All subscribers of the same URL share a single
 * underlying EventSource. Returns an unsubscribe function; when the last
 * subscriber unsubscribes, the connection is closed.
 */
export function subscribeSse(url: string, sub: SseSubscription = {}): () => void {
  auditResyncContract(url, sub);
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
      suspended: false,
      reconnectFanoutTimers: new Set(),
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
  resyncGapsByUrl.clear();
  memoryClientId = null;
  lastVisibilityReopenAt = 0;
  // The hidden-suspend grace timer and its hidden-since anchor outlive channels; leaving either set
  // retains a handle and can fire into (or silently suspend) a later test file's bus.
  clearHiddenSuspendState();
}

/** Test-only: inspect the number of live channels. */
export function __sseBusChannelCount(): number {
  return channels.size;
}

/** Test-only: observe hidden-suspend state and live timers for a channel. */
export function __sseBusChannelState(
  url: string,
): { suspended: boolean; closed: boolean; hasEventSource: boolean; hasKeepaliveTimer: boolean } | undefined {
  const channel = channels.get(url);
  if (!channel) return undefined;
  return {
    suspended: channel.suspended,
    closed: channel.closed,
    hasEventSource: channel.es !== null,
    hasKeepaliveTimer: channel.keepaliveTimer !== null,
  };
}
