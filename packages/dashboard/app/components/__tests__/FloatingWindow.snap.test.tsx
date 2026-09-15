import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWindowManagerProvider, useDashboardWindowLandmark } from "../../context/DashboardWindowManagerContext";
import { FloatingWindow } from "../FloatingWindow";

/*
FNXC:FloatingWindowSnap 2026-09-14-21:10:
FN-394 snap gestures, driven by REAL pointer events on the real window (native header and delegated
header, mouse and touch). These regressions assert the rendered rectangle, not helper return values:
half-width columns, the filled work area, top priority in a corner, the click threshold, detaching back
to the pre-snap floating rect, and the fact that an interrupted gesture validates nothing.

FNXC:FloatingWindowSnap 2026-09-15-04:01:
FN-401 moves arming from the pointer to the dragged PANEL rectangle. Two consequences are encoded here:
- a gesture that pushes the panel against a wall arms that column even with the pointer far from that wall;
- a still-docked window arms nothing at all while it is still pinned, so carrying it to another wall is one
  continuous gesture that first detaches and then travels on to the wall.
The `via` points of `drag` exist for exactly that two-phase gesture; they remain valid but are no longer the
only way out of a dock.

FNXC:FloatingWindowSnap 2026-09-15-14:07:
FN-422: undocking is OMNIDIRECTIONAL and fires at the ordinary drag threshold. A docked window used to come
loose only by travelling 24px DOWN, so a column or a filled work area ignored every upward, lateral, and
diagonal drag and looked stuck. The direction matrix below pins the new truth for all three docked modes on
both drag handles; a sub-threshold gesture is still a click that preserves the dock.
*/

const HEADER_HEIGHT = 64;
const FOOTER_HEIGHT = 36;
const SIDEBAR_WIDTH = 200;

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
  /** Intermediate pointermove points, e.g. the downward travel that detaches a docked window. */
  via?: { x: number; y: number }[];
  to: { x: number; y: number };
  pointerId?: number;
  pointerType?: "mouse" | "touch";
  /** Stop before pointerup so the armed preview can be inspected. */
  hold?: boolean;
  cancel?: boolean;
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
  if (gesture.cancel) fireEvent.pointerCancel(handle, { pointerId, pointerType, clientX: gesture.to.x, clientY: gesture.to.y });
  else fireEvent.pointerUp(handle, { pointerId, pointerType, clientX: gesture.to.x, clientY: gesture.to.y });
}

/** Dock the window into one of the three snapped modes with a single real gesture. */
function dock(handle: HTMLElement, mode: "left" | "right" | "maximized", pointerId: number, pointerType: "mouse" | "touch" = "mouse") {
  if (mode === "left") drag(handle, { from: { x: 600, y: 400 }, to: { x: 6, y: 400 }, pointerId, pointerType });
  else if (mode === "right") drag(handle, { from: { x: 600, y: 400 }, to: { x: 1276, y: 400 }, pointerId, pointerType });
  else drag(handle, { from: { x: 900, y: 300 }, to: { x: 900, y: HEADER_HEIGHT + 1 }, pointerId, pointerType });
}

function renderWindow(options: { sidebar?: boolean; delegated?: boolean; defaultSize?: { width: number; height: number } } = {}) {
  const defaultSize = options.defaultSize ?? { width: 600, height: 400 };
  const view = render(
    <DashboardWindowManagerProvider>
      <Landmarks sidebar={options.sidebar} />
      {options.delegated ? (
        <FloatingWindow windowKey="snap" title="Snap" onClose={() => {}} hideHeader dragHandleSelector=".host-header" defaultSize={defaultSize} minSize={{ width: 320, height: 200 }}>
          <div className="host-header">Host header</div>
        </FloatingWindow>
      ) : (
        <FloatingWindow windowKey="snap" title="Snap" onClose={() => {}} defaultSize={defaultSize} minSize={{ width: 320, height: 200 }}>body</FloatingWindow>
      )}
    </DashboardWindowManagerProvider>,
  );
  const panel = screen.getByTestId("floating-window-snap");
  const handle = options.delegated
    ? (panel.querySelector(".host-header") as HTMLElement)
    : screen.getByTestId("floating-window-drag-handle-snap");
  return { ...view, panel, handle };
}

