import { getMobileKeyboardLayoutViewportHeight } from "./mobileBarKeyboardFlags";

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 separates DETECTION from PLACEMENT.

Detection ("is a soft keyboard up?") stays heuristic: it needs a focused editable element, a
baseline, and shrink thresholds, and it is legitimately allowed to be wrong for a few frames.

Placement ("where does the visible area actually end?") must NOT be heuristic. The canonical datum
is the visible rectangle expressed in LAYOUT-viewport coordinates — exactly the coordinate space
`Element.getBoundingClientRect()` reports:

  visibleTop    = visualViewport.offsetTop
  visibleBottom = visualViewport.offsetTop + visualViewport.height

A layout-anchored element's residual bottom inset is therefore
`max(0, layoutHeight - visibleBottom)`, and it is ZERO when the browser already shrank the layout
viewport with the keyboard (Android Chrome + `interactive-widget=resizes-content`, which
`packages/dashboard/app/index.html` sets). Reserving a keyboard height on top of an already
reduced layout is the "gros espace entre le clavier et l'input" symptom; measuring a container's
own rect against `visibleBottom` is the only reading that stays correct in both browsers.

Two more rules encoded here, both from the researched sources:
- A baseline or screen dimension may QUALIFY a transition; it may never SUPPLY pixels to subtract
  from an already reduced container. Consumers use `visibleBottom`, never a derived keyboard height.
- Pinch/accessibility zoom (`scale > 1.01`) also shrinks the visual viewport and is not a keyboard.
  The frame still reports the true rectangle, and `scale` is exposed so detection can opt out.
*/

/** Visual-viewport scale above which the user is genuinely zoomed, not keyboard-occluded. */
export const ZOOMED_SCALE_THRESHOLD = 1.01;

/**
 * Tolerance for a physically impossible sample. WebKit can publish an `offsetTop` from the
 * keyboard transition while `height` is still the pre-keyboard value, so `offsetTop + height`
 * exceeds the layout viewport. Such a frame is marked incoherent rather than published.
 */
export const IMPOSSIBLE_VIEWPORT_EPSILON_PX = 2;

export interface KeyboardViewportFrame {
  /** Document-first layout viewport height (never the possibly stale `window.innerHeight`). */
  layoutHeight: number;
  /** Layout viewport width. */
  layoutWidth: number;
  /** `visualViewport.height`. */
  visualHeight: number;
  /** `visualViewport.width`. */
  visualWidth: number;
  /** `visualViewport.offsetTop`; the top edge of the visible rect in layout coordinates. */
  offsetTop: number;
  /** `visualViewport.offsetLeft`. */
  offsetLeft: number;
  /** `visualViewport.scale`. */
  scale: number;
  /** Bottom edge of the visible rect in layout coordinates (`offsetTop + visualHeight`). */
  visibleBottom: number;
  /**
   * Residual bottom inset for a LAYOUT-anchored element: `max(0, layoutHeight - visibleBottom)`.
   * Zero when the browser already resized the layout viewport.
   */
  residualBottomInset: number;
  /** Residual right inset, for the same reason on rotated/split viewports. */
  residualRightInset: number;
  /** False when the sample is physically impossible and must not be published. */
  coherent: boolean;
  /** True when the user is zoomed in; occlusion cannot be inferred from this frame. */
  zoomed: boolean;
  /**
   * Whether an editable element held focus at the instant this frame was read.
   *
   * FNXC:MobileKeyboardViewport 2026-09-17-14:23: focus is part of the ATOMIC snapshot, not a
   * separate signal read later. Keyboard detection depends on it, so a blur that leaves the
   * geometry unchanged must still produce a new frame; otherwise deduplication would suppress the
   * publish and consumers would stay stuck keyboard-up for the whole dismissal animation.
   */
  editableFocused: boolean;
}

