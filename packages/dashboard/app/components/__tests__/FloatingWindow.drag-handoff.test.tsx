import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWindowManagerProvider, useDashboardWindowLandmark } from "../../context/DashboardWindowManagerContext";
import { FloatingWindow, type FloatingWindowDragHandoff } from "../FloatingWindow";
import { expectedOpeningSize, harnessWorkArea } from "./floatingWindowOpeningFixture";
import { resolveHandoffRect } from "../floatingWindowGeometry";

/*
FNXC:FloatingWindowSnap 2026-09-16-18:31:
FN-469 gesture handoff. A host that replaces its own docked presentation with a floating window MID-DRAG used to
lose the gesture entirely: the window mounted at the standard CENTRED opening rectangle and the pointer was no
longer attached to anything ("ça crée un élément centré au lieu de juste sortir la modale"). These regressions pin
the new contract on REAL pointer events:
- with no handoff, the ordinary header drag and the delegated-header drag are bit-for-bit unchanged (capture
  included), because the drag body is now shared by both entry points;
- with a handoff, the window opens under the pointer at the requested grab point and the SAME gesture continues on
  `window` without any synthetic `pointerdown`;
- a sheet presentation and a foreign `pointerId` are the negative controls.
*/

const HEADER_HEIGHT = 64;
const FOOTER_HEIGHT = 36;

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

const DEFAULT_SIZE = { width: 600, height: 400 };
const MIN_SIZE = { width: 320, height: 200 };

function openedSize() {
  return expectedOpeningSize(DEFAULT_SIZE, { minSize: MIN_SIZE, bounds: harnessWorkArea(HEADER_HEIGHT, FOOTER_HEIGHT) });
}

function Harness({ handoff, delegated, sheet, mounted = true }: { handoff?: FloatingWindowDragHandoff; delegated?: boolean; sheet?: boolean; mounted?: boolean }) {
  return (
    <DashboardWindowManagerProvider>
      <Landmarks />
      {/* A probe window settles the work-area landmarks exactly as the live shell does before a host detaches into it. */}
      {mounted ? null : (
        <FloatingWindow windowKey="probe" title="Probe" onClose={() => {}} defaultSize={DEFAULT_SIZE} minSize={MIN_SIZE}>probe</FloatingWindow>
      )}
      {!mounted ? null : delegated ? (
        <FloatingWindow
          windowKey="handoff"
          title="Handoff"
          onClose={() => {}}
          hideHeader
          dragHandleSelector=".host-header"
          defaultSize={DEFAULT_SIZE}
          minSize={MIN_SIZE}
          dragHandoff={handoff}
        >
          <div className="host-header">Host header</div>
        </FloatingWindow>
      ) : (
        <FloatingWindow
          windowKey="handoff"
          title="Handoff"
          onClose={() => {}}
          defaultSize={DEFAULT_SIZE}
          minSize={MIN_SIZE}
          dragHandoff={handoff}
          suspendGeometryPersistenceOnMobile={sheet}
          suspendGeometryPersistenceOnShortViewport={sheet}
        >
          body
        </FloatingWindow>
      )}
    </DashboardWindowManagerProvider>
  );
}

function renderWindow(options: { handoff?: FloatingWindowDragHandoff; delegated?: boolean; sheet?: boolean } = {}) {
  const view = render(<Harness {...options} />);
  const panel = screen.getByTestId("floating-window-handoff");
  const handle = options.delegated
    ? (panel.querySelector(".host-header") as HTMLElement)
    : screen.queryByTestId("floating-window-drag-handle-handoff");
  return { ...view, panel, handle };
}

/**
 * Mount the handed-over window into an ALREADY settled work area, which is what the live shell does: the terminal
 * detaches into a dashboard whose header/footer landmarks have long been measured.
 */
async function renderHandoffIntoSettledShell(handoff: FloatingWindowDragHandoff) {
  const view = render(<Harness mounted={false} />);
  await waitFor(() => expect(Number.parseFloat(screen.getByTestId("floating-window-probe").style.top)).toBeGreaterThan(HEADER_HEIGHT));
  view.rerender(<Harness handoff={handoff} />);
  return { ...view, panel: screen.getByTestId("floating-window-handoff") };
}

/** Read a panel rectangle once the shell's asynchronous landmark settle has stopped changing it. */
async function settledRect(panel: HTMLElement) {
  let previous = rectOf(panel);
  let stable = 0;
  await waitFor(() => {
    const current = rectOf(panel);
    stable = JSON.stringify(current) === JSON.stringify(previous) ? stable + 1 : 0;
    previous = current;
    expect(stable).toBeGreaterThanOrEqual(3);
  });
  return previous;
}

function prepareCapture(target: HTMLElement) {
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.defineProperty(target, "setPointerCapture", { configurable: true, value: setPointerCapture });
  Object.defineProperty(target, "releasePointerCapture", { configurable: true, value: releasePointerCapture });
  return { setPointerCapture, releasePointerCapture };
}

