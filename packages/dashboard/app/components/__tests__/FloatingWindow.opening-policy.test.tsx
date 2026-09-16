import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWindowManagerProvider, useDashboardWindowLandmark } from "../../context/DashboardWindowManagerContext";
import {
  FLOATING_WINDOW_CASCADE_STEP_PX,
  FloatingWindow,
} from "../FloatingWindow";
import {
  FLOATING_WINDOW_OPENING_ASPECT_RATIO,
  FLOATING_WINDOW_OPENING_SIZE_SCALE,
  FLOATING_WINDOW_STANDARD_HEIGHT_RATIO,
} from "../floatingWindowGeometry";
import {
  FLOATING_WINDOW_DEFAULT_MIN_SIZE,
  expectedOpeningSize,
  harnessWorkAreaHeight,
} from "./floatingWindowOpeningFixture";

/*
FNXC:FloatingWindowGeometry 2026-09-14-21:10:
FN-394 opening policy, asserted on the RENDERED rectangle of real windows rather than on helper return
values: every window opens at its OWN standard size, centred in the live work area, uninfluenced by
storage, by another window's placement, or by an occupied snap zone. The one exception is the shared
cohort of still-pristine floating windows, which step by 28px and NEVER shrink to make room.

FNXC:FloatingWindowGeometry 2026-09-15-13:41:
FN-418 adds the proportional OPENING cap to that same policy: a window must never open filling the whole band
between header and footer, even when its host asks for more pixels than that band holds. Expected heights are
derived from the shared opening fixture so a future ratio change cannot leave this suite asserting a stale
literal.

FNXC:FloatingWindowGeometry 2026-09-16-05:45:
FN-456 normalizes the OPENING shape to 1.43, so a host's declared `defaultSize` is no longer the rectangle it
opens at. Every expectation here is now derived from the production seam through `expectedOpeningSize()`, the
single shared test helper, which is the "en DRY" part of the request applied to the suites.

FNXC:FloatingWindowGeometry 2026-09-16-07:38:
FN-460 enlarges that opening box by 20% on both axes. Every remaining opening literal in this suite was a
pre-FN-460 value, so they are replaced by `openingSize()` reads of the production seam; the laptop symptom
case below additionally pins the 20% relationship itself on a REALLY MOUNTED window.
*/

const HEADER_HEIGHT = 64;
const FOOTER_HEIGHT = 36;

/** Live work-area height in this harness: the band between the measured header and footer landmarks. */
function workAreaHeight(): number {
  return harnessWorkAreaHeight(HEADER_HEIGHT, FOOTER_HEIGHT);
}

/** FloatingWindow's default minimum height: it still wins over the FN-418 cap on a short work area. */
const DEFAULT_MIN_HEIGHT = FLOATING_WINDOW_DEFAULT_MIN_SIZE.height;

