import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useColumnScrollSnap } from "../useColumnScrollSnap";
import { isMobileViewport } from "../useViewportMode";

type Viewport = "mobile" | "wide-short-desktop";

function stubViewport(viewport: Viewport): void {
  const isMobile = viewport === "mobile";
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === "(max-width: 768px)" ? isMobile : query === "(max-height: 480px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })));
  Object.defineProperty(window, "screen", {
    configurable: true,
    value: viewport === "mobile" ? { width: 390, height: 844 } : { width: 1920, height: 1080 },
  });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: viewport === "mobile" ? 1 : 0 });
  vi.stubGlobal("visualViewport", {
    width: viewport === "mobile" ? 390 : 1200,
    height: viewport === "mobile" ? 844 : 400,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

function createScroller(columnCount = 2): HTMLElement {
  const scroller = document.createElement("main");
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 100 });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 100, 200);
  Object.defineProperty(scroller, "scrollTo", { configurable: true, value: vi.fn() });
  for (let index = 0; index < columnCount; index++) {
    const column = document.createElement("section");
    const left = index === 0 ? -60 : 30;
    column.getBoundingClientRect = () => new DOMRect(left, 0, 100, 200);
    scroller.append(column);
  }
  document.body.append(scroller);
  return scroller;
}

function dispatchUserPan(scroller: HTMLElement): void {
  scroller.dispatchEvent(new Event("pointerdown"));
  scroller.scrollLeft = 10;
  scroller.dispatchEvent(new Event("scroll"));
  scroller.dispatchEvent(new Event("scrollend"));
}

describe("useColumnScrollSnap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubViewport("mobile");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("unifies a user pan into one JS snap and restores the CSS proximity baseline", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => scroller.dispatchEvent(new Event("pointerdown")));
    expect(scroller.style.scrollSnapType).toBe("none");

    act(() => {
      scroller.scrollLeft = 10;
      scroller.dispatchEvent(new Event("scroll"));
      scroller.dispatchEvent(new Event("scrollend"));
    });

    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTo).toHaveBeenCalledWith({ left: 40, behavior: "smooth" });
    expect(scroller.style.scrollSnapType).toBe("none");

    act(() => scroller.dispatchEvent(new Event("scrollend")));
    expect(scroller.style.scrollSnapType).toBe("");
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("restores a pre-existing inline snap value after completion and cleanup", () => {
    const scroller = createScroller();
    scroller.style.scrollSnapType = "x proximity";
    const { unmount } = renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => dispatchUserPan(scroller));
    expect(scroller.style.scrollSnapType).toBe("none");
    act(() => scroller.dispatchEvent(new Event("scrollend")));
    expect(scroller.style.scrollSnapType).toBe("x proximity");

    act(() => scroller.dispatchEvent(new Event("pointerdown")));
    expect(scroller.style.scrollSnapType).toBe("none");
    unmount();
    expect(scroller.style.scrollSnapType).toBe("x proximity");
  });

  it("attaches after a loading skeleton is replaced by the live board", () => {
    const scroller = createScroller();
    const { rerender } = renderHook(
      ({ element }) => useColumnScrollSnap(element, { mobileOnly: true, isUserInteraction: () => true }),
      { initialProps: { element: null as HTMLElement | null } },
    );

    rerender({ element: scroller });
    act(() => dispatchUserPan(scroller));

    expect(scroller.scrollTo).toHaveBeenCalledWith({ left: 40, behavior: "smooth" });
  });

  it("does not snap on mount, viewport lifecycle events, or programmatic scrolling", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("pageshow"));
      scroller.scrollLeft = 40;
      scroller.dispatchEvent(new Event("scroll"));
      scroller.dispatchEvent(new Event("scrollend"));
      vi.advanceTimersByTime(500);
    });

    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  it("requires horizontal movement after user input rather than a recent tap", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => scroller.dispatchEvent(new Event("pointerdown")));
    expect(scroller.style.scrollSnapType).toBe("none");
    act(() => {
      scroller.dispatchEvent(new Event("pointerup"));
      vi.advanceTimersByTime(500);
    });

    expect(scroller.scrollTo).not.toHaveBeenCalled();
    expect(scroller.style.scrollSnapType).toBe("");
  });

  it("restores native proximity after a wheel that produces no horizontal scroll", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => scroller.dispatchEvent(new Event("wheel")));
    expect(scroller.style.scrollSnapType).toBe("none");
    act(() => vi.advanceTimersByTime(120));

    expect(scroller.scrollTo).not.toHaveBeenCalled();
    expect(scroller.style.scrollSnapType).toBe("");
  });

  it.each([0, 1])("does nothing with %s snap children", (columnCount) => {
    const scroller = createScroller(columnCount);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => dispatchUserPan(scroller));

    expect(scroller.scrollTo).not.toHaveBeenCalled();
    expect(scroller.style.scrollSnapType).toBe("");
  });

  it("does not attach magnetic snapping on a wide, short non-phone desktop", () => {
    stubViewport("wide-short-desktop");
    expect(window.screen.width).toBe(1920);
    expect(window.screen.height).toBe(1080);
    expect(window.visualViewport?.width).toBe(1200);
    expect(window.matchMedia("(max-width: 768px)").matches).toBe(false);
    expect(window.matchMedia("(max-height: 480px)").matches).toBe(true);
    expect(isMobileViewport()).toBe(false);
    const scroller = createScroller();
    const addListener = vi.spyOn(scroller, "addEventListener");
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => dispatchUserPan(scroller));

    expect(addListener).not.toHaveBeenCalledWith("scrollend", expect.any(Function));
    expect(scroller.style.scrollSnapType).toBe("");
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  it("ignores scroll activity while its own smooth snap is in progress", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchUserPan(scroller);
      scroller.dispatchEvent(new Event("scroll"));
      scroller.dispatchEvent(new Event("scrollend"));
      dispatchUserPan(scroller);
    });

    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
  });
});
