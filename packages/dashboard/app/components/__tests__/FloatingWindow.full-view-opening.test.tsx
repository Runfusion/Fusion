import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardWindowManagerProvider, useDashboardWindowLandmark } from "../../context/DashboardWindowManagerContext";
import { listComponentFiles, readAppFile } from "../../test/cssFixture";
import { FloatingWindow } from "../FloatingWindow";
import {
  FLOATING_WINDOW_OPENING_ASPECT_RATIO,
  FLOATING_WINDOW_STANDARD_HEIGHT_RATIO,
  clampFloatingWindowSize,
  resolveStandardSize,
} from "../floatingWindowGeometry";
import {
  OPENING_HARNESS_FOOTER_HEIGHT,
  OPENING_HARNESS_HEADER_HEIGHT,
  harnessWorkArea,
} from "./floatingWindowOpeningFixture";

/*
FNXC:FloatingWindowGeometry 2026-09-16-05:45:
FN-456 exemption contract, requested verbatim by the operator: "ça ne doit pas impacter les vues intégrales..
par exemple le gitmanager qui s'ouvre depuis le menu more du footer". An integral view deliberately fills the
work area, so normalizing it to the 1.43 ratio would shrink and crop it.

This suite proves the exemption three ways, because each alone is insufficient:
- EXACT PARITY: the `full-view` policy reproduces the pre-FN-456 formula bit for bit;
- HOST CENSUS: the exempted set is frozen to the two integral views, so neither an accidental addition on an
  ordinary dialog nor an accidental removal on an integral view can pass unnoticed;
- RENDERED RECTANGLE: a real mounted window carrying Git Manager's exact window props opens full width.
*/

/** The two integral views, and only those, may declare the exemption. */
const FULL_VIEW_HOSTS = ["GitManagerModal.tsx", "PlanningModeModal.tsx"] as const;

/** Git Manager's declared opening size at a 1440x900 viewport (see GitManagerModal.tsx). */
function gitManagerDefaultSize() {
  return { width: Math.min(window.innerWidth * 0.95, 1400), height: window.innerHeight * 0.92 };
}
const GIT_MANAGER_MIN_SIZE = { width: 360, height: 280 };

/** Planning mode's declared opening size (see PlanningModeModal.tsx). */
function planningModeDefaultSize() {
  return { width: Math.min(window.innerWidth * 0.95, 1200), height: window.innerHeight * 0.85 };
}
const PLANNING_MODE_MIN_SIZE = { width: 360, height: 480 };

/** The opening formula exactly as it existed BEFORE FN-456: height-only cap, width untouched, then clamp. */
function preFn456OpeningSize(
  requested: { width: number; height: number },
  minSize: { width: number; height: number },
  bounds: ReturnType<typeof harnessWorkArea>,
) {
  const proportional = Number.isFinite(bounds.height) && bounds.height > 0
    ? Math.min(requested.height, Math.round(bounds.height * FLOATING_WINDOW_STANDARD_HEIGHT_RATIO))
    : requested.height;
  return clampFloatingWindowSize({ width: requested.width, height: proportional }, minSize, bounds);
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

describe("FN-456 full-view exemption: exact parity with the pre-FN-456 opening", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
  });

  it.each([
    ["Git Manager", gitManagerDefaultSize, GIT_MANAGER_MIN_SIZE],
    ["Planning mode", planningModeDefaultSize, PLANNING_MODE_MIN_SIZE],
  ])("keeps %s opening geometry identical to before FN-456", (_name, sizeOf, minSize) => {
    const bounds = harnessWorkArea();
    const requested = sizeOf();
    const resolved = resolveStandardSize(requested, minSize, bounds, "full-view");

    expect(resolved).toEqual(preFn456OpeningSize(requested, minSize, bounds));
    // Width is deliberately untouched by the height cap for an integral view (the FN-418 contract, retained).
    expect(resolved.width).toBe(requested.width);
    // And it is emphatically NOT the shrunken 1.43 box the aspect-ratio policy would produce.
    const normalized = resolveStandardSize(requested, minSize, bounds, "aspect-ratio");
    expect(normalized.width).toBeLessThan(resolved.width);
    expect(Math.abs(normalized.width / normalized.height - FLOATING_WINDOW_OPENING_ASPECT_RATIO)).toBeLessThan(0.01);
  });

  it("keeps parity on a short laptop work area too", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 768 });
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
    const bounds = harnessWorkArea();
    const requested = gitManagerDefaultSize();
    expect(resolveStandardSize(requested, GIT_MANAGER_MIN_SIZE, bounds, "full-view")).toEqual(
      preFn456OpeningSize(requested, GIT_MANAGER_MIN_SIZE, bounds),
    );
  });
});

