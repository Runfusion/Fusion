import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useColumnScrollSnap } from "../useColumnScrollSnap";
import { isMobileViewport } from "../useViewportMode";

const COLUMN_WIDTH = 100;

type PointerCaptureEmulator = {
  dispatchMousePressSequence: (target: HTMLElement) => void;
  setPointerCapture: ReturnType<typeof vi.fn>;
};

function stubNarrowDesktopViewport(): void {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === "(max-width: 768px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })));
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
  Object.defineProperty(window, "screen", { configurable: true, value: { width: 1920, height: 1080 } });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 0 });
  delete (window as Window & { ontouchstart?: unknown }).ontouchstart;
}

function stubTouchPhoneViewport(): void {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === "(max-width: 768px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })));
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(window, "screen", { configurable: true, value: { width: 390, height: 844 } });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 1 });
}

function createScroller(): { scroller: HTMLElement; button: HTMLButtonElement } {
  const scroller = document.createElement("main");
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: COLUMN_WIDTH });
  Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: COLUMN_WIDTH * 3 });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, COLUMN_WIDTH, 200);
  let scrollLeft = 0;
  Object.defineProperty(scroller, "scrollLeft", {
    configurable: true,
    get: () => scrollLeft,
    set: (value: number) => {
      scrollLeft = value;
    },
  });
  for (let index = 0; index < 3; index++) {
    const column = document.createElement("section");
    column.className = "column";
    column.getBoundingClientRect = () => new DOMRect(index * COLUMN_WIDTH - scrollLeft, 0, COLUMN_WIDTH, 200);
    scroller.append(column);
  }
  const button = document.createElement("button");
  scroller.firstElementChild?.append(button);
  document.body.append(scroller);
  return { scroller, button };
}

function pointerEvent(type: string, pointerType: "mouse" | "touch", pointerId = 1, clientX = 20): PointerEvent {
  return new PointerEvent(type, {
    pointerType,
    pointerId,
    isPrimary: true,
    bubbles: true,
    cancelable: true,
    clientX,
    clientY: 20,
  });
}

/*
FNXC:BoardNavigation 2026-08-30-07:12:
jsdom omits browser pointer capture retargeting and the delivery-time ordering that preserves a
capturing ancestor as the click target after it releases capture during pointerup. Snapshot the
holder before pointerup so this seam fails on the production defect instead of reading released state.
*/
function createPointerCaptureEmulator(scroller: HTMLElement): PointerCaptureEmulator {
  let capturedPointerId: number | null = null;
  const setPointerCapture = vi.fn((pointerId: number) => {
    capturedPointerId = pointerId;
  });
  const releasePointerCapture = vi.fn((pointerId: number) => {
    if (capturedPointerId === pointerId) capturedPointerId = null;
  });
  const hasPointerCapture = vi.fn((pointerId: number) => capturedPointerId === pointerId);
  scroller.setPointerCapture = setPointerCapture;
  scroller.releasePointerCapture = releasePointerCapture;
  scroller.hasPointerCapture = hasPointerCapture;

  return {
    setPointerCapture,
    dispatchMousePressSequence(target) {
      target.dispatchEvent(pointerEvent("pointerdown", "mouse"));
      const deliveryTarget = capturedPointerId === null ? target : scroller;
      deliveryTarget.dispatchEvent(pointerEvent("pointerup", "mouse"));
      deliveryTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    },
  };
}

describe("narrow desktop board mouse clicks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the delivery-time capture snapshot when pointerup releases capture", () => {
    const ancestor = document.createElement("div");
    const button = document.createElement("button");
    ancestor.append(button);
    document.body.append(ancestor);
    const emulator = createPointerCaptureEmulator(ancestor);
    const ancestorClick = vi.fn();
    const buttonClick = vi.fn();
    ancestor.addEventListener("pointerdown", () => ancestor.setPointerCapture(1));
    ancestor.addEventListener("pointerup", () => ancestor.releasePointerCapture(1));
    ancestor.addEventListener("click", ancestorClick);
    button.addEventListener("click", buttonClick);

    emulator.dispatchMousePressSequence(button);

    expect(ancestorClick).toHaveBeenCalledOnce();
    expect(buttonClick).not.toHaveBeenCalled();
  });

  it("does not capture a narrow desktop mouse press, preserving the descendant click", () => {
    stubNarrowDesktopViewport();
    expect(isMobileViewport()).toBe(true);
    const { scroller, button } = createScroller();
    const emulator = createPointerCaptureEmulator(scroller);
    const buttonClick = vi.fn();
    button.addEventListener("click", buttonClick);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => emulator.dispatchMousePressSequence(button));
    act(() => vi.advanceTimersByTime(400));

    expect(emulator.setPointerCapture).not.toHaveBeenCalled();
    expect(scroller.style.scrollSnapType).not.toBe("none");
    expect(scroller.scrollLeft).toBe(0);
    expect(buttonClick).toHaveBeenCalledOnce();
  });

  it("continues to capture touch presses and start snap paging", () => {
    stubTouchPhoneViewport();
    const { scroller } = createScroller();
    const emulator = createPointerCaptureEmulator(scroller);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => {
      scroller.dispatchEvent(pointerEvent("pointerdown", "touch"));
      scroller.dispatchEvent(pointerEvent("pointermove", "touch", 1, 0));
    });

    expect(emulator.setPointerCapture).toHaveBeenCalledWith(1);
    expect(scroller.style.scrollSnapType).toBe("none");
  });

  it("continues wheel paging without pointer capture", () => {
    stubTouchPhoneViewport();
    const { scroller } = createScroller();
    const emulator = createPointerCaptureEmulator(scroller);
    renderHook(() => useColumnScrollSnap(scroller, { mobileOnly: true, isUserInteraction: () => true }));

    act(() => scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true })));

    expect(emulator.setPointerCapture).not.toHaveBeenCalled();
    expect(scroller.style.scrollSnapType).toBe("none");
  });
});