describe("FloatingWindow snap gestures", () => {
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
      if (name === "left-nav") return domRect({ left: 0, top: HEADER_HEIGHT, right: SIDEBAR_WIDTH, bottom: window.innerHeight - FOOTER_HEIGHT, width: SIDEBAR_WIDTH, height: 700 });
      return domRect({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    { name: "native header", delegated: false, pointerType: "mouse" as const },
    { name: "delegated host header", delegated: true, pointerType: "touch" as const },
  ])("snaps to the left half from the $name", async ({ delegated, pointerType }) => {
    const { panel, handle } = renderWindow({ delegated });
    await waitFor(() => expect(rectOf(panel).width).toBe(600));

    drag(handle, { to: { x: 8, y: 400 }, pointerType });

    expect(rectOf(panel)).toEqual({ left: 0, top: HEADER_HEIGHT, width: 640, height: 800 - HEADER_HEIGHT - FOOTER_HEIGHT });
    expect(panel.dataset.snapMode).toBe("left");
  });

  it("snaps to the right half and fills the work area from the top band", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(600));

    drag(handle, { to: { x: 1276, y: 400 }, pointerId: 2 });
    expect(rectOf(panel)).toEqual({ left: 640, top: HEADER_HEIGHT, width: 640, height: 700 });

    // One continuous gesture: the first move detaches the docked window, then the panel travels to the top band.
    drag(handle, { from: { x: 900, y: 200 }, via: [{ x: 900, y: 224 }], to: { x: 700, y: HEADER_HEIGHT + 4 }, pointerId: 3 });
    expect(rectOf(panel)).toEqual({ left: 0, top: HEADER_HEIGHT, width: 1280, height: 700 });
    expect(panel.dataset.snapMode).toBe("maximized");
  });

  /*
  FNXC:FloatingWindowSnap 2026-09-15-04:01:
  FN-401 symptom assertion (2): the pointer stays at mid-height and well inside the work area, so the OLD
  pointer-driven detection armed nothing. The position clamp pins the panel's right edge to the right wall,
  which must now arm and apply the right column.
  */
  it("arms the right column from the panel's own edge while the pointer stays away from the band", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(600));

    drag(handle, { from: { x: 600, y: 400 }, to: { x: 1000, y: 400 }, pointerId: 70, hold: true });
    const preview = screen.getByTestId("floating-window-snap-preview-snap");
    expect(preview.dataset.snapZone).toBe("right");
    // The pointer stayed 280px away from the right wall; only the panel's clamped edge is against it.
    expect(1280 - 1000).toBeGreaterThan(24);

    fireEvent.pointerUp(handle, { pointerId: 70, clientX: 1000, clientY: 400 });
    expect(panel.dataset.snapMode).toBe("right");
    expect(rectOf(panel)).toEqual({ left: 640, top: HEADER_HEIGHT, width: 640, height: 700 });
  });

  /*
  FNXC:FloatingWindowSnap 2026-09-15-14:07:
  FN-422 rewrites the former "arms nothing while the window is still docked" case. Its old subject — a
  non-downward gesture arms nothing and leaves the dock intact — is precisely the behaviour that was removed.
  What stays true: BELOW the drag threshold the window is still pinned, so nothing is armed and the dock
  survives. What is new: past the threshold the window comes loose and the SAME gesture carries it to another
  wall, which arms and applies that wall — with no downward `via` point.
  */
  it("arms nothing while the docked window is still pinned, then re-docks on the other wall in one gesture", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(600));

    drag(handle, { to: { x: 6, y: 400 }, pointerId: 71 });
    expect(panel.dataset.snapMode).toBe("left");
    const docked = rectOf(panel);

    // Still a click: under the threshold the panel is pinned, exposes no edge, and arms nothing.
    drag(handle, { from: { x: 300, y: 300 }, to: { x: 303, y: 302 }, pointerId: 72, hold: true });
    expect(screen.queryByTestId("floating-window-snap-preview-snap")).not.toBeInTheDocument();
    fireEvent.pointerUp(handle, { pointerId: 72, clientX: 303, clientY: 302 });
    expect(panel.dataset.snapMode).toBe("left");
    expect(rectOf(panel)).toEqual(docked);

    // Past the threshold the same single gesture detaches and carries the window to the opposite wall.
    drag(handle, { from: { x: 300, y: 300 }, to: { x: 1278, y: 290 }, pointerId: 73, hold: true });
    expect(screen.getByTestId("floating-window-snap-preview-snap").dataset.snapZone).toBe("right");
    fireEvent.pointerUp(handle, { pointerId: 73, clientX: 1278, clientY: 290 });
    expect(panel.dataset.snapMode).toBe("right");
    expect(rectOf(panel)).toEqual({ left: 640, top: HEADER_HEIGHT, width: 640, height: 700 });
  });

  /*
  FNXC:FloatingWindowSnap 2026-09-15-14:07:
  FN-422 symptom matrix: every docked mode (`left`, `right`, `maximized`) must come loose in EVERY direction
  — up, down, left, right, diagonal — and recover its pre-dock floating size. The "down" row is the
  non-regression of the previous gesture.
  */
  it.each(
    (["left", "right", "maximized"] as const).flatMap((mode, modeIndex) =>
      ([
        ["up", { x: 0, y: -40 }],
        ["down", { x: 0, y: 40 }],
        ["left", { x: -40, y: 0 }],
        ["right", { x: 40, y: 0 }],
        ["diagonal", { x: -30, y: -30 }],
      ] as const).map(([direction, delta], directionIndex) => ({
        mode,
        direction,
        delta,
        pointerId: 200 + modeIndex * 10 + directionIndex,
      })),
    ),
  )("undocks a $mode window on a $direction gesture and restores its floating size", async ({ mode, delta, pointerId }) => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(600));
    const floating = rectOf(panel);

    dock(handle, mode, pointerId);
    expect(panel.dataset.snapMode).toBe(mode);

    const from = { x: 640, y: 400 };
    drag(handle, { from, to: { x: from.x + delta.x, y: from.y + delta.y }, pointerId: pointerId + 500 });

    expect(panel.dataset.snapMode).toBe("floating");
    expect(rectOf(panel).width).toBe(floating.width);
    expect(rectOf(panel).height).toBe(floating.height);
    expect(screen.getByTestId("floating-window-resize-se")).toBeInTheDocument();
  });

  /*
  FNXC:FloatingWindowSnap 2026-09-15-14:07:
  FN-422 surface enumeration: both entry points into the single drag handler must inherit the omnidirectional
  undock — the native header (desktop mouse) and a delegated host header (touch tablet).
  */
  it.each([
    { name: "native header", delegated: false, pointerType: "mouse" as const, pointerId: 260 },
    { name: "delegated host header", delegated: true, pointerType: "touch" as const, pointerId: 262 },
  ])("undocks a maximized window upward from the $name", async ({ delegated, pointerType, pointerId }) => {
    const { panel, handle } = renderWindow({ delegated });
    await waitFor(() => expect(rectOf(panel).width).toBe(600));
    const floating = rectOf(panel);

    dock(handle, "maximized", pointerId, pointerType);
    expect(panel.dataset.snapMode).toBe("maximized");

    drag(handle, { from: { x: 640, y: 400 }, to: { x: 640, y: 360 }, pointerId: pointerId + 1, pointerType });

    expect(panel.dataset.snapMode).toBe("floating");
    expect(rectOf(panel).width).toBe(floating.width);
    expect(rectOf(panel).height).toBe(floating.height);
  });

  /*
  FNXC:FloatingWindowSnap 2026-09-15-14:07:
  FN-422 keeps the click guard: a header CLICK (below `FLOATING_WINDOW_DRAG_THRESHOLD_PX`) must never release a
  docked window, in any direction.
  */
  it.each([
    { direction: "up", delta: { x: 0, y: -4 } },
    { direction: "left", delta: { x: -4, y: 0 } },
    { direction: "diagonal", delta: { x: 3, y: -3 } },
  ])("keeps a docked window docked on a sub-threshold $direction gesture", async ({ delta }) => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(600));

    dock(handle, "maximized", 280);
    const docked = rectOf(panel);

    drag(handle, { from: { x: 640, y: 400 }, to: { x: 640 + delta.x, y: 400 + delta.y }, pointerId: 281 });

    expect(panel.dataset.snapMode).toBe("maximized");
    expect(rectOf(panel)).toEqual(docked);
  });

  /*
  FNXC:FloatingWindowSnap 2026-09-15-04:01:
  FN-401 surface enumeration: a sheet presentation (phone / short viewport) exposes no drag and therefore no
  zone at all. The panel geometry must not move and no preview may ever be armed.
  */
  it("arms no zone and moves nothing in sheet presentation", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 600 });
    // `isFullScreenSheetViewport` reads the CSS breakpoint through matchMedia, not innerWidth.
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
    await waitFor(() => expect(rectOf(panel).width).toBe(400));
    const before = rectOf(panel);

    const handle = screen.getByTestId("floating-window-drag-handle-sheet");
    drag(handle, { from: { x: 300, y: 400 }, via: [{ x: 300, y: 430 }], to: { x: 4, y: 400 }, pointerId: 73, hold: true });
    expect(screen.queryByTestId("floating-window-snap-preview-sheet")).not.toBeInTheDocument();
    fireEvent.pointerUp(handle, { pointerId: 73, clientX: 4, clientY: 400 });
    expect(rectOf(panel)).toEqual(before);
    expect(panel.dataset.snapMode).toBe("floating");
  });

  it("gives the top band priority over a side band in a corner", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(600));

    drag(handle, { to: { x: 4, y: HEADER_HEIGHT + 2 }, pointerId: 4 });
    expect(panel.dataset.snapMode).toBe("maximized");
  });

  it("keeps free movement outside the bands and treats a sub-threshold move as a click", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(600));
    const before = rectOf(panel);

    drag(handle, { to: { x: 604, y: 403 }, pointerId: 5 });
    expect(rectOf(panel)).toEqual(before);
    expect(panel.dataset.snapMode).toBe("floating");

    drag(handle, { to: { x: 700, y: 450 }, pointerId: 6 });
    const moved = rectOf(panel);
    expect(moved.left).toBe(before.left + 100);
    expect(moved.top).toBe(before.top + 50);
    expect(moved.width).toBe(600);
    expect(panel.dataset.snapMode).toBe("floating");
  });

  it("previews the armed zone without applying it and never exposes an interactive preview", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(600));
    const before = rectOf(panel);

    drag(handle, { to: { x: 6, y: 400 }, pointerId: 7, hold: true });
    const preview = screen.getByTestId("floating-window-snap-preview-snap");
    expect(preview).toHaveAttribute("aria-hidden", "true");
    expect(preview.dataset.snapZone).toBe("left");
    expect(preview.getAttribute("tabindex")).toBeNull();
    // The panel itself has not moved yet: the mode applies on release only.
    expect(rectOf(panel).width).toBe(before.width);

    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 6, clientY: 400 });
    expect(screen.queryByTestId("floating-window-snap-preview-snap")).not.toBeInTheDocument();
    expect(panel.dataset.snapMode).toBe("left");
  });

  it("restores the pre-snap floating rect after left then right then maximized then a detaching drag", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(600));

    // A genuine free resize before any snap: this is the rectangle that must come back.
    const seHandle = screen.getByTestId("floating-window-resize-se");
    prepareCapture(seHandle);
    fireEvent.pointerDown(seHandle, { pointerId: 10, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(seHandle, { pointerId: 10, clientX: 560, clientY: 540 });
    fireEvent.pointerUp(seHandle, { pointerId: 10, clientX: 560, clientY: 540 });
    const floating = rectOf(panel);
    expect(floating.width).toBe(660);
    expect(floating.height).toBe(440);

    drag(handle, { to: { x: 5, y: 400 }, pointerId: 11 });
    drag(handle, { from: { x: 300, y: 300 }, to: { x: 1278, y: 400 }, pointerId: 12 });
    // The first move detaches, then the gesture continues to the top band inside the same pointer session.
    drag(handle, { from: { x: 900, y: 300 }, via: [{ x: 900, y: 324 }], to: { x: 900, y: HEADER_HEIGHT + 1 }, pointerId: 13 });
    expect(panel.dataset.snapMode).toBe("maximized");
    expect(screen.queryByTestId("floating-window-resize-se")).not.toBeInTheDocument();

    drag(handle, { from: { x: 640, y: HEADER_HEIGHT + 10 }, to: { x: 640, y: HEADER_HEIGHT + 60 }, pointerId: 14 });
    const restored = rectOf(panel);
    expect(panel.dataset.snapMode).toBe("floating");
    expect(restored.width).toBe(floating.width);
    expect(restored.height).toBe(floating.height);
    expect(screen.getByTestId("floating-window-resize-se")).toBeInTheDocument();
  });

  it("detaches a maximized window grabbed at its very top edge instead of re-arming the top band", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(600));
    const floating = rectOf(panel);

    drag(handle, { from: { x: 900, y: 300 }, to: { x: 900, y: HEADER_HEIGHT + 1 }, pointerId: 20 });
    expect(panel.dataset.snapMode).toBe("maximized");

    // Grabbed on the first pixel row of a maximized window: a downward detach still ends inside the top band.
    drag(handle, { from: { x: 640, y: HEADER_HEIGHT }, to: { x: 640, y: HEADER_HEIGHT + 24 }, pointerId: 21 });

    expect(panel.dataset.snapMode).toBe("floating");
    expect(rectOf(panel).width).toBe(floating.width);
    expect(rectOf(panel).height).toBe(floating.height);
    expect(screen.getByTestId("floating-window-resize-se")).toBeInTheDocument();
  });

  it("re-splits both halves against the live work area when the sidebar opens and closes", async () => {
    const { panel, handle, rerender } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(600));
    drag(handle, { to: { x: 6, y: 400 }, pointerId: 20 });
    expect(rectOf(panel).width).toBe(640);

    rerender(
      <DashboardWindowManagerProvider>
        <Landmarks sidebar />
        <FloatingWindow windowKey="snap" title="Snap" onClose={() => {}} defaultSize={{ width: 600, height: 400 }} minSize={{ width: 320, height: 200 }}>body</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    await waitFor(() => expect(rectOf(panel).width).toBe((1280 - SIDEBAR_WIDTH) / 2));
    expect(rectOf(panel).left).toBe(SIDEBAR_WIDTH);

    rerender(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="snap" title="Snap" onClose={() => {}} defaultSize={{ width: 600, height: 400 }} minSize={{ width: 320, height: 200 }}>body</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    await waitFor(() => expect(rectOf(panel).width).toBe(640));
    expect(rectOf(panel).left).toBe(0);
  });

  it("lets a half-width column go below the declared minimum while the shell stays uncovered", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 600 });
    // The panel must be narrower than the work area, otherwise it touches BOTH walls at once and FN-401
    // deliberately refuses to guess a side.
    const { panel, handle } = renderWindow({ defaultSize: { width: 400, height: 400 } });
    await waitFor(() => expect(rectOf(panel).width).toBeGreaterThan(0));
    drag(handle, { from: { x: 300, y: 400 }, to: { x: 4, y: 400 }, pointerId: 21 });
    expect(rectOf(panel).width).toBe(300);
    expect(rectOf(panel).left).toBe(0);
  });

  it("validates nothing on pointercancel and returns to the pre-gesture placement", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(600));
    const before = rectOf(panel);

    drag(handle, { to: { x: 4, y: 400 }, pointerId: 30, cancel: true });
    expect(screen.queryByTestId("floating-window-snap-preview-snap")).not.toBeInTheDocument();
    expect(panel.dataset.snapMode).toBe("floating");
    expect(rectOf(panel)).toEqual(before);

    // The same cancellation from a snapped state returns to the snapped rect, not to a half-applied one.
    drag(handle, { to: { x: 4, y: 400 }, pointerId: 31 });
    expect(panel.dataset.snapMode).toBe("left");
    drag(handle, { from: { x: 200, y: 300 }, via: [{ x: 200, y: 330 }], to: { x: 1278, y: 400 }, pointerId: 32, cancel: true });
    expect(panel.dataset.snapMode).toBe("left");
    expect(rectOf(panel).left).toBe(0);
  });

  it("ignores a second finger and never snaps from a resize handle", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(600));
    const before = rectOf(panel);

    prepareCapture(handle);
    fireEvent.pointerDown(handle, { pointerId: 40, pointerType: "touch", clientX: 600, clientY: 400 });
    fireEvent.pointerMove(handle, { pointerId: 99, pointerType: "touch", clientX: 4, clientY: 400 });
    expect(screen.queryByTestId("floating-window-snap-preview-snap")).not.toBeInTheDocument();
    fireEvent.pointerUp(handle, { pointerId: 40, pointerType: "touch", clientX: 600, clientY: 400 });
    expect(rectOf(panel)).toEqual(before);

    const westHandle = screen.getByTestId("floating-window-resize-w");
    prepareCapture(westHandle);
    fireEvent.pointerDown(westHandle, { pointerId: 41, clientX: 400, clientY: 400 });
    fireEvent.pointerMove(westHandle, { pointerId: 41, clientX: 2, clientY: 400 });
    expect(screen.queryByTestId("floating-window-snap-preview-snap")).not.toBeInTheDocument();
    fireEvent.pointerUp(westHandle, { pointerId: 41, clientX: 2, clientY: 400 });
    expect(panel.dataset.snapMode).toBe("floating");
  });

  it("does not start a drag from an interactive control inside the header", async () => {
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="ctl" title="Ctl" onClose={() => {}} hideHeader dragHandleSelector=".host-header" defaultSize={{ width: 600, height: 400 }}>
          <div className="host-header"><button type="button">Action</button></div>
        </FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const panel = screen.getByTestId("floating-window-ctl");
    await waitFor(() => expect(rectOf(panel).width).toBe(600));
    const before = rectOf(panel);
    const button = screen.getByRole("button", { name: "Action" });
    prepareCapture(button);
    fireEvent.pointerDown(button, { pointerId: 50, clientX: 600, clientY: 400 });
    fireEvent.pointerMove(button, { pointerId: 50, clientX: 4, clientY: 400 });
    fireEvent.pointerUp(button, { pointerId: 50, clientX: 4, clientY: 400 });
    expect(rectOf(panel)).toEqual(before);
    expect(panel.dataset.snapMode).toBe("floating");
  });

  it("drops an armed preview when the window closes mid-gesture", async () => {
    const { panel, handle, rerender } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBe(600));
    drag(handle, { to: { x: 4, y: 400 }, pointerId: 60, hold: true });
    expect(screen.getByTestId("floating-window-snap-preview-snap")).toBeInTheDocument();

    rerender(<DashboardWindowManagerProvider><Landmarks /></DashboardWindowManagerProvider>);
    expect(screen.queryByTestId("floating-window-snap-preview-snap")).not.toBeInTheDocument();
    expect(screen.queryByTestId("floating-window-snap")).not.toBeInTheDocument();
  });
});
