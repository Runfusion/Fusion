import { useEffect, useRef, useState } from "react";
import {
  IMPOSSIBLE_VIEWPORT_EPSILON_PX,
  ZOOMED_SCALE_THRESHOLD,
  getKeyboardViewportFrame,
  subscribeKeyboardViewport,
  type KeyboardViewportFrame,
} from "../utils/mobileKeyboardViewport";

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 turns this hook into a FAÇADE over the shared frame in `utils/mobileKeyboardViewport.ts`.
It no longer installs its own listeners, tail timers, or stability poll — N mounted surfaces used to
install N of each and could publish N different answers for one instant, which is the intermittent
"1 fois sur 2" failure the operator reported.

The hook now publishes two deliberately different kinds of value:

- PLACEMENT (geometric, never heuristic): `keyboardOverlap` is the residual bottom inset of a
  LAYOUT-anchored element, `viewportHeight`/`viewportOffsetTop` are the visible rectangle, and
  `visibleBottom` is its bottom edge. `keyboardOverlap` is ZERO whenever the browser already shrank
  the layout viewport, so a fixed bar or bounded container can never subtract a keyboard height from
  a container that was already reduced. Before FN-512 the iOS branch derived this number from a
  cached baseline, which double-subtracted on Android and left a dead band above the keyboard.
- DETECTION (heuristic, tolerant): `keyboardOpen` still requires a focused editable element plus a
  meaningful shrink against a baseline, because "is a keyboard up?" genuinely cannot be measured.

A baseline may therefore QUALIFY a transition; it may never SUPPLY placement pixels.
*/

const IOS_VIEWPORT_SHRINK_MIN_PX = 16;
const SETTLED_FOLDED_VIEWPORT_MIN_HEIGHT_PX = 480;

/** Whether the current device is likely mobile (touch-primary, small viewport). */
function isMobileDevice(): boolean {
  if (typeof window === "undefined") return false;
  const hasTouchScreen =
    "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const visualWidth = window.visualViewport?.width;
  /*
  FNXC:Terminal 2026-07-02-12:39:
  Android Chrome can keep a tablet-sized layout viewport while the active visualViewport is the narrow keyboard-open terminal pane. Keyboard tracking must follow the touch visual width just like `useViewportMode`, or SessionTerminal renders mobile chrome but never lifts/refits its input bar for the initial 10px keyboard-open terminal state.
  */
  const effectiveWidth = hasTouchScreen && typeof visualWidth === "number" && visualWidth > 0
    ? Math.min(window.innerWidth, visualWidth)
    : window.innerWidth;
  const isNarrow = effectiveWidth <= 768;
  return hasTouchScreen && isNarrow;
}

/**
 * Baseline viewport height captured while the keyboard is likely closed.
 * DETECTION ONLY — see the module note. Never read for placement.
 */
let _baselineViewportHeight: number | null = null;
let _baselineViewportWidth: number | null = null;

function setBaselineViewport(height: number, width: number): void {
  _baselineViewportHeight = height;
  _baselineViewportWidth = width;
}

function getBaselineViewportHeight(frame: KeyboardViewportFrame): number {
  if (_baselineViewportHeight === null) {
    setBaselineViewport(frame.visualHeight, frame.visualWidth);
  }
  return _baselineViewportHeight ?? frame.visualHeight;
}

function updateBaselineViewportHeight(frame: KeyboardViewportFrame): void {
  const current = getBaselineViewportHeight(frame);
  const widthChanged = _baselineViewportWidth !== null
    && Math.abs(frame.visualWidth - _baselineViewportWidth) >= 1;
  /*
  FNXC:Terminal 2026-06-30-08:51:
  SessionTerminal shares the folded-phone root cause: a keyboard-closed width/posture settle can be shorter than the previous unfolded baseline, so max-only baselines overestimate later iOS keyboard occlusion. Replace the baseline on settled folded posture changes while preserving the max-observed recovery for same-posture keyboard-open first samples.
  */
  if (frame.visualHeight > current
    || (widthChanged && frame.visualHeight >= SETTLED_FOLDED_VIEWPORT_MIN_HEIGHT_PX)) {
    setBaselineViewport(frame.visualHeight, frame.visualWidth);
  }
}