describe("FloatingWindow drag handoff", () => {
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
  });

  /* (g) Non-regression: without a handoff the built-in header drag keeps its exact behaviour, capture included. */
  it("keeps the ordinary header drag unchanged, including pointer capture", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(openedSize().width));
    const opened = rectOf(panel);
    const capture = prepareCapture(handle!);

    fireEvent.pointerDown(handle!, { pointerId: 11, clientX: 600, clientY: 400, button: 0 });
    expect(capture.setPointerCapture).toHaveBeenCalledWith(11);
    fireEvent.pointerMove(handle!, { pointerId: 11, clientX: 660, clientY: 440 });
    fireEvent.pointerUp(handle!, { pointerId: 11, clientX: 660, clientY: 440 });

    expect(rectOf(panel)).toEqual({ ...opened, left: opened.left + 60, top: opened.top + 40 });
    expect(capture.releasePointerCapture).toHaveBeenCalledWith(11);
    expect(panel.dataset.snapMode).toBe("floating");
  });

  /* (h) Non-regression: the delegated `dragHandleSelector` path shares the same loop and is unchanged. */
  it("keeps the delegated host-header drag unchanged", async () => {
    const { panel, handle } = renderWindow({ delegated: true });
    await waitFor(() => expect(rectOf(panel).width).toBe(openedSize().width));
    const opened = rectOf(panel);
    // The delegated path forwards the PANEL-level event, so the panel is the capture target.
    const capture = prepareCapture(panel);

    fireEvent.pointerDown(handle!, { pointerId: 12, clientX: 600, clientY: 400, button: 0 });
    fireEvent.pointerMove(handle!, { pointerId: 12, clientX: 550, clientY: 460 });
    fireEvent.pointerUp(handle!, { pointerId: 12, clientX: 550, clientY: 460 });

    expect(capture.setPointerCapture).toHaveBeenCalledWith(12);
    expect(rectOf(panel)).toEqual({ ...opened, left: opened.left - 50, top: opened.top + 60 });
  });

  /* (i) The reported defect: the handed-over window opens under the pointer, not centred, and keeps moving. */
  it("opens under the pointer at the requested grab point and continues the same gesture on window", async () => {
    const centredLeft = (1280 - openedSize().width) / 2;

    const handoff: FloatingWindowDragHandoff = { pointerId: 21, pointer: { x: 1100, y: 400 }, grabOffset: { x: 480, y: 12 }, nonce: 1 };
    const { panel } = await renderHandoffIntoSettledShell(handoff);

    const expected = resolveHandoffRect({
      size: openedSize(),
      pointer: handoff.pointer,
      grabOffset: handoff.grabOffset,
      minSize: MIN_SIZE,
      bounds: harnessWorkArea(HEADER_HEIGHT, FOOTER_HEIGHT),
    });
    await waitFor(() => expect(rectOf(panel).left).toBe(expected.position.x));
    expect(rectOf(panel).left).not.toBe(centredLeft);
    expect(rectOf(panel).top).toBe(expected.position.y);
    // The pointer must sit INSIDE the opened panel, which is what "recropped under the mouse" means.
    const placed = rectOf(panel);
    expect(handoff.pointer.x).toBeGreaterThanOrEqual(placed.left);
    expect(handoff.pointer.x).toBeLessThanOrEqual(placed.left + placed.width);
    expect(handoff.pointer.y).toBeGreaterThanOrEqual(placed.top);
    expect(handoff.pointer.y).toBeLessThanOrEqual(placed.top + placed.height);

    // No new pointerdown: the SAME pointer id continues on window and moves the panel by the same delta.
    fireEvent.pointerMove(window, { pointerId: 21, clientX: 1040, clientY: 340 });
    expect(rectOf(panel)).toEqual({ ...placed, left: placed.left - 60, top: placed.top - 60 });

    // The handed-over gesture is a real drag: it suppresses selection until it ends, like a header drag.
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerUp(window, { pointerId: 21, clientX: 1040, clientY: 340 });
    expect(document.body.style.userSelect).toBe("");
    // Gesture over: a later move with the same id must no longer drag the window.
    const settled = rectOf(panel);
    fireEvent.pointerMove(window, { pointerId: 21, clientX: 900, clientY: 300 });
    expect(rectOf(panel)).toEqual(settled);
  });

  /* (i, negative control) No handoff means the historical centred/cascaded opening, untouched. */
  it("opens at the standard centred rectangle when no handoff is supplied", async () => {
    const { panel } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(openedSize().width));
    const expectedLeft = (1280 - openedSize().width) / 2;
    expect(rectOf(panel).left).toBe(expectedLeft);
  });

  /* (j) Phone / short-viewport sheet: no geometry, no handoff adoption, no listener left behind. */
  it("ignores a handoff in a sheet presentation and leaves no window listener behind", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 420 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 720 });
    // The sheet breakpoint is resolved through `matchMedia`, so a narrow jsdom width alone does not produce a sheet.
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: /max-width:\s*76[78]/.test(query) || /max-width:\s*600/.test(query),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })));
    const view = renderWindow({ sheet: true, handoff: { pointerId: 31, pointer: { x: 200, y: 300 }, nonce: 5 } });
    const panel = view.panel;
    await settledRect(panel);

    /*
    A live drag suppresses text selection for its whole duration, so an unsuppressed body is direct proof that no
    drag loop is held here — unlike a rectangle comparison, it cannot be confused with the sheet's own breakpoint
    settle. The wait exists because a phone resolves its viewport mode asynchronously: the window must end up with
    NO gesture whether the sheet classification was known at mount or landed one tick later.
    */
    await waitFor(() => expect(document.body.style.userSelect).toBe(""));
    expect(panel.dataset.snapMode).toBe("floating");

    fireEvent.pointerMove(window, { pointerId: 31, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(window, { pointerId: 31, clientX: 100, clientY: 100 });
    expect(document.body.style.userSelect).toBe("");

    view.unmount();
    fireEvent.pointerMove(window, { pointerId: 31, clientX: 50, clientY: 50 });
    expect(document.body.style.userSelect).toBe("");
  });

  /* (k) Tablet touch handoff behaves exactly like the mouse one. */
  it("adopts a touch handoff on a tablet viewport just like a mouse handoff", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 900 });
    const handoff: FloatingWindowDragHandoff = { pointerId: 41, pointer: { x: 700, y: 400 }, grabOffset: { x: 300, y: 16 }, nonce: 7 };
    const { panel } = await renderHandoffIntoSettledShell(handoff);

    const expected = resolveHandoffRect({
      size: openedSize(),
      pointer: handoff.pointer,
      grabOffset: handoff.grabOffset,
      minSize: MIN_SIZE,
      bounds: harnessWorkArea(HEADER_HEIGHT, FOOTER_HEIGHT),
    });
    await waitFor(() => expect(rectOf(panel).left).toBe(expected.position.x));
    const placed = rectOf(panel);

    fireEvent.pointerMove(window, { pointerId: 41, pointerType: "touch", clientX: 640, clientY: 370 });
    expect(rectOf(panel)).toEqual({ ...placed, left: placed.left - 60, top: placed.top - 30 });
  });

  /* (k, negative control) A second finger must never steer the handed-over gesture. */
  it("ignores pointer moves carrying a different pointer id", async () => {
    const handoff: FloatingWindowDragHandoff = { pointerId: 51, pointer: { x: 900, y: 400 }, nonce: 9 };
    const { panel } = await renderHandoffIntoSettledShell(handoff);
    await waitFor(() => expect(rectOf(panel).width).toBe(openedSize().width));
    const placed = rectOf(panel);

    fireEvent.pointerMove(window, { pointerId: 52, clientX: 500, clientY: 200 });
    expect(rectOf(panel)).toEqual(placed);

    fireEvent.pointerMove(window, { pointerId: 51, clientX: 860, clientY: 360 });
    expect(rectOf(panel)).toEqual({ ...placed, left: placed.left - 40, top: placed.top - 40 });
  });
});

