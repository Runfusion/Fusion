import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PAGE_ANIMATION_MS,
  getSnapColumns,
  isColumnCentered,
  nearestAnchorIndex,
  resolveColumnAnchors,
  resolveNeighborAnchor,
  scrollLeftToCenterColumn,
  useColumnScrollSnap,
} from "../useColumnScrollSnap";
import { BOARD_SCROLL_RESTORE_EVENT } from "../../utils/boardScrollSnapshot";

/*
FNXC:BoardNavigation 2026-09-17-09:49:
FN-500 — reproduction d\u00e9terministe du sympt\u00f4me rapport\u00e9 : sur t\u00e9l\u00e9phone, le d\u00e9filement horizontal du
board sautait de plusieurs colonnes selon la vitesse du geste et arrivait s\u00e8chement, au lieu d'avancer
colonne par colonne avec une transition douce. La g\u00e9om\u00e9trie est celle de la sp\u00e9cification : cinq
colonnes de 300 px, \u00e9cart de 16 px, padding horizontal de 16 px, viewport de 390 px.

Les positions atteignables attendues sont calcul\u00e9es ICI, ind\u00e9pendamment de la production, pour qu'une
r\u00e9gression de g\u00e9om\u00e9trie ne puisse pas se cacher derri\u00e8re le m\u00eame helper des deux c\u00f4t\u00e9s de l'assertion.
*/
const VIEWPORT = 390;
const COLUMN = 300;
const GAP = 16;
const PADDING = 16;

/** Left offset of column `index` inside the scroller content. */
function columnContentLeft(index: number): number {
  return PADDING + index * (COLUMN + GAP);
}

function contentWidth(columnCount: number): number {
  return PADDING * 2 + columnCount * COLUMN + Math.max(0, columnCount - 1) * GAP;
}

/** scrollLeft that rests column `index` at its reachable centre. */
function expectedAnchor(index: number, columnCount: number): number {
  const ideal = Math.round(columnContentLeft(index) + COLUMN / 2 - VIEWPORT / 2);
  const max = Math.max(0, contentWidth(columnCount) - VIEWPORT);
  return Math.min(Math.max(ideal, 0), max);
}

interface BoardFixture {
  scroller: HTMLElement;
  /** Native pan tick: the browser moved the content while the finger is down. */
  panTo: (scrollLeft: number) => void;
}

function createBoard(options: {
  columnCount?: number;
  initialScrollLeft?: number;
  /** Extra non-column children (empty-state banner, toolbar) that must never be snap targets. */
  chrome?: number;
  columnWidths?: number[];
  overflow?: boolean;
} = {}): BoardFixture {
  const {
    columnCount = 5,
    initialScrollLeft = 0,
    chrome = 0,
    columnWidths,
    overflow = true,
  } = options;
  const widths = columnWidths ?? new Array(columnCount).fill(COLUMN);
  const scroller = document.createElement("main");
  scroller.className = "board board-workflow-columns";
  const total = overflow
    ? PADDING * 2 + widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * GAP
    : VIEWPORT;
  const maxScrollLeft = Math.max(0, total - VIEWPORT);
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: VIEWPORT });
  Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: total });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, VIEWPORT, 700);
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

  for (let index = 0; index < chrome; index++) {
    const banner = document.createElement("div");
    banner.className = "board-empty-state";
    banner.getBoundingClientRect = () => new DOMRect(-scrollLeft, 0, 120, 700);
    scroller.append(banner);
  }

  let offset = PADDING;
  for (let index = 0; index < widths.length; index++) {
    const column = document.createElement("section");
    column.className = "column";
    column.dataset.column = `lane-${index}`;
    const left = offset;
    const width = widths[index];
    column.getBoundingClientRect = () => new DOMRect(left - scrollLeft, 0, width, 700);
    // Cards and virtualization spacers are descendants, never horizontal snap targets.
    const body = document.createElement("div");
    body.className = "column-body";
    const nested = document.createElement("div");
    nested.className = "column";
    body.append(nested);
    column.append(body);
    scroller.append(column);
    offset += width + GAP;
  }
  document.body.append(scroller);
  return {
    scroller,
    panTo: (value: number) => {
      scroller.scrollLeft = value;
      scroller.dispatchEvent(new Event("scroll"));
    },
  };
}

