import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const viewport = vi.hoisted(() => ({ tablet: false, sheet: false, short: false }));
vi.mock("../../hooks/useViewportMode", async () => {
  const actual = await vi.importActual<typeof import("../../hooks/useViewportMode")>("../../hooks/useViewportMode");
  return {
    ...actual,
    useViewportMode: () => viewport.tablet ? "tablet" : "desktop",
    isTabletTouchViewport: () => viewport.tablet,
    isFullScreenSheetViewport: () => viewport.sheet,
    isShortViewport: () => viewport.short,
  };
});

import { migratedModalFixtures } from "./migratedModalFixtures";

const fixtures = migratedModalFixtures.filter((fixture) => fixture.render && /Setup|Native|Docker/.test(fixture.name));
const directions = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

function capture(target: HTMLElement) {
  Object.defineProperties(target, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
}

afterEach(() => { cleanup(); localStorage.clear(); viewport.tablet = false; viewport.sheet = false; viewport.short = false; document.body.style.userSelect = ""; });

/*
FNXC:ModalTouchGeometry 2026-07-27-01:15:
FN-8607 exercises every production onboarding modal at the host boundary. The shared primitive owns the
math, while these fixtures prove each modal opts into tablet geometry and preserves its dismissal policy.
*/
describe("onboarding modal FloatingWindow geometry contract", () => {
  it.each(fixtures)("$name supports desktop drag and every resize direction", (fixture) => {
    const close = vi.fn();
    render(fixture.render!(close));
    const key = fixture.key!.replace("floating-window:", "");
    const panel = screen.getByTestId(`floating-window-${key}`);
    expect(screen.getByTestId(`floating-window-overlay-${key}`)).toHaveAttribute("role", "dialog");
    expect(screen.getAllByLabelText("Resize floating window")).toHaveLength(8);
    expect(panel.querySelectorAll("[data-resize-hit-target='true']")).toHaveLength(0);
    const drag = panel.querySelector<HTMLElement>(".modal-header, .agent-dialog-header, .setup-wizard-header") ?? panel;
    const initialPosition = { left: panel.style.left, top: panel.style.top };
    const setCapture = vi.fn();
    Object.defineProperty(panel, "setPointerCapture", { configurable: true, value: setCapture });
    fireEvent.pointerDown(drag, { pointerType: "mouse", pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(panel, { pointerType: "mouse", pointerId: 1, clientX: 135, clientY: 130 });
    fireEvent.pointerUp(panel, { pointerType: "mouse", pointerId: 1, clientX: 135, clientY: 130 });
    expect(setCapture).toHaveBeenCalledWith(1);
    // The listener commits a clamped geometry record even when jsdom has no layout dimensions.
    expect(localStorage.getItem(fixture.key!)).toContain('"position"');
    for (const direction of directions) {
      const handle = screen.getByTestId(`floating-window-resize-${direction}`);
      capture(handle);
      const before = { width: panel.style.width, height: panel.style.height };
      fireEvent.pointerDown(handle, { pointerType: "mouse", pointerId: 2, clientX: 300, clientY: 300 });
      fireEvent.pointerMove(handle, { pointerType: "mouse", pointerId: 2, clientX: 330, clientY: 325 });
      fireEvent.pointerUp(handle, { pointerType: "mouse", pointerId: 2, clientX: 330, clientY: 325 });
      if (direction.includes("e") || direction.includes("w")) expect(panel.style.width).not.toBe(before.width);
      if (direction.includes("n") || direction.includes("s")) expect(panel.style.height).not.toBe(before.height);
    }
    expect(localStorage.getItem(fixture.key!)).toContain('"size"');
  });

  it.each(fixtures)("$name enables touch targets, persistence recovery, and sheet suspension", (fixture) => {
    viewport.tablet = true;
    localStorage.setItem(fixture.key!, "not-json");
    const close = vi.fn();
    const { unmount } = render(fixture.render!(close));
    const key = fixture.key!.replace("floating-window:", "");
    const panel = screen.getByTestId(`floating-window-${key}`);
    expect(panel.querySelectorAll("[data-resize-hit-target='true']")).toHaveLength(9);
    for (const direction of directions) {
      const handle = screen.getByTestId(`floating-window-resize-${direction}`);
      const before = { width: panel.style.width, height: panel.style.height };
      capture(handle);
      fireEvent.pointerDown(handle, { pointerType: "touch", pointerId: 1, clientX: 300, clientY: 300 });
      fireEvent.pointerMove(handle, { pointerType: "touch", pointerId: 99, clientX: 600, clientY: 600 });
      fireEvent.pointerMove(handle, { pointerType: "touch", pointerId: 1, clientX: 330, clientY: 325 });
      fireEvent.pointerUp(handle, { pointerType: "touch", pointerId: 1, clientX: 330, clientY: 325 });
      if (direction.includes("e") || direction.includes("w")) expect(panel.style.width).not.toBe(before.width);
      if (direction.includes("n") || direction.includes("s")) expect(panel.style.height).not.toBe(before.height);
    }
    expect(() => JSON.parse(localStorage.getItem(fixture.key!)!)).not.toThrow();
    const drag = panel.querySelector<HTMLElement>(".modal-header, .agent-dialog-header, .setup-wizard-header") ?? panel;
    capture(panel);
    fireEvent.pointerDown(drag, { pointerType: "touch", pointerId: 7, clientX: 100, clientY: 100 });
    expect(document.body.style.userSelect).toBe("none");
    fireEvent.pointerCancel(panel, { pointerType: "touch", pointerId: 7 });
    expect(document.body.style.userSelect).toBe("");
    unmount();

    // A populated off-screen record must restore through the shared clamp, not strand the hosted dialog.
    viewport.tablet = false;
    localStorage.setItem(fixture.key!, JSON.stringify({ size: { width: 100_000, height: 100_000 }, position: { x: 100_000, y: 100_000 } }));
    render(fixture.render!(close));
    const restored = screen.getByTestId(`floating-window-${key}`);
    expect(Number.parseInt(restored.style.width, 10)).toBeLessThanOrEqual(window.innerWidth - 32);
    expect(Number.parseInt(restored.style.height, 10)).toBeLessThanOrEqual(window.innerHeight - 32);
    cleanup();

    // 767px/phone is represented by the shared sheet discriminator; it must not expose or write geometry.
    viewport.sheet = true; localStorage.clear();
    render(fixture.render!(close));
    expect(screen.queryAllByLabelText("Resize floating window")).toHaveLength(0);
    expect(localStorage.getItem(fixture.key!)).toBeNull();
    cleanup(); viewport.sheet = false; viewport.short = true;
    render(fixture.render!(close));
    expect(screen.queryAllByLabelText("Resize floating window")).toHaveLength(0);
    expect(localStorage.getItem(fixture.key!)).toBeNull();
  });

  it.each(fixtures)("$name keeps its outside dismissal decision", (fixture) => {
    const close = vi.fn(); render(fixture.render!(close));
    fireEvent.pointerDown(document.body, { pointerType: "mouse" });
    expect(close).toHaveBeenCalledTimes(fixture.outside ? 1 : 0);
  });
});
