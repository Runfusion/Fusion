import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getViewportMode,
  isFullScreenSheetViewport,
  isMobileViewport,
  isTabletTouchViewport,
  MOBILE_MEDIA_QUERY,
  publishViewportMode,
  useViewportMode,
  VIEWPORT_MODE_DATASET_KEY,
} from "../useViewportMode";

const TABLET_MEDIA_QUERY = "(min-width: 769px) and (max-width: 1024px)";
const MOBILE_WIDTH_MEDIA_QUERY = "(max-width: 768px)";
const FULL_SCREEN_SHEET_WIDTH_MEDIA_QUERY = "(max-width: 767.98px)";
const MOBILE_HEIGHT_MEDIA_QUERY = "(max-height: 480px)";
const PHONE_WIDTH_MEDIA_QUERY = "(max-width: 600px)";
const originalScreenDescriptor = Object.getOwnPropertyDescriptor(window, "screen");

function stubScreen(width: number, height: number) {
  Object.defineProperty(window, "screen", { configurable: true, value: { width, height } });
}

function stubMissingScreen() {
  Object.defineProperty(window, "screen", { configurable: true, value: undefined });
}

function installViewportMedia(options: { width: boolean; height: boolean; tablet: boolean; sheetWidth?: boolean }) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches:
        query === MOBILE_MEDIA_QUERY
          ? options.width || options.height
          : query === MOBILE_WIDTH_MEDIA_QUERY
            ? options.width
            : query === FULL_SCREEN_SHEET_WIDTH_MEDIA_QUERY
              ? (options.sheetWidth ?? options.width)
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
    [FULL_SCREEN_SHEET_WIDTH_MEDIA_QUERY, initial.mobile],
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
          matches.set(FULL_SCREEN_SHEET_WIDTH_MEDIA_QUERY, nextMatches);
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
    delete document.documentElement.dataset[VIEWPORT_MODE_DATASET_KEY];
    if (originalScreenDescriptor) {
      Object.defineProperty(window, "screen", originalScreenDescriptor);
    }
  });

  it("publishViewportMode mirrors mode onto documentElement dataset", () => {
    publishViewportMode("tablet");
    expect(document.documentElement.dataset[VIEWPORT_MODE_DATASET_KEY]).toBe("tablet");
    publishViewportMode("mobile");
    expect(document.documentElement.dataset[VIEWPORT_MODE_DATASET_KEY]).toBe("mobile");
  });

  it("useViewportMode publishes data-viewport-mode for CSS chrome alignment", () => {
    stubScreen(1024, 768);
    installViewportMedia({ width: false, height: false, tablet: true });

    const { result, unmount } = renderHook(() => useViewportMode());
    expect(result.current).toBe("tablet");
    expect(document.documentElement.dataset[VIEWPORT_MODE_DATASET_KEY]).toBe("tablet");
    unmount();
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

  /*
  FNXC:ViewportMode 2026-07-24-18:55:
  Regression cover for large Android phones losing the bottom nav bar. `window.screen`
  is not a reliable phone/tablet discriminator — these devices report a screen min edge
  above the 480px phone threshold, so the tablet-class exclusion stripped mobile mode at
  any CSS width. The invariant is width-based and asserted across every width signal the
  classifier reads (media query, innerWidth, visualViewport), not just the reported case,
  because each of the three can lead on a different device or update late on rotation.
  */
  describe("phone width floor overrides physical-screen tablet classification", () => {
    const LARGE_PHONE_SCREEN: [number, number] = [1080, 2400];

    function withTouch(run: () => void) {
      const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
      Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
      try {
        run();
      } finally {
        if (originalMaxTouchPoints) Object.defineProperty(navigator, "maxTouchPoints", originalMaxTouchPoints);
      }
    }

    function stubPhoneWidthMedia(phoneWidthMatches: boolean) {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({
          matches:
            query === MOBILE_MEDIA_QUERY || query === MOBILE_WIDTH_MEDIA_QUERY
              ? true
              : query === PHONE_WIDTH_MEDIA_QUERY
                ? phoneWidthMatches
                : false,
          media: query,
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      );
    }

    it("stays mobile when the phone width media query matches", () => {
      withTouch(() => {
        stubScreen(...LARGE_PHONE_SCREEN);
        stubPhoneWidthMedia(true);

        expect(isMobileViewport()).toBe(true);
        expect(getViewportMode()).toBe("mobile");
      });
    });

    it("stays mobile on a narrow innerWidth even when the media query has not updated", () => {
      withTouch(() => {
        stubScreen(...LARGE_PHONE_SCREEN);
        stubPhoneWidthMedia(false);
        vi.stubGlobal("innerWidth", 430);

        expect(isMobileViewport()).toBe(true);
        expect(getViewportMode()).toBe("mobile");
      });
    });

    it("stays mobile on a narrow visualViewport pane", () => {
      withTouch(() => {
        stubScreen(...LARGE_PHONE_SCREEN);
        stubPhoneWidthMedia(false);
        const originalVisualViewport = window.visualViewport;
        Object.defineProperty(window, "visualViewport", {
          configurable: true,
          value: { width: 412, height: 915, addEventListener: vi.fn(), removeEventListener: vi.fn() },
        });

        try {
          expect(isMobileViewport()).toBe(true);
          expect(getViewportMode()).toBe("mobile");
        } finally {
          Object.defineProperty(window, "visualViewport", { configurable: true, value: originalVisualViewport });
        }
      });
    });

    it("leaves the 601-768px tablet band to the physical-screen classification", () => {
      withTouch(() => {
        stubScreen(768, 1024);
        stubPhoneWidthMedia(false);
        vi.stubGlobal("innerWidth", 700);

        expect(isMobileViewport()).toBe(false);
      });
    });
  });

  it("enables the resize touch target only for tablet-class touch viewports", () => {
    const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 1 });
    try {
      stubScreen(768, 1024);
      installViewportMedia({ width: true, height: false, tablet: false });
      expect(isTabletTouchViewport()).toBe(true);

      stubScreen(1024, 768);
      installViewportMedia({ width: false, height: false, tablet: true });
      expect(isTabletTouchViewport()).toBe(true);

      stubScreen(1920, 1080);
      installViewportMedia({ width: false, height: false, tablet: false });
      expect(isTabletTouchViewport()).toBe(false);

      stubScreen(390, 844);
      installViewportMedia({ width: true, height: false, tablet: false });
      expect(isTabletTouchViewport()).toBe(false);
    } finally {
      if (originalMaxTouchPoints) Object.defineProperty(navigator, "maxTouchPoints", originalMaxTouchPoints);
    }
  });

  it("keeps a touch tablet at the 768px boundary out of the phone presentation", () => {
    const originalMaxTouchPoints = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
    stubScreen(768, 1024);
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 1 });
    installViewportMedia({ width: true, sheetWidth: false, height: false, tablet: false });

    try {
      expect(isMobileViewport()).toBe(false);
      expect(isFullScreenSheetViewport()).toBe(false);
      expect(getViewportMode()).toBe("tablet");
    } finally {
      if (originalMaxTouchPoints) Object.defineProperty(navigator, "maxTouchPoints", originalMaxTouchPoints);
    }
  });

  it("keeps 767px phone sheets below the 768px tablet boundary", () => {
    stubScreen(390, 844);
    installViewportMedia({ width: true, sheetWidth: true, height: false, tablet: false });
    expect(isFullScreenSheetViewport()).toBe(true);
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
