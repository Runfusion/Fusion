import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWindowManagerProvider, useDashboardWindowLandmark } from "../../context/DashboardWindowManagerContext";
import { FloatingWindow } from "../FloatingWindow";
import { expectedOpeningSize, harnessWorkArea } from "./floatingWindowOpeningFixture";

/*
FNXC:FloatingWindowSnap 2026-09-15-04:01:
FN-401 symptom assertion (3): the snap-zone preview used to be painted INSIDE its own window's overlay,
whose inline z-index opens a closed stacking context, so the board or another window could cover it. It now
lives in its own body portal at the top of the shared stack. These regressions prove, from a real drag
gesture, that the preview node is not a descendant of any overlay, that it outranks EVERY mounted overlay,
and that it leaves no orphan node behind on release, cancellation, hiding, or unmount.
*/

const HEADER_HEIGHT = 64;
const FOOTER_HEIGHT = 36;

/*
FNXC:FloatingWindowSnap 2026-09-16-07:38:
FN-460 opens the dragged window 20% larger, so its settle wait reads the production opening seam instead of
the host's declared width. The preview-layer contract itself is untouched.
*/
function draggedOpeningWidth(): number {
  return expectedOpeningSize(
    { width: 600, height: 400 },
    { minSize: { width: 320, height: 200 }, bounds: harnessWorkArea(HEADER_HEIGHT, FOOTER_HEIGHT) },
  ).width;
}

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

function prepareCapture(target: HTMLElement) {
  Object.defineProperty(target, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(target, "releasePointerCapture", { configurable: true, value: vi.fn() });
}

function renderTwoWindows(options: { hideSecond?: boolean } = {}) {
  return render(
    <DashboardWindowManagerProvider>
      <Landmarks />
      {/* A board-like page surface that historically painted over the preview. */}
      <div data-testid="board-surface" style={{ position: "relative", zIndex: 20 }}>board</div>
      <FloatingWindow windowKey="dragged" title="Dragged" onClose={() => {}} defaultSize={{ width: 600, height: 400 }} minSize={{ width: 320, height: 200 }}>
        dragged body
      </FloatingWindow>
      <FloatingWindow windowKey="blocker" title="Blocker" onClose={() => {}} modal hidden={options.hideSecond} defaultSize={{ width: 500, height: 360 }} minSize={{ width: 320, height: 200 }}>
        blocker body
      </FloatingWindow>
    </DashboardWindowManagerProvider>,
  );
}

function armLeftZone(pointerId: number) {
  const handle = screen.getByTestId("floating-window-drag-handle-dragged");
  prepareCapture(handle);
  fireEvent.pointerDown(handle, { pointerId, clientX: 600, clientY: 400, button: 0 });
  fireEvent.pointerMove(handle, { pointerId, clientX: 4, clientY: 400 });
  return handle;
}

function overlayZIndexes(): number[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".floating-window-overlay"))
    .map((overlay) => Number.parseFloat(overlay.style.zIndex))
    .filter((value) => Number.isFinite(value));
}

describe("FloatingWindow snap preview layer", () => {
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

  it("renders the armed preview outside every overlay and above all of them", async () => {
    renderTwoWindows();
    await waitFor(() => expect(screen.getByTestId("floating-window-dragged").style.width).toBe(`${draggedOpeningWidth()}px`));
    expect(document.querySelectorAll(".floating-window-overlay").length).toBe(2);

    armLeftZone(1);

    const preview = screen.getByTestId("floating-window-snap-preview-dragged");
    expect(preview.dataset.snapZone).toBe("left");
    // (a) Its own layer: not trapped in any overlay's stacking context.
    expect(preview.closest(".floating-window-overlay")).toBeNull();
    expect(preview.parentElement).toBe(document.body);
    // (b) Strictly above EVERY mounted overlay, including the modal one.
    const previewZ = Number.parseFloat(preview.style.zIndex);
    const overlays = overlayZIndexes();
    expect(overlays.length).toBe(2);
    for (const overlayZ of overlays) expect(previewZ).toBeGreaterThan(overlayZ);
    // ...and above the board surface it used to hide behind.
    expect(previewZ).toBeGreaterThan(20);
    // It stays paint-only.
    expect(preview).toHaveAttribute("aria-hidden", "true");
    expect(preview.getAttribute("tabindex")).toBeNull();
  });

  it("removes the preview node from the document on release", async () => {
    renderTwoWindows();
    await waitFor(() => expect(screen.getByTestId("floating-window-dragged").style.width).toBe(`${draggedOpeningWidth()}px`));
    const handle = armLeftZone(2);
    expect(screen.getByTestId("floating-window-snap-preview-dragged")).toBeInTheDocument();

    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 4, clientY: 400 });

    expect(document.querySelector(".floating-window__snap-preview")).toBeNull();
    expect(screen.getByTestId("floating-window-dragged").dataset.snapMode).toBe("left");
  });

  it("removes the preview node from the document on cancellation", async () => {
    renderTwoWindows();
    await waitFor(() => expect(screen.getByTestId("floating-window-dragged").style.width).toBe(`${draggedOpeningWidth()}px`));
    const handle = armLeftZone(3);
    expect(screen.getByTestId("floating-window-snap-preview-dragged")).toBeInTheDocument();

    fireEvent.pointerCancel(handle, { pointerId: 3, clientX: 4, clientY: 400 });

    expect(document.querySelector(".floating-window__snap-preview")).toBeNull();
    expect(screen.getByTestId("floating-window-dragged").dataset.snapMode).toBe("floating");
  });

  it("leaves no orphan preview node in the body when the window unmounts mid-gesture", async () => {
    const { unmount } = renderTwoWindows();
    await waitFor(() => expect(screen.getByTestId("floating-window-dragged").style.width).toBe(`${draggedOpeningWidth()}px`));
    armLeftZone(4);
    expect(screen.getByTestId("floating-window-snap-preview-dragged")).toBeInTheDocument();

    unmount();

    expect(document.querySelector(".floating-window__snap-preview")).toBeNull();
    expect(document.querySelector(".floating-window-overlay")).toBeNull();
  });

  it("shows no preview for a hidden window", async () => {
    const view = renderTwoWindows();
    await waitFor(() => expect(screen.getByTestId("floating-window-dragged").style.width).toBe(`${draggedOpeningWidth()}px`));
    armLeftZone(5);
    expect(screen.getByTestId("floating-window-snap-preview-dragged")).toBeInTheDocument();

    view.rerender(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <div data-testid="board-surface" style={{ position: "relative", zIndex: 20 }}>board</div>
        <FloatingWindow windowKey="dragged" title="Dragged" onClose={() => {}} hidden defaultSize={{ width: 600, height: 400 }} minSize={{ width: 320, height: 200 }}>
          dragged body
        </FloatingWindow>
      </DashboardWindowManagerProvider>,
    );

    expect(document.querySelector(".floating-window__snap-preview")).toBeNull();
  });
});
