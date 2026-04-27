import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetInitialViewportHeight, useMobileKeyboard } from "../useMobileKeyboard";

describe("useMobileKeyboard", () => {
  let savedVisualViewport: typeof window.visualViewport;
  let savedInnerWidth: number;
  let savedInnerHeight: number;
  let savedOntouchstart: typeof window.ontouchstart;
  let savedMaxTouchPoints: number;

  beforeEach(() => {
    _resetInitialViewportHeight();
    savedVisualViewport = window.visualViewport;
    savedInnerWidth = window.innerWidth;
    savedInnerHeight = window.innerHeight;
    savedOntouchstart = window.ontouchstart;
    savedMaxTouchPoints = navigator.maxTouchPoints;
  });

  afterEach(() => {
    Object.defineProperty(window, "visualViewport", {
      value: savedVisualViewport,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "innerWidth", {
      value: savedInnerWidth,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: savedInnerHeight,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "ontouchstart", {
      value: savedOntouchstart,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: savedMaxTouchPoints,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  function setupMobileVisualViewport({
    innerHeight,
    vvHeight,
    vvOffsetTop = 0,
  }: {
    innerHeight: number;
    vvHeight: number;
    vvOffsetTop?: number;
  }) {
    (window as any).ontouchstart = null;
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: 5,
      configurable: true,
    });
    Object.defineProperty(window, "innerWidth", {
      value: 375,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: innerHeight,
      writable: true,
      configurable: true,
    });

    const listeners: Record<string, Array<() => void>> = {
      resize: [],
      scroll: [],
    };

    const mockVV = {
      width: 375,
      height: vvHeight,
      offsetTop: vvOffsetTop,
      offsetLeft: 0,
      addEventListener: vi.fn((event: string, cb: () => void) => {
        listeners[event]?.push(cb);
      }),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(window, "visualViewport", {
      value: mockVV,
      writable: true,
      configurable: true,
    });

    return { listeners, mockVV };
  }

  it("keeps keyboardOverlap at 0 when not on mobile", async () => {
    delete (window as any).ontouchstart;
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: 0,
      configurable: true,
    });
    Object.defineProperty(window, "innerWidth", {
      value: 1280,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useMobileKeyboard());

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(0);
      expect(result.current.viewportHeight).toBeNull();
    });
  });

  it("updates overlap when visualViewport resize fires on mobile", async () => {
    const { listeners, mockVV } = setupMobileVisualViewport({
      innerHeight: 800,
      vvHeight: 600,
    });

    const { result } = renderHook(() => useMobileKeyboard());

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(200);
      expect(result.current.viewportHeight).toBe(600);
    });

    Object.defineProperty(window, "innerHeight", {
      value: 800,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(mockVV, "height", {
      value: 700,
      writable: true,
      configurable: true,
    });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(100);
      expect(result.current.viewportHeight).toBe(700);
    });
  });

  it("unsubscribes listeners and resets state when disabled", async () => {
    const { listeners, mockVV } = setupMobileVisualViewport({
      innerHeight: 760,
      vvHeight: 600,
    });

    const { result, rerender } = renderHook(
      ({ enabled }) => useMobileKeyboard({ enabled }),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(160);
      expect(result.current.viewportHeight).toBe(600);
    });

    const resizeListener = listeners.resize[0];
    const scrollListener = listeners.scroll[0];

    rerender({ enabled: false });

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(0);
      expect(result.current.viewportHeight).toBeNull();
    });

    expect(mockVV.removeEventListener).toHaveBeenCalledWith("resize", resizeListener);
    expect(mockVV.removeEventListener).toHaveBeenCalledWith("scroll", scrollListener);
  });

  it("uses iOS Safari fallback when innerHeight shrinks with visualViewport", async () => {
    const { listeners, mockVV } = setupMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
    });

    const { result } = renderHook(() => useMobileKeyboard());

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(0);
      expect(result.current.viewportHeight).toBeNull();
    });

    Object.defineProperty(window, "innerHeight", {
      value: 520,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(mockVV, "height", {
      value: 520,
      writable: true,
      configurable: true,
    });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(324);
      expect(result.current.viewportHeight).toBe(520);
    });
  });
});
