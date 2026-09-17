import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const viewport = vi.hoisted(() => ({ mode: "desktop" as "desktop" | "tablet" | "mobile", tabletTouch: false }));

vi.mock("../../hooks/useViewportMode", async () => {
  const actual = await vi.importActual<typeof import("../../hooks/useViewportMode")>("../../hooks/useViewportMode");
  return {
    ...actual,
    useViewportMode: () => viewport.mode,
    isTabletTouchViewport: (mode?: string) => viewport.tabletTouch && (mode ?? viewport.mode) === "tablet",
  };
});

import {
  DashboardWindowManagerProvider,
  useDashboardWindowBottomDockReservation,
  useDashboardWindowLandmark,
  useDashboardWindowVisibility,
} from "../../context/DashboardWindowManagerContext";
import { FloatingWindow } from "../FloatingWindow";

/*
FNXC:FloatingWindowSnap 2026-09-17-04:51:
FN-487 acceptance on the SHARED window contract: every non-sheet window docked along the bottom publishes the band the
shell must reserve, and only that mode does. Real pointer gestures drive the production component; the assertions read
the published reservation, never a helper return value.
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

/** Stands in for the shell: it renders exactly what `.dashboard-project-stack` would reserve. */
function Stack() {
  const reserved = useDashboardWindowBottomDockReservation();
  const visibility = useDashboardWindowVisibility();
  return (
    <>
      <output data-testid="reservation">{reserved}</output>
      <button type="button" data-testid="toggle-visibility" onClick={() => visibility?.toggleVisibility()}>
        hide
      </button>
    </>
  );
}

