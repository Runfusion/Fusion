import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isColumnCentered,
  resolvePanDirection,
  resolveTargetIndexInScrollDirection,
  useColumnScrollSnap,
} from "../useColumnScrollSnap";
import { isMobileViewport } from "../useViewportMode";

type Viewport = "mobile" | "wide-short-desktop";

const COLUMN_WIDTH = 100;

function stubViewport(viewport: Viewport): void {
  const isMobile = viewport === "mobile";
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches:
      query === "(max-width: 768px)"
        ? isMobile
        : query === "(max-height: 480px)"
          ? true
          : false,
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

function createScroller(columnCount = 3, initialScrollLeft = 0): HTMLElement {
  const scroller = document.createElement("main");
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: COLUMN_WIDTH });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, COLUMN_WIDTH, 200);
  let scrollLeft = initialScrollLeft;
  Object.defineProperty(scroller, "scrollLeft", {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = value;
    },
  });
  scroller.setPointerCapture = vi.fn();
  scroller.releasePointerCapture = vi.fn();
  scroller.hasPointerCapture = vi.fn(() => false);
  for (let index = 0; index < columnCount; index++) {
    const column = document.createElement("section");
    column.className = "column";
    column.getBoundingClientRect = () => {
      const left = index * COLUMN_WIDTH - scrollLeft;
      return new DOMRect(left, 0, COLUMN_WIDTH, 200);
    };
    scroller.append(column);
  }
  document.body.append(scroller);
  return scroller;
}

function dispatchPointerEvent(scroller: HTMLElement, type: string, clientX: number): void {
  scroller.dispatchEvent(
    new PointerEvent(type, { clientX, pointerId: 1, isPrimary: true, bubbles: true, cancelable: true }),
  );
}

function dispatchShortSwipe(
  scroller: HTMLElement,
  options: { scrollDelta?: number; clientDelta?: number },
): void {
  const scrollDelta = options.scrollDelta ?? 4;
  const clientDelta = options.clientDelta ?? 24;
  scroller.dispatchEvent(new Event("touchstart"));
  dispatchPointerEvent(scroller, "pointerdown", 200);
  dispatchPointerEvent(scroller, "pointermove", 200 - clientDelta);
  scroller.scrollLeft = scroller.scrollLeft + scrollDelta;
  scroller.dispatchEvent(new Event("scroll"));
  dispatchPointerEvent(scroller, "pointerup", 200 - clientDelta);
}

function settleAfterMomentum(): void {
  act(() => {
    vi.advanceTimersByTime(48);
  });
}

describe("resolvePanDirection", () => {
  it("uses net scroll delta only (not micro-ticks)", () => {
    expect(resolvePanDirection({ scrollDelta: 5, clientDelta: 0 })).toBe(1);
    expect(resolvePanDirection({ scrollDelta: -5, clientDelta: 0 })).toBe(-1);
  });

  it("uses finger travel when scroll barely moved", () => {
    expect(resolvePanDirection({ scrollDelta: 0, clientDelta: 12 })).toBe(1);
    expect(resolvePanDirection({ scrollDelta: 0, clientDelta: -12 })).toBe(-1);
  });

  it("ignores tiny noise", () => {
    expect(resolvePanDirection({ scrollDelta: 0, clientDelta: 3 })).toBe(0);
  });
});

describe("isColumnCentered", () => {
  it("recognizes only an integer column-centering target", () => {
    const scroller = createScroller(3, COLUMN_WIDTH);
    const columns = [...scroller.children] as HTMLElement[];

    expect(isColumnCentered(scroller, columns)).toBe(true);
    scroller.scrollLeft = 40;
    expect(isColumnCentered(scroller, columns)).toBe(false);
  });
});

