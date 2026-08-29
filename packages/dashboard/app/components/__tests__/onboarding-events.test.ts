import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  __test_clearSessionId,
  clearOnboardingEvents,
  getOnboardingEvents,
  getOnboardingSessionId,
  trackOnboardingEvent,
} from "../onboarding-events";

const EVENTS_STORAGE_KEY = "fusion_onboarding_events";
const SESSION_STORAGE_KEY = "fusion_onboarding_session_id";

describe("onboarding-events", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.removeItem(EVENTS_STORAGE_KEY);
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    __test_clearSessionId();

    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    localStorage.removeItem(EVENTS_STORAGE_KEY);
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    __test_clearSessionId();
  });

  it("stores tracked events in localStorage", () => {
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");

    trackOnboardingEvent("onboarding:wizard-opened", { source: "initial" });

    expect(setItemSpy).toHaveBeenCalledWith(EVENTS_STORAGE_KEY, expect.any(String));

    const raw = localStorage.getItem(EVENTS_STORAGE_KEY);
    expect(raw).toBeTruthy();

    const events = JSON.parse(raw ?? "[]") as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "onboarding:wizard-opened",
      metadata: { source: "initial" },
    });
    expect(typeof events[0]?.timestamp).toBe("string");
  });

  it("accumulates events in insertion order", () => {
    trackOnboardingEvent("onboarding:step-completed", { step: "ai-setup" });
    trackOnboardingEvent("onboarding:step-completed", { step: "github" });
    trackOnboardingEvent("onboarding:step-completed", { step: "first-task" });

    const events = getOnboardingEvents();

    expect(events).toHaveLength(3);
    expect(events[0]?.metadata.step).toBe("ai-setup");
    expect(events[1]?.metadata.step).toBe("github");
    expect(events[2]?.metadata.step).toBe("first-task");
  });

  it("prunes ring buffer by 50 when event count exceeds 200", () => {
    for (let index = 1; index <= 201; index += 1) {
      trackOnboardingEvent("onboarding:step-completed", { step: "ai-setup", sequence: index });
    }

    const events = getOnboardingEvents();

    expect(events).toHaveLength(151);
    expect(events[0]?.metadata.sequence).toBe(51);
    expect(events.at(-1)?.metadata.sequence).toBe(201);
  });

  it("clears stored events", () => {
    const removeItemSpy = vi.spyOn(window.localStorage, "removeItem");

    trackOnboardingEvent("onboarding:finished");
    expect(getOnboardingEvents()).toHaveLength(1);

    clearOnboardingEvents();

    expect(getOnboardingEvents()).toEqual([]);
    expect(removeItemSpy).toHaveBeenCalledWith(EVENTS_STORAGE_KEY);
  });

  it("returns a stable session id within one browser session", () => {
    const randomUuidSpy = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("123e4567-e89b-12d3-a456-426614174000");

    const first = getOnboardingSessionId();
    const second = getOnboardingSessionId();

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(randomUuidSpy).toHaveBeenCalledTimes(1);
  });

  it("regenerates session id across storage resets", () => {
    const randomUuidSpy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("123e4567-e89b-12d3-a456-426614174000")
      .mockReturnValueOnce("123e4567-e89b-12d3-a456-426614174001");

    const first = getOnboardingSessionId();
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    __test_clearSessionId();
    const second = getOnboardingSessionId();

    expect(first).not.toBe(second);
    expect(randomUuidSpy).toHaveBeenCalledTimes(2);
  });

  it("is SSR-safe when window is unavailable", () => {
    vi.stubGlobal("window", undefined);

    expect(getOnboardingEvents()).toEqual([]);
    expect(() => trackOnboardingEvent("onboarding:finished")).not.toThrow();
  });

  it("stores events with the expected structure", () => {
    trackOnboardingEvent("onboarding:step-completed", { step: "github", source: "test" });

    const [event] = getOnboardingEvents();
    expect(event).toBeDefined();
    expect(event).toMatchObject({
      type: "onboarding:step-completed",
      metadata: { step: "github", source: "test" },
    });
    expect(typeof event?.sessionId).toBe("string");
    expect(event?.sessionId.length).toBeGreaterThan(0);
    expect(Date.parse(event?.timestamp ?? "")).not.toBeNaN();
  });

  it("defaults metadata to an empty object", () => {
    trackOnboardingEvent("onboarding:finished");

    const [event] = getOnboardingEvents();
    expect(event?.metadata).toEqual({});
  });

  it("handles storage quota errors without throwing", () => {
    const setItemSpy = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    expect(() => trackOnboardingEvent("onboarding:finished")).not.toThrow();
    expect(setItemSpy).toHaveBeenCalled();
  });

  it("logs events in DEV mode", () => {
    trackOnboardingEvent("onboarding:finished");

    expect(consoleInfoSpy).toHaveBeenCalledWith("[fusion:onboarding]", expect.any(String));
  });

  it("resets session id via __test_clearSessionId", () => {
    const randomUuidSpy = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("123e4567-e89b-12d3-a456-426614174000")
      .mockReturnValueOnce("123e4567-e89b-12d3-a456-426614174001");

    const first = getOnboardingSessionId();
    __test_clearSessionId();
    const second = getOnboardingSessionId();

    expect(first).not.toBe(second);
    expect(randomUuidSpy).toHaveBeenCalledTimes(2);
  });
});
