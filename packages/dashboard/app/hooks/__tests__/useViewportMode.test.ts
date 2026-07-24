import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getViewportMode, isFullScreenSheetViewport, isMobileViewport, MOBILE_MEDIA_QUERY, useViewportMode } from "../useViewportMode";

const TABLET_MEDIA_QUERY = "(min-width: 769px) and (max-width: 1024px)";
const MOBILE_WIDTH_MEDIA_QUERY = "(max-width: 768px)";
const MOBILE_HEIGHT_MEDIA_QUERY = "(max-height: 480px)";
const originalScreenDescriptor = Object.getOwnPropertyDescriptor(window, "screen");

function stubScreen(width: number, height: number) {
  Object.defineProperty(window, "screen", { configurable: true, value: { width, height } });
}

function stubMissingScreen() {
  Object.defineProperty(window, "screen", { configurable: true, value: undefined });
}

function installViewportMedia(options: { width: boolean; height: boolean; tablet: boolean }) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches:
        query === MOBILE_MEDIA_QUERY
          ? options.width || options.height
          : query === MOBILE_WIDTH_MEDIA_QUERY
            ? options.width
            : query === MOBILE_HEIGHT_MEDIA_QUERY
              ? options.height
              : query === TABLET_MEDIA_QUERY
                ? options.tablet
                : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

type TestMediaQueryList = MediaQueryList & {
  setMatches: (matches: boolean) => void;
  dispatchChange: () => void;
};

function createViewportMediaMock(initial: { mobile: boolean; tablet: boolean }) {
  const listeners = new Map<string, Set<() => void>>();
  const matches = new Map<string, boolean>([
    [MOBILE_MEDIA_QUERY, initial.mobile],
    [MOBILE_WIDTH_MEDIA_QUERY, initial.mobile],
    [MOBILE_HEIGHT_MEDIA_QUERY, false],
    [TABLET_MEDIA_QUERY, initial.tablet],
  ]);
  const queries = new Map<string, TestMediaQueryList>();

  const getQuery = (query: string): TestMediaQueryList => {
    const existing = queries.get(query);
    if (existing) return existing;

    const queryListeners = new Set<() => void>();
    listeners.set(query, queryListeners);
    const mediaQueryList = {
      get matches() {
        return matches.get(query) ?? false;
      },
      media: query,
      onchange: null,
      addEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === "change") queryListeners.add(listener);
      }),
      removeEventListener: vi.fn((event: string, listener: () => void) => {
        if (event === "change") queryListeners.delete(listener);
      }),
      addListener: vi.fn((listener: () => void) => queryListeners.add(listener)),
      removeListener: vi.fn((listener: () => void) => queryListeners.delete(listener)),
      dispatchEvent: vi.fn(() => true),
      setMatches: (nextMatches: boolean) => {
        matches.set(query, nextMatches);
        if (query === MOBILE_MEDIA_QUERY) {
          matches.set(MOBILE_WIDTH_MEDIA_QUERY, nextMatches);
        }
      },
      dispatchChange: () => {
        for (const listener of [...queryListeners]) listener();
      },
    } as TestMediaQueryList;
    queries.set(query, mediaQueryList);
    return mediaQueryList;
  };

  vi.stubGlobal("matchMedia", vi.fn((query: string) => getQuery(query)));

  return {
    mobileQuery: getQuery(MOBILE_MEDIA_QUERY),
    tabletQuery: getQuery(TABLET_MEDIA_QUERY),
    transition(next: { mobile: boolean; tablet: boolean }, dispatch: "mobile" | "tablet" | "both" = "both") {
      getQuery(MOBILE_MEDIA_QUERY).setMatches(next.mobile);
      getQuery(TABLET_MEDIA_QUERY).setMatches(next.tablet);
      if (dispatch === "mobile" || dispatch === "both") getQuery(MOBILE_MEDIA_QUERY).dispatchChange();
      if (dispatch === "tablet" || dispatch === "both") getQuery(TABLET_MEDIA_QUERY).dispatchChange();
    },
  };
}

