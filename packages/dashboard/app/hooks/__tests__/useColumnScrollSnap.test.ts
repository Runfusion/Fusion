import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAGE_ANIMATION_MS,
  PIN_MAX_REASSERT_MS,
  isColumnCentered,
  resolvePanDirection,
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

/*
FNXC:BoardNavigation 2026-09-17-09:49:
FN-500 : la fixture déclare son `scrollWidth`. La production ne conserve plus d'exception « scrollWidth
inutilisable → borne supérieure infinie » : un ancrage doit toujours être une position ATTEIGNABLE, donc
c'est à la fixture de décrire une géométrie réaliste.
*/
function createScroller(columnCount = 3, initialScrollLeft = 0): HTMLElement {
  const scroller = document.createElement("main");
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: COLUMN_WIDTH });
  Object.defineProperty(scroller, "scrollWidth", {
    configurable: true,
    value: columnCount * COLUMN_WIDTH,
  });
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
  pointerType: "touch" | "mouse" = "touch",
): void {
  scroller.dispatchEvent(
    new PointerEvent(type, { clientX, clientY, pointerType, pointerId: 1, isPrimary: true, bubbles: true, cancelable: true }),
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

/*
FNXC:BoardNavigation 2026-07-24-11:20:
The hook now owns the post-lift motion: a directional lift animates to its target column instead of
waiting out native inertia. Settling therefore means "run the page animation to completion", so this
helper advances past both the idle fallback and the longest page animation.
*/
const SETTLE_ADVANCE_MS = 500;

/*
FNXC:BoardNavigation 2026-09-14-20:19:
FN-398 bounded the compositor pin, so cases that assert the fence must reach the snap WITHOUT spending the whole
fence window first. This advance clears the single-column page animation plus a couple of frames, leaving the fence open.

FNXC:BoardNavigation 2026-09-17-09:49:
FN-500 : la transition dure désormais PAGE_ANIMATION_MS (280 ms) avec un profil accelération/décélération ;
cette avance est dérivée de la constante de production, jamais recopiée.
*/
const PAGE_ANIMATION_SETTLE_MS = PAGE_ANIMATION_MS + 34;

function settleAfterMomentum(): void {
  act(() => {
    vi.advanceTimersByTime(SETTLE_ADVANCE_MS);
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

/*
FNXC:BoardNavigation 2026-07-26-09:15:
Phone geometry: board columns (min-width 300px) are NARROWER than the phone viewport, so the first
and last columns can never reach their ideal centered scrollLeft (it is negative / past max). This
is the geometry the two-column edge jump only reproduces under — the default `createScroller` makes
columns exactly viewport-wide, where every column is perfectly centerable.
*/
const NARROW_VIEWPORT_WIDTH = 390;
const NARROW_COLUMN_WIDTH = 300;

function createNarrowColumnScroller(columnCount: number, initialScrollLeft: number): HTMLElement {
  const scroller = document.createElement("main");
  const contentWidth = columnCount * NARROW_COLUMN_WIDTH;
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: NARROW_VIEWPORT_WIDTH });
  Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: contentWidth });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, NARROW_VIEWPORT_WIDTH, 200);
  const maxScrollLeft = Math.max(0, contentWidth - NARROW_VIEWPORT_WIDTH);
  let scrollLeft = initialScrollLeft;
  Object.defineProperty(scroller, "scrollLeft", {
    configurable: true,
    get: () => scrollLeft,
    // Mirror the browser: positions outside the scrollable range are clamped, never stored.
    set: (value: number) => {
      scrollLeft = Math.min(Math.max(value, 0), maxScrollLeft);
    },
  });
  scroller.setPointerCapture = vi.fn();
  scroller.releasePointerCapture = vi.fn();
  scroller.hasPointerCapture = vi.fn(() => false);
  for (let index = 0; index < columnCount; index++) {
    const column = document.createElement("section");
    column.className = "column";
    column.getBoundingClientRect = () =>
      new DOMRect(index * NARROW_COLUMN_WIDTH - scrollLeft, 0, NARROW_COLUMN_WIDTH, 200);
    scroller.append(column);
  }
  document.body.append(scroller);
  return scroller;
}

