import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWindowManagerProvider, useDashboardWindowLandmark } from "../../context/DashboardWindowManagerContext";
import { FloatingWindow } from "../FloatingWindow";
import { expectedOpeningSize, harnessWorkArea } from "./floatingWindowOpeningFixture";

/*
FNXC:FloatingWindowSnap 2026-09-17-07:21:
FN-493 corner quadrants, driven by REAL pointer gestures on the generic host — the same harness as
`FloatingWindow.snap.test.tsx` (1280x700 work area between a 64px header and a 36px footer). The operator asked
that a window dropped in a corner take a quarter of the area "de telle sorte que si j'en mets dans chaque angle ça
me fait une grille 2x2", so these regressions assert the RENDERED rectangle rather than helper return values.

Surfaces covered here: the four corners armed then applied (a), the live work area re-splitting a quadrant when a
sidebar opens and closes (d), a delegated host header under touch (e), the sheet presentation that exposes no snap
at all (f), two windows sharing one corner because zones are deliberately NOT exclusive (h), the preview contract
(k), and the resize-handle / restore round trip (l).
*/

const HEADER_HEIGHT = 64;
const FOOTER_HEIGHT = 36;
const SIDEBAR_WIDTH = 200;
const WORK_AREA_HEIGHT = 800 - HEADER_HEIGHT - FOOTER_HEIGHT;

let resizeObservers: Array<() => void> = [];

function openedWidth(
  requested = { width: 600, height: 400 },
  minSize = { width: 320, height: 200 },
): number {
  return expectedOpeningSize(requested, { minSize, bounds: harnessWorkArea(HEADER_HEIGHT, FOOTER_HEIGHT) }).width;
}

function domRect(value: { left: number; top: number; right: number; bottom: number; width: number; height: number }): DOMRect {
  return { ...value, x: value.left, y: value.top, toJSON: () => ({}) } as DOMRect;
}