/** Frame used when the Visual Viewport API is unavailable: the layout viewport IS the visible rect. */
export function createUnavailableFrame(): KeyboardViewportFrame | null {
  if (typeof window === "undefined") return null;
  const layoutHeight = getMobileKeyboardLayoutViewportHeight();
  const layoutWidth = typeof document === "undefined"
    ? window.innerWidth
    : document.documentElement?.clientWidth || window.innerWidth;
  return {
    layoutHeight,
    layoutWidth,
    visualHeight: layoutHeight,
    visualWidth: layoutWidth,
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1,
    visibleBottom: layoutHeight,
    residualBottomInset: 0,
    residualRightInset: 0,
    coherent: true,
    zoomed: false,
    editableFocused: readEditableFocus(),
  };
}

function readEditableFocus(): boolean {
  if (typeof document === "undefined") return false;
  return isKeyboardEditableElement(document.activeElement);
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Read one atomic frame. Returns `null` only outside a browser. When the Visual Viewport API is
 * missing or publishes a non-finite sample, the layout viewport is used as the visible rect so
 * consumers can never observe NaN, a negative size, or an invented keyboard height.
 */
export function readKeyboardViewportFrame(): KeyboardViewportFrame | null {
  if (typeof window === "undefined") return null;
  const vv = window.visualViewport;
  if (!vv) return createUnavailableFrame();

  const visualHeight = vv.height;
  const visualWidth = vv.width;
  const offsetTop = vv.offsetTop;
  const offsetLeft = vv.offsetLeft;
  const scale = vv.scale;

  if (!isFinitePositive(visualHeight) || !isFinitePositive(visualWidth)
    || !Number.isFinite(offsetTop) || !Number.isFinite(offsetLeft)
    || visualHeight <= 0) {
    return createUnavailableFrame();
  }

  const layoutHeight = getMobileKeyboardLayoutViewportHeight();
  const layoutWidth = typeof document === "undefined"
    ? window.innerWidth
    : document.documentElement?.clientWidth || window.innerWidth;
  /*
  FNXC:MobileKeyboardViewport 2026-09-17-14:23:
  A visual viewport as tall as the layout viewport cannot ALSO be offset down inside it. WebKit can
  nevertheless report exactly that after a restore or a tab switch: the height has already snapped
  back while a stale `offsetTop` from the keyboard transition survives. Normalizing that leftover
  offset to zero is not a heuristic — it is the only geometry consistent with the reported height,
  and it stops a stale drift surviving as a permanent downward shift of the whole page.
  */
  const rawOffsetTop = Math.max(0, offsetTop);
  const safeOffsetTop = visualHeight + IMPOSSIBLE_VIEWPORT_EPSILON_PX >= layoutHeight ? 0 : rawOffsetTop;
  const safeOffsetLeft = Math.max(0, offsetLeft);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const visibleBottom = safeOffsetTop + visualHeight;

  return {
    layoutHeight,
    layoutWidth,
    visualHeight,
    visualWidth,
    offsetTop: safeOffsetTop,
    offsetLeft: safeOffsetLeft,
    scale: safeScale,
    visibleBottom,
    residualBottomInset: Math.max(0, layoutHeight - visibleBottom),
    residualRightInset: Math.max(0, layoutWidth - safeOffsetLeft - visualWidth),
    coherent: visibleBottom <= layoutHeight + IMPOSSIBLE_VIEWPORT_EPSILON_PX,
    zoomed: safeScale > ZOOMED_SCALE_THRESHOLD,
    editableFocused: readEditableFocus(),
  };
}

/** Stable identity of a frame, used to drop duplicate events without re-rendering consumers. */
export function keyboardViewportFrameKey(frame: KeyboardViewportFrame): string {
  return [
    frame.layoutHeight,
    frame.layoutWidth,
    frame.visualHeight,
    frame.visualWidth,
    frame.offsetTop,
    frame.offsetLeft,
    frame.scale,
    frame.coherent ? 1 : 0,
    frame.editableFocused ? 1 : 0,
  ].join("|");
}

export function areKeyboardViewportFramesEqual(
  a: KeyboardViewportFrame | null,
  b: KeyboardViewportFrame | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return keyboardViewportFrameKey(a) === keyboardViewportFrameKey(b);
}

const NON_TEXT_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "file",
  "range",
  "color",
  "hidden",
]);

