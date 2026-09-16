import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMobileBarKeyboardState } from "../App";
import { createMobileNavGeometryStyle, MobileNavBar } from "../components/MobileNavBar";
import { _resetInitialViewportHeight } from "../hooks/useMobileKeyboard";
import { GEOMETRY_TOKEN_VALUES, installGeometryTokenValues, resolveMobileNavAnchorPx } from "../test/mobileNavGeometry";

const initialDescriptors = {
  clientHeight: Object.getOwnPropertyDescriptor(document.documentElement, "clientHeight"),
  innerHeight: Object.getOwnPropertyDescriptor(window, "innerHeight"),
  innerWidth: Object.getOwnPropertyDescriptor(window, "innerWidth"),
  matchMedia: Object.getOwnPropertyDescriptor(window, "matchMedia"),
  maxTouchPoints: Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints"),
  screen: Object.getOwnPropertyDescriptor(window, "screen"),
  visualViewport: Object.getOwnPropertyDescriptor(window, "visualViewport"),
};

function installViewport(width: number, height: number) {
  const target = new EventTarget();
  const viewport = {
    width,
    height,
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return viewport;
}

function setLayoutViewportHeight(height: number) {
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: height });
}

function installResponsiveMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => {
      const matches = query === "(max-width: 768px), (max-height: 480px)"
        ? window.innerWidth <= 768 || window.innerHeight <= 480
        : query === "(max-width: 768px)"
          ? window.innerWidth <= 768
          : query === "(max-width: 600px)"
            ? window.innerWidth <= 600
            : query === "(max-height: 480px)"
              ? window.innerHeight <= 480
              : query === "(min-width: 769px) and (max-width: 1023.98px)"
                ? window.innerWidth >= 769 && window.innerWidth <= 1024
                : false;
      return {
        matches,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      };
    }),
  });
}

function restoreDescriptor(target: object, property: string, descriptor?: PropertyDescriptor) {
  if (descriptor) Object.defineProperty(target, property, descriptor);
  else delete (target as Record<string, unknown>)[property];
}

function readRenderedLength(element: HTMLElement, property: string): number {
  const value = element.style.getPropertyValue(property);
  if (!/^-?\d+(?:\.\d+)?px$/.test(value)) {
    throw new Error(`Expected a concrete ${property} on ${element.className}, received ${JSON.stringify(value)}.`);
  }
  return Number.parseFloat(value);
}

/*
FNXC:MobilePillPopover 2026-09-13-10:03:
The browser-independent matrix resolves each sibling from the geometry declarations rendered by the production component. It never supplies pill or popover rectangles.

FNXC:MobilePillKeyboard 2026-09-16-16:27:
FN-463: the resolved bottom anchors come from the shared numeric resolver, because the published `calc()` strings are constants and cannot express whether the pill actually moved. The keyboard-open scenarios below therefore compare pill.bottom / pill.top / popover.bottom NUMBERS across rest, keyboard-open, and restored samples.
*/
function resolveRenderedOverlayGeometry({
  nav,
  popover,
  layoutViewportHeight,
  viewportHeight,
  viewportOffsetTop,
}: {
  nav: HTMLElement;
  popover: HTMLElement;
  layoutViewportHeight: number;
  viewportHeight: number;
  viewportOffsetTop: number;
}) {
  const navViewportTop = readRenderedLength(nav, "--mobile-nav-viewport-offset-top");
  const popoverViewportTop = readRenderedLength(popover, "--mobile-nav-viewport-offset-top");
  const expectedStyle = createMobileNavGeometryStyle(navViewportTop);
  for (const property of [
    "--mobile-nav-floating-gap",
    "--mobile-nav-viewport-offset-top",
    "--mobile-nav-pill-bottom",
    "--mobile-nav-popover-bottom",
  ] as const) {
    expect(nav.style.getPropertyValue(property)).toBe(expectedStyle[property]);
    expect(popover.style.getPropertyValue(property)).toBe(expectedStyle[property]);
  }
  expect(navViewportTop).toBe(viewportOffsetTop);
  expect(popoverViewportTop).toBe(navViewportTop);

  const systemOffset = GEOMETRY_TOKEN_VALUES["--mobile-nav-system-offset"];
  const floatingGap = GEOMETRY_TOKEN_VALUES["--space-sm"];
  const pillHeight = GEOMETRY_TOKEN_VALUES["--mobile-nav-pill-height"];
  const popoverGap = GEOMETRY_TOKEN_VALUES["--space-xs"];
  const safeTop = popoverViewportTop + GEOMETRY_TOKEN_VALUES["--space-md"];
  const pillBottom = layoutViewportHeight - systemOffset - floatingGap;
  const pillTop = pillBottom - pillHeight;
  const popoverBottom = layoutViewportHeight
    - systemOffset
    - floatingGap
    - pillHeight
    - popoverGap;
  const popoverMaxHeight = Math.max(0, popoverBottom - safeTop);
  const itemCount = popover.querySelectorAll("button").length;
  const minimumContentHeight = itemCount * 36;
  const renderedPopoverHeight = Math.min(minimumContentHeight, popoverMaxHeight);
  const popoverTop = popoverBottom - renderedPopoverHeight;
  const terminalScrollTop = Math.max(0, minimumContentHeight - renderedPopoverHeight);
  const terminalItemBottom = popoverTop + minimumContentHeight - terminalScrollTop;
  const visualBottom = viewportOffsetTop + viewportHeight;

  return {
    itemCount,
    pill: { top: pillTop, bottom: pillBottom },
    popover: { top: popoverTop, bottom: popoverBottom, maxHeight: popoverMaxHeight },
    terminalItemBottom,
    terminalScrollTop,
    visualBottom,
  };
}

