import { useState, useEffect, useLayoutEffect } from "react";

export type ViewportMode = "mobile" | "tablet" | "desktop";

/*
FNXC:ViewportChrome 2026-08-03-00:13:
Shell chrome (left sidebar, mobile tab bar, footer stacking above the tab bar) must follow the JS viewport mode, not pure CSS width. Tablet-class devices at ≤768 CSS px are mode=tablet (sidebar on, no bottom tab bar) while `@media (max-width: 768px)` still hid the sidebar and elevated the footer for a phantom mobile nav — missing tab bar + mid-page overlapping footer. Publish the mode on `document.documentElement` so co-located CSS can override width-only rules and keep left sidebar + footer-at-bottom on tablet.
*/
export const VIEWPORT_MODE_DATASET_KEY = "viewportMode";

/** Mirrors the resolved viewport mode onto `<html data-viewport-mode="…">` for CSS chrome alignment. */
export function publishViewportMode(mode: ViewportMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset[VIEWPORT_MODE_DATASET_KEY] = mode;
}

// `(max-height: 480px)` catches phones held in landscape, which can exceed
// 768 CSS px wide but stay short. Without it, landscape phones fall out of
// mobile mode and lose the bottom nav bar + get the desktop horizontally-
// scrollable board. Runtime mode resolution additionally gates this height
// clause on phone-class physical screen size so virtual keyboards cannot flip
// tablet/desktop layouts into mobile mode by shrinking the CSS viewport height.
export const MOBILE_MEDIA_QUERY = "(max-width: 768px), (max-height: 480px)";

const MOBILE_WIDTH_MEDIA_QUERY = "(max-width: 768px)";
const FULL_SCREEN_SHEET_WIDTH_MEDIA_QUERY = "(max-width: 767.98px)";
const MOBILE_HEIGHT_MEDIA_QUERY = "(max-height: 480px)";

/*
FNXC:ViewportMode 2026-07-24-18:55:
No tablet renders a viewport this narrow as its primary layout, so a CSS width at
or below this is a phone regardless of what `window.screen` reports. The physical-
screen heuristic below cannot be trusted on its own: large Android phones report a
screen min edge above the 480px phone threshold, which classified them tablet-class
and dropped the bottom nav bar entirely while `MobileNavBar.css` still displayed at
`(max-width: 768px)` — JS and CSS disagreeing about the same device. The tablet
carve-out only ever needed the 601-768px band (portrait tablets at the boundary).
*/
const PHONE_WIDTH_MEDIA_QUERY = "(max-width: 600px)";
const PHONE_MAX_CSS_WIDTH = 600;

/*
FNXC:ModalGeometryPersistence 2026-07-15-19:30:
Full-screen FloatingWindow sheets use only the CSS width breakpoint. This deliberately diverges from
`isMobileViewport()`: its short landscape-phone clause still renders movable windows, whose desktop
geometry must continue to restore and persist.

FNXC:ModalTouchGeometry 2026-07-26-12:19:
The sheet boundary is strictly below 768px so JS geometry persistence agrees with FloatingWindow CSS:
a 768px known tablet touch viewport is movable/resizable, never a phone sheet.
*/
export function isFullScreenSheetViewport(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(FULL_SCREEN_SHEET_WIDTH_MEDIA_QUERY).matches;
}

/** Returns whether the CSS short-viewport breakpoint is active. */
export function isShortViewport(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MOBILE_HEIGHT_MEDIA_QUERY).matches;
}

function hasTouchScreen(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

function getTouchVisualViewportWidth(): number | null {
  if (!hasTouchScreen()) return null;
  const width = window.visualViewport?.width;
  return typeof width === "number" && width > 0 ? width : null;
}

function getTouchVisualViewportHeight(): number | null {
  if (!hasTouchScreen()) return null;
  const height = window.visualViewport?.height;
  return typeof height === "number" && height > 0 ? height : null;
}

// The virtual keyboard shrinks the CSS/visual viewport height (matching
// `(max-height: 480px)`) but never the device's physical screen. Only treat a
// short viewport as a landscape phone when the smaller physical screen edge is
// phone-class. Fail safe (return false) when screen data is unavailable.
function hasKnownPhysicalScreenSize(): boolean {
  if (typeof window === "undefined" || !window.screen) return false;
  const { width, height } = window.screen;
  return Boolean(width && height);
}

function isPhoneClassScreen(): boolean {
  if (!hasKnownPhysicalScreenSize()) return false;
  return Math.min(window.screen.width, window.screen.height) <= 480;
}

function isTabletClassTouchScreen(): boolean {
  return hasTouchScreen() && hasKnownPhysicalScreenSize() && !isPhoneClassScreen();
}

/**
 * Whether the CSS viewport is narrow enough to be a phone on width alone.
 *
 * FNXC:ViewportMode 2026-07-24-18:55:
 * Overrides the physical-screen tablet classification: no `window.screen` value
 * can turn a <=600px CSS viewport into a tablet presentation. Checks every width
 * signal the module already trusts (visual viewport, media query, innerWidth) so
 * a delayed media-query update on rotation cannot strand a phone in tablet mode.
 */
function isPhoneClassWidth(): boolean {
  if (typeof window === "undefined") return false;
  const visualWidth = getTouchVisualViewportWidth();
  if (visualWidth !== null && visualWidth <= PHONE_MAX_CSS_WIDTH) return true;
  if (typeof window.matchMedia === "function" && window.matchMedia(PHONE_WIDTH_MEDIA_QUERY).matches) return true;
  return window.innerWidth > 0 && window.innerWidth <= PHONE_MAX_CSS_WIDTH;
}

export function isMobileViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  const visualWidth = getTouchVisualViewportWidth();
  const visualHeight = getTouchVisualViewportHeight();
  /*
  FNXC:ViewportMode 2026-07-01-11:56:
  Android foldables can expose a wide layout viewport while visualViewport is the folded phone pane. Treat touch-primary visualViewport width as the mobile breakpoint so terminal surfaces render mobile controls and fit xterm from the initial folded geometry, not a stale desktop/tablet shell.
  */
  /*
  FNXC:TerminalModalControls 2026-07-24-14:15:
  A touch viewport exactly at the 768px CSS boundary can be a portrait tablet, not a phone.
  Keep the physical layout/visual-width fallback for delayed media-query and orientation updates,
  but route a known tablet-class physical screen through tablet geometry controls. Unknown screen
  dimensions retain the conservative CSS-only phone path, while narrow foldable panes remain phones.
  */
  const hasNarrowWidth = window.innerWidth <= 768 ||
    window.matchMedia(MOBILE_WIDTH_MEDIA_QUERY).matches ||
    (visualWidth !== null && visualWidth <= 768);
  /*
  FNXC:ViewportMode 2026-07-24-18:55:
  The tablet exclusion applies only above the phone width floor. Without that
  guard every touch device whose reported physical screen exceeds the 480px phone
  threshold — which includes large Android phones — lost mobile mode at any width,
  taking the bottom nav bar with it.
  */
  return (hasNarrowWidth && (isPhoneClassWidth() || !isTabletClassTouchScreen())) ||
    ((window.matchMedia(MOBILE_HEIGHT_MEDIA_QUERY).matches || (visualHeight !== null && visualHeight <= 480)) && isPhoneClassScreen());
}