describe("FN-456 full-view exemption: host census", () => {
  it("freezes the exempted set to the two integral views", () => {
    const declaringHosts = listComponentFiles()
      .filter((relativePath) => !relativePath.includes("__tests__/"))
      .filter((relativePath) => readAppFile(`components/${relativePath}`).includes('openingSizePolicy="full-view"'));

    expect(declaringHosts).toEqual([...FULL_VIEW_HOSTS]);
  });

  it("keeps each integral view's viewport-proportional opening size next to its exemption", () => {
    for (const relativePath of FULL_VIEW_HOSTS) {
      const source = readAppFile(`components/${relativePath}`);
      expect(source, relativePath).toMatch(/window\.innerHeight \* 0\.\d+/);
      expect(source, relativePath).toContain('openingSizePolicy="full-view"');
    }
  });
});

describe("FN-456 full-view exemption: rendered rectangle", () => {
  /*
  A test host is mounted with Git Manager's EXACT window props instead of the full `GitManagerModal`, whose
  mount pulls the entire git API surface, repository state, and dock context — none of which participates in
  the geometry under test. The host census above is what ties these literals back to the real component.
  */
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const name = this.dataset.landmark;
      if (name === "header") {
        return domRect({ left: 0, top: 0, right: window.innerWidth, bottom: OPENING_HARNESS_HEADER_HEIGHT, width: window.innerWidth, height: OPENING_HARNESS_HEADER_HEIGHT });
      }
      if (name === "footer") {
        return domRect({ left: 0, top: window.innerHeight - OPENING_HARNESS_FOOTER_HEIGHT, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: OPENING_HARNESS_FOOTER_HEIGHT });
      }
      return domRect({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens an integral view at its full declared width, not at the 1.43 box", async () => {
    const requested = gitManagerDefaultSize();
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow
          windowKey="git-manager"
          title="Git Manager"
          onClose={() => {}}
          defaultSize={requested}
          minSize={GIT_MANAGER_MIN_SIZE}
          openingSizePolicy="full-view"
        >
          git
        </FloatingWindow>
      </DashboardWindowManagerProvider>,
    );

    const panel = screen.getByTestId("floating-window-git-manager");
    const expected = preFn456OpeningSize(requested, GIT_MANAGER_MIN_SIZE, harnessWorkArea());
    await waitFor(() => expect(Number.parseFloat(panel.style.width)).toBe(expected.width));
    expect(Number.parseFloat(panel.style.height)).toBe(expected.height);
    expect(Number.parseFloat(panel.style.width) / Number.parseFloat(panel.style.height))
      .toBeGreaterThan(FLOATING_WINDOW_OPENING_ASPECT_RATIO + 0.01);
  });

  it("still normalizes an ordinary dialog rendered in the same harness", async () => {
    render(
      <DashboardWindowManagerProvider>
        <Landmarks />
        <FloatingWindow windowKey="ordinary" title="Ordinary" onClose={() => {}} defaultSize={{ width: 1100, height: 720 }}>
          dialog
        </FloatingWindow>
      </DashboardWindowManagerProvider>,
    );
    const panel = screen.getByTestId("floating-window-ordinary");
    await waitFor(() => expect(Number.parseFloat(panel.style.width)).toBeGreaterThan(0));
    const ratio = Number.parseFloat(panel.style.width) / Number.parseFloat(panel.style.height);
    expect(Math.abs(ratio - FLOATING_WINDOW_OPENING_ASPECT_RATIO)).toBeLessThan(0.01);
  });
});