/*
FNXC:MobilePillKeyboard 2026-09-16-16:27:
FN-463: the overlay keeps its exclusive stacking (popover strictly above the pill, one --space-xs apart, fully
scrollable) in every viewport sample. Whether it MOVED between samples is proven separately by comparing the
returned numbers across rest, keyboard-open, and restored states.
*/
function expectStackedOverlayGeometry({
  nav,
  popover,
  layoutViewportHeight,
  viewportHeight,
  viewportOffsetTop,
}: {
  nav: HTMLElement;
  popover: HTMLElement;
  layoutViewportHeight: number;
  viewportHeight: number;
  viewportOffsetTop: number;
}) {
  const geometry = resolveRenderedOverlayGeometry({
    nav,
    popover,
    layoutViewportHeight,
    viewportHeight,
    viewportOffsetTop,
  });

  expect(geometry.popover.bottom).toBeLessThan(geometry.pill.top);
  expect(geometry.pill.top - geometry.popover.bottom).toBe(GEOMETRY_TOKEN_VALUES["--space-xs"]);
  expect(geometry.popover.maxHeight).toBeGreaterThan(0);
  expect(geometry.itemCount).toBeGreaterThan(0);
  expect(geometry.terminalScrollTop).toBeGreaterThanOrEqual(0);
  expect(geometry.terminalItemBottom).toBeLessThanOrEqual(geometry.popover.bottom);
  return geometry;
}

/** Resolved bottom anchors of the pill, read straight from the production declarations. */
function readNavAnchors(nav: HTMLElement) {
  return {
    pillBottomPx: resolveMobileNavAnchorPx(nav, "--mobile-nav-pill-bottom"),
    popoverBottomPx: resolveMobileNavAnchorPx(nav, "--mobile-nav-popover-bottom"),
  };
}

