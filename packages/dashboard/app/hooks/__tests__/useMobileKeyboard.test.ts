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
    _resetInitialViewportHeight();
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
    width = 375,
  }: {
    innerHeight: number;
    vvHeight: number;
    vvOffsetTop?: number;
    width?: number;
  }) {
    (window as any).ontouchstart = null;
    Object.defineProperty(navigator, "maxTouchPoints", {
      value: 5,
      configurable: true,
    });
    Object.defineProperty(window, "innerWidth", {
      value: width,
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
      width,
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

    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();

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

    input.remove();
  });

  it("unsubscribes listeners and resets state when disabled", async () => {
    const { listeners, mockVV } = setupMobileVisualViewport({
      innerHeight: 760,
      vvHeight: 600,
    });

    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();

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

    input.remove();
  });

  it("uses iOS Safari fallback when innerHeight shrinks with visualViewport", async () => {
    const { listeners, mockVV } = setupMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
    });

    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();

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

    input.remove();
  });

  it("re-baselines iOS fallback after a folded viewport settles while the keyboard is closed", async () => {
    const { listeners, mockVV } = setupMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
      width: 700,
    });

    const { result } = renderHook(() => useMobileKeyboard());

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(0);
      expect(result.current.viewportHeight).toBeNull();
    });

    Object.defineProperty(window, "innerWidth", { value: 375, writable: true, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 667, writable: true, configurable: true });
    Object.defineProperty(mockVV, "width", { value: 375, writable: true, configurable: true });
    Object.defineProperty(mockVV, "height", { value: 667, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(0);
      expect(result.current.viewportHeight).toBeNull();
    });

    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();

    Object.defineProperty(window, "innerHeight", { value: 300, writable: true, configurable: true });
    Object.defineProperty(mockVV, "height", { value: 300, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(367);
      expect(result.current.viewportHeight).toBe(300);
    });

    input.remove();
  });

  it("reports moderate iOS fallback overlap below 80px", async () => {
    const { listeners, mockVV } = setupMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
    });

    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();

    const { result } = renderHook(() => useMobileKeyboard());

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(0);
    });

    Object.defineProperty(window, "innerHeight", {
      value: 804,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(mockVV, "height", {
      value: 804,
      writable: true,
      configurable: true,
    });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(40);
      expect(result.current.viewportHeight).toBe(804);
    });

    input.remove();
  });

  it("uses focused-input fallback for small viewport gaps", async () => {
    const { listeners, mockVV } = setupMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
    });

    const input = document.createElement("textarea");
    document.body.appendChild(input);
    input.focus();

    const { result } = renderHook(() => useMobileKeyboard());

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(0);
    });

    Object.defineProperty(window, "innerHeight", {
      value: 820,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(mockVV, "height", {
      value: 820,
      writable: true,
      configurable: true,
    });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(24);
      expect(result.current.viewportHeight).toBe(820);
      expect(result.current.keyboardOpen).toBe(true);
    });

    input.remove();
  });

  it("treats focused input + viewport shrink as keyboard-open even when overlap is 0", async () => {
    // iOS last-resort path: chromeOverlap = 0 (innerHeight tracks offsetTop+vv.height),
    // gap < 16 (focused-fallback doesn't fire), and viewportShrink >= 16 from the
    // baseline so the focused-input shrink heuristic is the only signal left.
    const { listeners, mockVV } = setupMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
    });

    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);

    const { result } = renderHook(() => useMobileKeyboard());

    await waitFor(() => {
      expect(result.current.keyboardOpen).toBe(false);
    });

    input.focus();
    Object.defineProperty(mockVV, "height", {
      value: 824,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(mockVV, "offsetTop", {
      value: 5,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 829,
      writable: true,
      configurable: true,
    });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(0);
      expect(result.current.viewportHeight).toBe(824);
      expect(result.current.keyboardOpen).toBe(true);
    });

    input.remove();
  });

  it("uses iOS gap fallback when viewport shrink occurs with offsetTop at 0", async () => {
    const { listeners, mockVV } = setupMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
    });

    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);

    const { result } = renderHook(() => useMobileKeyboard());

    await waitFor(() => {
      expect(result.current.keyboardOpen).toBe(false);
    });

    input.focus();
    Object.defineProperty(mockVV, "height", {
      value: 824,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(mockVV, "offsetTop", {
      value: 0,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 824,
      writable: true,
      configurable: true,
    });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      expect(result.current.keyboardOverlap).toBe(20);
      expect(result.current.viewportOffsetTop).toBe(0);
      expect(result.current.keyboardOpen).toBe(true);
    });

    input.remove();
  });

  it("reports keyboardOpen=false the instant focus leaves an input even while visualViewport still reports keyboard-up size", async () => {
    // Regression for the ChatView "composer crawls down with the keyboard"
    // bug: on iOS the visualViewport keeps reporting the small mid-dismiss
    // size for hundreds of ms after the user blurs an input. App-level
    // layout (mobile nav bar, project-content padding) must flip back to
    // no-keyboard mode immediately on blur, not when vv finally settles.
    const { listeners, mockVV } = setupMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
    });

    const input = document.createElement("textarea");
    document.body.appendChild(input);

    const { result } = renderHook(() => useMobileKeyboard());

    // Bring up the keyboard: focus the input, then shrink the viewport.
    input.focus();
    Object.defineProperty(window, "innerHeight", { value: 520, writable: true, configurable: true });
    Object.defineProperty(mockVV, "height", { value: 520, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      expect(result.current.keyboardOpen).toBe(true);
    });

    // Blur, but leave visualViewport still reporting the small mid-dismiss
    // size — the dismissal animation takes hundreds of ms on iOS.
    input.blur();

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      expect(result.current.keyboardOpen).toBe(false);
    });

    input.remove();
  });

  it("FN-5155: ignores impossible focusin samples until the visualViewport settles", async () => {
    vi.useFakeTimers();
    try {
      const { mockVV } = setupMobileVisualViewport({
        innerHeight: 844,
        vvHeight: 844,
      });

      const input = document.createElement("textarea");
      document.body.appendChild(input);

      const { result } = renderHook(() => useMobileKeyboard());

      expect(result.current.keyboardOpen).toBe(false);

      input.focus();
      Object.defineProperty(mockVV, "offsetTop", {
        value: 180,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(mockVV, "height", {
        value: 820,
        writable: true,
        configurable: true,
      });

      act(() => {
        document.dispatchEvent(new Event("focusin"));
      });

      // FN-5155: current main incorrectly treats this as open via the
      // viewport-shrink fallback even though offsetTop + height exceeds the
      // window height, so the impossible sample must be ignored.
      expect(result.current.keyboardOpen).toBe(false);
      expect(result.current.viewportHeight).toBeNull();
      expect(result.current.viewportOffsetTop).toBe(0);

      Object.defineProperty(mockVV, "offsetTop", {
        value: 0,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(mockVV, "height", {
        value: 520,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 520,
        writable: true,
        configurable: true,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });

      expect(result.current.keyboardOpen).toBe(true);
      expect(result.current.keyboardOverlap).toBe(324);
      expect(result.current.viewportHeight).toBe(520);
      expect(result.current.viewportOffsetTop).toBe(0);

      input.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("FN-5155: converges from stale visibility-restore metrics to the settled keyboard-open viewport", async () => {
    vi.useFakeTimers();
    try {
      const { listeners, mockVV } = setupMobileVisualViewport({
        innerHeight: 844,
        vvHeight: 844,
      });

      const input = document.createElement("textarea");
      document.body.appendChild(input);

      const { result } = renderHook(() => useMobileKeyboard());

      expect(result.current.keyboardOpen).toBe(false);

      input.focus();
      Object.defineProperty(mockVV, "offsetTop", {
        value: 160,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(mockVV, "height", {
        value: 820,
        writable: true,
        configurable: true,
      });

      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      // FN-5155: page-restore can surface the same impossible transient sample
      // before resize settles; keep the hook closed until metrics agree.
      expect(result.current.keyboardOpen).toBe(false);
      expect(result.current.viewportHeight).toBeNull();
      expect(result.current.viewportOffsetTop).toBe(0);

      Object.defineProperty(mockVV, "offsetTop", {
        value: 0,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(mockVV, "height", {
        value: 520,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 520,
        writable: true,
        configurable: true,
      });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });

      expect(result.current.keyboardOpen).toBe(true);
      expect(result.current.keyboardOverlap).toBe(324);
      expect(result.current.viewportHeight).toBe(520);
      expect(result.current.viewportOffsetTop).toBe(0);

      input.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("FN-6362: resets stale iOS keyboard metrics on visibility restore when the keyboard collapsed but focus remains", async () => {
    const { listeners, mockVV } = setupMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
    });

    const input = document.createElement("textarea");
    document.body.appendChild(input);

    const { result } = renderHook(() => useMobileKeyboard());

    input.focus();
    Object.defineProperty(mockVV, "height", { value: 520, writable: true, configurable: true });
    Object.defineProperty(mockVV, "offsetTop", { value: 180, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      expect(result.current.keyboardOpen).toBe(true);
      expect(result.current.viewportOffsetTop).toBe(180);
    });

    // iOS can restore with the visual viewport back at full height while
    // window.innerHeight still reflects the pre-background keyboard shrink.
    // The retained focused input plus impossible sample used to hold the stale
    // keyboard-open metrics forever because no blur/resize followed.
    Object.defineProperty(window, "innerHeight", { value: 520, writable: true, configurable: true });
    Object.defineProperty(mockVV, "height", { value: 844, writable: true, configurable: true });
    Object.defineProperty(mockVV, "offsetTop", { value: 0, writable: true, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => {
      expect(result.current.keyboardOpen).toBe(false);
      expect(result.current.viewportOffsetTop).toBe(0);
      expect(result.current.viewportHeight).toBeNull();
    });

    input.remove();
  });

  it("FN-6362: resets stale iOS keyboard metrics on pageshow when stale offset drift remains", async () => {
    const { listeners, mockVV } = setupMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
    });

    const input = document.createElement("textarea");
    document.body.appendChild(input);

    const { result } = renderHook(() => useMobileKeyboard());

    input.focus();
    Object.defineProperty(mockVV, "height", { value: 520, writable: true, configurable: true });
    Object.defineProperty(mockVV, "offsetTop", { value: 160, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      expect(result.current.keyboardOpen).toBe(true);
      expect(result.current.viewportOffsetTop).toBe(160);
    });

    Object.defineProperty(window, "innerHeight", { value: 520, writable: true, configurable: true });
    Object.defineProperty(mockVV, "height", { value: 844, writable: true, configurable: true });
    Object.defineProperty(mockVV, "offsetTop", { value: 120, writable: true, configurable: true });

    const pageshow = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(pageshow, "persisted", { value: false });

    act(() => {
      window.dispatchEvent(pageshow);
    });

    await waitFor(() => {
      expect(result.current.keyboardOpen).toBe(false);
      expect(result.current.viewportOffsetTop).toBe(0);
      expect(result.current.viewportHeight).toBeNull();
    });

    input.remove();
  });

  it("FN-6362: keeps a genuinely-open restored viewport open", async () => {
    const { mockVV } = setupMobileVisualViewport({
      innerHeight: 844,
      vvHeight: 844,
    });

    const input = document.createElement("textarea");
    document.body.appendChild(input);

    const { result } = renderHook(() => useMobileKeyboard());

    input.focus();
    Object.defineProperty(window, "innerHeight", { value: 520, writable: true, configurable: true });
    Object.defineProperty(mockVV, "height", { value: 520, writable: true, configurable: true });
    Object.defineProperty(mockVV, "offsetTop", { value: 0, writable: true, configurable: true });

    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });

    await waitFor(() => {
      expect(result.current.keyboardOpen).toBe(true);
      expect(result.current.viewportOffsetTop).toBe(0);
      expect(result.current.viewportHeight).toBe(520);
    });

    input.remove();
  });

  it("FN-6362: resets Android-style shrink metrics on restore without introducing offset drift", async () => {
    const { listeners, mockVV } = setupMobileVisualViewport({
      innerHeight: 800,
      vvHeight: 800,
    });

    const input = document.createElement("textarea");
    document.body.appendChild(input);

    const { result } = renderHook(() => useMobileKeyboard());

    input.focus();
    Object.defineProperty(mockVV, "height", { value: 500, writable: true, configurable: true });
    Object.defineProperty(mockVV, "offsetTop", { value: 0, writable: true, configurable: true });

    act(() => {
      for (const cb of listeners.resize) cb();
    });

    await waitFor(() => {
      expect(result.current.keyboardOpen).toBe(true);
      expect(result.current.viewportOffsetTop).toBe(0);
      expect(result.current.viewportHeight).toBe(500);
    });

    Object.defineProperty(mockVV, "height", { value: 800, writable: true, configurable: true });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => {
      expect(result.current.keyboardOpen).toBe(false);
      expect(result.current.viewportOffsetTop).toBe(0);
      expect(result.current.viewportHeight).toBeNull();
    });

    input.remove();
  });

  // FN-3290 regression: focusout must reset keyboard state when input blurs
  describe("FN-3290: focusout resets keyboard state", () => {
    it("resets keyboardOpen to false on focusout when viewport returns to baseline", async () => {
      const { listeners, mockVV } = setupMobileVisualViewport({
        innerHeight: 844,
        vvHeight: 844,
      });

      const input = document.createElement("textarea");
      document.body.appendChild(input);

      const { result } = renderHook(() => useMobileKeyboard());

      await waitFor(() => {
        expect(result.current.keyboardOpen).toBe(false);
      });

      // Focus the input and simulate keyboard opening
      input.focus();
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
        expect(result.current.keyboardOpen).toBe(true);
        expect(result.current.keyboardOverlap).toBe(324);
      });

      // Blur the input and restore viewport to baseline
      input.blur();
      Object.defineProperty(window, "innerHeight", {
        value: 844,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(mockVV, "height", {
        value: 844,
        writable: true,
        configurable: true,
      });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(result.current.keyboardOpen).toBe(false);
        expect(result.current.keyboardOverlap).toBe(0);
      });

      input.remove();
    });

    it("clears keyboardOpen when active input is removed from DOM (simulating modal close)", async () => {
      const { listeners, mockVV } = setupMobileVisualViewport({
        innerHeight: 844,
        vvHeight: 844,
      });

      const input = document.createElement("input");
      input.type = "text";
      document.body.appendChild(input);

      const { result } = renderHook(() => useMobileKeyboard());

      await waitFor(() => {
        expect(result.current.keyboardOpen).toBe(false);
      });

      // Focus input and shrink viewport (keyboard appears)
      input.focus();
      Object.defineProperty(mockVV, "height", {
        value: 824,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(mockVV, "offsetTop", {
        value: 5,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 829,
        writable: true,
        configurable: true,
      });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(result.current.keyboardOpen).toBe(true);
      });

      // Simulate modal close: remove the focused input from DOM and restore viewport
      // The focusout event fires when the element is removed
      input.remove();
      Object.defineProperty(mockVV, "height", {
        value: 844,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(mockVV, "offsetTop", {
        value: 0,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: 844,
        writable: true,
        configurable: true,
      });

      act(() => {
        for (const cb of listeners.resize) cb();
      });

      await waitFor(() => {
        expect(result.current.keyboardOpen).toBe(false);
        expect(result.current.keyboardOverlap).toBe(0);
      });
    });
  });
});