/**
 * Shared editable predicate. `useKeyboardFocusPending`, keyboard detection, and the local scroll
 * helper must agree on what raises a keyboard, or a non-text control can collapse mobile chrome.
 */
export function isKeyboardEditableElement(element: Element | null | undefined): boolean {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  if (element instanceof HTMLInputElement) {
    if (element.disabled || element.readOnly) return false;
    return !NON_TEXT_INPUT_TYPES.has(element.type.toLowerCase());
  }
  return element instanceof HTMLElement && element.isContentEditable === true;
}

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
One shared subscription, not one per consumer. Before FN-512 every hook instance installed its own
`resize`/`scroll`/`focusin`/`focusout` listeners plus its own 50/200/500/1000/1500 ms tail and its own
rAF poll, so N mounted surfaces multiplied the work and could publish N different answers for the
same instant. The store batches all events into one animation frame, deduplicates identical frames,
and runs ONE bounded stabilization poll — WebKit can publish the settled height late in the keyboard
animation (bug 265578), so a bounded re-sample is required, but it must be bounded and cancellable.
*/

/** Upper bound of the stabilization poll. Past this the last coherent frame is authoritative. */
export const STABILIZATION_DEADLINE_MS = 1200;
/** Consecutive identical frames that prove the transition settled. */
const STABLE_FRAMES_REQUIRED = 2;

export type KeyboardViewportListener = (frame: KeyboardViewportFrame) => void;

interface StoreState {
  listeners: Set<KeyboardViewportListener>;
  frame: KeyboardViewportFrame | null;
  teardown: (() => void) | null;
  scheduledFrame: number | null;
  pollFrame: number | null;
  pollDeadline: number;
  stableFrames: number;
  lastPolledKey: string | null;
}

const store: StoreState = {
  listeners: new Set(),
  frame: null,
  teardown: null,
  scheduledFrame: null,
  pollFrame: null,
  pollDeadline: 0,
  stableFrames: 0,
  lastPolledKey: null,
};

function publish(next: KeyboardViewportFrame): void {
  /*
  FNXC:MobileKeyboardViewport 2026-09-17-14:23:
  An incoherent sample cannot prove anything about placement, so the previous coherent frame stays
  authoritative. It is NOT retained forever: the stabilization poll below keeps sampling until a
  coherent frame lands or the deadline expires, at which point the incoherent frame is published
  clamped rather than freezing the UI in a stale position.
  */
  if (!next.coherent && store.frame) return;
  if (areKeyboardViewportFramesEqual(store.frame, next)) return;
  store.frame = next;
  for (const listener of [...store.listeners]) listener(next);
}

function sampleNow(): void {
  const frame = readKeyboardViewportFrame();
  if (frame) publish(frame);
}

function cancelScheduledFrame(): void {
  if (store.scheduledFrame !== null && typeof window !== "undefined") {
    window.cancelAnimationFrame(store.scheduledFrame);
  }
  store.scheduledFrame = null;
}

function cancelPoll(): void {
  if (store.pollFrame !== null && typeof window !== "undefined") {
    window.cancelAnimationFrame(store.pollFrame);
  }
  store.pollFrame = null;
  store.stableFrames = 0;
  store.lastPolledKey = null;
}