function MobileNavKeyboardHarness({ isMobile }: { isMobile: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const state = useMobileBarKeyboardState({ isMobile, anyModalOpen: false, overlayOpen: false });
  return <>
    <output data-testid="keyboard-open">{String(state.keyboardOpen)}</output>
    <output data-testid="footer-hidden">{String(state.footerHidden)}</output>
    <MobileNavBar
      view="board"
      onChangeView={vi.fn()}
      footerVisible={!state.footerHidden}
      keyboardOpen={state.navKeyboardOpen}
      keyboardMetrics={state}
      navigationMenuOpen={menuOpen}
      onUiMenuOpenChange={setMenuOpen}
    />
  </>;
}

const keyboardScenarios = [
  { label: "portrait iOS décalé focus puis resize", width: 390, layoutHeight: 844, visualHeight: 504, viewportOffsetTop: 40, platform: "ios", order: "focus-first" },
  { label: "portrait iOS décalé resize puis focus", width: 390, layoutHeight: 844, visualHeight: 504, viewportOffsetTop: 40, platform: "ios", order: "resize-first" },
  { label: "portrait Android focus puis resize", width: 390, layoutHeight: 844, visualHeight: 544, viewportOffsetTop: 0, platform: "android", order: "focus-first" },
  { label: "portrait Android resize puis focus", width: 390, layoutHeight: 844, visualHeight: 544, viewportOffsetTop: 0, platform: "android", order: "resize-first" },
  { label: "paysage iOS focus puis resize", width: 932, layoutHeight: 430, visualHeight: 220, viewportOffsetTop: 0, platform: "ios", order: "focus-first" },
  { label: "paysage iOS resize puis focus", width: 932, layoutHeight: 430, visualHeight: 220, viewportOffsetTop: 0, platform: "ios", order: "resize-first" },
  { label: "paysage Android focus puis resize", width: 932, layoutHeight: 430, visualHeight: 220, viewportOffsetTop: 0, platform: "android", order: "focus-first" },
  { label: "paysage Android resize puis focus", width: 932, layoutHeight: 430, visualHeight: 220, viewportOffsetTop: 0, platform: "android", order: "resize-first" },
] as const;

describe("App mobile keyboard and production pill seam", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetInitialViewportHeight();
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 1 });
    installResponsiveMedia();
    installGeometryTokenValues();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    delete document.documentElement.dataset.viewportMode;
    document.documentElement.style.removeProperty("--mobile-nav-height");
    for (const property of Object.keys(GEOMETRY_TOKEN_VALUES)) {
      document.documentElement.style.removeProperty(property);
    }
    restoreDescriptor(document.documentElement, "clientHeight", initialDescriptors.clientHeight);
    restoreDescriptor(window, "innerHeight", initialDescriptors.innerHeight);
    restoreDescriptor(window, "innerWidth", initialDescriptors.innerWidth);
    restoreDescriptor(window, "matchMedia", initialDescriptors.matchMedia);
    restoreDescriptor(navigator, "maxTouchPoints", initialDescriptors.maxTouchPoints);
    restoreDescriptor(window, "screen", initialDescriptors.screen);
    restoreDescriptor(window, "visualViewport", initialDescriptors.visualViewport);
  });

  it.each(keyboardScenarios)("garde la pill et son popover immobiles pendant tout le cycle clavier — $label", ({
    width,
    layoutHeight,
    visualHeight,
    viewportOffsetTop,
    platform,
    order,
  }) => {
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: width },
      innerHeight: { configurable: true, value: layoutHeight },
      screen: { configurable: true, value: { width, height: layoutHeight } },
    });
    setLayoutViewportHeight(layoutHeight);
    const viewport = installViewport(width, layoutHeight);
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    const { container } = render(<MobileNavKeyboardHarness isMobile />);
    const nav = container.querySelector<HTMLElement>(".mobile-nav-bar");
    expect(nav).not.toBeNull();
    expect(nav).not.toHaveClass("mobile-nav-bar--keyboard-open");
    const trigger = screen.getByTestId("mobile-menu-trigger");
    expect(trigger).toBeEnabled();
    const restingAnchors = readNavAnchors(nav!);

    const shrinkViewport = () => {
      viewport.height = visualHeight;
      viewport.offsetTop = viewportOffsetTop;
      if (platform === "android") setLayoutViewportHeight(visualHeight);
      viewport.dispatchEvent(new Event("resize"));
    };

    if (order === "focus-first") {
      act(() => textarea.focus());
      expect(nav).toHaveClass("mobile-nav-bar--keyboard-open");
      expect(readNavAnchors(nav!)).toEqual(restingAnchors);
      expect(screen.getByTestId("footer-hidden")).toHaveTextContent("false");
      act(shrinkViewport);
    } else {
      act(shrinkViewport);
      expect(nav).not.toHaveClass("mobile-nav-bar--keyboard-open");
      act(() => textarea.focus());
    }

    act(() => vi.advanceTimersByTime(1_600));
    expect(screen.getByTestId("keyboard-open")).toHaveTextContent("true");
    expect(screen.getByTestId("footer-hidden")).toHaveTextContent("true");
    expect(nav).toHaveClass("mobile-nav-bar--keyboard-open");
    expect(readNavAnchors(nav!)).toEqual(restingAnchors);

    // Opening the production hamburger focuses its first menu item. The input
    // interaction ends immediately, but the viewport remains keyboard-sized
    // until the platform's dismissal animation supplies a restored sample.
    fireEvent.click(trigger);
    const popover = screen.getByRole("menu", { name: "Navigate" });
    expect(textarea).not.toHaveFocus();
    expect(screen.getByTestId("keyboard-open")).toHaveTextContent("false");
    expect(screen.getByTestId("footer-hidden")).toHaveTextContent("false");
    expect(nav).toHaveClass("mobile-nav-bar--keyboard-open");
    expect(readNavAnchors(nav!)).toEqual(restingAnchors);
    expect(readNavAnchors(popover)).toEqual(restingAnchors);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    /*
    FNXC:MobileNav 2026-09-14-07:48:
    Opening the popover freezes the published geometry, so --mobile-nav-viewport-offset-top keeps the sample captured
    at open time for the whole gesture, including after the keyboard is dismissed.
    */
    const frozenViewportTop = readRenderedLength(nav!, "--mobile-nav-viewport-offset-top");
    const keyboardOpenGeometry = expectStackedOverlayGeometry({
      nav: nav!,
      popover,
      layoutViewportHeight: layoutHeight,
      viewportHeight: visualHeight,
      viewportOffsetTop: frozenViewportTop,
    });

    act(() => {
      viewport.height = layoutHeight;
      viewport.offsetTop = 0;
      setLayoutViewportHeight(layoutHeight);
      viewport.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(1_600);
    });
    expect(screen.getByTestId("keyboard-open")).toHaveTextContent("false");
    expect(screen.getByTestId("footer-hidden")).toHaveTextContent("false");
    expect(nav).not.toHaveClass("mobile-nav-bar--keyboard-open");
    expect(readNavAnchors(nav!)).toEqual(restingAnchors);
    expect(readNavAnchors(popover)).toEqual(restingAnchors);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const restoredGeometry = expectStackedOverlayGeometry({
      nav: nav!,
      popover,
      layoutViewportHeight: layoutHeight,
      viewportHeight: layoutHeight,
      viewportOffsetTop: frozenViewportTop,
    });

    /*
    FNXC:MobilePillKeyboard 2026-09-16-16:27:
    FN-463 immobility invariant: the pill's top/bottom and the popover's bottom are identical while the keyboard
    occupies the screen and after it is dismissed. Before the fix these numbers differed by the occlusion band.
    */
    expect(keyboardOpenGeometry.pill).toEqual(restoredGeometry.pill);
    expect(keyboardOpenGeometry.popover.bottom).toBe(restoredGeometry.popover.bottom);
  });

  it("never fabricates landscape keyboard state for a non-mobile host", () => {
    Object.defineProperties(window, {
      innerWidth: { configurable: true, value: 1280 },
      innerHeight: { configurable: true, value: 430 },
      screen: { configurable: true, value: { width: 1280, height: 800 } },
    });
    setLayoutViewportHeight(430);
    const viewport = installViewport(1280, 430);
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    const { container } = render(<MobileNavKeyboardHarness isMobile={false} />);
    act(() => {
      textarea.focus();
      viewport.height = 220;
      viewport.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId("keyboard-open")).toHaveTextContent("false");
    expect(container.querySelector(".mobile-nav-bar")).toBeNull();
  });

  it("keeps App's only keyboard hook call inside the exported production seam", () => {
    const appSource = readFileSync(resolve(__dirname, "../App.tsx"), "utf8");
    expect(appSource.match(/useMobileKeyboard\(/g)).toHaveLength(1);
    const seamStart = appSource.indexOf("export function useMobileBarKeyboardState");
    const hookCall = appSource.indexOf("useMobileKeyboard(");
    // The next exported declaration after the seam closes it. `shouldOpenBoardTaskInDock` no longer exists.
    const seamEnd = appSource.indexOf("export type BoardTaskOpenRoute");
    expect(seamEnd).toBeGreaterThan(seamStart);
    expect(hookCall).toBeGreaterThan(seamStart);
    expect(hookCall).toBeLessThan(seamEnd);
  });
});