function stubPhoneViewport(): void {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === "(max-width: 768px)" || query === "(max-height: 480px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })));
  Object.defineProperty(window, "screen", { configurable: true, value: { width: 390, height: 844 } });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
  vi.stubGlobal("visualViewport", {
    width: 390,
    height: 844,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

function pointer(scroller: HTMLElement, type: string, clientX: number, clientY = 400): void {
  scroller.dispatchEvent(new PointerEvent(type, {
    clientX,
    clientY,
    pointerType: "touch",
    pointerId: 1,
    isPrimary: true,
    bubbles: true,
    cancelable: true,
  }));
}

function mount(scroller: HTMLElement): void {
  renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));
}

/** Run the owned transition to completion (plus the bounded compositor fence). */
function settle(): void {
  act(() => {
    vi.advanceTimersByTime(PAGE_ANIMATION_MS + 240);
  });
}

/**
 * One finger gesture: press, native pan ticks spaced by `stepMs`, then lift.
 * Returns the scrollLeft samples observed during the hook-owned transition.
 */
function swipe(fixture: BoardFixture, options: {
  from: number;
  ticks: number[];
  stepMs?: number;
  /** Samples of the owned transition, taken every 32ms. */
  sampleFrames?: number;
}): number[] {
  const { scroller, panTo } = fixture;
  const { from, ticks, stepMs = 50, sampleFrames = 6 } = options;
  const samples: number[] = [];
  act(() => {
    scroller.dispatchEvent(new Event("touchstart"));
    pointer(scroller, "pointerdown", from);
    let travelled = 0;
    for (const tick of ticks) {
      vi.advanceTimersByTime(stepMs);
      travelled = tick;
      pointer(scroller, "pointermove", from - travelled);
      panTo(scroller.scrollLeft + (tick - (ticks[ticks.indexOf(tick) - 1] ?? 0)));
    }
    pointer(scroller, "pointerup", from - travelled);
  });
  for (let index = 0; index < sampleFrames; index++) {
    act(() => {
      vi.advanceTimersByTime(32);
    });
    samples.push(scroller.scrollLeft);
  }
  settle();
  return samples;
}

describe("FN-500 board column anchors are real columns only", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubPhoneViewport();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("matches the specification geometry: [0, 287, 603, 919, 1206]", () => {
    const { scroller } = createBoard();
    expect(scroller.scrollWidth).toBe(1596);
    const anchors = resolveColumnAnchors(scroller, getSnapColumns(scroller));
    expect(anchors).toEqual([0, 287, 603, 919, 1206]);
    expect(anchors).toEqual([0, 1, 2, 3, 4].map((index) => expectedAnchor(index, 5)));
  });

  it("never treats chrome, cards or nested descendants as snap targets", () => {
    const { scroller } = createBoard({ columnCount: 1, chrome: 1 });
    const columns = getSnapColumns(scroller);

    expect(columns).toHaveLength(1);
    expect(columns[0].dataset.column).toBe("lane-0");
    expect(columns.some((element) => element.classList.contains("board-empty-state"))).toBe(false);
    // The nested `.column` inside `.column-body` is a descendant, not a direct child.
    expect(scroller.querySelectorAll(".column")).toHaveLength(2);
  });

  it.each([
    { label: "zero columns", columnCount: 0, chrome: 2, expected: 0 },
    { label: "one column plus chrome", columnCount: 1, chrome: 1, expected: 1 },
    { label: "many columns plus chrome", columnCount: 5, chrome: 2, expected: 5 },
  ])("returns only the real columns for $label", ({ columnCount, chrome, expected }) => {
    const { scroller } = createBoard({ columnCount, chrome });
    expect(getSnapColumns(scroller)).toHaveLength(expected);
  });

  it("excludes hidden columns from the reachable anchors", () => {
    const { scroller } = createBoard({ columnCount: 3 });
    const columns = Array.from(scroller.children) as HTMLElement[];
    columns[1].hidden = true;

    expect(getSnapColumns(scroller)).toHaveLength(2);
  });

  it("keeps identical lane labels as distinct target elements", () => {
    const { scroller } = createBoard({ columnCount: 3 });
    for (const column of Array.from(scroller.children) as HTMLElement[]) {
      column.textContent = "Todo";
    }
    const columns = getSnapColumns(scroller);

    expect(new Set(columns).size).toBe(3);
    expect(resolveColumnAnchors(scroller, columns)).toEqual([0, 287, 603].map((_, index) => expectedAnchor(index, 3)));
  });

  it("clamps unequal-width edge columns to reachable positions", () => {
    const { scroller } = createBoard({ columnWidths: [180, 420, 200] });
    const anchors = resolveColumnAnchors(scroller, getSnapColumns(scroller));

    const max = scroller.scrollWidth - VIEWPORT;
    expect(anchors[0]).toBe(0);
    expect(anchors[anchors.length - 1]).toBe(max);
    for (const anchor of anchors) {
      expect(anchor).toBeGreaterThanOrEqual(0);
      expect(anchor).toBeLessThanOrEqual(max);
    }
  });

  it("treats anchors that coincide at an edge as a single reachable stop", () => {
    // Two narrow leading columns whose ideal centres are both negative: they rest at scrollLeft 0.
    const { scroller } = createBoard({ columnWidths: [60, 80, 900, 900] });
    const anchors = resolveColumnAnchors(scroller, getSnapColumns(scroller));

    expect(anchors[0]).toBe(0);
    expect(anchors[1]).toBe(0);
    // Paging forward from the first column must skip the coincident stop.
    expect(resolveNeighborAnchor({ anchors, originIndex: 0, direction: 1 })).toBe(anchors[2]);
    expect(resolveNeighborAnchor({ anchors, originIndex: 1, direction: -1 })).toBe(0);
  });

  it("resolves a board without overflow to the single reachable position", () => {
    const { scroller } = createBoard({ columnCount: 1, overflow: false });
    const columns = getSnapColumns(scroller);

    expect(scrollLeftToCenterColumn(scroller, columns[0])).toBe(0);
  });

  it("clamps overscroll beyond both ends back onto real anchors", () => {
    const { scroller } = createBoard({ initialScrollLeft: 0 });
    const anchors = resolveColumnAnchors(scroller, getSnapColumns(scroller));

    expect(nearestAnchorIndex(-80, anchors)).toBe(0);
    expect(nearestAnchorIndex(99_999, anchors)).toBe(anchors.length - 1);
  });
});

