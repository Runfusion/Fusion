import { cleanup, fireEvent, screen, type RenderResult } from "@testing-library/react";
import { expect, vi } from "vitest";

/**
 * FNXC:ModalTouchGeometry 2026-07-26-13:42:
 * Modal migrations share one pointer sequence so every window identity is checked against the
 * same touch drag contract instead of accumulating subtly different synthetic gestures.
 */
export function expectFloatingWindowStructure(windowKey: string): HTMLElement {
  const panel = screen.getByTestId(`floating-window-${windowKey}`);
  expect(panel).toBeInTheDocument();
  for (const direction of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
    expect(screen.getByTestId(`floating-window-resize-${direction}`)).toBeInTheDocument();
  }
  return panel;
}

function prepareTouchCapture(target: HTMLElement): void {
  Object.defineProperty(target, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(target, "releasePointerCapture", { configurable: true, value: vi.fn() });
}

export function dragWithTouch(handle: HTMLElement, pointerId = 991): void {
  prepareTouchCapture(handle);
  fireEvent.pointerDown(handle, { pointerId, pointerType: "touch", clientX: 100, clientY: 100 });
  fireEvent.pointerMove(handle, { pointerId, pointerType: "touch", clientX: 140, clientY: 140 });
  fireEvent.pointerUp(handle, { pointerId, pointerType: "touch", clientX: 140, clientY: 140 });
}

export function resizeWithTouch(handle: HTMLElement, pointerId = 992): void {
  prepareTouchCapture(handle);
  fireEvent.pointerDown(handle, { pointerId, pointerType: "touch", clientX: 100, clientY: 100 });
  fireEvent.pointerMove(handle, { pointerId, pointerType: "touch", clientX: 140, clientY: 140 });
  fireEvent.pointerUp(handle, { pointerId, pointerType: "touch", clientX: 140, clientY: 140 });
}

/**
 * FNXC:ModalTouchGeometry 2026-07-26-16:25:
 * Real modal tests use this after rendering their production component. It intentionally receives
 * the modal's actual header element so a renamed or missing delegated drag selector fails here,
 * rather than being hidden by a synthetic FloatingWindow fixture.
 */
export function assertRenderedModalTouchGeometry(windowKey: string, dragHandle: HTMLElement): void {
  const panel = expectFloatingWindowStructure(windowKey);
  const initialLeft = Number.parseFloat(panel.style.left);
  const initialWidth = Number.parseFloat(panel.style.width);
  dragWithTouch(dragHandle);
  resizeWithTouch(screen.getByTestId("floating-window-resize-se"));
  expect(Number.parseFloat(panel.style.left)).not.toBe(initialLeft);
  expect(Number.parseFloat(panel.style.width)).toBeGreaterThan(initialWidth);
  const persisted = JSON.parse(localStorage.getItem(`floating-window:${windowKey}`) ?? "{}");
  expect(persisted.position.x).toBeGreaterThanOrEqual(16);
  expect(persisted.position.y).toBeGreaterThanOrEqual(16);
  expect(persisted.size.width).toBeLessThanOrEqual(window.innerWidth - 32);
  expect(persisted.size.height).toBeLessThanOrEqual(window.innerHeight - 32);
}

type ModalMount = () => RenderResult;
type SheetMode = "phone" | "short";

function setSheetViewport(mode: SheetMode): () => void {
  const original = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: mode === "phone" ? query === "(max-width: 767.98px)" : query === "(max-height: 480px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  return () => Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
}

/**
 * FNXC:ModalTouchGeometry 2026-07-26-18:10:
 * FN-8606 requires production renders, not a FloatingWindow stand-in, to prove every migrated
 * caller rejects corrupt geometry, clamps a geometry saved on a larger display, and avoids both
 * reads/writes plus drag/resize chrome in phone and short-viewport sheets.
 */
export function assertModalGeometryRecoveryAndSheetContracts(windowKey: string, mount: ModalMount): void {
  const geometryKey = `floating-window:${windowKey}`;

  cleanup();
  localStorage.setItem(geometryKey, "not-json");
  let rendered = mount();
  const corruptPanel = screen.getByTestId(`floating-window-${windowKey}`);
  expect(Number.parseFloat(corruptPanel.style.width)).toBeGreaterThan(0);
  expect(Number.parseFloat(corruptPanel.style.height)).toBeGreaterThan(0);
  rendered.unmount();

  localStorage.setItem(geometryKey, JSON.stringify({
    size: { width: 99999, height: 99999 },
    position: { x: 99999, y: -99999 },
  }));
  rendered = mount();
  const restoredPanel = screen.getByTestId(`floating-window-${windowKey}`);
  expect(Number.parseFloat(restoredPanel.style.left)).toBeGreaterThanOrEqual(16);
  expect(Number.parseFloat(restoredPanel.style.top)).toBeGreaterThanOrEqual(16);
  expect(Number.parseFloat(restoredPanel.style.width)).toBeLessThanOrEqual(window.innerWidth - 32);
  expect(Number.parseFloat(restoredPanel.style.height)).toBeLessThanOrEqual(window.innerHeight - 32);
  rendered.unmount();

  for (const mode of ["phone", "short"] as const) {
    localStorage.setItem(geometryKey, JSON.stringify({ size: { width: 99999, height: 99999 }, position: { x: 99999, y: -99999 } }));
    const restoreMatchMedia = setSheetViewport(mode);
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      rendered = mount();
      expect(screen.getByTestId(`floating-window-${windowKey}`)).toBeInTheDocument();
      expect(screen.queryByTestId("floating-window-resize-se")).not.toBeInTheDocument();
      expect(getItem).not.toHaveBeenCalledWith(geometryKey);
      expect(setItem).not.toHaveBeenCalledWith(geometryKey, expect.any(String));
      rendered.unmount();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
      restoreMatchMedia();
    }
  }
}
