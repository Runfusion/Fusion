import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useModalResizePersist } from "../useModalResizePersist";

const STORAGE_KEY = "fusion:test-modal-size";

type ResizeObserverCallback = ConstructorParameters<typeof ResizeObserver>[0];

const resizeObserverCallbacks = new Set<ResizeObserverCallback>();

class MockResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObserverCallbacks.add(callback);
  }

  observe = vi.fn();
  unobserve = vi.fn();

  disconnect = vi.fn(() => {
    resizeObserverCallbacks.delete(this.callback);
  });
}

function setViewport(width: number, height = 800): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  Object.defineProperty(window, "screen", {
    configurable: true,
    value: { width, height },
  });
  window.matchMedia = vi.fn((query: string) => ({
    matches: query.includes("max-width: 768px")
      ? width <= 768
      : query.includes("max-height: 480px")
        ? height <= 480
        : query.includes("min-width: 769px") && query.includes("max-width: 1024px")
          ? width >= 769 && width <= 1024
          : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as typeof window.matchMedia;
}

function dispatchPointerEvent(
  target: EventTarget,
  type: string,
  init: { clientX: number; clientY: number; pointerId?: number; pointerType?: string },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: init.pointerType ?? "touch" },
  });
  target.dispatchEvent(event);
}

function installModalGeometry(node: HTMLElement, width = 500, height = 400): void {
  Object.defineProperty(node, "offsetWidth", {
    configurable: true,
    get: () => Number.parseFloat(node.style.width) || width,
  });
  Object.defineProperty(node, "offsetHeight", {
    configurable: true,
    get: () => Number.parseFloat(node.style.height) || height,
  });
  node.getBoundingClientRect = vi.fn(() => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: node.offsetWidth,
    bottom: node.offsetHeight,
    width: node.offsetWidth,
    height: node.offsetHeight,
    toJSON: () => ({}),
  }));
}

function triggerResizeObservers(): void {
  for (const callback of resizeObserverCallbacks) {
    callback([], {} as ResizeObserver);
  }
}

function Harness({
  initialHeight,
  initialWidth,
  isOpen = true,
  storageKey = STORAGE_KEY,
}: {
  initialHeight?: string;
  initialWidth?: string;
  isOpen?: boolean;
  storageKey?: string;
}) {
  const modalRef = useRef<HTMLDivElement | null>(null);
  useModalResizePersist(modalRef, isOpen, storageKey);

  return (
    <div
      data-testid="modal"
      ref={modalRef}
      className="modal"
      style={{ width: initialWidth, height: initialHeight }}
    />
  );
}

describe("useModalResizePersist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resizeObserverCallbacks.clear();
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.style.userSelect = "";
  });

  it("injects a touch-capable resize grip on tablet and persists dragged size", () => {
    setViewport(900);
    render(<Harness />);

    const modal = screen.getByTestId("modal");
    installModalGeometry(modal);

    const grip = modal.querySelector(".modal-resize-grip") as HTMLElement;
    expect(grip).toBeTruthy();

    expect(grip).toHaveAttribute("role", "separator");
    expect(grip).toHaveAttribute("aria-label", "Resize modal from bottom-right corner");

    dispatchPointerEvent(grip, "pointerdown", { clientX: 10, clientY: 20, pointerType: "touch" });
    dispatchPointerEvent(document, "pointermove", { clientX: 70, clientY: 65, pointerType: "touch" });
    dispatchPointerEvent(document, "pointerup", { clientX: 70, clientY: 65, pointerType: "touch" });

    expect(modal.style.width).toBe("560px");
    expect(modal.style.height).toBe("445px");

    vi.advanceTimersByTime(200);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"))
      .toEqual({ width: 560, height: 445 });
  });

  it("keeps desktop grip and native ResizeObserver persistence/restore behavior", () => {
    setViewport(1280);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: 610, height: 480 }));

    render(<Harness />);
    const modal = screen.getByTestId("modal");
    installModalGeometry(modal);

    expect(modal.querySelector(".modal-resize-grip")).toBeTruthy();
    expect(modal.style.width).toBe("610px");
    expect(modal.style.height).toBe("480px");

    modal.style.width = "640px";
    modal.style.height = "500px";
    triggerResizeObservers();
    vi.advanceTimersByTime(200);

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"))
      .toEqual({ width: 640, height: 500 });
  });

  it("clears inline size and does not inject a grip on mobile", () => {
    /*
    FNXC:ViewportMode 2026-07-24-02:25:
    FN-8557 (973c978f9) classifies a narrow touch viewport with a tablet-class
    physical screen (min edge > 480px) as tablet, which keeps the FN-6377 touch
    grip. jsdom reports `"ontouchstart" in window === true`, so the old 700x800
    fixture became a tablet. Use a phone-class screen (375px min edge) so this
    test still exercises the true mobile contract: no grip, inline size cleared.
    */
    setViewport(375);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: 610, height: 480 }));

    render(<Harness initialWidth="610px" initialHeight="480px" />);
    const mobileModal = screen.getByTestId("modal");

    expect(mobileModal.querySelector(".modal-resize-grip")).toBeNull();
    expect(mobileModal.style.width).toBe("");
    expect(mobileModal.style.height).toBe("");
  });

  it("removes the grip and drag listeners when closed or unmounted", () => {
    setViewport(900);
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { rerender, unmount } = render(<Harness isOpen />);

    const modal = screen.getByTestId("modal");
    installModalGeometry(modal);
    const grip = modal.querySelector(".modal-resize-grip") as HTMLElement;
    expect(grip).toBeTruthy();

    dispatchPointerEvent(grip, "pointerdown", { clientX: 10, clientY: 20 });
    rerender(<Harness isOpen={false} />);

    expect(modal.querySelector(".modal-resize-grip")).toBeNull();
    expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointercancel", expect.any(Function));

    rerender(<Harness isOpen />);
    expect(modal.querySelector(".modal-resize-grip")).toBeTruthy();
    unmount();
    expect(modal.querySelector(".modal-resize-grip")).toBeNull();
  });
});