/** Rectangle a host asking for `requested` actually opens at, computed by the production seam. */
function openingSize(requested: { width: number; height: number }) {
  return expectedOpeningSize(requested);
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

function rectOf(panel: HTMLElement) {
  return {
    left: Number.parseFloat(panel.style.left),
    top: Number.parseFloat(panel.style.top),
    width: Number.parseFloat(panel.style.width),
    height: Number.parseFloat(panel.style.height),
  };
}

/** Asserts the panel opened centred at the size the seam resolves for `requested`. */
function expectCentered(panel: HTMLElement, requested: { width: number; height: number }) {
  const size = openingSize(requested);
  const rect = rectOf(panel);
  expect(rect.width).toBe(size.width);
  expect(rect.height).toBe(size.height);
  expect(rect.left).toBe((window.innerWidth - size.width) / 2);
  expect(rect.top).toBe(HEADER_HEIGHT + (window.innerHeight - HEADER_HEIGHT - FOOTER_HEIGHT - size.height) / 2);
}

function prepareCapture(target: HTMLElement) {
  Object.defineProperty(target, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(target, "releasePointerCapture", { configurable: true, value: vi.fn() });
}

function dragBy(handle: HTMLElement, dx: number, dy: number, pointerId = 1) {
  prepareCapture(handle);
  fireEvent.pointerDown(handle, { pointerId, clientX: 400, clientY: 300, button: 0 });
  fireEvent.pointerMove(handle, { pointerId, clientX: 400 + dx, clientY: 300 + dy });
  fireEvent.pointerUp(handle, { pointerId, clientX: 400 + dx, clientY: 300 + dy });
}

describe("FloatingWindow opening policy", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const name = this.dataset.landmark;
      if (name === "header") return domRect({ left: 0, top: 0, right: window.innerWidth, bottom: HEADER_HEIGHT, width: window.innerWidth, height: HEADER_HEIGHT });
      if (name === "footer") {
        return domRect({ left: 0, top: window.innerHeight - FOOTER_HEIGHT, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: FOOTER_HEIGHT });
      }
      return domRect({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens the first window centered at its own standard size", async () => {
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="alpha" title="Alpha" onClose={() => {}} defaultSize={{ width: 600, height: 400 }}>body</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const panel = screen.getByTestId("floating-window-alpha");
    await waitFor(() => expect(Number.parseFloat(panel.style.width)).toBe(openingSize({ width: 600, height: 400 }).width));
    expectCentered(panel, { width: 600, height: 400 });
  });

  it("offsets a second pristine window of another type by one shared cascade step, keeping each own size", async () => {
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="alpha" title="Alpha" onClose={() => {}} defaultSize={{ width: 600, height: 400 }}>a</FloatingWindow>
        <FloatingWindow windowKey="beta" title="Beta" onClose={() => {}} defaultSize={{ width: 820, height: 520 }}>b</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const alpha = screen.getByTestId("floating-window-alpha");
    const beta = screen.getByTestId("floating-window-beta");
    const betaSize = openingSize({ width: 820, height: 520 });
    await waitFor(() => expect(Number.parseFloat(beta.style.width)).toBe(betaSize.width));

    expectCentered(alpha, { width: 600, height: 400 });
    // Beta keeps its own standard size — the cascade only displaces it.
    const betaRect = rectOf(beta);
    expect(betaRect.width).toBe(betaSize.width);
    expect(betaRect.height).toBe(betaSize.height);
    expect(betaRect.left).toBe((window.innerWidth - betaSize.width) / 2 + FLOATING_WINDOW_CASCADE_STEP_PX);
    expect(betaRect.top).toBe(HEADER_HEIGHT + (workAreaHeight() - betaSize.height) / 2 + FLOATING_WINDOW_CASCADE_STEP_PX);
  });

  it("ignores prefilled, invalid, and failing storage and never writes geometry", async () => {
    localStorage.setItem("floating-window:alpha", JSON.stringify({ size: { width: 250, height: 180 }, position: { x: 4, y: 900 } }));
    localStorage.setItem("kb-dashboard-chat-floating-window", "not-json");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="alpha" title="Alpha" onClose={() => {}} defaultSize={{ width: 600, height: 400 }} persistGeometryKey="floating-window:alpha">body</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const panel = screen.getByTestId("floating-window-alpha");
    const alphaSize = openingSize({ width: 600, height: 400 });
    await waitFor(() => expect(Number.parseFloat(panel.style.width)).toBe(alphaSize.width));
    expectCentered(panel, { width: 600, height: 400 });

    dragBy(screen.getByTestId("floating-window-drag-handle-alpha"), 120, 90);
    expect(rectOf(panel).left).not.toBe((window.innerWidth - alphaSize.width) / 2);
    expect(setItem).not.toHaveBeenCalledWith("floating-window:alpha", expect.any(String));
    // Historical values stay untouched in storage; no global purge.
    expect(localStorage.getItem("floating-window:alpha")).toContain("250");
  });

  it("centers a newly opened window once every earlier window has really been moved", async () => {
    const { rerender } = render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="alpha" title="Alpha" onClose={() => {}} defaultSize={{ width: 600, height: 400 }}>a</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const alpha = screen.getByTestId("floating-window-alpha");
    await waitFor(() => expect(Number.parseFloat(alpha.style.width)).toBe(openingSize({ width: 600, height: 400 }).width));
    dragBy(screen.getByTestId("floating-window-drag-handle-alpha"), 150, 100);

    rerender(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="alpha" title="Alpha" onClose={() => {}} defaultSize={{ width: 600, height: 400 }}>a</FloatingWindow>
        <FloatingWindow windowKey="beta" title="Beta" onClose={() => {}} defaultSize={{ width: 600, height: 400 }}>b</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const beta = screen.getByTestId("floating-window-beta");
    await waitFor(() => expect(Number.parseFloat(beta.style.width)).toBe(openingSize({ width: 600, height: 400 }).width));
    // Alpha left the pristine cohort when it was dragged, freeing slot 0 for Beta.
    expectCentered(beta, { width: 600, height: 400 });
  });

  it("returns to the standard size and center after a real close and reopen", async () => {
    const { rerender } = render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="alpha" title="Alpha" onClose={() => {}} defaultSize={{ width: 600, height: 400 }}>a</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    await waitFor(() =>
      expect(Number.parseFloat(screen.getByTestId("floating-window-alpha").style.width)).toBe(
        openingSize({ width: 600, height: 400 }).width,
      ),
    );
    dragBy(screen.getByTestId("floating-window-drag-handle-alpha"), 200, 140);

    rerender(<DashboardWindowManagerProvider><Landmarks /></DashboardWindowManagerProvider>);
    expect(screen.queryByTestId("floating-window-alpha")).not.toBeInTheDocument();

    rerender(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="alpha" title="Alpha" onClose={() => {}} defaultSize={{ width: 600, height: 400 }}>a</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const reopened = screen.getByTestId("floating-window-alpha");
    await waitFor(() => expect(Number.parseFloat(reopened.style.width)).toBe(openingSize({ width: 600, height: 400 }).width));
    expectCentered(reopened, { width: 600, height: 400 });
  });

  it("clamps the cascade instead of shrinking a window when the work area is tight", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 640 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 420 });
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="alpha" title="Alpha" onClose={() => {}} defaultSize={{ width: 640, height: 320 }}>a</FloatingWindow>
        <FloatingWindow windowKey="beta" title="Beta" onClose={() => {}} defaultSize={{ width: 640, height: 320 }}>b</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const alpha = screen.getByTestId("floating-window-alpha");
    const beta = screen.getByTestId("floating-window-beta");
    const tight = openingSize({ width: 640, height: 320 });
    await waitFor(() => expect(Number.parseFloat(beta.style.width)).toBe(tight.width));
    // Overlap is preferred over any size reduction: beta opens at exactly the same standard height as alpha.
    // On this very short work area the default minimum height dominates the proportional cap and the ratio.
    expect(tight.height).toBe(DEFAULT_MIN_HEIGHT);
    expect(rectOf(beta).height).toBe(tight.height);
    expect(rectOf(beta).height).toBe(rectOf(alpha).height);
  });

  /*
  FNXC:FloatingWindowGeometry 2026-09-15-13:41:
  FN-418 symptom assertion: on a realistic laptop work area (1024x768 viewport, 64px header, 36px footer =>
  668px), a host asking for 720px used to open at 668px — 100% of the band between header and footer, which is
  exactly what the operator reported. The opening height must now land inside the cap while the window stays
  centred, and a host already below the cap must be left alone.

  FNXC:FloatingWindowGeometry 2026-09-16-07:38:
  FN-460 symptom assertion, on the SAME laptop work area, because that is the surface the "too small" report
  came from: the window this harness used to open at 414px of height must now open 20% taller (~497px) at the
  unchanged 1.43 shape, and still strictly below the work area. The three facts are asserted together — a
  bigger window that broke the shape, or one that filled the band, would not be the requested change.
  */
  it("opens a tall window 20% larger than before, at about three quarters of the work area", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 768 });
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="tall" title="Tall" onClose={() => {}} defaultSize={{ width: 720, height: 720 }}>settings</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const panel = screen.getByTestId("floating-window-tall");
    const tall = openingSize({ width: 720, height: 720 });
    await waitFor(() => expect(Number.parseFloat(panel.style.width)).toBe(tall.width));

    expect(workAreaHeight()).toBe(668);
    const rect = rectOf(panel);
    // The pre-FN-460 opening height on this exact harness, recomputed from the seam constants (414px).
    const preScaleHeight = Math.round(workAreaHeight() * FLOATING_WINDOW_STANDARD_HEIGHT_RATIO);
    expect(rect.height).toBe(tall.height);
    expect(Math.abs(rect.height - preScaleHeight * FLOATING_WINDOW_OPENING_SIZE_SCALE)).toBeLessThanOrEqual(1);
    expect(rect.height).toBeGreaterThan(preScaleHeight);
    expect(rect.height).toBeLessThan(workAreaHeight());
    const ratio = rect.height / workAreaHeight();
    expect(ratio).toBeGreaterThanOrEqual(0.72);
    expect(ratio).toBeLessThanOrEqual(0.76);
    // FN-456: and the window it opens is the shared 1.43 landscape shape.
    expect(Math.abs(rect.width / rect.height - FLOATING_WINDOW_OPENING_ASPECT_RATIO)).toBeLessThan(0.01);
    expectCentered(panel, { width: 720, height: 720 });
  });

  it("leaves a window that already fits below the cap at its own size", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 768 });
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="short" title="Short" onClose={() => {}} defaultSize={{ width: 520, height: 400 }}>dialog</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const panel = screen.getByTestId("floating-window-short");
    await waitFor(() => expect(Number.parseFloat(panel.style.width)).toBe(openingSize({ width: 520, height: 400 }).width));
    expectCentered(panel, { width: 520, height: 400 });
  });

  /*
  FNXC:FloatingWindowGeometry 2026-09-16-05:45:
  FN-456 rendered-rectangle proof: the ratio must hold on a REAL mounted window, not only on the pure seam,
  because a host could otherwise bypass `resolveOpeningRect`. The mobile sheet case is the paired negative
  control: a full-screen sheet exposes no window geometry at all and must never be shaped by the ratio.
  */
  it("opens real mounted windows of different host shapes at the shared 1.43 ratio", async () => {
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="confirm" title="Confirm" onClose={() => {}} defaultSize={{ width: 520, height: 320 }}>a</FloatingWindow>
        <FloatingWindow windowKey="settings" title="Settings" onClose={() => {}} defaultSize={{ width: 1100, height: 720 }}>b</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    for (const key of ["confirm", "settings"]) {
      const panel = screen.getByTestId(`floating-window-${key}`);
      await waitFor(() => expect(Number.parseFloat(panel.style.width)).toBeGreaterThan(0));
      const rect = rectOf(panel);
      expect(Math.abs(rect.width / rect.height - FLOATING_WINDOW_OPENING_ASPECT_RATIO), key).toBeLessThan(0.01);
    }
  });

  it("leaves a mobile full-screen sheet free of the interactive geometry the ratio governs", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 420 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 760 });
    // jsdom never evaluates media queries, so the CSS sheet breakpoint has to be reported explicitly.
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: /max-width:\s*76[78](?:\.98)?px/.test(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="sheet" title="Sheet" onClose={() => {}} defaultSize={{ width: 1100, height: 720 }} suspendGeometryPersistenceOnMobile>
          sheet
        </FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const panel = screen.getByTestId("floating-window-sheet");
    await waitFor(() => expect(panel).toBeInTheDocument());
    /*
    A sheet presentation exposes NO window geometry: its full-screen size comes from the CSS sheet breakpoint,
    which jsdom does not apply, so the retained inline rect is irrelevant to what the operator sees. What the
    ratio could actually constrain — resizing and dragging — is absent, and that absence is the contract.
    */
    expect(panel.querySelector(".floating-window__resize-handle")).toBeNull();
    expect(screen.queryByTestId("floating-window-resize-se")).not.toBeInTheDocument();
    const before = rectOf(panel);
    dragBy(screen.getByTestId("floating-window-drag-handle-sheet"), 120, 90);
    expect(rectOf(panel)).toEqual(before);
  });

  it("does not mark a window as user-adjusted when the shell resizes it", async () => {
    const { rerender } = render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="alpha" title="Alpha" onClose={() => {}} defaultSize={{ width: 600, height: 400 }}>a</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    await waitFor(() =>
      expect(Number.parseFloat(screen.getByTestId("floating-window-alpha").style.width)).toBe(
        openingSize({ width: 600, height: 400 }).width,
      ),
    );

    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1000 });
    fireEvent(window, new Event("resize"));

    rerender(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="alpha" title="Alpha" onClose={() => {}} defaultSize={{ width: 600, height: 400 }}>a</FloatingWindow>
        <FloatingWindow windowKey="beta" title="Beta" onClose={() => {}} defaultSize={{ width: 600, height: 400 }}>b</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const beta = screen.getByTestId("floating-window-beta");
    const betaWidth = openingSize({ width: 600, height: 400 }).width;
    await waitFor(() => expect(Number.parseFloat(beta.style.width)).toBe(betaWidth));
    // Alpha is still pristine, so Beta must take the cascaded slot rather than the centre.
    expect(rectOf(beta).left).toBe((window.innerWidth - betaWidth) / 2 + FLOATING_WINDOW_CASCADE_STEP_PX);
  });

  it("gives two windows sharing one logical id two distinct slots", async () => {
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="same" title="One" onClose={() => {}} defaultSize={{ width: 600, height: 400 }}>a</FloatingWindow>
        <FloatingWindow windowKey="same" title="Two" onClose={() => {}} defaultSize={{ width: 600, height: 400 }}>b</FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const panels = screen.getAllByTestId("floating-window-same");
    await waitFor(() => expect(Number.parseFloat(panels[1].style.left)).not.toBe(Number.parseFloat(panels[0].style.left)));
    expect(Number.parseFloat(panels[1].style.left) - Number.parseFloat(panels[0].style.left)).toBe(FLOATING_WINDOW_CASCADE_STEP_PX);
  });
});