function Landmarks({ sidebar = false }: { sidebar?: boolean }) {
  const headerRef = useDashboardWindowLandmark("header");
  const footerRef = useDashboardWindowLandmark("footer");
  const leftNavRef = useDashboardWindowLandmark("left-nav");
  return (
    <>
      <header ref={headerRef} data-landmark="header" />
      <footer ref={footerRef} data-landmark="footer" />
      {sidebar ? <aside ref={leftNavRef} data-landmark="left-nav" /> : null}
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

interface Gesture {
  from?: { x: number; y: number };
  /** Intermediate pointermove points, e.g. the travel that lifts an undocked panel off the bottom wall. */
  via?: { x: number; y: number }[];
  to: { x: number; y: number };
  pointerId?: number;
  pointerType?: "mouse" | "touch";
  hold?: boolean;
}

function drag(handle: HTMLElement, gesture: Gesture) {
  const pointerId = gesture.pointerId ?? 1;
  const pointerType = gesture.pointerType ?? "mouse";
  const from = gesture.from ?? { x: 600, y: 400 };
  prepareCapture(handle);
  fireEvent.pointerDown(handle, { pointerId, pointerType, clientX: from.x, clientY: from.y, button: 0 });
  for (const point of gesture.via ?? []) {
    fireEvent.pointerMove(handle, { pointerId, pointerType, clientX: point.x, clientY: point.y });
  }
  fireEvent.pointerMove(handle, { pointerId, pointerType, clientX: gesture.to.x, clientY: gesture.to.y });
  if (gesture.hold) return;
  fireEvent.pointerUp(handle, { pointerId, pointerType, clientX: gesture.to.x, clientY: gesture.to.y });
}

/** Pointer targets well beyond each corner: the position clamp pins the panel exactly on both walls. */
const CORNER_GESTURES = {
  "top-left": { x: -200, y: -200 },
  "top-right": { x: 1480, y: -200 },
  "bottom-left": { x: -200, y: 1000 },
  "bottom-right": { x: 1480, y: 1000 },
} as const;

/** Expected rendered rectangle of each quadrant in the harness work area (1280x700 at top 64). */
const QUADRANT_RECTS = {
  "top-left": { left: 0, top: HEADER_HEIGHT, width: 640, height: WORK_AREA_HEIGHT / 2 },
  "top-right": { left: 640, top: HEADER_HEIGHT, width: 640, height: WORK_AREA_HEIGHT / 2 },
  "bottom-left": { left: 0, top: HEADER_HEIGHT + WORK_AREA_HEIGHT / 2, width: 640, height: WORK_AREA_HEIGHT / 2 },
  "bottom-right": { left: 640, top: HEADER_HEIGHT + WORK_AREA_HEIGHT / 2, width: 640, height: WORK_AREA_HEIGHT / 2 },
} as const;

type Corner = keyof typeof CORNER_GESTURES;

function renderWindow(options: { sidebar?: boolean; delegated?: boolean; windowKey?: string } = {}) {
  const windowKey = options.windowKey ?? "snap";
  const view = render(
    <DashboardWindowManagerProvider>
      <Landmarks sidebar={options.sidebar} />
      {options.delegated ? (
        <FloatingWindow windowKey={windowKey} title="Snap" onClose={() => {}} hideHeader dragHandleSelector=".host-header" defaultSize={{ width: 600, height: 400 }} minSize={{ width: 320, height: 200 }}>
          <div className="host-header">Host header</div>
        </FloatingWindow>
      ) : (
        <FloatingWindow windowKey={windowKey} title="Snap" onClose={() => {}} defaultSize={{ width: 600, height: 400 }} minSize={{ width: 320, height: 200 }}>body</FloatingWindow>
      )}
    </DashboardWindowManagerProvider>,
  );
  const panel = screen.getByTestId(`floating-window-${windowKey}`);
  const handle = options.delegated
    ? (panel.querySelector(".host-header") as HTMLElement)
    : screen.getByTestId(`floating-window-drag-handle-${windowKey}`);
  return { ...view, panel, handle };
}

describe("FloatingWindow corner quadrants", () => {
  beforeEach(() => {
    resizeObservers = [];
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        resizeObservers.push(() => callback([], this as unknown as ResizeObserver));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const name = this.dataset.landmark;
      if (name === "header") return domRect({ left: 0, top: 0, right: window.innerWidth, bottom: HEADER_HEIGHT, width: window.innerWidth, height: HEADER_HEIGHT });
      if (name === "footer") return domRect({ left: 0, top: window.innerHeight - FOOTER_HEIGHT, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: FOOTER_HEIGHT });
      if (name === "left-nav") return domRect({ left: 0, top: HEADER_HEIGHT, right: SIDEBAR_WIDTH, bottom: window.innerHeight - FOOTER_HEIGHT, width: SIDEBAR_WIDTH, height: WORK_AREA_HEIGHT });
      return domRect({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /* Case (a): each corner is previewed under the finger, then applied as an exact quarter on release. */
  it.each(Object.keys(CORNER_GESTURES) as Corner[])("arms and applies the %s quadrant", async (corner) => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(openedWidth()));
    const pointerId = 300 + Object.keys(CORNER_GESTURES).indexOf(corner);

    drag(handle, { to: CORNER_GESTURES[corner], pointerId, hold: true });
    expect(screen.getByTestId("floating-window-snap-preview-snap").dataset.snapZone).toBe(corner);

    fireEvent.pointerUp(handle, { pointerId, clientX: CORNER_GESTURES[corner].x, clientY: CORNER_GESTURES[corner].y });
    expect(panel.dataset.snapMode).toBe(corner);
    expect(rectOf(panel)).toEqual(QUADRANT_RECTS[corner]);
    expect(panel.className).toContain(`floating-window--snap-${corner}`);
  });

  /*
  Case (d): a quadrant is derived from the LIVE work area like every other mode, so opening a sidebar re-splits it
  immediately and closing the sidebar restores the full-area quarter. Nothing is re-measured from a stored rect.
  */
  it("re-derives the quadrant from the live work area when the sidebar opens and closes", async () => {
    const { panel, handle, rerender } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(openedWidth()));

    drag(handle, { to: CORNER_GESTURES["bottom-left"], pointerId: 310 });
    expect(rectOf(panel)).toEqual(QUADRANT_RECTS["bottom-left"]);

    const withSidebar = (sidebar: boolean) => (
      <DashboardWindowManagerProvider>
        <Landmarks sidebar={sidebar} />
        <FloatingWindow windowKey="snap" title="Snap" onClose={() => {}} defaultSize={{ width: 600, height: 400 }} minSize={{ width: 320, height: 200 }}>body</FloatingWindow>
      </DashboardWindowManagerProvider>
    );

    rerender(withSidebar(true));
    resizeObservers.forEach((notify) => notify());
    await waitFor(() => expect(rectOf(panel).left).toBe(SIDEBAR_WIDTH));
    // Work area is now 1080 wide, so the quadrant is 540 wide and still rests on the left and bottom walls.
    expect(rectOf(panel)).toEqual({
      left: SIDEBAR_WIDTH,
      top: HEADER_HEIGHT + WORK_AREA_HEIGHT / 2,
      width: (1280 - SIDEBAR_WIDTH) / 2,
      height: WORK_AREA_HEIGHT / 2,
    });

    rerender(withSidebar(false));
    resizeObservers.forEach((notify) => notify());
    await waitFor(() => expect(rectOf(panel).left).toBe(0));
    expect(rectOf(panel)).toEqual(QUADRANT_RECTS["bottom-left"]);
    expect(panel.dataset.snapMode).toBe("bottom-left");
  });

  /* Case (e): the delegated host header under a real touch gesture (tablet) reaches the same quadrant. */
  it("arms a quadrant from a delegated host header under touch", async () => {
    const { panel, handle } = renderWindow({ delegated: true });
    await waitFor(() => expect(rectOf(panel).width).toBe(openedWidth()));

    drag(handle, { to: CORNER_GESTURES["top-right"], pointerId: 320, pointerType: "touch" });

    expect(panel.dataset.snapMode).toBe("top-right");
    expect(rectOf(panel)).toEqual(QUADRANT_RECTS["top-right"]);
  });

  /* Case (f): the mobile sheet presentation exposes no snapping at all — no preview, no move, no mode. */
  it("arms no quadrant in sheet presentation", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 600 });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: /max-width/.test(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow
          windowKey="sheet"
          title="Sheet"
          onClose={() => {}}
          suspendGeometryPersistenceOnMobile
          suspendGeometryPersistenceOnShortViewport
          defaultSize={{ width: 400, height: 300 }}
          minSize={{ width: 320, height: 200 }}
        >
          body
        </FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const panel = screen.getByTestId("floating-window-sheet");
    await waitFor(() => expect(rectOf(panel).width).toBe(openedWidth({ width: 400, height: 300 })));
    const before = rectOf(panel);

    const handle = screen.getByTestId("floating-window-drag-handle-sheet");
    drag(handle, { from: { x: 300, y: 400 }, to: { x: -200, y: -200 }, pointerId: 330, hold: true });
    expect(screen.queryByTestId("floating-window-snap-preview-sheet")).not.toBeInTheDocument();
    fireEvent.pointerUp(handle, { pointerId: 330, clientX: -200, clientY: -200 });

    expect(rectOf(panel)).toEqual(before);
    expect(panel.dataset.snapMode).toBe("floating");
  });

  /* Case (h): zones are deliberately NOT exclusive — two windows dropped in the same corner share that quarter. */
  it("lets two windows share the same quadrant", async () => {
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="one" title="One" onClose={() => {}} defaultSize={{ width: 600, height: 400 }} minSize={{ width: 320, height: 200 }}>one</FloatingWindow>
        <FloatingWindow windowKey="two" title="Two" onClose={() => {}} defaultSize={{ width: 600, height: 400 }} minSize={{ width: 320, height: 200 }}>two</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const first = screen.getByTestId("floating-window-one");
    const second = screen.getByTestId("floating-window-two");
    await waitFor(() => expect(rectOf(second).width).toBe(openedWidth()));

    drag(screen.getByTestId("floating-window-drag-handle-one"), { to: CORNER_GESTURES["top-left"], pointerId: 340 });
    drag(screen.getByTestId("floating-window-drag-handle-two"), { to: CORNER_GESTURES["top-left"], pointerId: 341 });

    expect(rectOf(first)).toEqual(QUADRANT_RECTS["top-left"]);
    expect(rectOf(second)).toEqual(QUADRANT_RECTS["top-left"]);
    expect(first.dataset.snapMode).toBe("top-left");
    expect(second.dataset.snapMode).toBe("top-left");
  });

  /*
  Case (k): the preview is paint only. It publishes the armed quadrant, stays `aria-hidden` and non-interactive,
  and applies NOTHING until the pointer is released.
  */
  it("previews a quadrant without applying it and never exposes an interactive preview", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(openedWidth()));
    const before = rectOf(panel);

    drag(handle, { to: CORNER_GESTURES["top-left"], pointerId: 350, hold: true });
    const preview = screen.getByTestId("floating-window-snap-preview-snap");
    expect(preview.dataset.snapZone).toBe("top-left");
    expect(preview.getAttribute("aria-hidden")).toBe("true");
    expect(preview).not.toHaveAttribute("tabindex");
    expect(Number.parseFloat(preview.style.width)).toBe(QUADRANT_RECTS["top-left"].width);
    expect(Number.parseFloat(preview.style.height)).toBe(QUADRANT_RECTS["top-left"].height);
    // Not applied yet: the panel still carries its dragged floating size and mode.
    expect(panel.dataset.snapMode).toBe("floating");
    expect(rectOf(panel).width).toBe(before.width);

    fireEvent.pointerUp(handle, { pointerId: 350, clientX: -200, clientY: -200 });
    expect(screen.queryByTestId("floating-window-snap-preview-snap")).not.toBeInTheDocument();
    expect(panel.dataset.snapMode).toBe("top-left");
  });

  /*
  Case (l): a snapped window hides its resize handles, and releasing a quadrant restores the floating rectangle
  captured before the FIRST snap — so quadrant → quadrant → release never restores a quarter.
  */
  it("hides the resize handles while snapped and restores the pre-first-snap floating rect", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(openedWidth()));
    const floating = rectOf(panel);
    expect(screen.getByTestId("floating-window-resize-se")).toBeInTheDocument();

    drag(handle, { to: CORNER_GESTURES["top-left"], pointerId: 360 });
    expect(panel.dataset.snapMode).toBe("top-left");
    expect(screen.queryByTestId("floating-window-resize-se")).not.toBeInTheDocument();

    /*
    Straight on to another quadrant in one gesture: the captured floating rect must NOT become the quarter. The
    `via` point lifts the undocked panel off the bottom wall first, which is what expires the FN-469 artifact and
    lets the bottom quadrant arm again — the artifact's whole promise is that it survives no longer than that.
    */
    drag(handle, { from: { x: 300, y: 300 }, via: [{ x: 700, y: 200 }], to: CORNER_GESTURES["bottom-right"], pointerId: 361 });
    expect(panel.dataset.snapMode).toBe("bottom-right");
    expect(rectOf(panel)).toEqual(QUADRANT_RECTS["bottom-right"]);

    drag(handle, { from: { x: 900, y: 600 }, to: { x: 900, y: 540 }, pointerId: 362 });
    expect(panel.dataset.snapMode).toBe("floating");
    expect(rectOf(panel).width).toBe(floating.width);
    expect(rectOf(panel).height).toBe(floating.height);
    expect(screen.getByTestId("floating-window-resize-se")).toBeInTheDocument();
  });

  /*
  FNXC:FloatingWindowSnap 2026-09-17-07:21:
  FN-493 keeps FN-469's undock artifact neutralised, but only on its BOTTOM component. Both halves of that promise
  are pinned here: an undock from the bottom band arms nothing until the panel leaves the wall, and a lateral
  undock whose bottom edge is plastered onto the wall by the clamp still arms the COLUMN, never a bottom quadrant.
  */
  it("disarms only the bottom component of the undock artifact", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(openedWidth()));

    // Band first: undocking it re-anchors the panel back onto the bottom wall, which must arm nothing.
    drag(handle, { from: { x: 640, y: 400 }, to: { x: 640, y: 1200 }, pointerId: 370 });
    expect(panel.dataset.snapMode).toBe("bottom");
    drag(handle, { from: { x: 640, y: 600 }, to: { x: 640, y: 540 }, pointerId: 371, hold: true });
    expect(screen.queryByTestId("floating-window-snap-preview-snap")).not.toBeInTheDocument();
    fireEvent.pointerUp(handle, { pointerId: 371, clientX: 640, clientY: 540 });
    expect(panel.dataset.snapMode).toBe("floating");

    // Column next: aim at mid-height so the panel really is against the side wall alone before undocking it.
    drag(handle, { from: { x: 640, y: 400 }, to: { x: 6, y: 299 }, pointerId: 372 });
    expect(panel.dataset.snapMode).toBe("left");
    drag(handle, { from: { x: 300, y: 300 }, to: { x: 1278, y: 290 }, pointerId: 373, hold: true });
    expect(screen.getByTestId("floating-window-snap-preview-snap").dataset.snapZone).toBe("right");
    fireEvent.pointerUp(handle, { pointerId: 373, clientX: 1278, clientY: 290 });
    expect(panel.dataset.snapMode).toBe("right");
    expect(rectOf(panel)).toEqual({ left: 640, top: HEADER_HEIGHT, width: 640, height: WORK_AREA_HEIGHT });
  });
});