export function getViewportMode(): ViewportMode {
  if (typeof window === "undefined") return "desktop";
  if (isMobileViewport()) return "mobile";
  const isTabletBoundary = window.innerWidth <= 768 ||
    window.matchMedia(MOBILE_WIDTH_MEDIA_QUERY).matches ||
    (getTouchVisualViewportWidth() ?? Number.POSITIVE_INFINITY) <= 768;
  if (window.matchMedia("(min-width: 769px) and (max-width: 1024px)").matches ||
    (isTabletBoundary && isTabletClassTouchScreen())) return "tablet";
  return "desktop";
}

/**
 * Whether a viewport is the tablet-only touch-resize surface.
 *
 * FNXC:TaskModalResize 2026-07-26-10:40:
 * Tablet resize controls need a finger-sized target, but `(pointer: coarse)` alone
 * would also enlarge controls on desktop hybrids and true phones. Compose the existing
 * physical-screen-aware tablet classifier with touch capability instead; phones retain
 * full-screen sheets and desktop coarse-pointer devices retain mouse-sized chrome.
 */
export function isTabletTouchViewport(mode = getViewportMode()): boolean {
  return mode === "tablet" && hasTouchScreen() && !isPhoneClassScreen();
}

export function useViewportMode(): ViewportMode {
  /*
  FNXC:ViewportChrome 2026-08-03-00:17:
  Lazy initial state still runs publishViewportMode during the first render so the first paint already has data-viewport-mode — useLayoutEffect alone still leaves a pre-hydration/SSR-empty frame where width-only CSS hides the tablet sidebar.
  */
  const [mode, setMode] = useState<ViewportMode>(() => {
    const initial = getViewportMode();
    publishViewportMode(initial);
    return initial;
  });

  /*
  FNXC:ViewportChrome 2026-08-03-00:13:
  Re-publish on every mode change before paint so resize/orientation updates do not flash phone chrome (hidden sidebar + elevated footer) on a tablet-class narrow viewport.
  */
  useLayoutEffect(() => {
    publishViewportMode(mode);
  }, [mode]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const mobileQuery = window.matchMedia(MOBILE_MEDIA_QUERY);
    const tabletQuery = window.matchMedia("(min-width: 769px) and (max-width: 1024px)");

    const updateMode = () => {
      setMode(getViewportMode());
    };

    const addChangeListener = (query: MediaQueryList, listener: () => void) => {
      if (typeof query.addEventListener === "function") {
        query.addEventListener("change", listener);
        return;
      }
      if (typeof query.addListener === "function") {
        query.addListener(listener);
      }
    };

    const removeChangeListener = (query: MediaQueryList, listener: () => void) => {
      if (typeof query.removeEventListener === "function") {
        query.removeEventListener("change", listener);
        return;
      }
      if (typeof query.removeListener === "function") {
        query.removeListener(listener);
      }
    };

    addChangeListener(mobileQuery, updateMode);
    addChangeListener(tabletQuery, updateMode);
    window.addEventListener("resize", updateMode);
    window.addEventListener("orientationchange", updateMode);
    const visualViewport = window.visualViewport;
    if (typeof visualViewport?.addEventListener === "function") {
      visualViewport.addEventListener("resize", updateMode);
    }
    updateMode();

    return () => {
      removeChangeListener(mobileQuery, updateMode);
      removeChangeListener(tabletQuery, updateMode);
      window.removeEventListener("resize", updateMode);
      window.removeEventListener("orientationchange", updateMode);
      if (typeof visualViewport?.removeEventListener === "function") {
        visualViewport.removeEventListener("resize", updateMode);
      }
    };
  }, []);

  return mode;
}
