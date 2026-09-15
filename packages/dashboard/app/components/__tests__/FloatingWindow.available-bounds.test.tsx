import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDashboardWindowLandmark, DashboardWindowManagerProvider } from "../../context/DashboardWindowManagerContext";
import { FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, FloatingWindow } from "../FloatingWindow";

const rects = {
  header: { left: 0, top: 0, right: 1280, bottom: 64, width: 1280, height: 64 },
  footer: { left: 0, top: 764, right: 1280, bottom: 800, width: 1280, height: 36 },
  alphaFooter: { left: 0, top: 752, right: 1280, bottom: 800, width: 1280, height: 48 },
  dock: { left: 980, top: 64, right: 1280, bottom: 764, width: 300, height: 700 },
};

let resizeObservers: Array<() => void> = [];

function domRect(value: Omit<DOMRect, "x" | "y" | "toJSON">): DOMRect {
  return { ...value, x: value.left, y: value.top, toJSON: () => ({}) };
}

function Landmarks({ dock = true, alphaFooter = false }: { dock?: boolean; alphaFooter?: boolean }) {
  const headerRef = useDashboardWindowLandmark("header");
  const footerRef = useDashboardWindowLandmark("footer");
  const dockRef = useDashboardWindowLandmark("right-dock");
  return (
    <>
      <header ref={headerRef} data-landmark="header" />
      <footer ref={footerRef} data-landmark={alphaFooter ? "alphaFooter" : "footer"} />
      {dock ? <aside ref={dockRef} data-landmark="dock" /> : null}
    </>
  );
}