/*
FNXC:FloatingWindowSnap 2026-09-16-18:31:
FN-469 unit contract of the placement helper itself: the grab point is honoured exactly, an out-of-bounds pointer
still yields a rectangle fully inside the work area, and non-finite input degrades instead of throwing.
*/
describe("resolveHandoffRect", () => {
  const bounds = { left: 0, top: 64, right: 1280, bottom: 764, width: 1280, height: 700 };
  const size = { width: 800, height: 360 };
  const minSize = { width: 320, height: 200 };

  it("places the requested grab point exactly under the pointer", () => {
    const rect = resolveHandoffRect({ size, pointer: { x: 900, y: 400 }, grabOffset: { x: 600, y: 10 }, minSize, bounds });
    expect(rect.position).toEqual({ x: 300, y: 390 });
    expect(rect.size).toEqual(size);
  });

  it("falls back to the shared undock anchor when no grab offset is supplied", () => {
    const rect = resolveHandoffRect({ size, pointer: { x: 700, y: 400 }, minSize, bounds });
    expect(rect.position).toEqual({ x: 300, y: 376 });
  });

  it("keeps the window fully inside the work area for an out-of-bounds pointer", () => {
    const rect = resolveHandoffRect({ size, pointer: { x: 5000, y: 5000 }, grabOffset: { x: 0, y: 0 }, minSize, bounds });
    expect(rect.position).toEqual({ x: bounds.right - size.width, y: bounds.bottom - size.height });
  });

  it("clamps a grab offset that falls outside the panel", () => {
    const rect = resolveHandoffRect({ size, pointer: { x: 900, y: 400 }, grabOffset: { x: 5000, y: -40 }, minSize, bounds });
    expect(rect.position).toEqual({ x: 900 - size.width, y: 400 });
  });

  it("degrades to the centred rectangle for a non-finite pointer, without throwing", () => {
    const rect = resolveHandoffRect({ size, pointer: { x: Number.NaN, y: 400 }, minSize, bounds });
    expect(rect.position).toEqual({ x: (bounds.width - size.width) / 2, y: bounds.top + (bounds.height - size.height) / 2 });
  });

  it("falls back to the minimum size for a non-finite size", () => {
    const rect = resolveHandoffRect({ size: { width: Number.NaN, height: 400 }, pointer: { x: 400, y: 400 }, minSize, bounds });
    expect(rect.size).toEqual(minSize);
  });
});