describe("FN-500 mobile paging is one column at a time, smoothly", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubPhoneViewport();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /*
  FNXC:BoardNavigation 2026-09-17-09:49:
  Sympt\u00f4me exact : `0 -> 90 -> 180 -> 270` en 3 ticks de 50 ms puis lever. L'ancien code d\u00e9duisait deux
  pages (1,8 px/ms, 270 px de trajet) et visait 603. Le contrat est la voisine, 287.
  */
  it("reproduction: a fast three-tick swipe pages to the neighbour, not two columns ahead", () => {
    const fixture = createBoard();
    mount(fixture.scroller);

    const samples = swipe(fixture, { from: 330, ticks: [90, 180, 270] });

    expect(fixture.scroller.scrollLeft).toBe(expectedAnchor(1, 5));
    expect(fixture.scroller.scrollLeft).not.toBe(expectedAnchor(2, 5));
    expect(samples.some((value) => value > 270 && value < expectedAnchor(1, 5))).toBe(true);
  });

  it("reproduction: the same travel done slowly also pages exactly one column", () => {
    const fixture = createBoard();
    mount(fixture.scroller);

    swipe(fixture, { from: 330, ticks: [90, 180, 270], stepMs: 220 });

    expect(fixture.scroller.scrollLeft).toBe(expectedAnchor(1, 5));
  });

  it("reproduction: a small deliberate swipe stopping at 35px still validates the neighbour", () => {
    const fixture = createBoard();
    mount(fixture.scroller);

    swipe(fixture, { from: 330, ticks: [35] });

    expect(fixture.scroller.scrollLeft).toBe(expectedAnchor(1, 5));
  });

  it("never teleports at lift and interpolates smoothly to the neighbour", () => {
    const fixture = createBoard();
    mount(fixture.scroller);
    const { scroller, panTo } = fixture;

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      pointer(scroller, "pointerdown", 330);
      vi.advanceTimersByTime(50);
      pointer(scroller, "pointermove", 240);
      panTo(90);
    });
    // Finger still down: no correction, no freeze, the pan stands where the browser left it.
    expect(scroller.scrollLeft).toBe(90);
    expect(scroller.style.overflowX).toBe("");

    act(() => {
      pointer(scroller, "pointerup", 240);
    });
    // The lift itself must not jump the board anywhere.
    expect(scroller.scrollLeft).toBe(90);

    const samples: number[] = [];
    for (let index = 0; index < 7; index++) {
      act(() => {
        vi.advanceTimersByTime(32);
      });
      samples.push(scroller.scrollLeft);
    }

    const target = expectedAnchor(1, 5);
    // Progressive departure: an ease-in profile barely moves in the first frame.
    expect(samples[0] - 90).toBeLessThan((target - 90) * 0.2);
    // Monotonic, bounded, no overshoot.
    for (let index = 1; index < samples.length; index++) {
      expect(samples[index]).toBeGreaterThanOrEqual(samples[index - 1]);
    }
    expect(samples.every((value) => value >= 90 && value <= target)).toBe(true);
    expect(samples.filter((value) => value > 90 && value < target).length).toBeGreaterThanOrEqual(3);

    settle();
    expect(scroller.scrollLeft).toBe(target);
  });

  it("walks column by column across three successive swipes and back again", () => {
    const fixture = createBoard();
    mount(fixture.scroller);

    const forward: number[] = [];
    for (let step = 0; step < 3; step++) {
      swipe(fixture, { from: 330, ticks: [60] });
      forward.push(fixture.scroller.scrollLeft);
    }
    expect(forward).toEqual([expectedAnchor(1, 5), expectedAnchor(2, 5), expectedAnchor(3, 5)]);

    const backward: number[] = [];
    for (let step = 0; step < 2; step++) {
      swipe(fixture, { from: 60, ticks: [-60] });
      backward.push(fixture.scroller.scrollLeft);
    }
    expect(backward).toEqual([expectedAnchor(2, 5), expectedAnchor(1, 5)]);
  });

  it("animates back to the chosen neighbour after a long pull overshot it", () => {
    const fixture = createBoard();
    mount(fixture.scroller);
    const { scroller, panTo } = fixture;

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      pointer(scroller, "pointerdown", 360);
      vi.advanceTimersByTime(50);
      pointer(scroller, "pointermove", 100);
      // Native pan drags well past the neighbouring column.
      panTo(430);
      pointer(scroller, "pointerup", 100);
    });

    const samples: number[] = [];
    for (let index = 0; index < 6; index++) {
      act(() => {
        vi.advanceTimersByTime(32);
      });
      samples.push(scroller.scrollLeft);
    }
    const target = expectedAnchor(1, 5);
    // The return is animated from 430, never a hard snap back to the origin.
    expect(samples.some((value) => value > target && value < 430)).toBe(true);
    expect(samples.every((value) => value >= target && value <= 430)).toBe(true);

    settle();
    expect(scroller.scrollLeft).toBe(target);
  });

  it("stops at the first and last columns instead of paging past them", () => {
    const first = createBoard({ initialScrollLeft: 0 });
    mount(first.scroller);
    swipe(first, { from: 60, ticks: [-60] });
    expect(first.scroller.scrollLeft).toBe(expectedAnchor(0, 5));

    const last = createBoard({ initialScrollLeft: expectedAnchor(4, 5) });
    mount(last.scroller);
    swipe(last, { from: 330, ticks: [60] });
    expect(last.scroller.scrollLeft).toBe(expectedAnchor(4, 5));
  });

  it("does not move on a tap over an already anchored column", () => {
    const fixture = createBoard({ initialScrollLeft: expectedAnchor(2, 5) });
    mount(fixture.scroller);

    act(() => {
      fixture.scroller.dispatchEvent(new Event("touchstart"));
      pointer(fixture.scroller, "pointerdown", 200);
      pointer(fixture.scroller, "pointerup", 200);
    });
    settle();

    expect(fixture.scroller.scrollLeft).toBe(expectedAnchor(2, 5));
    expect(fixture.scroller.style.overflowX).toBe("");
  });

  it("every validated user gesture ends on a reachable anchor within 1px", () => {
    const fixture = createBoard();
    mount(fixture.scroller);
    const anchors = [0, 1, 2, 3, 4].map((index) => expectedAnchor(index, 5));

    for (const ticks of [[35], [90, 180, 270], [-40], [200], [-300]]) {
      swipe(fixture, { from: 330, ticks });
      const distance = Math.min(...anchors.map((anchor) => Math.abs(anchor - fixture.scroller.scrollLeft)));
      expect(distance).toBeLessThanOrEqual(1);
    }
  });
});