function preparePointerTarget(target: HTMLElement) {
  Object.defineProperty(target, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(target, "releasePointerCapture", { configurable: true, value: vi.fn() });
}

function dragTo(target: HTMLElement, clientX: number, clientY: number, pointerId: number) {
  preparePointerTarget(target);
  fireEvent.pointerDown(target, { pointerId, clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerMove(target, { pointerId, clientX, clientY });
  fireEvent.pointerUp(target, { pointerId, clientX, clientY });
}

/*
FNXC:FloatingWindowBounds 2026-09-15-04:01:
FN-401 arms a snap zone from the dragged PANEL's own edge, so pushing a window fully against a work-area
edge is now a dock request, applied on release. The clamping contract (exact edges, no artificial gutter)
is therefore asserted while the gesture is still HELD — the panel has already moved to the exact edge and
only the dock is deferred — then cancelled, which validates nothing.
*/
function holdDragTo(target: HTMLElement, clientX: number, clientY: number, pointerId: number) {
  preparePointerTarget(target);
  fireEvent.pointerDown(target, { pointerId, clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerMove(target, { pointerId, clientX, clientY });
  return () => fireEvent.pointerCancel(target, { pointerId, clientX, clientY });
}

/*
FNXC:FloatingWindowBounds 2026-09-14-10:52:
These regressions reproduce the shell geometry contract with live DOM landmark rectangles. Exact edges, rather than a synthetic viewport gutter, remain authoritative across drag, oversized restore, dock/footer replacement, and viewport resize.
*/
describe("FloatingWindow available shell bounds", () => {
  beforeEach(() => {
    resizeObservers = [];
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        resizeObservers.push(() => callback([], this as unknown as ResizeObserver));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const name = this.dataset.landmark as keyof typeof rects | undefined;
      if (name === "header") return domRect({ ...rects.header, right: window.innerWidth, width: window.innerWidth });
      if (name === "footer" || name === "alphaFooter") {
        const height = name === "footer" ? rects.footer.height : rects.alphaFooter.height;
        return domRect({ left: 0, top: window.innerHeight - height, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height });
      }
      if (name === "dock") return domRect({ left: window.innerWidth - rects.dock.width, top: rects.dock.top, right: window.innerWidth, bottom: window.innerHeight - rects.footer.height, width: rects.dock.width, height: window.innerHeight - rects.dock.top - rects.footer.height });
      return domRect({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("drags to all four exact work-area edges without artificial padding", async () => {
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="edge" title="Edge" onClose={() => {}} defaultSize={{ width: 300, height: 200 }} minSize={{ width: 100, height: 100 }} defaultPosition={{ x: 100, y: 100 }}>
          body
        </FloatingWindow>
      </DashboardWindowManagerProvider>,
    );

    const panel = screen.getByTestId("floating-window-edge");
    const handle = screen.getByTestId("floating-window-drag-handle-edge");
    await waitFor(() => expect(panel.style.top).toBe("100px"));

    // The held drag applies its position through requestAnimationFrame; run it synchronously here.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const cancelTopLeft = holdDragTo(handle, -5000, -5000, 1);
    expect(panel.style.left).toBe("0px");
    expect(panel.style.top).toBe("64px");
    cancelTopLeft();

    const cancelBottomRight = holdDragTo(handle, 5000, 5000, 2);
    expect(panel.style.left).toBe("680px");
    expect(panel.style.top).toBe("564px");
    expect(Number.parseFloat(panel.style.left) + Number.parseFloat(panel.style.width)).toBe(980);
    expect(Number.parseFloat(panel.style.top) + Number.parseFloat(panel.style.height)).toBe(764);
    cancelBottomRight();
    expect(panel.dataset.snapMode).toBe("floating");
  });

  /*
  FNXC:FloatingWindowBounds 2026-09-15-04:01:
  FN-401: releasing at that same exact edge is the dock request, and the half is measured against the work
  area the dock actually reduces — header, footer, and right dock excluded, no gutter.
  */
  it("docks to the right half of the exact work area when released against its right edge", async () => {
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="dock-edge" title="Edge" onClose={() => {}} defaultSize={{ width: 300, height: 200 }} minSize={{ width: 100, height: 100 }} defaultPosition={{ x: 100, y: 100 }}>
          body
        </FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const panel = screen.getByTestId("floating-window-dock-edge");
    const handle = screen.getByTestId("floating-window-drag-handle-dock-edge");
    await waitFor(() => expect(panel.style.top).toBe("100px"));

    dragTo(handle, 5000, 400, 3);

    expect(panel.dataset.snapMode).toBe("right");
    expect(panel.style.width).toBe("490px");
    expect(panel.style.left).toBe("490px");
    expect(Number.parseFloat(panel.style.left) + Number.parseFloat(panel.style.width)).toBe(980);
  });

  it("falls back edge-by-edge to the viewport when landmarks are absent", async () => {
    render(
      <DashboardWindowManagerProvider>
        <FloatingWindow windowKey="fallback" title="Fallback" onClose={() => {}} defaultSize={{ width: 300, height: 200 }} defaultPosition={{ x: -100, y: -100 }}>body</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const panel = screen.getByTestId("floating-window-fallback");
    await waitFor(() => expect(panel.style.left).toBe("0px"));
    expect(panel.style.top).toBe("0px");
  });

  it("reclamps mounted geometry after dock, footer, and viewport changes and emits geometry", async () => {
    const geometryEvents = vi.fn();
    window.addEventListener(FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, geometryEvents);
    const { rerender } = render(
      <DashboardWindowManagerProvider>
        <Landmarks dock={false} />
        <FloatingWindow windowKey="dynamic" title="Dynamic" onClose={() => {}} defaultSize={{ width: 600, height: 500 }} defaultPosition={{ x: 680, y: 264 }}>body</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const panel = screen.getByTestId("floating-window-dynamic");
    await waitFor(() => expect(panel.style.left).toBe("680px"));

    rerender(
      <DashboardWindowManagerProvider>
        <Landmarks dock alphaFooter />
        <FloatingWindow windowKey="dynamic" title="Dynamic" onClose={() => {}} defaultSize={{ width: 600, height: 500 }} defaultPosition={{ x: 680, y: 264 }}>body</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    resizeObservers.forEach((notify) => notify());
    await waitFor(() => expect(panel.style.left).toBe("380px"));
    expect(panel.style.top).toBe("252px");

    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 900 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 500 });
    fireEvent(window, new Event("resize"));
    await waitFor(() => {
      expect(Number.parseFloat(panel.style.width)).toBe(900 - 300);
      expect(Number.parseFloat(panel.style.height)).toBe(500 - 64 - 48);
    });
    expect(geometryEvents).toHaveBeenCalled();
    window.removeEventListener(FLOATING_WINDOW_GEOMETRY_CHANGE_EVENT, geometryEvents);
  });

  it("shrinks an oversized persisted or maximized geometry before clamping its position", async () => {
    localStorage.setItem("floating-window:oversized", JSON.stringify({
      size: { width: 9999, height: 9999 },
      position: { x: 9999, y: -9999 },
    }));
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="oversized" title="Oversized" onClose={() => {}} persistGeometryKey="floating-window:oversized" minSize={{ width: 1200, height: 900 }}>body</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const panel = screen.getByTestId("floating-window-oversized");
    await waitFor(() => expect(panel.style.width).toBe("980px"));
    expect(panel.style.height).toBe("700px");
    expect(panel.style.left).toBe("0px");
    expect(panel.style.top).toBe("64px");
  });
});
