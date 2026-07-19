import { useState, useEffect } from "react";

export type ViewportMode = "mobile" | "tablet" | "desktop";

// `(max-height: 480px)` catches phones held in landscape, which can exceed
// 768 CSS px wide but stay short. Without it, landscape phones fall out of
// mobile mode and lose the bottom nav bar + get the desktop horizontally-
// scrollable board. Runtime mode resolution additionally gates this height
// clause on phone-class physical screen size so virtual keyboards cannot flip
// tablet/desktop layouts into mobile mode by shrinking the CSS viewport height.
export const MOBILE_MEDIA_QUERY = "(max-width: 768px), (max-height: 480px)";

const MOBILE_WIDTH_MEDIA_QUERY = "(max-width: 768px)";
const MOBILE_HEIGHT_MEDIA_QUERY = "(max-height: 480px)";

/*
FNXC:ModalGeometryPersistence 2026-07-15-19:30:
Full-screen FloatingWindow sheets use only the CSS width breakpoint. This deliberately diverges from
`isMobileViewport()`: its short landscape-phone clause still renders movable windows, whose desktop
geometry must continue to restore and persist.
*/
export function isFullScreenSheetViewport(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(MOBILE_WIDTH_MEDIA_QUERY).matches;
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
function isPhoneClassScreen(): boolean {
  if (typeof window === "undefined" || !window.screen) return false;
  const { width, height } = window.screen;
  if (!width || !height) return false;
  return Math.min(width, height) <= 480;
}

export function isMobileViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  const visualWidth = getTouchVisualViewportWidth();
  const visualHeight = getTouchVisualViewportHeight();
  /*
  FNXC:ViewportMode 2026-07-01-11:56:
  Android foldables can expose a wide layout viewport while visualViewport is the folded phone pane. Treat touch-primary visualViewport width as the mobile breakpoint so terminal surfaces render mobile controls and fit xterm from the initial folded geometry, not a stale desktop/tablet shell.
  */
  return window.matchMedia(MOBILE_WIDTH_MEDIA_QUERY).matches ||
    (visualWidth !== null && visualWidth <= 768) ||
    ((window.matchMedia(MOBILE_HEIGHT_MEDIA_QUERY).matches || (visualHeight !== null && visualHeight <= 480)) && isPhoneClassScreen());
}

export function getViewportMode(): ViewportMode {
  if (typeof window === "undefined") return "desktop";
  if (isMobileViewport()) return "mobile";
  if (window.matchMedia("(min-width: 769px) and (max-width: 1024px)").matches) return "tablet";
  return "desktop";
}

export function useViewportMode(): ViewportMode {
  const [mode, setMode] = useState<ViewportMode>(getViewportMode);

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
