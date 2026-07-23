import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isColumnCentered,
  resolvePanDirection,
  resolveSettleTargetIndex,
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

function dispatchPointerEvent(
  scroller: HTMLElement,
  type: string,
  clientX: number,
  clientY = 0,
): void {
  scroller.dispatchEvent(
    new PointerEvent(type, { clientX, clientY, pointerId: 1, isPrimary: true, bubbles: true, cancelable: true }),
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

describe("resolveSettleTargetIndex", () => {
  it("forward short swipe from column 0 commits to column 1", () => {
    const scroller = createScroller(3, 8);
    expect(resolveSettleTargetIndex(scroller, [...scroller.children] as HTMLElement[], 1, 0)).toBe(1);
  });

  it("forward just past column 0 center still commits to column 1, never back", () => {
    const scroller = createScroller(3, 40);
    expect(resolveSettleTargetIndex(scroller, [...scroller.children] as HTMLElement[], 1, 0)).toBe(1);
  });

  /*
  FNXC:BoardNavigation 2026-07-22-21:05:
  Overshoot regression: a fling that decelerates with column 1 mostly on screen (viewport
  center just past its center) must land on column 1 — the prior pager forced column 2.
  */
  it("forward fling that decelerated onto column 1 lands on column 1, not one further", () => {
    const scroller = createScroller(3, 120);
    expect(resolveSettleTargetIndex(scroller, [...scroller.children] as HTMLElement[], 1, 0)).toBe(1);
  });

  it("forward fling that carried to column 2 lands on column 2 (nearest wins)", () => {
    const scroller = createScroller(3, 180);
    expect(resolveSettleTargetIndex(scroller, [...scroller.children] as HTMLElement[], 1, 0)).toBe(2);
  });

  it("back short swipe from column 1 commits to column 0", () => {
    const scroller = createScroller(3, COLUMN_WIDTH - 8);
    expect(resolveSettleTargetIndex(scroller, [...scroller.children] as HTMLElement[], -1, 1)).toBe(0);
  });

  it("backward fling that decelerated onto column 1 lands on column 1, not one further", () => {
    const scroller = createScroller(3, 80);
    expect(resolveSettleTargetIndex(scroller, [...scroller.children] as HTMLElement[], -1, 2)).toBe(1);
  });

  it("never settles against the locked direction from the origin column", () => {
    // Rubber-band pulled the rest point back onto the origin column: still advance one.
    const forward = createScroller(4, COLUMN_WIDTH);
    expect(resolveSettleTargetIndex(forward, [...forward.children] as HTMLElement[], 1, 1)).toBe(2);
    const backward = createScroller(4, COLUMN_WIDTH);
    expect(resolveSettleTargetIndex(backward, [...backward.children] as HTMLElement[], -1, 1)).toBe(0);
  });

  it("clamps at the board edges", () => {
    const last = createScroller(3, COLUMN_WIDTH * 2);
    expect(resolveSettleTargetIndex(last, [...last.children] as HTMLElement[], 1, 2)).toBe(2);
    const first = createScroller(3, 0);
    expect(resolveSettleTargetIndex(first, [...first.children] as HTMLElement[], -1, 0)).toBe(0);
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

  /*
  FNXC:BoardNavigation 2026-07-22-21:40:
  A vertical card-list scroll with incidental diagonal drift (dx ≥ 12px but dy dominant) must
  not read as a horizontal swipe — it previously paged the board to the next column.
  */
  it("does not page the board when a vertical card-list scroll drifts diagonally", () => {
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200, 400);
      // 15px of horizontal drift during 140px of vertical scrolling inside a column.
      dispatchPointerEvent(scroller, "pointermove", 185, 260);
      dispatchPointerEvent(scroller, "pointerup", 185, 260);
    });
    settleAfterMomentum();
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(scroller.scrollLeft).toBe(0);
  });

  /*
  FNXC:BoardNavigation 2026-07-22-21:40:
  Tap-to-stop during momentum, then drag: the new drag's landing point must win. The
  commit-one-column clamp only applies to gestures that began centered at rest — from a
  mid-transit origin it forced a page past the corrective drag.
  */
  it("takes the new drag's landing point after a tap-to-stop mid-transit", () => {
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      // Swipe right, coast mid-transit past column 1's center.
      dispatchPointerEvent(scroller, "pointerdown", 200);
      dispatchPointerEvent(scroller, "pointermove", 160);
      scroller.scrollLeft = 30;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 160);
      scroller.scrollLeft = 130;
      scroller.dispatchEvent(new Event("scroll"));

      // Tap to stop, then drag back left onto column 1's center.
      dispatchPointerEvent(scroller, "pointerdown", 150);
      dispatchPointerEvent(scroller, "pointermove", 180);
      scroller.scrollLeft = 100;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 180);
    });
    settleAfterMomentum();

    // Regression: the min-progress clamp previously forced column 0 (scrollLeft 0).
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
    expect(isColumnCentered(scroller, [...scroller.children] as HTMLElement[])).toBe(true);
  });

  it("does not overshoot a fling that decelerates with the next column mostly on screen", () => {
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200);
      dispatchPointerEvent(scroller, "pointermove", 150);
      scroller.scrollLeft = 60;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 150);
      // Momentum carries just past column 1's center — column 1 is mostly on screen.
      scroller.scrollLeft = 120;
      scroller.dispatchEvent(new Event("scroll"));
    });
    settleAfterMomentum();

    // Regression: the directional pager previously pushed on to column 2 (scrollLeft 200).
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

  it("keeps the integer pin after a compositor fling tick arrives after earlier reassertions", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchShortSwipe(scroller, { scrollDelta: 10, clientDelta: 20 });
      // iOS can report scrollend before its final compositor fling tick.
      scroller.dispatchEvent(new Event("scrollend"));
      expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);

      // Let multiple watchdog passes complete before the callback-less compositor write.
      vi.advanceTimersByTime(48);
      scroller.scrollLeft = COLUMN_WIDTH + 40;
      vi.advanceTimersByTime(16);
    });

    const columns = [...scroller.children] as HTMLElement[];
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
    expect(isColumnCentered(scroller, columns)).toBe(true);
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

  /*
  FNXC:BoardNavigation 2026-07-22-20:10:
  iOS/Android fire pointercancel when native scrolling claims the touch, while touchmove/touchend
  keep flowing. An early pointercancel must not orphan the gesture (board resting mid-column until
  the next tap), and it must not arm the idle settle while the finger is still down (mid-drag
  snap-back fighting a slow scroll, worst at the edge columns).
  */
  it("still settles after native scroll takeover cancels the pointer stream early", () => {
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      dispatchPointerEvent(scroller, "pointerdown", 200);
      // Native pan claims the gesture before 12px of finger travel.
      dispatchPointerEvent(scroller, "pointercancel", 195);
      // Touch stream continues: finger drags the board to a mid-column rest, then lifts.
      scroller.scrollLeft = 40;
      scroller.dispatchEvent(new Event("scroll"));
      scroller.dispatchEvent(new Event("touchend"));
    });
    settleAfterMomentum();

    // Regression: the orphaned gesture previously left the board resting at 40 until a tap.
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
    expect(isColumnCentered(scroller, [...scroller.children] as HTMLElement[])).toBe(true);
  });

  it("does not snap mid-drag when the finger pauses after pointercancel", () => {
    const scroller = createScroller(3, COLUMN_WIDTH * 2);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      dispatchPointerEvent(scroller, "pointerdown", 100);
      dispatchPointerEvent(scroller, "pointercancel", 100);
      // Slow scroll away from the last column, then the finger pauses while still down.
      scroller.scrollLeft = COLUMN_WIDTH * 2 - 20;
      scroller.dispatchEvent(new Event("scroll"));
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });
    // Regression: the idle settle previously fired mid-drag and snapped back to the edge column.
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH * 2 - 20);

    act(() => {
      scroller.scrollLeft = COLUMN_WIDTH + 50;
      scroller.dispatchEvent(new Event("scroll"));
      scroller.dispatchEvent(new Event("touchend"));
    });
    settleAfterMomentum();

    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
    expect(isColumnCentered(scroller, [...scroller.children] as HTMLElement[])).toBe(true);
  });

  it("still fully cancels on pointercancel when no touch stream is active", () => {
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      // Pointer-only gesture (no touchstart): pointercancel is a genuine gesture end.
      dispatchPointerEvent(scroller, "pointerdown", 200);
      dispatchPointerEvent(scroller, "pointermove", 160);
      scroller.scrollLeft = 30;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointercancel", 160);
    });
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

  /*
  FNXC:BoardNavigation 2026-07-22-15:10 / 2026-07-22-15:26:
  Tap-to-stop during post-lift momentum must not page with the original swipe direction, and
  must hard-jump to the nearest column center so the board never rests between columns.
  */
  it("tap during momentum settles to nearest column, not the cancelled swipe direction", () => {
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      // Forward swipe arms a rightward directional settle (would page to column 1).
      dispatchPointerEvent(scroller, "pointerdown", 200);
      dispatchPointerEvent(scroller, "pointermove", 160);
      scroller.scrollLeft = 30;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 160);

      // Coast only slightly — still nearest to column 0 — then tap to stop.
      scroller.scrollLeft = 40;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerdown", 100);
      dispatchPointerEvent(scroller, "pointerup", 100);
    });

    settleAfterMomentum();
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // Nearest is column 0; original rightward settle would have jumped to COLUMN_WIDTH.
    expect(scroller.scrollLeft).toBe(0);
    expect(isColumnCentered(scroller, [...scroller.children] as HTMLElement[])).toBe(true);
  });

  it("tap during momentum past the midpoint snaps to the nearer column center", () => {
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200);
      dispatchPointerEvent(scroller, "pointermove", 160);
      scroller.scrollLeft = 30;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 160);

      // Past the midpoint toward column 1 — nearest is column 1.
      scroller.scrollLeft = 55;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerdown", 100);
      dispatchPointerEvent(scroller, "pointerup", 100);
    });

    settleAfterMomentum();
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
    expect(isColumnCentered(scroller, [...scroller.children] as HTMLElement[])).toBe(true);
  });

  it("never rests between columns after a zero-direction settle", () => {
    const scroller = createScroller(3, 40);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200);
      scroller.scrollLeft = 40;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 200);
    });
    settleAfterMomentum();

    const columns = [...scroller.children] as HTMLElement[];
    expect(isColumnCentered(scroller, columns)).toBe(true);
    expect([0, COLUMN_WIDTH, COLUMN_WIDTH * 2]).toContain(scroller.scrollLeft);
  });

  it("starts a new directional settle after a pan that continues from a mid-momentum re-touch", () => {
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200);
      dispatchPointerEvent(scroller, "pointermove", 160);
      scroller.scrollLeft = 30;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 160);

      // Interrupt fling, then pan back left so settle must use the new gesture only.
      scroller.scrollLeft = 55;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerdown", 100);
      dispatchPointerEvent(scroller, "pointermove", 140);
      scroller.scrollLeft = 20;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 140);
    });
    settleAfterMomentum();

    expect(scroller.scrollLeft).toBe(0);
    expect(isColumnCentered(scroller, [...scroller.children] as HTMLElement[])).toBe(true);
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
