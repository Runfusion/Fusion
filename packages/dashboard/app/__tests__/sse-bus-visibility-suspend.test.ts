/*
FNXC:DashboardSSE 2026-07-26-10:55:
Regression coverage for the hidden-tab SSE suspend. The requirement it guards: a backgrounded mobile
tab must schedule NO SSE work (no open EventSource, no keepalive interval, no heartbeat reconnect)
once it has been hidden past the grace delay, because that background work is a primary OS/browser
page-discard signal and the discard is what the operator sees as a white-splash reload. It also pins
the bfcache requirement that no `beforeunload` listener is registered.
Fake timers only — the grace delay is 60s of wall clock.
*/
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { MockEventSource } from "../../vitest.setup";
import {
  subscribeSse,
  __resetSseBus,
  __sseBusChannelState,
  SSE_HIDDEN_SUSPEND_DELAY_MS,
} from "../sse-bus";

const URL_A = "/api/events?projectId=suspend-test";

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

/**
 * Advance `ms` while feeding the server heartbeats a real /api/events stream would send, so these
 * assertions isolate the suspend behavior instead of tripping the unrelated 45s heartbeat timeout.
 */
function advanceWithHeartbeats(ms: number, es: MockEventSource): void {
  const STEP_MS = 20_000;
  let remaining = ms;
  while (remaining > STEP_MS) {
    vi.advanceTimersByTime(STEP_MS);
    es._emit("heartbeat");
    remaining -= STEP_MS;
  }
  vi.advanceTimersByTime(remaining);
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  __resetSseBus();
  setVisibility("visible");
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("sse-bus hidden-tab suspend", () => {
  it("closes channels after the grace period while the tab stays hidden", () => {
    subscribeSse(URL_A, { events: { "task:updated": () => {} } });
    const es = MockEventSource.instances[0]!;
    expect(__sseBusChannelState(URL_A)).toMatchObject({ suspended: false, hasEventSource: true });

    setVisibility("hidden");
    // Still connected during the grace window.
    advanceWithHeartbeats(SSE_HIDDEN_SUSPEND_DELAY_MS - 1, es);
    expect(__sseBusChannelState(URL_A)).toMatchObject({ suspended: false, hasEventSource: true });
    expect(es.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(es.close).toHaveBeenCalled();
    expect(__sseBusChannelState(URL_A)).toMatchObject({
      suspended: true,
      closed: false,
      hasEventSource: false,
    });
  });

  it("stops the keepalive interval while suspended so nothing fires when hidden", () => {
    subscribeSse(URL_A, {});
    const es = MockEventSource.instances[0]!;
    expect(__sseBusChannelState(URL_A)?.hasKeepaliveTimer).toBe(true);

    setVisibility("hidden");
    advanceWithHeartbeats(SSE_HIDDEN_SUSPEND_DELAY_MS, es);

    expect(__sseBusChannelState(URL_A)?.hasKeepaliveTimer).toBe(false);

    // A long hidden stretch must not resurrect the socket via heartbeat/reconnect timers.
    const instanceCount = MockEventSource.instances.length;
    vi.advanceTimersByTime(10 * SSE_HIDDEN_SUSPEND_DELAY_MS);
    expect(MockEventSource.instances).toHaveLength(instanceCount);
    expect(__sseBusChannelState(URL_A)?.hasEventSource).toBe(false);
  });

  it("does not close when the tab becomes visible before the grace period expires", () => {
    subscribeSse(URL_A, {});
    const es = MockEventSource.instances[0]!;

    setVisibility("hidden");
    advanceWithHeartbeats(SSE_HIDDEN_SUSPEND_DELAY_MS / 2, es);
    setVisibility("visible");
    advanceWithHeartbeats(SSE_HIDDEN_SUSPEND_DELAY_MS * 2, es);

    expect(es.close).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(1);
    expect(__sseBusChannelState(URL_A)).toMatchObject({ suspended: false, hasEventSource: true });
  });

  it("reopens suspended channels on visible and signals subscribers to resync", () => {
    const onReconnect = vi.fn();
    subscribeSse(URL_A, { events: { "task:updated": () => {} }, onReconnect });
    // The real EventSource fires `open` on connect; the mock does not, and `hasOpenedOnce` is what
    // turns the post-resume open into an onReconnect resync signal.
    MockEventSource.instances[0]!._emit("open");
    expect(onReconnect).not.toHaveBeenCalled();

    setVisibility("hidden");
    advanceWithHeartbeats(SSE_HIDDEN_SUSPEND_DELAY_MS, MockEventSource.instances[0]!);
    expect(__sseBusChannelState(URL_A)?.suspended).toBe(true);

    setVisibility("visible");

    expect(MockEventSource.instances).toHaveLength(2);
    expect(__sseBusChannelState(URL_A)).toMatchObject({
      suspended: false,
      hasEventSource: true,
      hasKeepaliveTimer: true,
    });

    // Events missed while suspended are recovered by the reconnect resync signal.
    const reopened = MockEventSource.instances[1]!;
    reopened._emit("open");
    expect(onReconnect).toHaveBeenCalled();
  });

  it("delivers events again on the reopened stream", () => {
    const received: unknown[] = [];
    subscribeSse(URL_A, { events: { "task:updated": (e) => received.push(JSON.parse(e.data)) } });

    setVisibility("hidden");
    advanceWithHeartbeats(SSE_HIDDEN_SUSPEND_DELAY_MS, MockEventSource.instances[0]!);
    setVisibility("visible");

    const reopened = MockEventSource.instances[1]!;
    reopened._emit("task:updated", { id: "t-9" });

    expect(received).toEqual([{ id: "t-9" }]);
  });

  it("releases the suspend on a bfcache pageshow that arrives without a visibilitychange", () => {
    subscribeSse(URL_A, {});

    setVisibility("hidden");
    advanceWithHeartbeats(SSE_HIDDEN_SUSPEND_DELAY_MS, MockEventSource.instances[0]!);
    expect(__sseBusChannelState(URL_A)?.suspended).toBe(true);

    // Restored from bfcache: the page is visible again but no visibilitychange was delivered.
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));

    expect(__sseBusChannelState(URL_A)).toMatchObject({ suspended: false, hasEventSource: true });
  });

  /*
  FNXC:DashboardSSE 2026-07-26-16:20:
  A channel that is first subscribed (or rebuilt by a subscribe/unsubscribe cycle) DURING the hidden
  window must not open a socket. The suspend used to be per-channel state armed by a single hidden
  transition, so both of these cases produced a live EventSource plus a 30s keepalive for the rest of
  the background period — the background work the whole suspend exists to remove, and invisible because
  the tab looks idle from the UI.
  */
  it("does not open an EventSource for a channel first subscribed while already hidden", () => {
    setVisibility("hidden");
    vi.advanceTimersByTime(SSE_HIDDEN_SUSPEND_DELAY_MS);
    const instancesBefore = MockEventSource.instances.length;

    const unsub = subscribeSse(URL_A, { events: { "task:updated": () => {} }, onReconnect: () => {} });

    expect(MockEventSource.instances).toHaveLength(instancesBefore);
    expect(__sseBusChannelState(URL_A)).toMatchObject({
      suspended: true,
      hasEventSource: false,
      hasKeepaliveTimer: false,
    });

    // A long hidden stretch must not resurrect it either.
    vi.advanceTimersByTime(10 * SSE_HIDDEN_SUSPEND_DELAY_MS);
    expect(MockEventSource.instances).toHaveLength(instancesBefore);

    // ...and it still comes back on the visible edge, so the suspend is not a silent permanent mute.
    setVisibility("visible");
    expect(__sseBusChannelState(URL_A)).toMatchObject({ suspended: false, hasEventSource: true });
    unsub();
  });

  it("does not let a subscribe/unsubscribe cycle rebuild a live channel while hidden", () => {
    const unsubFirst = subscribeSse(URL_A, { events: { "task:updated": () => {} } });

    setVisibility("hidden");
    advanceWithHeartbeats(SSE_HIDDEN_SUSPEND_DELAY_MS, MockEventSource.instances[0]!);
    expect(__sseBusChannelState(URL_A)?.suspended).toBe(true);

    // Last subscriber leaves: closeChannel DELETES the channel, discarding its `suspended` flag.
    unsubFirst();
    expect(__sseBusChannelState(URL_A)).toBeUndefined();

    const instancesBefore = MockEventSource.instances.length;
    const unsubSecond = subscribeSse(URL_A, { events: { "task:updated": () => {} } });

    expect(MockEventSource.instances).toHaveLength(instancesBefore);
    expect(__sseBusChannelState(URL_A)).toMatchObject({ suspended: true, hasEventSource: false });
    unsubSecond();
  });

  it("suspends a channel that was opened inside the grace window", () => {
    setVisibility("hidden");
    // Half a grace window in, a component mounts and subscribes: opening is allowed (the tab may be
    // coming right back), but the channel must still be torn down at the original threshold rather
    // than surviving because the hidden transition that armed the timer already passed.
    vi.advanceTimersByTime(SSE_HIDDEN_SUSPEND_DELAY_MS / 2);
    const unsub = subscribeSse(URL_A, { events: { "task:updated": () => {} } });
    expect(__sseBusChannelState(URL_A)).toMatchObject({ suspended: false, hasEventSource: true });

    advanceWithHeartbeats(SSE_HIDDEN_SUSPEND_DELAY_MS, MockEventSource.instances.at(-1)!);

    expect(__sseBusChannelState(URL_A)).toMatchObject({
      suspended: true,
      hasEventSource: false,
      hasKeepaliveTimer: false,
    });
    unsub();
  });

  /*
  FNXC:DashboardSSE 2026-07-26-16:20:
  onReconnect is a refetch trigger, so firing it twice per reconnect doubles every subscriber's resync
  cost (AgentDetailView refetches an unbounded run log and replaces its whole buffer). It used to fire
  once synchronously in forceReconnect and again ~3s later when the replacement stream opened.
  */
  it("fires onReconnect exactly once per reconnect cycle, including the forceReconnect path", () => {
    const onReconnect = vi.fn();
    const unsub = subscribeSse(URL_A, { events: { "task:updated": () => {} }, onReconnect });

    const first = MockEventSource.instances[0]!;
    first._emit("open");
    expect(onReconnect).not.toHaveBeenCalled();

    first._emit("error");
    // An attempt that has not reconnected yet must not claim to have resynced.
    expect(onReconnect).not.toHaveBeenCalled();

    // RECONNECT_DELAY_MS.
    vi.advanceTimersByTime(3_000);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(onReconnect).not.toHaveBeenCalled();

    MockEventSource.instances[1]!._emit("open");
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // No delayed second signal from the other authority.
    vi.advanceTimersByTime(10_000);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    unsub();
  });

  /*
  FNXC:DashboardSSE 2026-07-26-16:20:
  ~28 subscribers declare onReconnect. Firing them in one tick issues ~28 fetches against a ~6
  connection-per-origin cap on a waking mobile radio, starving the EventSource reconnect that is
  competing for the same pool and looping the failure every RECONNECT_DELAY_MS. The fan-out is
  staggered on the same deterministic slot scheme as the polling side's visible-edge stagger.
  */
  it("staggers the reconnect fan-out instead of firing every subscriber in one tick", () => {
    const calls: number[] = [];
    const unsubs = Array.from({ length: 5 }, (_, i) =>
      subscribeSse(URL_A, { events: { "task:updated": () => {} }, onReconnect: () => calls.push(i) }),
    );

    MockEventSource.instances[0]!._emit("open");
    MockEventSource.instances[0]!._emit("error");
    vi.advanceTimersByTime(3_000);
    MockEventSource.instances[1]!._emit("open");

    // Slot 0 stays synchronous so a single subscriber is unchanged; the rest are spread.
    expect(calls).toEqual([0]);
    vi.advanceTimersByTime(150);
    expect(calls).toEqual([0, 1]);
    vi.advanceTimersByTime(150);
    expect(calls).toEqual([0, 1, 2]);
    vi.advanceTimersByTime(300);
    expect(calls).toEqual([0, 1, 2, 3, 4]);

    for (const unsub of unsubs) unsub();
  });

  it("drops a pending staggered resync for a subscriber that unmounted during the window", () => {
    const calls: number[] = [];
    const unsubs = Array.from({ length: 5 }, (_, i) =>
      subscribeSse(URL_A, { events: { "task:updated": () => {} }, onReconnect: () => calls.push(i) }),
    );

    MockEventSource.instances[0]!._emit("open");
    MockEventSource.instances[0]!._emit("error");
    vi.advanceTimersByTime(3_000);
    MockEventSource.instances[1]!._emit("open");

    vi.advanceTimersByTime(150);
    expect(calls).toEqual([0, 1]);

    // Deferring the fan-out means a subscriber can unmount before its slot; the delayed signal must
    // not land in a torn-down consumer.
    unsubs[3]!();
    vi.advanceTimersByTime(1_000);
    expect(calls).toEqual([0, 1, 2, 4]);

    for (const [i, unsub] of unsubs.entries()) if (i !== 3) unsub();
  });

  it("cancels every pending staggered resync when the channel closes mid-window", () => {
    const calls: number[] = [];
    const unsubs = Array.from({ length: 5 }, (_, i) =>
      subscribeSse(URL_A, { events: { "task:updated": () => {} }, onReconnect: () => calls.push(i) }),
    );

    MockEventSource.instances[0]!._emit("open");
    MockEventSource.instances[0]!._emit("error");
    vi.advanceTimersByTime(3_000);
    MockEventSource.instances[1]!._emit("open");
    expect(calls).toEqual([0]);

    for (const unsub of unsubs) unsub();
    vi.advanceTimersByTime(5_000);

    expect(calls).toEqual([0]);
  });

  it("registers no beforeunload listener on either EventSource path (bfcache eligibility)", async () => {
    const spy = vi.spyOn(window, "addEventListener");
    try {
      vi.resetModules();
      await import("../sse-bus");
      await import("../api/event-source");
      const types = spy.mock.calls.map(([type]) => type);
      expect(types).not.toContain("beforeunload");
      expect(types).toContain("pagehide");
    } finally {
      spy.mockRestore();
      vi.resetModules();
    }
  });
});
