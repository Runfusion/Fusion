import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectMissionInterviewStream } from "../legacy";

class MockEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: MockEventSource[] = [];

  url: string;
  readyState = MockEventSource.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = MockEventSource.CLOSED;
  });

  private listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(eventName: string, listener: EventListener) {
    const listeners = this.listeners.get(eventName) ?? [];
    listeners.push(listener as (event: MessageEvent) => void);
    this.listeners.set(eventName, listeners);
  }

  dispatch(eventName: string, data = "", lastEventId = "") {
    const event = { data, lastEventId } as MessageEvent;
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(event);
    }
  }
}

describe("connectMissionInterviewStream", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function connect(handlers: Partial<Parameters<typeof connectMissionInterviewStream>[2]> = {}, options?: { maxReconnectAttempts?: number }) {
    const onError = vi.fn();
    const onComplete = vi.fn();
    const connection = connectMissionInterviewStream("mission-session-1", undefined, { onError, onComplete, ...handlers }, options);
    const source = MockEventSource.instances[0];
    return { connection, source, onError, onComplete };
  }

  it.each([
    ["JSON message", JSON.stringify({ message: "The model rejected the prompt." }), "The model rejected the prompt."],
    ["JSON error fallback", JSON.stringify({ error: "Provider is unavailable." }), "Provider is unavailable."],
    ["JSON string", JSON.stringify("Please try again later."), "Please try again later."],
    ["non-JSON text", "Temporary outage", "Temporary outage"],
    ["empty data", "", "The mission interview stream was interrupted. Please retry the session."],
    ["generic stream error", "Stream error", "The mission interview stream was interrupted. Please retry the session."],
    ["JSON primitive", JSON.stringify(500), "The mission interview stream was interrupted. Please retry the session."],
  ])("normalizes terminal error payloads: %s", (_name, data, expected) => {
    const { source, onError } = connect();

    source.dispatch("error", data);

    expect(onError).toHaveBeenCalledWith(expected);
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("dedupes late terminal events and closes the stale EventSource once", () => {
    const { source, onError, onComplete } = connect();

    source.dispatch("error", JSON.stringify({ message: "First failure" }), "1");
    source.dispatch("error", JSON.stringify({ message: "Second failure" }), "2");
    source.dispatch("complete", "", "3");

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("First failure");
    expect(onComplete).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("reports fatal reconnect exhaustion through the same recoverable error path", () => {
    const { source, onError } = connect({}, { maxReconnectAttempts: 0 });

    source.readyState = MockEventSource.CLOSED;
    source.onerror?.();

    expect(onError).toHaveBeenCalledWith("Connection lost");
    expect(source.close).toHaveBeenCalledTimes(1);
  });
});