/*
FNXC:Terminal 2026-07-02-18:18:
iOS Safari can deliver the very FIRST sample with the helper textarea already focused, the soft
keyboard already open, and `innerHeight`, `clientHeight`, and `visualViewport.height` all already
reduced. There is then no closed sample anywhere to compare against, so a screen dimension is the only
remaining evidence that a keyboard is up.

FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 keeps this strictly as DETECTION. The candidate can make `keyboardOpen` true; it can never
become `keyboardOverlap`. In exactly this state the layout viewport has already been reduced, so a
layout-anchored bar at `bottom: 0` is visible and the correct reservation is ZERO — subtracting a
screen-derived height here used to push the terminal input bar clean off the top of a 390px viewport.
*/
function getScreenViewportBaselineCandidate(frame: KeyboardViewportFrame): number | null {
  if (typeof window === "undefined" || !window.screen) return null;
  const screenWidth = window.screen.width;
  const screenHeight = window.screen.height;
  if (!Number.isFinite(screenWidth) || !Number.isFinite(screenHeight) || screenWidth <= 0 || screenHeight <= 0) {
    return null;
  }

  const portraitLike = frame.visualHeight >= frame.visualWidth;
  const candidate = portraitLike
    ? Math.max(screenWidth, screenHeight)
    : Math.min(screenWidth, screenHeight);
  const gap = candidate - frame.visualHeight;
  const minMeaningfulGap = portraitLike
    ? Math.max(220, candidate * 0.25)
    : Math.max(80, candidate * 0.25);

  return gap >= minMeaningfulGap ? candidate : null;
}

function resetBaselineViewportHeight(): void {
  _baselineViewportHeight = null;
  _baselineViewportWidth = null;
}

/** Reset cached viewport baseline. Exported for tests only. */
export function _resetInitialViewportHeight(): void {
  resetBaselineViewportHeight();
}

export interface MobileKeyboardNavigationViewport {
  active: boolean;
  keyboardOverlap: number;
  viewportHeight: number | null;
  viewportOffsetTop: number;
}

export interface MobileKeyboardState {
  /**
   * Residual bottom inset of a LAYOUT-anchored element, in CSS pixels. Geometric, never derived
   * from a baseline or screen size, and zero when the layout viewport already shrank.
   */
  keyboardOverlap: number;
  /** Visible rectangle height (`visualViewport.height`), or null while no frame is tracked. */
  viewportHeight: number | null;
  /** Visible rectangle top edge in layout coordinates. */
  viewportOffsetTop: number;
  /** Visible rectangle bottom edge in layout coordinates, or null while no frame is tracked. */
  visibleBottom: number | null;
  /** Heuristic: a soft keyboard is believed to be up for a focused editable element. */
  keyboardOpen: boolean;
  /** Raw shared frame, for consumers that measure their own container against it. */
  frame: KeyboardViewportFrame | null;
  navigationViewport: MobileKeyboardNavigationViewport;
}

const CLOSED_NAVIGATION_VIEWPORT: MobileKeyboardNavigationViewport = {
  active: false,
  keyboardOverlap: 0,
  viewportHeight: null,
  viewportOffsetTop: 0,
};

const CLOSED_STATE: MobileKeyboardState = {
  keyboardOverlap: 0,
  viewportHeight: null,
  viewportOffsetTop: 0,
  visibleBottom: null,
  keyboardOpen: false,
  frame: null,
  navigationViewport: CLOSED_NAVIGATION_VIEWPORT,
};

/**
 * Heuristic keyboard detection for one frame. Placement values are taken straight from the frame;
 * only the boolean is inferred.
 */
function detectKeyboardOpen(frame: KeyboardViewportFrame): boolean {
  // Pinch/accessibility zoom also shrinks the visual viewport. Android Chrome ignores
  // user-scalable=no for a11y, so a zoomed user with a focused textarea would otherwise
  // false-positive "keyboard open" and strip the mobile chrome.
  if (frame.scale > ZOOMED_SCALE_THRESHOLD) return false;

  // Focus is read from the frame, not from the DOM at commit time, so detection and placement
  // always describe the same instant.
  const focused = frame.editableFocused;

  // Refresh the baseline only while nothing editable is focused.
  if (!focused) {
    updateBaselineViewportHeight(frame);
    return false;
  }

  // Layout-resizing browsers (Android + interactive-widget=resizes-content) prove occlusion
  // directly: the visible rect no longer reaches the layout bottom.
  if (frame.residualBottomInset > 0) return true;

  // Otherwise the only available evidence is a shrink against the closed baseline, or — when the
  // very first sample is already keyboard-open — against a guarded screen dimension. This is
  // detection, not placement: neither gap is ever handed to a container.
  const baseline = Math.max(
    getBaselineViewportHeight(frame),
    getScreenViewportBaselineCandidate(frame) ?? 0,
  );
  const shrink = Math.max(0, baseline - frame.offsetTop - frame.visualHeight);
  if (shrink >= IOS_VIEWPORT_SHRINK_MIN_PX) return true;

  return Math.max(0, baseline - frame.visualHeight) >= IOS_VIEWPORT_SHRINK_MIN_PX;
}

