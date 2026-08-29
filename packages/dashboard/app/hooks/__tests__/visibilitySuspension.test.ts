import { act, fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  isLikelyTabSuspensionError,
  isVisibilityResumeError,
  lastVisibilityTransition,
  useTabVisibilitySuspension,
} from "../visibilitySuspension";

describe("visibilitySuspension", () => {
  it.each([
    "Load failed",
    "Failed to fetch",
    "NetworkError when attempting to fetch resource.",
    "Connection aborted",
    "Connection closed unexpectedly",
    "network error",
  ])("matches known tab-suspension transport errors: %s", (message) => {
    expect(isLikelyTabSuspensionError(message)).toBe(true);
  });

  it("rejects unrelated backend errors", () => {
    expect(isLikelyTabSuspensionError("Request failed: 500")).toBe(false);
    expect(isLikelyTabSuspensionError("Validation error: missing key")).toBe(false);
  });

  it("matches visibility-resume errors when recently hidden and suspension-like", () => {
    expect(isVisibilityResumeError("Failed to fetch", true)).toBe(true);
  });

  it("rejects visibility-resume errors when not recently hidden", () => {
    expect(isVisibilityResumeError("Failed to fetch", false)).toBe(false);
  });

  it("rejects visibility-resume errors for unrelated failures", () => {
    expect(isVisibilityResumeError("Request failed: 500", true)).toBe(false);
  });

  it("tracks recently hidden window", () => {
    vi.useFakeTimers();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    const { result } = renderHook(() => useTabVisibilitySuspension());

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    act(() => {
      fireEvent(document, new Event("visibilitychange"));
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    act(() => {
      fireEvent(document, new Event("visibilitychange"));
    });

    expect(lastVisibilityTransition().hiddenAt).not.toBeNull();
    expect(lastVisibilityTransition().visibleAt).not.toBeNull();
    expect(result.current.wasRecentlyHidden(5000)).toBe(true);

    act(() => {
      vi.advanceTimersByTime(6000);
    });

    expect(result.current.wasRecentlyHidden(5000)).toBe(false);

    vi.useRealTimers();
  });

  it("fires onBecameVisible on hidden to visible transition", () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    const { result } = renderHook(() => useTabVisibilitySuspension());
    const callback = vi.fn();
    result.current.onBecameVisible(callback);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    act(() => {
      fireEvent(document, new Event("visibilitychange"));
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    act(() => {
      fireEvent(document, new Event("visibilitychange"));
    });

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("does not fire onBecameVisible when moving visible to hidden", () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    const { result } = renderHook(() => useTabVisibilitySuspension());
    const callback = vi.fn();
    result.current.onBecameVisible(callback);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    act(() => {
      fireEvent(document, new Event("visibilitychange"));
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it("unsubscribes onBecameVisible callback", () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    const { result } = renderHook(() => useTabVisibilitySuspension());
    const callback = vi.fn();
    const unsubscribe = result.current.onBecameVisible(callback);
    unsubscribe();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    act(() => {
      fireEvent(document, new Event("visibilitychange"));
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    act(() => {
      fireEvent(document, new Event("visibilitychange"));
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it("fires all onBecameVisible subscribers", () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    const { result } = renderHook(() => useTabVisibilitySuspension());
    const callbackA = vi.fn();
    const callbackB = vi.fn();
    result.current.onBecameVisible(callbackA);
    result.current.onBecameVisible(callbackB);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    act(() => {
      fireEvent(document, new Event("visibilitychange"));
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    act(() => {
      fireEvent(document, new Event("visibilitychange"));
    });

    expect(callbackA).toHaveBeenCalledTimes(1);
    expect(callbackB).toHaveBeenCalledTimes(1);
  });
});
