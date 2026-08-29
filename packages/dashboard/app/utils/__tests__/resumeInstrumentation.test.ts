/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearResumeEvents,
  getResumeEvents,
  recordResumeEvent,
  setResumeInstrumentationEnabled,
  type ResumeTrigger,
} from "../resumeInstrumentation";

const triggers: ResumeTrigger[] = [
  "visibility",
  "pageshow",
  "sse-error",
  "sse-reconnect",
  "sse-open",
  "remount",
  "route-active",
  "route-inactive",
  "project-context-change",
];

describe("resumeInstrumentation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00.000Z"));
    clearResumeEvents();
    setResumeInstrumentationEnabled(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records all trigger values", () => {
    for (const trigger of triggers) {
      recordResumeEvent({ view: "test", trigger, replayAttempted: false });
    }

    expect(getResumeEvents().map((event) => event.trigger)).toEqual(triggers);
  });

  it("computes gapMs with fake timers", () => {
    const first = recordResumeEvent({ view: "gap", trigger: "visibility", replayAttempted: false });
    expect(first.gapMs).toBeUndefined();

    vi.advanceTimersByTime(250);
    const second = recordResumeEvent({ view: "gap", trigger: "visibility", replayAttempted: false });
    expect(second.gapMs).toBe(250);
  });

  it("isolates per-view gaps while falling back to global baseline", () => {
    recordResumeEvent({ view: "a", trigger: "remount", replayAttempted: false, now: 1000 });
    const other = recordResumeEvent({ view: "b", trigger: "remount", replayAttempted: false, now: 1500 });
    const againA = recordResumeEvent({ view: "a", trigger: "route-active", replayAttempted: false, now: 1800 });

    expect(other.gapMs).toBe(500);
    expect(againA.gapMs).toBe(800);
  });

  it("caps ring at 500", () => {
    for (let i = 0; i < 520; i += 1) {
      recordResumeEvent({
        view: "cap",
        trigger: "visibility",
        replayAttempted: false,
        detail: { i },
      });
    }

    const events = getResumeEvents();
    expect(events).toHaveLength(500);
    expect(events[0]?.detail).toEqual({ i: 20 });
    expect(events[499]?.detail).toEqual({ i: 519 });
  });

  it("is a no-op for buffering and posting when disabled", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    setResumeInstrumentationEnabled(false);
    const event = recordResumeEvent({ view: "disabled", trigger: "visibility", replayAttempted: false });

    expect(event.ts).toBeDefined();
    expect(getResumeEvents()).toHaveLength(0);
    await vi.runAllTimersAsync();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts batched events with payload cap of 25", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    for (let i = 0; i < 30; i += 1) {
      recordResumeEvent({
        view: "batch",
        trigger: "sse-open",
        replayAttempted: false,
        detail: { i },
      });
    }

    await vi.runAllTimersAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body));
    expect(firstBody.events).toHaveLength(25);
    expect(secondBody.events).toHaveLength(5);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/diagnostics/resume-events");
  });

  it("swallows network failures", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchSpy);

    recordResumeEvent({ view: "network", trigger: "sse-error", replayAttempted: false });

    await vi.runAllTimersAsync();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