/** scrollLeft that rests column `index` at its (range-clamped) center. */
function narrowColumnRest(index: number, columnCount: number): number {
  const ideal =
    index * NARROW_COLUMN_WIDTH + NARROW_COLUMN_WIDTH / 2 - NARROW_VIEWPORT_WIDTH / 2;
  const maxScrollLeft = Math.max(0, columnCount * NARROW_COLUMN_WIDTH - NARROW_VIEWPORT_WIDTH);
  return Math.min(Math.max(Math.round(ideal), 0), maxScrollLeft);
}

/** One deliberate drag: finger travel plus the board scroll it produced, then lift. */
function dispatchDrag(
  scroller: HTMLElement,
  options: { scrollDelta: number; clientDelta: number },
): void {
  const { scrollDelta, clientDelta } = options;
  scroller.dispatchEvent(new Event("touchstart"));
  dispatchPointerEvent(scroller, "pointerdown", 200);
  dispatchPointerEvent(scroller, "pointermove", 200 - clientDelta);
  scroller.scrollLeft = scroller.scrollLeft + scrollDelta;
  scroller.dispatchEvent(new Event("scroll"));
  dispatchPointerEvent(scroller, "pointerup", 200 - clientDelta);
}

describe("edge columns narrower than the viewport", () => {
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

  it("counts the far-left rest position as centered on the first column", () => {
    const scroller = createNarrowColumnScroller(4, 0);
    expect(isColumnCentered(scroller, [...scroller.children] as HTMLElement[])).toBe(true);
  });

  it("counts the far-right rest position as centered on the last column", () => {
    const columnCount = 4;
    const scroller = createNarrowColumnScroller(columnCount, narrowColumnRest(columnCount - 1, columnCount));
    expect(isColumnCentered(scroller, [...scroller.children] as HTMLElement[])).toBe(true);
  });

  /*
  FNXC:BoardNavigation 2026-07-26-09:15:
  Original symptom: one swipe starting on the far-left column advanced TWO columns, while the same
  swipe from a scrolled-over position advanced one. Assert one column of travel from every resting
  position — both clamped edges and the interior.
  */
  it.each([
    { label: "far-left edge", from: 0, expected: 1 },
    { label: "interior column", from: 1, expected: 2 },
  ])("advances exactly one column per forward swipe from the $label", ({ from, expected }) => {
    const columnCount = 4;
    const scroller = createNarrowColumnScroller(columnCount, narrowColumnRest(from, columnCount));
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    // Drag far enough that the NEAREST column has already flipped to the next one at lift.
    act(() => dispatchDrag(scroller, { scrollDelta: 200, clientDelta: 200 }));
    settleAfterMomentum();

    expect(scroller.scrollLeft).toBe(narrowColumnRest(expected, columnCount));
  });

  it("advances exactly one column per backward swipe from the far-right edge", () => {
    const columnCount = 4;
    const scroller = createNarrowColumnScroller(columnCount, narrowColumnRest(columnCount - 1, columnCount));
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => dispatchDrag(scroller, { scrollDelta: -200, clientDelta: -200 }));
    settleAfterMomentum();

    expect(scroller.scrollLeft).toBe(narrowColumnRest(columnCount - 2, columnCount));
  });

  it("never pins an unreachable scroll position at an edge", () => {
    const scroller = createNarrowColumnScroller(4, narrowColumnRest(1, 4));
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => dispatchDrag(scroller, { scrollDelta: -400, clientDelta: -400 }));
    settleAfterMomentum();
    const settled = scroller.scrollLeft;

    // The pin watchdog must agree with the clamped position instead of fighting it forever.
    act(() => vi.advanceTimersByTime(200));
    expect(scroller.scrollLeft).toBe(settled);
    expect(settled).toBe(0);
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

  /*
  FNXC:BoardNavigation 2026-08-18-19:10:
  A direction-zero release still has a meaningful correction when the finger leaves the viewport
  between columns. Keep that correction on the normal-motion path so proximity does not create an
  abrupt lock, while the nearest reachable column remains the same target.
  */
  it("smoothly settles a zero-direction pan at the nearest column center", () => {
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
    expect(scroller.scrollLeft).toBe(40);

    const samples: number[] = [];
    for (let index = 0; index < 4; index++) {
      act(() => {
        vi.advanceTimersByTime(32);
      });
      samples.push(scroller.scrollLeft);
    }

    expect(samples.some((value) => value > 0 && value < 40)).toBe(true);
    expect(samples.every((value) => value >= 0 && value <= 40)).toBe(true);
    for (let index = 1; index < samples.length; index++) {
      expect(samples[index]).toBeLessThanOrEqual(samples[index - 1]);
    }

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

  /*
  FNXC:BoardNavigation 2026-08-18-19:10:
  Backward phone releases must use the same continuous normal-motion path as forward releases;
  direction changes the existing target only, not whether the board visibly jumps to it.
  */
  it("smoothly settles a backward release without overshooting the target", () => {
    const scroller = createScroller(3, COLUMN_WIDTH);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 100);
      dispatchPointerEvent(scroller, "pointermove", 140);
      scroller.scrollLeft = COLUMN_WIDTH - 8;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 140);
    });

    const samples: number[] = [];
    for (let index = 0; index < 4; index++) {
      act(() => {
        vi.advanceTimersByTime(32);
      });
      samples.push(scroller.scrollLeft);
    }
    expect(samples.some((value) => value > 0 && value < COLUMN_WIDTH - 8)).toBe(true);
    expect(samples.every((value) => value >= 0 && value <= COLUMN_WIDTH - 8)).toBe(true);
    for (let index = 1; index < samples.length; index++) {
      expect(samples[index]).toBeLessThanOrEqual(samples[index - 1]);
    }

    settleAfterMomentum();
    expect(scroller.scrollLeft).toBe(0);
  });

  /*
  FNXC:BoardNavigation 2026-07-24-11:20:
  Free-scroll while the finger is DOWN is still untouched. What changed is after lift: the hook
  animates to the target column itself, so a residual native-inertia write mid-animation cannot
  redirect the destination.
  */
  it("free-scrolls while dragging, then owns the motion after lift", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200);
      scroller.scrollLeft = 40;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointermove", 160);
    });
    // Finger still down: the board rests wherever it was dragged.
    expect(scroller.scrollLeft).toBe(40);

    act(() => {
      dispatchPointerEvent(scroller, "pointerup", 160);
      // Residual compositor inertia tick arriving after lift, mid page animation.
      scroller.scrollLeft = 70;
      scroller.dispatchEvent(new Event("scroll"));
    });

    settleAfterMomentum();
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
  });

  /*
  FNXC:BoardNavigation 2026-07-24-11:20:
  Owning the momentum means the page starts moving on lift rather than after the native coast.
  Guard the observable part of that: partway through the animation the board has already left the
  release point and is heading toward the target column.
  */
  it("starts moving toward the target column during the page animation", () => {
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => dispatchShortSwipe(scroller, { scrollDelta: 8, clientDelta: 20 }));

    const samples: number[] = [];
    for (let index = 0; index < 4; index++) {
      act(() => {
        vi.advanceTimersByTime(32);
      });
      samples.push(scroller.scrollLeft);
    }
    expect(samples.some((value) => value > 8 && value < COLUMN_WIDTH)).toBe(true);
    expect(samples.every((value) => value >= 8 && value <= COLUMN_WIDTH)).toBe(true);
    for (let index = 1; index < samples.length; index++) {
      expect(samples[index]).toBeGreaterThanOrEqual(samples[index - 1]);
    }

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
  FNXC:BoardNavigation 2026-07-22-21:40 (reframed 2026-07-24-11:20):
  The corrective seam used to be tap-to-stop during native momentum; owning the momentum replaces
  that long coast with a ~200ms animation, so the equivalent guard is a re-touch DURING the page
  animation. It must cancel the pending page and let the new drag's direction win.
  */
  it("lets a drag that interrupts the page animation win over the pending page", () => {
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      // Swipe right: the hook starts animating toward column 1.
      dispatchPointerEvent(scroller, "pointerdown", 200);
      dispatchPointerEvent(scroller, "pointermove", 160);
      scroller.scrollLeft = 30;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 160);
    });

    // Let the page animation get most of the way to column 1, then grab it.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(scroller.scrollLeft).toBeGreaterThan(30);
    expect(scroller.scrollLeft).toBeLessThan(COLUMN_WIDTH);

    act(() => {
      // Re-touch cancels the animation; drag back left.
      dispatchPointerEvent(scroller, "pointerdown", 150);
      dispatchPointerEvent(scroller, "pointermove", 190);
      scroller.scrollLeft = 60;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 190);
    });
    settleAfterMomentum();

    // The leftward corrective drag wins: back to column 0, never onward to column 1.
    expect(scroller.scrollLeft).toBe(0);
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

  /*
  FNXC:BoardNavigation 2026-09-14-20:19:
  FN-398 turned the pin into a BOUNDED compositor fence. Residual fling arriving inside the fence window is
  still corrected — that is what this case has always guarded — but the fence now closes on its own instead of
  vetoing every later scroll "until the next touch", which is what took the scroll away from mouse, keyboard and
  programmatic board-scroll restores.
  */
  it("pins residual fling that arrives inside the bounded compositor fence", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchShortSwipe(scroller, { scrollDelta: 10, clientDelta: 20 });
      vi.advanceTimersByTime(PAGE_ANIMATION_SETTLE_MS);
      expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);

      // Late WebKit compositor write, one frame after the snap: still inside the fence.
      scroller.scrollLeft = COLUMN_WIDTH + 40;
      scroller.dispatchEvent(new Event("scroll"));
      scroller.dispatchEvent(new Event("scrollend"));
    });

    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
  });

  it("closes the compositor fence so a later scroll is never rewritten", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchShortSwipe(scroller, { scrollDelta: 10, clientDelta: 20 });
      vi.advanceTimersByTime(PAGE_ANIMATION_SETTLE_MS);
    });
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);

    // Past the bounded window there is no compositor write left to correct.
    act(() => { vi.advanceTimersByTime(PIN_MAX_REASSERT_MS + 32); });

    act(() => {
      scroller.scrollLeft = COLUMN_WIDTH + 40;
      scroller.dispatchEvent(new Event("scroll"));
      scroller.dispatchEvent(new Event("scrollend"));
      vi.advanceTimersByTime(500);
    });

    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH + 40);
  });

  /*
  FNXC:BoardNavigation 2026-09-14-20:19:
  FN-398 reported symptom, board side: once the columns snapped, a scroll written from a NON-touch source (a mouse
  pan, or `restoreBoardScroll` from app/utils/boardScrollSnapshot.ts) was immediately rewritten back to the snapped
  column and the reassert loop kept doing it. A difference beyond compositor drift is a real scroll and is kept.
  */
  it("keeps a real non-touch scroll and releases the pin instead of vetoing it", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchShortSwipe(scroller, { scrollDelta: 10, clientDelta: 20 });
      vi.advanceTimersByTime(PAGE_ANIMATION_SETTLE_MS);
    });
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);

    act(() => {
      scroller.scrollLeft = COLUMN_WIDTH + 2 * COLUMN_WIDTH;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH + 2 * COLUMN_WIDTH);

    // The pin is gone: no reassertion survives to pull the board back.
    act(() => { vi.advanceTimersByTime(500); });
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH + 2 * COLUMN_WIDTH);
  });

  it("still corrects a one-pixel compositor drift inside the fence", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchShortSwipe(scroller, { scrollDelta: 10, clientDelta: 20 });
      vi.advanceTimersByTime(PAGE_ANIMATION_SETTLE_MS);
      scroller.scrollLeft = COLUMN_WIDTH + 1;
      vi.advanceTimersByTime(16);
    });

    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
  });

  it("releases the pin on a mouse pointerdown", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchShortSwipe(scroller, { scrollDelta: 10, clientDelta: 20 });
      vi.advanceTimersByTime(PAGE_ANIMATION_SETTLE_MS);
    });

    act(() => {
      const event = new Event("pointerdown", { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      Object.defineProperty(event, "isPrimary", { value: true });
      scroller.dispatchEvent(event);
      scroller.scrollLeft = COLUMN_WIDTH + 30;
      scroller.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(500);
    });

    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH + 30);
  });

  it("releases the pin on a keyboard scroll", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchShortSwipe(scroller, { scrollDelta: 10, clientDelta: 20 });
      vi.advanceTimersByTime(PAGE_ANIMATION_SETTLE_MS);
    });

    act(() => {
      scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      scroller.scrollLeft = COLUMN_WIDTH + 30;
      scroller.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(500);
    });

    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH + 30);
  });

  /*
  FNXC:BoardNavigation 2026-09-14-20:19:
  FN-398 keeps this iOS invariant but times it against the bounded fence: the callback-less compositor write is
  corrected while the fence is open, after several earlier reassertion passes.
  */
  it("keeps the integer pin after a compositor fling tick arrives after earlier reassertions", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchShortSwipe(scroller, { scrollDelta: 10, clientDelta: 20 });
      // iOS can report scrollend before its final compositor fling tick — and, now, before the
      // hook-owned page animation has finished. It must not abort the page.
      scroller.dispatchEvent(new Event("scrollend"));

      // Run the page animation out, then let several watchdog passes complete before the
      // callback-less compositor write, all inside the bounded fence.
      vi.advanceTimersByTime(PAGE_ANIMATION_SETTLE_MS);
      expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
      scroller.scrollLeft = COLUMN_WIDTH + 40;
      vi.advanceTimersByTime(16);
    });

    const columns = [...scroller.children] as HTMLElement[];
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
    expect(isColumnCentered(scroller, columns)).toBe(true);
  });

  /*
  FNXC:BoardNavigation 2026-07-24-11:20:
  `touchcancel` is a genuine gesture end (unlike a pointercancel with a live touch stream), so a
  cancelled pan pages on the same owned animation as a lift instead of coasting to an idle settle.
  */
  it("pages a cancelled pan gesture on touchcancel", () => {
    const scroller = createScroller();
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200);
      dispatchPointerEvent(scroller, "pointermove", 170);
      scroller.scrollLeft = 25;
      scroller.dispatchEvent(new Event("scroll"));
    });
    // Finger still down: no snapping mid-drag.
    expect(scroller.scrollLeft).toBe(25);

    act(() => {
      scroller.dispatchEvent(new Event("touchcancel"));
    });
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

  it("ignores mouse pointer sequences without capturing, suspending native snap, or settling", () => {
    const scroller = createScroller(3, 30);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200, 0, "mouse");
      dispatchPointerEvent(scroller, "pointermove", 160, 0, "mouse");
      scroller.scrollLeft = 45;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 160, 0, "mouse");
      vi.advanceTimersByTime(500);
    });

    expect(scroller.setPointerCapture).not.toHaveBeenCalled();
    expect(scroller.style.scrollSnapType).not.toBe("none");
    expect(scroller.scrollLeft).toBe(45);
  });

  it("continues to page an equivalent touch pointer sequence", () => {
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200);
      dispatchPointerEvent(scroller, "pointermove", 160);
      scroller.scrollLeft = 30;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 160);
    });
    settleAfterMomentum();

    expect(scroller.setPointerCapture).toHaveBeenCalledWith(1);
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
  });

  it("does not let a mouse pointerup settle an active touch gesture", () => {
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200);
      dispatchPointerEvent(scroller, "pointermove", 160);
      scroller.scrollLeft = 30;
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 160, 0, "mouse");
    });
    expect(scroller.scrollLeft).toBe(30);

    act(() => dispatchPointerEvent(scroller, "pointerup", 160));
    settleAfterMomentum();
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
  });

  /*
  FNXC:BoardNavigation 2026-07-22-15:10 / 2026-07-22-15:26:
  Tap-to-stop during post-lift momentum must not page with the original swipe direction, and
  must smoothly settle to the nearest column center so the board never rests between columns.
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

  /*
  FNXC:BoardNavigation 2026-08-18-19:10:
  A nearest-column animation owns inline overflow only while it runs. Unmounting the Board must
  restore that style and cancel future frame writes rather than leaving a frozen or stale scroller.
  */
  it("restores styles and cancels a nearest-column animation on unmount", () => {
    const scroller = createScroller(3, 40);
    scroller.style.overflowX = "auto";
    const { unmount } = renderHook(() =>
      useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }),
    );

    act(() => {
      dispatchPointerEvent(scroller, "pointerdown", 200);
      scroller.dispatchEvent(new Event("scroll"));
      dispatchPointerEvent(scroller, "pointerup", 200);
      vi.advanceTimersByTime(64);
    });
    const inFlightPosition = scroller.scrollLeft;
    expect(inFlightPosition).toBeGreaterThan(0);
    expect(inFlightPosition).toBeLessThan(40);
    expect(scroller.style.overflowX).toBe("hidden");

    unmount();
    expect(scroller.style.overflowX).toBe("auto");
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(scroller.scrollLeft).toBe(inFlightPosition);
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

  /*
  FNXC:BoardNavigation 2026-09-17-09:49:
  FN-500 : sur téléphone le déplacement est colonne par colonne. Un flick dur et un glissement lent
  depuis la MÊME origine au repos valident donc la même voisine ; la vitesse n'achète plus de pages.
  */
  it("pages exactly one column for a hard flick and for a slow swipe alike", () => {
    const fastScroller = createScroller(5, 0);
    renderHook(() => useColumnScrollSnap(fastScroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      fastScroller.dispatchEvent(new Event("touchstart"));
      dispatchPointerEvent(fastScroller, "pointerdown", 300);
      // ~4 px/ms of real content travel while the finger is down.
      for (let tick = 1; tick <= 3; tick++) {
        vi.advanceTimersByTime(10);
        dispatchPointerEvent(fastScroller, "pointermove", 300 - tick * 40);
        fastScroller.scrollLeft = tick * 40;
        fastScroller.dispatchEvent(new Event("scroll"));
      }
      dispatchPointerEvent(fastScroller, "pointerup", 180);
    });
    settleAfterMomentum();

    expect(fastScroller.scrollLeft).toBe(COLUMN_WIDTH);

    const slowScroller = createScroller(5, 0);
    renderHook(() => useColumnScrollSnap(slowScroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      slowScroller.dispatchEvent(new Event("touchstart"));
      dispatchPointerEvent(slowScroller, "pointerdown", 300);
      // ~0.3 px/ms: a deliberate drag, not a flick.
      for (let tick = 1; tick <= 3; tick++) {
        vi.advanceTimersByTime(50);
        dispatchPointerEvent(slowScroller, "pointermove", 300 - tick * 15);
        slowScroller.scrollLeft = tick * 15;
        slowScroller.dispatchEvent(new Event("scroll"));
      }
      dispatchPointerEvent(slowScroller, "pointerup", 255);
    });
    settleAfterMomentum();

    expect(slowScroller.scrollLeft).toBe(COLUMN_WIDTH);
  });

  /*
  FNXC:BoardNavigation 2026-09-17-09:49:
  FN-500 : une traction longue peut dépasser la voisine sous le doigt. Au lever, le retour VERS cette
  voisine est animé depuis la position courante — ni page supplémentaire, ni retour sec à l'origine.
  */
  it("returns to the single neighbour after a long drag that overshot it", () => {
    const scroller = createScroller(5, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      dispatchPointerEvent(scroller, "pointerdown", 300);
      for (let tick = 1; tick <= 3; tick++) {
        vi.advanceTimersByTime(10);
        dispatchPointerEvent(scroller, "pointermove", 300 - tick * 40);
        scroller.scrollLeft = tick * 40;
        scroller.dispatchEvent(new Event("scroll"));
      }
      // Finger parks for a beat with no further scroll ticks, then lifts.
      vi.advanceTimersByTime(300);
      dispatchPointerEvent(scroller, "pointerup", 180);
    });
    settleAfterMomentum();

    // Nearest column at release (120 -> column 1) rather than a 3-column flick.
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
  });

  /*
  FNXC:BoardNavigation 2026-07-24-11:20:
  Reduced-motion users get the destination without the animation — the page still lands on a column
  center, it just arrives instantly.
  */
  it("jumps instead of animating when the user prefers reduced motion", () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches:
        query === "(max-width: 768px)" ||
        query === "(max-height: 480px)" ||
        query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })));
    const scroller = createScroller(3, 0);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => dispatchShortSwipe(scroller, { scrollDelta: 8, clientDelta: 20 }));

    // No timer advance: the target is already applied at lift.
    expect(scroller.scrollLeft).toBe(COLUMN_WIDTH);
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
