import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { MockEventSource } from "../../vitest.setup";
import { subscribeSse, __resetSseBus, __sseBusChannelCount } from "../sse-bus";

function expectEventsUrl(url: string, projectId?: string): void {
  const parsed = new URL(url, "http://localhost");
  expect(parsed.pathname).toBe("/api/events");
  expect(parsed.searchParams.get("projectId")).toBe(projectId ?? null);
  expect(parsed.searchParams.get("clientId")).toBeTruthy();
}

beforeEach(() => {
  window.sessionStorage.clear();
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

  it("fires onReconnect whenever the channel is rebuilt", () => {
    const url = "/api/events";
    let reconnects = 0;
    const unsub = subscribeSse(url, {
      onReconnect: () => reconnects++,
    });
    const es = MockEventSource.instances[0];
    // An error that tears down the connection triggers a resync signal.
    es._emit("error");
    expect(reconnects).toBe(1);
    unsub();
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
    // After 5 subscribe/unsubscribe cycles the channel has been opened and closed 5
    // times, creating 5 EventSource instances (channel is deleted from the map on
    // every unsubscribe). The key leak concern is zombie reconnect timers — verify
    // no additional instances are created when reconnect delay fires after teardown.
    const countBeforeTimers = MockEventSource.instances.length;
    vi.useFakeTimers();
    vi.advanceTimersByTime(4_000);
    vi.useRealTimers();
    // No new instances should be created by the (blocked) reconnect timer
    expect(MockEventSource.instances.length).toBe(countBeforeTimers);
  });
});
