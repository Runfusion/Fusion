import { useEffect } from "react";

function isMobileDevice(): boolean {
  if (typeof window === "undefined") return false;
  const hasTouchScreen =
    "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const isNarrow = window.innerWidth <= 768;
  return hasTouchScreen && isNarrow;
}

/**
 * The scroll lock is an iOS-specific workaround: iOS Safari shifts the layout
 * viewport on input focus (visualViewport.offsetTop > 0) which pushes the
 * dashboard off-screen, so we pin body via position:fixed to make it
 * unscrollable. Android Chrome does NOT need this — and applying the same
 * fix there is actively harmful: mutating body styles while the soft keyboard
 * is opening causes Chrome to treat it as a focus-target relayout and
 * dismisses the keyboard immediately. So we gate the lock to iOS only.
 *
 * With `interactive-widget=resizes-content` set on the viewport meta, Android
 * Chrome shrinks the layout viewport with the keyboard, so no drift
 * compensation is needed there.
 */
export function isIOS(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPad on iPadOS 13+ reports as MacIntel + touch — handle that too.
  return /iPad|iPhone|iPod/.test(ua)
    || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

/**
 * Reference-counted body scroll lock for fullscreen mobile overlays.
 *
 * Uses the `position: fixed; top: -scrollY` pattern (the same approach used
 * by Bootstrap, Headless UI, and Stripe Elements) instead of just
 * `overflow: hidden`. The reason: iOS Safari ignores `overflow: hidden` when
 * an input inside a `position: fixed` overlay is focused — it scrolls the
 * document to bring the caret above the soft keyboard, and after dismissal
 * the document can be left scrolled with `visualViewport.offsetTop > 0`,
 * shoving the underlying dashboard (header included) off the top of the
 * screen with a matching gap at the bottom.
 *
 * Pinning `body` with `position: fixed` makes the document genuinely
 * unscrollable, so iOS has nothing to do on focus and leaves the visible
 * area aligned with the layout viewport.
 *
 * Reference counting matters because multiple overlays can be open at once
 * (e.g. a confirm dialog over another modal) — only the outermost lock should
 * actually mutate styles, so an inner unmount doesn't release the lock for
 * an outer overlay that is still open.
 */
let lockCount = 0;
let savedStyles: {
  htmlOverflow: string;
  bodyPosition: string;
  bodyTop: string;
  bodyLeft: string;
  bodyRight: string;
  bodyWidth: string;
  bodyOverflow: string;
  scrollY: number;
} | null = null;

function applyLock(): void {
  if (typeof window === "undefined") return;
  if (lockCount > 0) {
    lockCount += 1;
    return;
  }
  const html = document.documentElement;
  const body = document.body;
  savedStyles = {
    htmlOverflow: html.style.overflow,
    bodyPosition: body.style.position,
    bodyTop: body.style.top,
    bodyLeft: body.style.left,
    bodyRight: body.style.right,
    bodyWidth: body.style.width,
    bodyOverflow: body.style.overflow,
    scrollY: window.scrollY,
  };
  html.style.overflow = "hidden";
  body.style.position = "fixed";
  body.style.top = `-${savedStyles.scrollY}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
  body.style.overflow = "hidden";
  lockCount = 1;
}

function releaseLock(): void {
  if (typeof window === "undefined") return;
  if (lockCount === 0) return;
  lockCount -= 1;
  if (lockCount > 0 || !savedStyles) return;
  const html = document.documentElement;
  const body = document.body;
  const { htmlOverflow, bodyPosition, bodyTop, bodyLeft, bodyRight, bodyWidth, bodyOverflow, scrollY } = savedStyles;
  html.style.overflow = htmlOverflow;
  body.style.position = bodyPosition;
  body.style.top = bodyTop;
  body.style.left = bodyLeft;
  body.style.right = bodyRight;
  body.style.width = bodyWidth;
  body.style.overflow = bodyOverflow;
  savedStyles = null;
  // Always snap back to the top, not to the captured `scrollY`. The
  // captured value is only meaningful if the lock was applied before iOS
  // had a chance to forcibly scroll the document (e.g. modal open with
  // no focused input). For App-level activation triggered by an input
  // gaining focus, iOS may have already scrolled the document by the
  // time the lock effect runs — capturing that already-shifted scrollY
  // and restoring to it would leave the dashboard pushed up after the
  // keyboard dismisses (the original bug). The dashboard's base layout
  // has `body { overflow: hidden }` so user-initiated scroll position
  // is always 0 anyway.
  window.scrollTo(0, 0);
  void scrollY;
}

export function isAnyMobileScrollLockActive(): boolean {
  return lockCount > 0 || kbLockCount > 0;
}

function clearOrphanedBodyOffset(): void {
  if (savedStyles !== null || kbSavedStyles !== null) return;
  const body = document.body;
  if (body.style.position === "fixed") {
    body.style.position = "";
  }
  if (body.style.top) {
    body.style.top = "";
  }
  if (body.style.left === "0px") {
    body.style.left = "";
  }
  if (body.style.right === "0px") {
    body.style.right = "";
  }
  if (body.style.width === "100%") {
    body.style.width = "";
  }
}

function resetStaleDocumentScrollOnRestore(): void {
  if (isAnyMobileScrollLockActive()) return;
  clearOrphanedBodyOffset();
  if (window.scrollY > 0) {
    window.scrollTo(0, 0);
  }
}

/** Test-only: reset the module-level lock state. */
export function _resetLockState(): void {
  lockCount = 0;
  savedStyles = null;
  kbLockCount = 0;
  kbSavedStyles = null;
}

// --- Keyboard viewport lock (non-blurring variant) -------------------------
//
// The `position: fixed` lock above is correct for fullscreen overlays whose
// input is focused AFTER the lock is applied (modals). It is WRONG for the
// inline chat composer: there the input is focused FIRST (the tap raises the
// keyboard), and pinning `body { position: fixed }` a beat later — once
// `keyboardOpen` flips true — makes iOS Safari blur the focused textarea and
// collapse the keyboard the instant it opens (no visible jump, because the
// dashboard's base layout is already at scrollY 0).
//
// This variant mirrors the QuickChat overlay's proven approach: lock
// `overflow: hidden` on <html>/<body> and snap scroll to the top, WITHOUT
// touching `position`. No position change → iOS keeps the input focused, so
// the keyboard stays up. Independent ref-count from the modal lock so the two
// never interfere.
let kbLockCount = 0;
let kbSavedStyles: {
  htmlOverflow: string;
  bodyOverflow: string;
} | null = null;

function applyKeyboardLock(): void {
  if (typeof window === "undefined") return;
  if (kbLockCount > 0) {
    kbLockCount += 1;
    return;
  }
  const html = document.documentElement;
  const body = document.body;
  kbSavedStyles = {
    htmlOverflow: html.style.overflow,
    bodyOverflow: body.style.overflow,
  };
  window.scrollTo(0, 0);
  html.style.overflow = "hidden";
  body.style.overflow = "hidden";
  kbLockCount = 1;
}

function releaseKeyboardLock(): void {
  if (typeof window === "undefined") return;
  if (kbLockCount === 0) return;
  kbLockCount -= 1;
  if (kbLockCount > 0 || !kbSavedStyles) return;
  document.documentElement.style.overflow = kbSavedStyles.htmlOverflow;
  document.body.style.overflow = kbSavedStyles.bodyOverflow;
  kbSavedStyles = null;
  window.scrollTo(0, 0);
}

/**
 * Pin the mobile viewport while the soft keyboard is up for an INLINE
 * (non-overlay) focused input — chat composer, inline edits. Uses an
 * overflow-only lock that does not change `position`, so iOS does not blur
 * the already-focused input. iOS-only; no-op on desktop/Android.
 */
export function useMobileKeyboardViewportLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !isMobileDevice() || !isIOS()) return;
    applyKeyboardLock();
    return () => {
      releaseKeyboardLock();
    };
  }, [enabled]);
}

/**
 * Snap stale iOS document scroll/body offset back to the dashboard's resting
 * position when the page is restored from background or bfcache. Active locks
 * own their own restore path, so this only runs when the page is otherwise
 * unlocked.
 */
export function useMobileViewportRestoreReset(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !isMobileDevice() || !isIOS()) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      resetStaleDocumentScrollOnRestore();
    };

    const handlePageShow = () => {
      resetStaleDocumentScrollOnRestore();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [enabled]);
}

/**
 * Lock body scroll and pin position while a fullscreen mobile overlay is
 * open. Recovers iOS visualViewport drift on cleanup. No-op on desktop.
 */
export function useMobileScrollLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !isMobileDevice() || !isIOS()) return;
    applyLock();
    return () => {
      releaseLock();
    };
  }, [enabled]);
}
