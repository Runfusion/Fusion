import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWindowManagerProvider, useDashboardWindowLandmark } from "../../context/DashboardWindowManagerContext";
import { FloatingWindow } from "../FloatingWindow";
import { migratedModalFixtures } from "./migratedModalFixtures";

/*
FNXC:FloatingWindowSnap 2026-09-14-21:10:
FN-394 host contract, exercised on PRODUCTION modals rather than a synthetic stand-in: each hosted window
opens at its own standard size, snaps left/right/top from its REAL header, restores its pre-snap rect on a
downward drag, and stays independent of any historical geometry record and of a neighbouring window.
*/

const HEADER_HEIGHT = 64;
const FOOTER_HEIGHT = 36;
const hostFixtures = migratedModalFixtures.filter((fixture) => fixture.render && fixture.key);

function domRect(value: { left: number; top: number; right: number; bottom: number; width: number; height: number }): DOMRect {
  return { ...value, x: value.left, y: value.top, toJSON: () => ({}) } as DOMRect;
}

function Landmarks() {
  const headerRef = useDashboardWindowLandmark("header");
  const footerRef = useDashboardWindowLandmark("footer");
  return (
    <>
      <header ref={headerRef} data-landmark="header" />
      <footer ref={footerRef} data-landmark="footer" />
    </>
  );
}

function rectOf(panel: HTMLElement) {
  return {
    left: Number.parseFloat(panel.style.left),
    top: Number.parseFloat(panel.style.top),
    width: Number.parseFloat(panel.style.width),
    height: Number.parseFloat(panel.style.height),
  };
}

function prepareCapture(target: HTMLElement) {
  Object.defineProperty(target, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(target, "releasePointerCapture", { configurable: true, value: vi.fn() });
}

function drag(handle: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }, pointerId: number) {
  prepareCapture(handle);
  fireEvent.pointerDown(handle, { pointerId, clientX: from.x, clientY: from.y, button: 0 });
  fireEvent.pointerMove(handle, { pointerId, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(handle, { pointerId, clientX: to.x, clientY: to.y });
}

function headerOf(panel: HTMLElement, windowKey: string): HTMLElement {
  return panel.querySelector<HTMLElement>(".view-header, .modal-header, .agent-dialog-header, .setup-wizard-header")
    ?? screen.getByTestId(`floating-window-drag-handle-${windowKey}`);
}

describe("hosted modal snap contract", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const name = this.dataset.landmark;
      if (name === "header") return domRect({ left: 0, top: 0, right: window.innerWidth, bottom: HEADER_HEIGHT, width: window.innerWidth, height: HEADER_HEIGHT });
      if (name === "footer") return domRect({ left: 0, top: window.innerHeight - FOOTER_HEIGHT, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: FOOTER_HEIGHT });
      return domRect({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it.each(hostFixtures)("$name opens standard, snaps to both halves and the work area, then restores", (fixture) => {
    const windowKey = fixture.key!.replace("floating-window:", "");
    // A historical off-standard record for this exact host must change nothing.
    localStorage.setItem(fixture.key!, JSON.stringify({ size: { width: 311, height: 222 }, position: { x: 7, y: 9 } }));

    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        {fixture.render!(() => {})}
      </DashboardWindowManagerProvider>,
    );

    const panel = screen.getByTestId(`floating-window-${windowKey}`);
    const opened = rectOf(panel);
    expect(opened.width).not.toBe(311);
    expect(opened.height).not.toBe(222);
    // Centred inside the live work area.
    expect(opened.left).toBeCloseTo((window.innerWidth - opened.width) / 2, 5);
    expect(opened.top).toBeCloseTo(HEADER_HEIGHT + (window.innerHeight - HEADER_HEIGHT - FOOTER_HEIGHT - opened.height) / 2, 5);

    const header = headerOf(panel, windowKey);
    drag(header, { x: 600, y: 400 }, { x: 6, y: 400 }, 1);
    expect(rectOf(panel)).toEqual({ left: 0, top: HEADER_HEIGHT, width: 640, height: 700 });
    expect(screen.queryByTestId("floating-window-resize-se")).not.toBeInTheDocument();

    drag(header, { x: 200, y: 300 }, { x: 1277, y: 400 }, 2);
    expect(rectOf(panel).left).toBe(640);

    drag(header, { x: 900, y: 300 }, { x: 900, y: HEADER_HEIGHT + 2 }, 3);
    expect(rectOf(panel)).toEqual({ left: 0, top: HEADER_HEIGHT, width: 1280, height: 700 });

    drag(header, { x: 640, y: HEADER_HEIGHT + 8 }, { x: 640, y: HEADER_HEIGHT + 70 }, 4);
    const restored = rectOf(panel);
    expect(restored.width).toBe(opened.width);
    expect(restored.height).toBe(opened.height);
    expect(screen.getByTestId("floating-window-resize-se")).toBeInTheDocument();
    // Nothing durable was written for this host, and the historical record is untouched.
    expect(localStorage.getItem(fixture.key!)).toContain("311");
  });

  it.each(hostFixtures)("$name keeps its own standard size next to a generic neighbour window", async (fixture) => {
    const windowKey = fixture.key!.replace("floating-window:", "");
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        {fixture.render!(() => {})}
        <FloatingWindow windowKey="neighbour" title="Neighbour" onClose={() => {}} defaultSize={{ width: 480, height: 360 }}>
          neighbour body
        </FloatingWindow>
      </DashboardWindowManagerProvider>,
    );

    const host = screen.getByTestId(`floating-window-${windowKey}`);
    const neighbour = screen.getByTestId("floating-window-neighbour");
    await waitFor(() => expect(rectOf(neighbour).width).toBe(480));
    expect(rectOf(host).width).not.toBe(480);
    // Two pristine windows, two cascade slots: the neighbour is displaced, never resized to match.
    expect(rectOf(neighbour).left).not.toBe(rectOf(host).left);
  });

  it("covers every hosted production modal of the shared fixture table", () => {
    expect(hostFixtures.length).toBeGreaterThanOrEqual(10);
  });
});
