import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { MockEventSource } from "../../vitest.setup";
import { subscribeSse, __resetSseBus, __sseBusChannelCount } from "../sse-bus";
import { clearTraces, getTraces } from "../utils/dashboardTraceBuffer";

function expectEventsUrl(url: string, projectId?: string): void {
  const parsed = new URL(url, "http://localhost");
  expect(parsed.pathname).toBe("/api/events");
  expect(parsed.searchParams.get("projectId")).toBe(projectId ?? null);
  expect(parsed.searchParams.get("clientId")).toBeTruthy();
}

beforeEach(() => {
  window.sessionStorage.clear();
  clearTraces();
});

afterEach(() => {
  __resetSseBus();
});

describe("sse-bus", () => {
  it("opens one EventSource per URL regardless of subscriber count", () => {
    const url = "/api/events?projectId=p1";
    const unsubA = subscribeSse(url, { events: { "task:created": () => {} } });
    const unsubB = subscribeSse(url, { events: { "task:updated": () => {} } });
    const unsubC = subscribeSse(url, { events: { "task:deleted": () => {} } });

    const sources = MockEventSource.instances.filter((es) => {
      expectEventsUrl(es.url, "p1");
      return true;
    });
    expect(sources).toHaveLength(1);

    unsubA();
    unsubB();
    unsubC();
  });

  it("opens separate EventSources for different URLs", () => {
    const unsubA = subscribeSse("/api/events", {});
    const unsubB = subscribeSse("/api/events?projectId=p1", {});
    expect(MockEventSource.instances).toHaveLength(2);
    expectEventsUrl(MockEventSource.instances[0]!.url);
    expectEventsUrl(MockEventSource.instances[1]!.url, "p1");
    unsubA();
    unsubB();
  });

  it("dispatches events to every subscriber of the same URL", () => {
    const url = "/api/events";
    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];
    const unsubA = subscribeSse(url, {
      events: { "task:created": (e) => receivedA.push(JSON.parse(e.data)) },
    });
    const unsubB = subscribeSse(url, {
      events: { "task:created": (e) => receivedB.push(JSON.parse(e.data)) },
    });

    const es = MockEventSource.instances[0];
    es._emit("task:created", { id: "t-1" });

    expect(receivedA).toEqual([{ id: "t-1" }]);
    expect(receivedB).toEqual([{ id: "t-1" }]);

    unsubA();
    unsubB();
  });

  it("closes the EventSource when the last subscriber unsubscribes", () => {
    const url = "/api/events";
    const unsubA = subscribeSse(url, {});
    const unsubB = subscribeSse(url, {});
    expect(__sseBusChannelCount()).toBe(1);

    const es = MockEventSource.instances[0];
    unsubA();
    expect(es.close).not.toHaveBeenCalled();

    unsubB();
    expect(es.close).toHaveBeenCalledTimes(1);
    expect(__sseBusChannelCount()).toBe(0);
  });

  it("stops dispatching to a subscriber after it unsubscribes", () => {
    const url = "/api/events";
    const received: unknown[] = [];
    const unsub = subscribeSse(url, {
      events: { "task:created": (e) => received.push(JSON.parse(e.data)) },
    });

    const es = MockEventSource.instances[0];
    es._emit("task:created", { id: "t-1" });
    expect(received).toEqual([{ id: "t-1" }]);

    unsub();
    // Another subscriber keeps the channel alive so we can assert the old handler is gone.
    const unsub2 = subscribeSse(url, {});
    es._emit("task:created", { id: "t-2" });
    expect(received).toEqual([{ id: "t-1" }]);
    unsub2();
  });

  it("attaches native listeners lazily as new event types are subscribed", () => {
    const url = "/api/events";
    const unsubA = subscribeSse(url, { events: { "task:created": () => {} } });
    const es = MockEventSource.instances[0];
    expect(Object.keys(es.listeners)).toEqual(
      expect.arrayContaining(["task:created"])
    );
    expect(es.listeners["task:updated"]).toBeUndefined();

    const unsubB = subscribeSse(url, { events: { "task:updated": () => {} } });
    expect(es.listeners["task:updated"]).toBeDefined();

    unsubA();
    unsubB();
  });

  it("fires onOpen for every subscriber on initial connect", () => {
    const url = "/api/events";
    let opensA = 0;
    let opensB = 0;
    const unsubA = subscribeSse(url, { onOpen: () => opensA++ });
    const unsubB = subscribeSse(url, { onOpen: () => opensB++ });

    const es = MockEventSource.instances[0];
    es._emit("open");

    expect(opensA).toBe(1);
    expect(opensB).toBe(1);

    unsubA();
    unsubB();
  });

  /*
  FNXC:DashboardSSE 2026-07-26-11:20:
  onReconnect now fires when the REBUILT stream actually opens, not at the moment the old one errored.
  A failed reconnect attempt must not claim to have resynced, and the old synchronous signal fired
  BEFORE the replacement EventSource had a connection slot, so the resync burst competed with the
  reconnect it was meant to follow. The test therefore has to drive the reconnect timer and emit `open`
  on the replacement stream — vitest.setup's MockEventSource marks itself OPEN in its constructor but
  never dispatches `open`, unlike a real EventSource.
  */
  it("fires onReconnect once the rebuilt channel actually opens, not when it fails", () => {
    vi.useFakeTimers();
    try {
      const url = "/api/events";
      let reconnects = 0;
      const unsub = subscribeSse(url, {
        onReconnect: () => reconnects++,
      });
      const es = MockEventSource.instances[0];
      // The channel must have genuinely connected once before a later `open` counts as a RE-connect.
      es._emit("open");
      expect(reconnects).toBe(0);
      // A transport error alone is not proof of a resync.
      es._emit("error");
      expect(reconnects).toBe(0);

      // The scheduled reconnect builds a replacement stream; only its `open` is authoritative.
      vi.advanceTimersByTime(3_000);
      expect(MockEventSource.instances.length).toBeGreaterThan(1);
      MockEventSource.instances[MockEventSource.instances.length - 1]._emit("open");
      expect(reconnects).toBe(1);
      unsub();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not set a reconnect timer after closeChannel is called", () => {
    vi.useFakeTimers();
    const url = "/api/events";
    const unsub = subscribeSse(url, { events: { "task:created": () => {} } });
    const es = MockEventSource.instances[0];

    // Simulate an error which triggers forceReconnect (and schedules reconnect timer)
    es._emit("error");

    // Immediately unsubscribe (triggers closeChannel which sets closed=true)
    unsub();

    // Advance timers past RECONNECT_DELAY_MS (3 seconds)
    vi.advanceTimersByTime(4_000);

    // No new EventSource should be created — the closed flag prevented reconnect
    expect(MockEventSource.instances).toHaveLength(1);
    vi.useRealTimers();
  });

  it("does not leak channels on rapid subscribe/unsubscribe cycles", () => {
    const url = "/api/events";
    for (let i = 0; i < 5; i++) {
      const unsub = subscribeSse(url, { events: { "task:created": () => {} } });
      unsub();
    }
    expect(__sseBusChannelCount()).toBe(0);
    const countBeforeTimers = MockEventSource.instances.length;
    vi.useFakeTimers();
    vi.advanceTimersByTime(4_000);
    vi.useRealTimers();
    expect(MockEventSource.instances.length).toBe(countBeforeTimers);
  });

  it("does not storm keepalive control requests for active local event streams", () => {
    vi.useFakeTimers();
    const originalFetch = window.fetch;
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    Object.defineProperty(window, "fetch", {
      configurable: true,
      writable: true,
      value: fetchMock,
    });
    try {
      const unsub = subscribeSse("/api/events", {});

      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(29_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      unsub();
    } finally {
      Object.defineProperty(window, "fetch", {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
      vi.useRealTimers();
    }
  });

  it("reopens subscribed channel on pageshow even when event.persisted is false", () => {
    subscribeSse("/api/events?projectId=p1", {});
    expect(MockEventSource.instances).toHaveLength(1);

    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));

    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("does not reopen on pageshow when there are no subscribers", () => {
    const unsub = subscribeSse("/api/events", {});
    unsub();
    const count = MockEventSource.instances.length;

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));

    expect(MockEventSource.instances).toHaveLength(count);
  });

  it("reopens null channels on visibilitychange visible", () => {
    subscribeSse("/api/events", {});
    window.dispatchEvent(new Event("pagehide"));

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("reopens CLOSED channels on visibilitychange visible", () => {
    subscribeSse("/api/events", {});
    const first = MockEventSource.instances[0]!;
    first.readyState = MockEventSource.CLOSED;

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(MockEventSource.instances).toHaveLength(2);
  });

  it("does not reopen on visibilitychange hidden", () => {
    subscribeSse("/api/events", {});
    const count = MockEventSource.instances.length;

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(MockEventSource.instances).toHaveLength(count);
  });

  it("pushes traces for pageshow, visibilitychange, and forceReconnect", () => {
    subscribeSse("/api/events", {});
    const first = MockEventSource.instances[0]!;

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    first._emit("error");

    const events = getTraces().map((entry) => entry.event);
    expect(events).toContain("pageshow");
    expect(events).toContain("visibilitychange");
    expect(events).toContain("forceReconnect");
  });
});