describe("useViewportMode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalScreenDescriptor) {
      Object.defineProperty(window, "screen", originalScreenDescriptor);
    }
  });

  it("treats short landscape phones as mobile", () => {
    stubScreen(844, 390);
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches:
          query === MOBILE_MEDIA_QUERY || query === MOBILE_HEIGHT_MEDIA_QUERY
            ? true
            : query === MOBILE_WIDTH_MEDIA_QUERY || query === "(min-width: 769px) and (max-width: 1024px)"
              ? false
              : false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );

    expect(getViewportMode()).toBe("mobile");
    expect(renderHook(() => useViewportMode()).result.current).toBe("mobile");
  });

  it("matches full-screen sheets by width only, not the landscape-phone mobile clause", () => {
    stubScreen(844, 390);
    installViewportMedia({ width: false, height: true, tablet: false });

    expect(isMobileViewport()).toBe(true);
    expect(isFullScreenSheetViewport()).toBe(false);

    installViewportMedia({ width: true, height: false, tablet: false });
    expect(isFullScreenSheetViewport()).toBe(true);
  });

  it("keeps tablet mode when only the short-height clause matches on a tablet-class screen", () => {
    stubScreen(1024, 768);
    installViewportMedia({ width: false, height: true, tablet: true });

    expect(getViewportMode()).toBe("tablet");
    expect(renderHook(() => useViewportMode()).result.current).toBe("tablet");
  });

  it("keeps a touch tablet at the 768px boundary out of the phone presentation", () => {
    const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
    stubScreen(768, 1024);
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 1 });
    installViewportMedia({ width: true, height: false, tablet: false });

    try {
      expect(isMobileViewport()).toBe(false);
      expect(getViewportMode()).toBe("tablet");
    } finally {
      if (originalMaxTouchPoints) Object.defineProperty(navigator, "maxTouchPoints", originalMaxTouchPoints);
    }
  });

  it("keeps desktop mode when only the short-height clause matches on a desktop-class screen", () => {
    stubScreen(1920, 1080);
    installViewportMedia({ width: false, height: true, tablet: false });

    expect(getViewportMode()).toBe("desktop");
    expect(renderHook(() => useViewportMode()).result.current).toBe("desktop");
  });

  it("keeps mobile portrait mode from width regardless of height", () => {
    stubScreen(390, 844);
    installViewportMedia({ width: true, height: false, tablet: false });

    expect(getViewportMode()).toBe("mobile");
    expect(renderHook(() => useViewportMode()).result.current).toBe("mobile");
  });

  it("treats touch visualViewport width as mobile on folded Android panes", () => {
    stubScreen(390, 844);
    installViewportMedia({ width: false, height: false, tablet: true });
    const originalVisualViewport = window.visualViewport;
    const originalMaxTouchPoints = navigator.maxTouchPoints;
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 1 });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        width: 390,
        height: 700,
        offsetTop: 0,
        offsetLeft: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    try {
      expect(isMobileViewport()).toBe(true);
      expect(getViewportMode()).toBe("mobile");
    } finally {
      Object.defineProperty(window, "visualViewport", { configurable: true, value: originalVisualViewport });
      Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: originalMaxTouchPoints });
    }
  });

  /*
  FNXC:ViewportMode 2026-07-08-00:00:
  FN-7687: reproduce the reported foldable regression literally — a fold->unfold->refold cycle
  driven purely through `visualViewport`'s own `resize` event (not a matchMedia change), matching
  how a real Android/Chrome foldable notifies the page when its folded pane changes width while the
  CSS layout viewport can lag behind. Confirms `useViewportMode` recomputes back to `mobile` on
  refold rather than getting stuck on the wide (unfolded) `desktop` mode it resolved to mid-cycle.
  */
  it("resolves back to mobile after a fold -> unfold -> refold visualViewport resize cycle", () => {
    stubScreen(390, 844);
    // Foldable quirk: the CSS layout viewport (and therefore matchMedia) can stay wide/desktop-shaped
    // even while the folded visualViewport pane is narrow, so none of the width/height/tablet media
    // queries match here — only the touch-primary visualViewport check should drive mobile detection.
    installViewportMedia({ width: false, height: false, tablet: false });
    const originalVisualViewport = window.visualViewport;
    const originalMaxTouchPoints = navigator.maxTouchPoints;
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 1 });

    let currentWidth = 350; // folded pane
    const resizeListeners = new Set<() => void>();
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        get width() {
          return currentWidth;
        },
        height: 700,
        offsetTop: 0,
        offsetLeft: 0,
        addEventListener: vi.fn((event: string, listener: () => void) => {
          if (event === "resize") resizeListeners.add(listener);
        }),
        removeEventListener: vi.fn((event: string, listener: () => void) => {
          resizeListeners.delete(listener);
        }),
      },
    });

    try {
      const { result } = renderHook(() => useViewportMode());
      expect(result.current).toBe("mobile");

      act(() => {
        currentWidth = 1024; // unfold: wide pane
        for (const listener of [...resizeListeners]) listener();
      });
      expect(result.current).toBe("desktop");

      act(() => {
        currentWidth = 350; // refold: narrow pane again
        for (const listener of [...resizeListeners]) listener();
      });
      expect(result.current).toBe("mobile");
    } finally {
      Object.defineProperty(window, "visualViewport", { configurable: true, value: originalVisualViewport });
      Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: originalMaxTouchPoints });
    }
  });

  it("falls back to width-only mobile detection when screen data is unavailable", () => {
    stubMissingScreen();
    installViewportMedia({ width: false, height: true, tablet: true });
    expect(() => getViewportMode()).not.toThrow();
    expect(getViewportMode()).toBe("tablet");

    installViewportMedia({ width: true, height: false, tablet: false });
    expect(getViewportMode()).toBe("mobile");
  });

  it("falls back to width-only mobile detection when screen dimensions are zero", () => {
    stubScreen(0, 0);
    installViewportMedia({ width: false, height: true, tablet: false });
    expect(() => getViewportMode()).not.toThrow();
    expect(getViewportMode()).toBe("desktop");

    installViewportMedia({ width: true, height: true, tablet: false });
    expect(getViewportMode()).toBe("mobile");
  });

  it("updates from mobile to tablet when the mobile media query changes", () => {
    const viewport = createViewportMediaMock({ mobile: true, tablet: false });
    const { result } = renderHook(() => useViewportMode());

    expect(result.current).toBe("mobile");

    act(() => {
      viewport.transition({ mobile: false, tablet: true }, "mobile");
    });

    expect(result.current).toBe("tablet");
  });

  it("updates from tablet to mobile when the tablet media query changes", () => {
    const viewport = createViewportMediaMock({ mobile: false, tablet: true });
    const { result } = renderHook(() => useViewportMode());

    expect(result.current).toBe("tablet");

    act(() => {
      viewport.transition({ mobile: true, tablet: false }, "tablet");
    });

    expect(result.current).toBe("mobile");
  });

  it("updates from mobile to tablet on window resize when media-query change events are missed", () => {
    const viewport = createViewportMediaMock({ mobile: true, tablet: false });
    const { result } = renderHook(() => useViewportMode());

    expect(result.current).toBe("mobile");

    act(() => {
      viewport.mobileQuery.setMatches(false);
      viewport.tabletQuery.setMatches(true);
      window.dispatchEvent(new Event("resize"));
    });

    expect(result.current).toBe("tablet");
  });

  it("tracks a mobile to tablet to desktop to mobile viewport cycle", () => {
    const viewport = createViewportMediaMock({ mobile: true, tablet: false });
    const { result } = renderHook(() => useViewportMode());

    expect(result.current).toBe("mobile");

    act(() => {
      viewport.transition({ mobile: false, tablet: true }, "tablet");
    });
    expect(result.current).toBe("tablet");

    act(() => {
      viewport.transition({ mobile: false, tablet: false }, "tablet");
    });
    expect(result.current).toBe("desktop");

    act(() => {
      viewport.transition({ mobile: true, tablet: false }, "mobile");
    });
    expect(result.current).toBe("mobile");
  });

  it("supports legacy MediaQueryList listeners without runtime errors", () => {
    const listeners: Array<() => void> = [];
    const removeListener = vi.fn((listener: () => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === MOBILE_MEDIA_QUERY,
        media: query,
        onchange: null,
        addListener: (listener: () => void) => listeners.push(listener),
        removeListener,
      })),
    );

    renderHook(() => useViewportMode());

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