/*
FNXC:MobilePillKeyboard 2026-09-13-11:20:
A keyboard interaction ends as soon as focus leaves the editor, so `keyboardOpen` must still release
composers and the executor footer immediately. Fixed mobile navigation has a different placement
lifetime: retain and refresh its last proven keyboard viewport until both the visual viewport height
and top offset return to the captured closed baseline, preventing the pill and its open popover from
falling behind the dismissing iOS keyboard.

FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 keeps this lifetime intact but feeds it the shared frame. Its metrics remain navigation-only;
they are not an authorization to move the pill above the keyboard.
*/
function computeNavigationViewport(
  frame: KeyboardViewportFrame,
  keyboardOpen: boolean,
  previous: MobileKeyboardNavigationViewport,
): MobileKeyboardNavigationViewport {
  if (frame.scale > ZOOMED_SCALE_THRESHOLD) return CLOSED_NAVIGATION_VIEWPORT;

  if (keyboardOpen) {
    return {
      active: true,
      keyboardOverlap: frame.residualBottomInset,
      viewportHeight: frame.visualHeight,
      viewportOffsetTop: frame.offsetTop,
    };
  }

  if (!previous.active) return CLOSED_NAVIGATION_VIEWPORT;

  const baseline = getBaselineViewportHeight(frame);
  const heightRestored = frame.visualHeight >= baseline - IOS_VIEWPORT_SHRINK_MIN_PX;
  const topRestored = frame.offsetTop <= IMPOSSIBLE_VIEWPORT_EPSILON_PX;
  if (heightRestored && topRestored) return CLOSED_NAVIGATION_VIEWPORT;

  return {
    active: true,
    keyboardOverlap: frame.residualBottomInset,
    viewportHeight: frame.visualHeight,
    viewportOffsetTop: frame.offsetTop,
  };
}

interface UseMobileKeyboardOptions {
  enabled?: boolean;
  allowNonMobileViewport?: boolean;
}

export function useMobileKeyboard(
  { enabled = true, allowNonMobileViewport = false }: UseMobileKeyboardOptions = {},
): MobileKeyboardState {
  const [state, setState] = useState<MobileKeyboardState>(CLOSED_STATE);
  const navigationRef = useRef<MobileKeyboardNavigationViewport>(CLOSED_NAVIGATION_VIEWPORT);

  useEffect(() => {
    if (!enabled || (!allowNonMobileViewport && !isMobileDevice())) {
      navigationRef.current = CLOSED_NAVIGATION_VIEWPORT;
      setState(CLOSED_STATE);
      return;
    }

    /*
    FNXC:MobileKeyboardViewport 2026-09-17-14:23:
    The legacy placement triple stays gated on `keyboardOpen`: consumers write
    `--vv-height`/`--vv-offset-top`/`--keyboard-overlap` only while a keyboard is believed to be up,
    so a closed keyboard must publish no geometry at all and leave resting layout untouched.
    `frame` and `visibleBottom` are always available for container owners that measure their own
    rectangle against the visible bound rather than consuming a keyboard height.
    */
    const commit = (frame: KeyboardViewportFrame) => {
      const keyboardOpen = detectKeyboardOpen(frame);
      const navigationViewport = computeNavigationViewport(frame, keyboardOpen, navigationRef.current);
      navigationRef.current = navigationViewport;
      setState({
        keyboardOverlap: keyboardOpen ? frame.residualBottomInset : 0,
        viewportHeight: keyboardOpen ? frame.visualHeight : null,
        viewportOffsetTop: keyboardOpen ? frame.offsetTop : 0,
        visibleBottom: frame.visibleBottom,
        keyboardOpen,
        frame,
        navigationViewport,
      });
    };

    const unsubscribe = subscribeKeyboardViewport(commit);
    return () => {
      unsubscribe();
      navigationRef.current = CLOSED_NAVIGATION_VIEWPORT;
      setState(CLOSED_STATE);
    };
  }, [allowNonMobileViewport, enabled]);

  return state;
}

/** Read the current placement frame outside React. */
export { getKeyboardViewportFrame };