function pollStep(): void {
  if (typeof window === "undefined") return;
  store.pollFrame = null;
  const frame = readKeyboardViewportFrame();
  if (!frame) return;
  const key = keyboardViewportFrameKey(frame);
  if (frame.coherent) {
    publish(frame);
    if (key === store.lastPolledKey) {
      store.stableFrames += 1;
    } else {
      store.stableFrames = 0;
      store.lastPolledKey = key;
    }
  } else {
    store.stableFrames = 0;
    store.lastPolledKey = key;
  }

  const expired = now() >= store.pollDeadline;
  if (store.stableFrames >= STABLE_FRAMES_REQUIRED || expired) {
    if (expired && !frame.coherent) {
      // Deadline reached with nothing coherent: publish the clamped reading rather than
      // leaving every consumer pinned to a stale pre-transition rectangle forever.
      store.frame = null;
      publish({ ...frame, visibleBottom: Math.min(frame.visibleBottom, frame.layoutHeight), coherent: true });
    }
    cancelPoll();
    return;
  }
  store.pollFrame = window.requestAnimationFrame(pollStep);
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function startStabilization(): void {
  if (typeof window === "undefined") return;
  cancelPoll();
  store.pollDeadline = now() + STABILIZATION_DEADLINE_MS;
  store.pollFrame = window.requestAnimationFrame(pollStep);
}

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
The head sample is SYNCHRONOUS. Deferring it to an animation frame would make every consumer lag one
frame behind a focus or resize event, which is visible as a late jump. Redundant work is prevented by
frame-key deduplication rather than by batching: a burst of identical `resize`/`scroll` events
publishes once, and only a genuinely changed rectangle reaches consumers.

The bounded stabilization poll is the deferred part, because WebKit can publish the settled height
late in the keyboard animation (bug 265578). It is cancellable, so a newer transition always
supersedes an older one instead of letting a stale callback overwrite the successor.
*/
function scheduleSample({ stabilize }: { stabilize: boolean }): void {
  if (typeof window === "undefined") return;
  sampleNow();
  if (stabilize) startStabilization();
}

function attach(): void {
  if (typeof window === "undefined" || store.teardown) return;
  const vv = window.visualViewport;

  const onGeometry = () => scheduleSample({ stabilize: true });
  // A visual-viewport pan publishes a coherent height/offset pair; it needs no re-settle tail.
  const onScroll = () => scheduleSample({ stabilize: false });
  const onRestore = () => {
    cancelPoll();
    scheduleSample({ stabilize: true });
  };
  const onVisibility = () => {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    onRestore();
  };

  vv?.addEventListener("resize", onGeometry);
  vv?.addEventListener("scroll", onScroll);
  window.addEventListener("resize", onGeometry);
  window.addEventListener("orientationchange", onRestore);
  window.addEventListener("pageshow", onRestore);
  document.addEventListener("focusin", onGeometry);
  document.addEventListener("focusout", onGeometry);
  document.addEventListener("visibilitychange", onVisibility);

  store.teardown = () => {
    vv?.removeEventListener("resize", onGeometry);
    vv?.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onGeometry);
    window.removeEventListener("orientationchange", onRestore);
    window.removeEventListener("pageshow", onRestore);
    document.removeEventListener("focusin", onGeometry);
    document.removeEventListener("focusout", onGeometry);
    document.removeEventListener("visibilitychange", onVisibility);
  };

  sampleNow();
}

function detach(): void {
  store.teardown?.();
  store.teardown = null;
  cancelScheduledFrame();
  cancelPoll();
  store.frame = null;
}

/**
 * Subscribe to the shared frame. The listener is invoked synchronously with the current frame and
 * then on every coherent change. Returns an unsubscribe that tears the shared listeners down once
 * the last consumer leaves, so no timer or rAF outlives the surfaces that needed it.
 */
export function subscribeKeyboardViewport(listener: KeyboardViewportListener): () => void {
  store.listeners.add(listener);
  if (store.listeners.size === 1) attach();
  const current = store.frame ?? readKeyboardViewportFrame();
  if (current) {
    store.frame = store.frame ?? current;
    listener(current);
  }
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0) detach();
  };
}

/** Current shared frame without subscribing. */
export function getKeyboardViewportFrame(): KeyboardViewportFrame | null {
  return store.frame ?? readKeyboardViewportFrame();
}

/** Force a fresh sample plus a bounded re-settle; used by explicit restore paths. */
export function refreshKeyboardViewport(): void {
  if (store.listeners.size === 0) return;
  scheduleSample({ stabilize: true });
}

/** Test-only: drop every listener, timer, and cached frame. */
export function _resetKeyboardViewportStore(): void {
  store.listeners.clear();
  detach();
}

/** Test-only: number of live consumers of the shared subscription. */
export function _keyboardViewportListenerCount(): number {
  return store.listeners.size;
}