describe("resolveTargetIndexInScrollDirection", () => {
  it("forward from column 0 always goes right to column 1", () => {
    const scroller = createScroller(3, 0);
    expect(resolveTargetIndexInScrollDirection(scroller, [...scroller.children] as HTMLElement[], 1)).toBe(1);
  });

  it("forward past column 0 center still goes right, never left", () => {
    const scroller = createScroller(3, 40);
    // nearest may be 0; past its center → 1
    expect(resolveTargetIndexInScrollDirection(scroller, [...scroller.children] as HTMLElement[], 1)).toBe(1);
  });

  it("forward when nearest is already column 1 stays on 1 if still approaching its center", () => {
    const scroller = createScroller(3, 80);
    const columns = [...scroller.children] as HTMLElement[];
    const index = resolveTargetIndexInScrollDirection(scroller, columns, 1);
    expect(index).toBeGreaterThanOrEqual(1);
    expect(index).toBeLessThanOrEqual(2);
  });

  it("back from column 1 always goes left to column 0", () => {
    const scroller = createScroller(3, COLUMN_WIDTH);
    expect(resolveTargetIndexInScrollDirection(scroller, [...scroller.children] as HTMLElement[], -1)).toBe(0);
  });

  it("never returns a column against scroll direction from nearest", () => {
    const scroller = createScroller(4, COLUMN_WIDTH);
    const columns = [...scroller.children] as HTMLElement[];
    // At col 1, scroll right → not 0
    expect(resolveTargetIndexInScrollDirection(scroller, columns, 1)).toBeGreaterThanOrEqual(1);
    // At col 1, scroll left → not 2+
    expect(resolveTargetIndexInScrollDirection(scroller, columns, -1)).toBeLessThanOrEqual(1);
  });
});

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

  it("forward short swipe snaps to the next column on the right", () => {
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => dispatchShortSwipe(scroller, { scrollDelta: 8, clientDelta: 20 }));
    settleAfterMomentum();

    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
  });

  it("hard-settles a zero-direction pan at the nearest column center", () => {
    const scroller = createScroller(3, 40);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200);
      // A weak/reversed gesture can have a real pan but zero net direction at lift.
      scroller.scrollLeft = 60;
      scroller.dispatchEvent(new Event("scroll"));
      scroller.scrollLeft = 40;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 200);
    });
    settleAfterMomentum();

    // Regression: proximity alone previously left this invalid mid-column rest at 40.
    expect(scroller.scrollLeft).toBe(0);
    expect(isColumnCentered(scroller, [...scroller.children] as HTMLElement[])).toBe(true);
  });

  it("does not reverse direction when post-lift scroll rubber-bands", () => {
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200);
      dispatchPointerEvent(scroller, "pointermove", 160);
      scroller.scrollLeft = 30;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 160);
      // Simulated fling end bounce left (wrong-way micro ticks after lift).
      scroller.scrollLeft = 28;
      scroller.dispatchEvent(new Event("scroll"));
      scroller.scrollLeft = 25;
      scroller.dispatchEvent(new Event("scroll"));
    });
    settleAfterMomentum();

    // Must still land on the next column to the right, not snap back to 0.
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
  });

  it("backward short swipe snaps to the previous column on the left", () => {
    const scroller = createScroller(3, COLUMN_WIDTH);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 100);
      dispatchPointerEvent(scroller, "pointermove", 140);
      scroller.scrollLeft = COLUMN_WIDTH - 8;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 140);
    });
    settleAfterMomentum();

    expect(scroller.scrollLeft).toBe(0);
  });

  it("free-scrolls while dragging and coasts after lift before snapping", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200);
      scroller.scrollLeft = 40;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointermove", 160);
      dispatchPointerEvent(scroller, "pointerup", 160);
    });
    expect(scroller.scrollLeft).toBe(40);

    act(() => {
      scroller.scrollLeft = 70;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(scroller.scrollLeft).toBe(70);

    settleAfterMomentum();
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
  });

  it("pins after settle so residual fling cannot move the board", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => dispatchShortSwipe(scroller, { scrollDelta: 10, clientDelta: 20 }));
    settleAfterMomentum();
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);

    act(() => {
      scroller.scrollLeft = COLUMN_WIDTH + 40;
      scroller.dispatchEvent(new Event("scroll"));
      scroller.dispatchEvent(new Event("scrollend"));
      vi.advanceTimersByTime(500);
    });
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
  });

  it("does not snap on touchcancel mid-drag", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200);
      dispatchPointerEvent(scroller, "pointermove", 170);
      scroller.scrollLeft = 25;
      scroller.dispatchEvent(new Event("scroll"));
      scroller.dispatchEvent(new Event("touchcancel"));
      vi.advanceTimersByTime(30);
    });
    expect(scroller.scrollLeft).toBe(25);

    settleAfterMomentum();
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
  });

  it("does not snap on mount or programmatic scrolling", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      scroller.scrollLeft = 40;
      scroller.dispatchEvent(new Event("scroll"));
      scroller.dispatchEvent(new Event("scrollend"));
      vi.advanceTimersByTime(500);
    });
    expect(scroller.scrollLeft).toBe(40);
  });

  it("requires horizontal movement rather than a tap", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 100);
      dispatchPointerEvent(scroller, "pointerup", 100);
      vi.advanceTimersByTime(500);
    });
    expect(scroller.scrollLeft).toBe(0);
  });

  it("does not attach on non-phone desktop", () => {
    stubViewport("wide-short-desktop");
    expect(isMobileViewport()).toBe(false);
    const scroller = createScroller();
    const addListener = vi.spyOn(scroller, "addEventListener");
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => dispatchShortSwipe(scroller, { scrollDelta: 10, clientDelta: 20 }));
    expect(addListener).not.toHaveBeenCalledWith("pointerup", expect.any(Function));
    expect(scroller.scrollLeft).toBe(10);
  });

  it.each([0, 1])("does nothing with %s columns", (columnCount) => {
    const scroller = createScroller(columnCount);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => dispatchShortSwipe(scroller, { scrollDelta: 10, clientDelta: 20 }));
    settleAfterMomentum();
    expect(scroller.scrollLeft).toBe(10);
  });
});