function reservation(): number {
  return Number(screen.getByTestId("reservation").textContent);
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
  fireEvent.pointerDown(handle, { pointerId, pointerType: "mouse", button: 0, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(handle, { pointerId, pointerType: "mouse", clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(handle, { pointerId, pointerType: "mouse", clientX: to.x, clientY: to.y });
}

function windowNode(mounted = true) {
  return mounted ? (
    <FloatingWindow
      windowKey="reservation"
      title="Reservation"
      onClose={() => {}}
      defaultSize={{ width: 600, height: 400 }}
      minSize={{ width: 320, height: 200 }}
    >
      body
    </FloatingWindow>
  ) : null;
}

function renderWindow() {
  const view = render(
    <DashboardWindowManagerProvider>
      <Landmarks />
      <Stack />
      {windowNode()}
    </DashboardWindowManagerProvider>,
  );
  return { ...view, panel: screen.getByTestId("floating-window-reservation"), handle: screen.getByTestId("floating-window-drag-handle-reservation") };
}

/** Drag far past the bottom wall: the position clamp pins the panel's bottom edge onto it. */
function dockBottom(handle: HTMLElement, pointerId: number) {
  drag(handle, { x: 600, y: 300 }, { x: 600, y: 300 + window.innerHeight }, pointerId);
}

describe("FloatingWindow bottom dock reservation", () => {
  beforeEach(() => {
    localStorage.clear();
    viewport.mode = "desktop";
    viewport.tabletTouch = false;
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
    delete document.documentElement.dataset.mobileDrawers;
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /*
  (a) Negative control: only the bottom band reorganizes the shell; every other mode overlays as before.

  FNXC:FloatingWindowSnap 2026-09-17-07:21:
  FN-493 adjusts the `maximized` row's horizontal target only — the former one carried the panel to the top wall
  with its right edge still ON the right wall, which is now an unambiguous top-right corner — and extends the row
  set with the four quadrants. A quadrant covers half the width, so it deliberately reserves NOTHING: the FN-487
  shell reservation stays the full-width band's alone.
  */
  it.each([
    { mode: "floating", gesture: { to: { x: 700, y: 380 } } },
    { mode: "left", gesture: { to: { x: 6, y: 400 } } },
    { mode: "right", gesture: { to: { x: 1276, y: 400 } } },
    { mode: "maximized", gesture: { to: { x: 600, y: HEADER_HEIGHT + 1 } } },
    { mode: "top-left", gesture: { to: { x: -200, y: -200 } } },
    { mode: "top-right", gesture: { to: { x: 1480, y: -200 } } },
    { mode: "bottom-left", gesture: { to: { x: -200, y: 1000 } } },
    { mode: "bottom-right", gesture: { to: { x: 1480, y: 1000 } } },
  ])("never reserves anything in $mode mode", async ({ mode, gesture }) => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBeGreaterThan(0));

    drag(handle, { x: 600, y: 400 }, gesture.to, 10);

    expect(panel.dataset.snapMode).toBe(mode);
    expect(reservation()).toBe(0);
  });

  /* (b) Docking publishes the distance from the band's TOP edge to the bottom of the viewport; detaching releases it. */
  it("reserves the band while docked and releases it on detach", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBeGreaterThan(0));
    expect(reservation()).toBe(0);

    dockBottom(handle, 11);
    expect(panel.dataset.snapMode).toBe("bottom");
    expect(reservation()).toBe(window.innerHeight - rectOf(panel).top);
    // Parity with the pinned terminal: the band also covers the fixed bottom bar it paints over.
    expect(reservation()).toBe(rectOf(panel).height + FOOTER_HEIGHT);

    drag(handle, { x: 600, y: 600 }, { x: 700, y: 360 }, 12);
    expect(panel.dataset.snapMode).toBe("floating");
    expect(reservation()).toBe(0);
  });

  /* (c) Unmounting (closing) a docked window returns the space to the board. */
  it("releases the band when the docked window unmounts", async () => {
    const { rerender, panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBeGreaterThan(0));

    dockBottom(handle, 13);
    expect(reservation()).toBeGreaterThan(0);

    rerender(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <Stack />
        {windowNode(false)}
      </DashboardWindowManagerProvider>,
    );
    expect(reservation()).toBe(0);
  });

  /* (d) A phone sheet exposes no geometry at all, so no gesture can ever publish a band. */
  it("never reserves anything in a mobile sheet presentation", async () => {
    viewport.mode = "mobile";
    // The phone sheet presentation is host state, published by the shell on the document element.
    document.documentElement.dataset.mobileDrawers = "true";
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <Stack />
        {windowNode()}
      </DashboardWindowManagerProvider>,
    );
    const panel = screen.getByTestId("floating-window-reservation");
    const handle = screen.queryByTestId("floating-window-drag-handle-reservation");

    if (handle) drag(handle, { x: 200, y: 300 }, { x: 200, y: 300 + window.innerHeight }, 14);

    expect(panel.dataset.snapMode).not.toBe("bottom");
    expect(reservation()).toBe(0);
  });

  /* (e) A touch tablet keeps the desktop window contract, so it reserves exactly like desktop. */
  it("keeps the desktop reservation on a touch tablet", async () => {
    viewport.mode = "tablet";
    viewport.tabletTouch = true;
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBeGreaterThan(0));

    dockBottom(handle, 15);

    expect(panel.dataset.snapMode).toBe("bottom");
    expect(reservation()).toBe(window.innerHeight - rectOf(panel).top);
  });

  /* (f) A globally hidden window paints no band, so it must reserve nothing until it is restored. */
  it("drops the band while globally hidden and republishes it on restore", async () => {
    const { panel, handle } = renderWindow();
    await waitFor(() => expect(rectOf(panel).width).toBeGreaterThan(0));

    dockBottom(handle, 16);
    const docked = reservation();
    expect(docked).toBeGreaterThan(0);

    act(() => { screen.getByTestId("toggle-visibility").click(); });
    expect(reservation()).toBe(0);

    act(() => { screen.getByTestId("toggle-visibility").click(); });
    expect(reservation()).toBe(docked);
    expect(panel.dataset.snapMode).toBe("bottom");
  });
});