describe("FN-500 flows without an explicit end, and interruptions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubPhoneViewport();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("treats a horizontal wheel burst as one gesture worth one column", () => {
    const fixture = createBoard();
    mount(fixture.scroller);
    const { scroller, panTo } = fixture;

    act(() => {
      for (let tick = 1; tick <= 4; tick++) {
        scroller.dispatchEvent(new WheelEvent("wheel", { deltaX: 30, deltaY: 0, bubbles: true }));
        panTo(tick * 30);
        vi.advanceTimersByTime(80);
      }
    });
    settle();

    expect(scroller.scrollLeft).toBe(expectedAnchor(1, 5));
  });

  it("ignores a vertical wheel entirely", () => {
    const fixture = createBoard({ initialScrollLeft: 40 });
    mount(fixture.scroller);

    act(() => {
      fixture.scroller.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 120, bubbles: true }));
    });
    settle();

    expect(fixture.scroller.scrollLeft).toBe(40);
    expect(fixture.scroller.style.scrollSnapType).toBe("");
  });

  it("does not page the board on a column-body scroll or a duplicate scrollend", () => {
    const fixture = createBoard({ initialScrollLeft: 40 });
    mount(fixture.scroller);
    const body = fixture.scroller.querySelector(".column-body") as HTMLElement;

    act(() => {
      body.dispatchEvent(new Event("scroll", { bubbles: true }));
      body.dispatchEvent(new Event("scrollend", { bubbles: true }));
    });
    settle();
    expect(fixture.scroller.scrollLeft).toBe(40);

    // A real gesture, then a duplicated scrollend: the second must not buy a second column.
    swipe(fixture, { from: 330, ticks: [60] });
    const landed = fixture.scroller.scrollLeft;
    act(() => {
      fixture.scroller.dispatchEvent(new Event("scrollend"));
      fixture.scroller.dispatchEvent(new Event("scrollend"));
    });
    settle();
    expect(fixture.scroller.scrollLeft).toBe(landed);
  });

  it("lands a gesture that interrupts a transition on the nearest anchor of its own direction", () => {
    const fixture = createBoard();
    mount(fixture.scroller);
    const { scroller, panTo } = fixture;

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      pointer(scroller, "pointerdown", 330);
      vi.advanceTimersByTime(50);
      pointer(scroller, "pointermove", 270);
      panTo(60);
      pointer(scroller, "pointerup", 270);
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    const midTransition = scroller.scrollLeft;
    expect(midTransition).toBeGreaterThan(60);
    expect(midTransition).toBeLessThan(expectedAnchor(1, 5));

    act(() => {
      // Corrective drag back to the left while the transition is running.
      scroller.dispatchEvent(new Event("touchstart"));
      pointer(scroller, "pointerdown", 200);
      vi.advanceTimersByTime(50);
      pointer(scroller, "pointermove", 260);
      panTo(40);
      pointer(scroller, "pointerup", 260);
    });
    settle();

    // Neither the cancelled page nor a mandatory extra page: the nearest anchor of this gesture.
    expect(scroller.scrollLeft).toBe(expectedAnchor(0, 5));
    expect(isColumnCentered(scroller, getSnapColumns(scroller))).toBe(true);
  });

  it("yields the axis to a programmatic restore, including a small one", () => {
    const fixture = createBoard();
    mount(fixture.scroller);
    const { scroller, panTo } = fixture;

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      pointer(scroller, "pointerdown", 330);
      vi.advanceTimersByTime(50);
      pointer(scroller, "pointermove", 270);
      panTo(60);
      pointer(scroller, "pointerup", 270);
    });

    act(() => {
      // A restore announces itself before writing; the hook must stop owning the axis.
      scroller.dispatchEvent(new Event(BOARD_SCROLL_RESTORE_EVENT));
      scroller.scrollLeft = 80;
    });
    settle();

    expect(scroller.scrollLeft).toBe(80);
    expect(scroller.style.overflowX).toBe("");
    expect(scroller.style.scrollSnapType).toBe("");
  });

  it("makes the deferred callbacks of a cancelled interaction inert", () => {
    const fixture = createBoard();
    mount(fixture.scroller);
    const { scroller, panTo } = fixture;

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      pointer(scroller, "pointerdown", 330);
      vi.advanceTimersByTime(50);
      pointer(scroller, "pointermove", 270);
      panTo(60);
      pointer(scroller, "pointerup", 270);
    });

    act(() => {
      scroller.dispatchEvent(new Event(BOARD_SCROLL_RESTORE_EVENT));
      scroller.scrollLeft = 500;
    });
    // Old deadlines and frames belong to a retired generation.
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(scroller.scrollLeft).toBe(500);
  });

  it("restores styles and leaves no pending callback after unmount", () => {
    const fixture = createBoard();
    const hook = renderHook(() => useColumnScrollSnap(fixture.scroller, {
      mobileOnly: true,
      isUserInteraction: () => true,
    }));
    const { scroller, panTo } = fixture;

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      pointer(scroller, "pointerdown", 330);
      vi.advanceTimersByTime(50);
      pointer(scroller, "pointermove", 270);
      panTo(60);
      pointer(scroller, "pointerup", 270);
    });
    act(() => {
      hook.unmount();
    });
    const afterUnmount = scroller.scrollLeft;

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(scroller.style.overflowX).toBe("");
    expect(scroller.style.scrollSnapType).toBe("");
    expect(scroller.scrollLeft).toBe(afterUnmount);
  });

  it("does not attach at all when disabled, and attaches again when re-enabled", () => {
    const fixture = createBoard();
    const hook = renderHook(({ enabled }) => useColumnScrollSnap(fixture.scroller, {
      mobileOnly: true,
      isUserInteraction: () => true,
      enabled,
    }), { initialProps: { enabled: false } });

    swipe(fixture, { from: 330, ticks: [60] });
    expect(fixture.scroller.scrollLeft).toBe(60);

    act(() => {
      hook.rerender({ enabled: true });
    });
    swipe(fixture, { from: 330, ticks: [60] });
    expect(fixture.scroller.scrollLeft).toBe(expectedAnchor(1, 5));
  });

  it("cancels a running transition when the board context changes", () => {
    const fixture = createBoard();
    const hook = renderHook(({ contextKey }) => useColumnScrollSnap(fixture.scroller, {
      mobileOnly: true,
      isUserInteraction: () => true,
      contextKey,
    }), { initialProps: { contextKey: "project-a:wf-1" } });
    const { scroller, panTo } = fixture;

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      pointer(scroller, "pointerdown", 330);
      vi.advanceTimersByTime(50);
      pointer(scroller, "pointermove", 270);
      panTo(60);
      pointer(scroller, "pointerup", 270);
    });
    act(() => {
      hook.rerender({ contextKey: "project-a:wf-2" });
    });
    const afterSwitch = scroller.scrollLeft;
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(scroller.scrollLeft).toBe(afterSwitch);
    expect(scroller.style.overflowX).toBe("");
  });

  it("resolves the remainder against the columns rendered now, not a stale layout", () => {
    const fixture = createBoard();
    mount(fixture.scroller);
    const { scroller, panTo } = fixture;

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      pointer(scroller, "pointerdown", 330);
      vi.advanceTimersByTime(50);
      pointer(scroller, "pointermove", 270);
      panTo(60);
    });
    act(() => {
      // The last column disappears (SSE update) while the finger is still down.
      scroller.lastElementChild?.remove();
      pointer(scroller, "pointerup", 270);
    });
    settle();

    const anchors = resolveColumnAnchors(scroller, getSnapColumns(scroller));
    expect(anchors).toHaveLength(4);
    expect(anchors).toContain(scroller.scrollLeft);
  });

  it("keeps a reduced-motion user on an exact anchor without animating", () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches:
        query === "(max-width: 768px)"
        || query === "(max-height: 480px)"
        || query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })));
    const fixture = createBoard();
    mount(fixture.scroller);
    const { scroller, panTo } = fixture;

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      pointer(scroller, "pointerdown", 330);
      vi.advanceTimersByTime(50);
      pointer(scroller, "pointermove", 270);
      panTo(60);
      pointer(scroller, "pointerup", 270);
    });

    expect(scroller.scrollLeft).toBe(expectedAnchor(1, 5));
  });

  it("still lands exactly when requestAnimationFrame is unavailable", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const fixture = createBoard();
    mount(fixture.scroller);
    const { scroller, panTo } = fixture;

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      pointer(scroller, "pointerdown", 330);
      vi.advanceTimersByTime(50);
      pointer(scroller, "pointermove", 270);
      panTo(60);
      pointer(scroller, "pointerup", 270);
    });

    expect(scroller.scrollLeft).toBe(expectedAnchor(1, 5));
  });

  it("does not page a vertical card scroll with diagonal drift", () => {
    const fixture = createBoard({ initialScrollLeft: expectedAnchor(1, 5) });
    mount(fixture.scroller);
    const { scroller } = fixture;

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      pointer(scroller, "pointerdown", 200, 600);
      vi.advanceTimersByTime(50);
      pointer(scroller, "pointermove", 185, 300);
      pointer(scroller, "pointerup", 185, 300);
    });
    settle();

    expect(scroller.scrollLeft).toBe(expectedAnchor(1, 5));
  });

  it("never pages twice for the paired pointer and touch events of one gesture", () => {
    const fixture = createBoard();
    mount(fixture.scroller);
    const { scroller, panTo } = fixture;

    act(() => {
      scroller.dispatchEvent(new Event("touchstart"));
      pointer(scroller, "pointerdown", 330);
      vi.advanceTimersByTime(50);
      pointer(scroller, "pointermove", 270);
      panTo(60);
      pointer(scroller, "pointerup", 270);
      scroller.dispatchEvent(new Event("touchend"));
    });
    settle();

    expect(scroller.scrollLeft).toBe(expectedAnchor(1, 5));
  });
});
