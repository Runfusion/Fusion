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
 *
 * FNXC:FloatingWindowGeometry 2026-09-14-21:10:
 * FN-394 removed durable geometry, so the gesture is still proven by the RENDERED rectangle while the
 * historical storage key must stay untouched by the window.
 */
export function assertRenderedModalTouchGeometry(windowKey: string, dragHandle: HTMLElement): void {
  const panel = expectFloatingWindowStructure(windowKey);
  const initialLeft = Number.parseFloat(panel.style.left);
  const initialWidth = Number.parseFloat(panel.style.width);
  dragWithTouch(dragHandle);
  resizeWithTouch(screen.getByTestId("floating-window-resize-se"));
  expect(Number.parseFloat(panel.style.left)).not.toBe(initialLeft);
  expect(Number.parseFloat(panel.style.width)).toBeGreaterThan(initialWidth);
  expect(localStorage.getItem(`floating-window:${windowKey}`)).toBeNull();
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
 * FN-8606 requires production renders, not a FloatingWindow stand-in, to prove every migrated caller
 * behaves at its real host boundary, including phone and short-viewport sheets with no drag/resize chrome.
 *
 * FNXC:FloatingWindowGeometry 2026-09-14-21:10:
 * FN-394 replaced geometry RESTORATION with geometry INDEPENDENCE. The historical key is pre-filled with
 * a corrupt value and then with an off-standard rectangle: in both cases the host must open at its own
 * standard size and must neither read nor write that key, on desktop exactly as on a sheet.
 */
export function assertModalGeometryRecoveryAndSheetContracts(windowKey: string, mount: ModalMount): void {
  const geometryKey = `floating-window:${windowKey}`;
  const offStandard = JSON.stringify({ size: { width: 311, height: 222 }, position: { x: 7, y: 9 } });

  cleanup();
  localStorage.setItem(geometryKey, "not-json");
  let rendered = mount();
  const corruptPanel = screen.getByTestId(`floating-window-${windowKey}`);
  const standard = { width: corruptPanel.style.width, height: corruptPanel.style.height };
  expect(Number.parseFloat(standard.width)).toBeGreaterThan(0);
  expect(Number.parseFloat(standard.height)).toBeGreaterThan(0);
  rendered.unmount();

  cleanup();
  localStorage.setItem(geometryKey, offStandard);
  const getItemDesktop = vi.spyOn(Storage.prototype, "getItem");
  const setItemDesktop = vi.spyOn(Storage.prototype, "setItem");
  try {
    rendered = mount();
    const reopened = screen.getByTestId(`floating-window-${windowKey}`);
    expect(reopened.style.width).toBe(standard.width);
    expect(reopened.style.height).toBe(standard.height);
    expect(getItemDesktop).not.toHaveBeenCalledWith(geometryKey);
    expect(setItemDesktop).not.toHaveBeenCalledWith(geometryKey, expect.any(String));
    expect(localStorage.getItem(geometryKey)).toBe(offStandard);
    rendered.unmount();
  } finally {
    getItemDesktop.mockRestore();
    setItemDesktop.mockRestore();
  }

  for (const mode of ["phone", "short"] as const) {
    localStorage.setItem(geometryKey, offStandard);
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
