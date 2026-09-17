import { act } from "@testing-library/react";
import { _resetKeyboardViewportStore } from "../utils/mobileKeyboardViewport";

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
Restorable harness for FN-512 keyboard-geometry regressions. jsdom has no Visual Viewport API and
no layout, so tests must DRIVE the exact metric pairs the researched browsers publish:

- Android / `interactive-widget=resizes-content`: layout AND visual shrink together, offsetTop 0.
  `window.innerHeight` can lag behind `documentElement.clientHeight`, which is why the production
  reader is document-first and why this harness lets the two disagree.
- iOS / WebKit: only the visual viewport shrinks, and `offsetTop` can become positive.
- Impossible transitional sample: `offsetTop + height > layoutHeight`.

This harness reproduces METRICS, not rendering. jsdom never lays anything out, so a test built on
it proves state/style writes and cancellation, never a rendered CSS result.
*/

export interface KeyboardViewportMetrics {
  /** Document-first layout viewport height (`documentElement.clientHeight`). */
  layoutHeight: number;
  /** `window.innerHeight`; defaults to `layoutHeight`, set separately to model Android lag. */
  innerHeight?: number;
  layoutWidth?: number;
  innerWidth?: number;
  visualHeight: number;
  visualWidth?: number;
  offsetTop?: number;
  offsetLeft?: number;
  scale?: number;
}

type Listener = (event: Event) => void;

class FakeVisualViewport extends EventTarget {
  height = 0;
  width = 0;
  offsetTop = 0;
  offsetLeft = 0;
  pageTop = 0;
  pageLeft = 0;
  scale = 1;
}

export interface MobileKeyboardViewportHarness {
  /** Publish a new metric snapshot and fire `resize` (and `scroll` when `offsetTop` moved). */
  set(metrics: KeyboardViewportMetrics): void;
  /** Publish new metrics WITHOUT firing any event (models a first mount already keyboard-open). */
  setSilently(metrics: KeyboardViewportMetrics): void;
  /** Fire `visualViewport.scroll` only. */
  emitScroll(): void;
  /** Fire `visualViewport.resize` only. */
  emitResize(): void;
  /** Fire a document `focusin`. */
  emitFocusIn(): void;
  /** Fire a document `focusout`. */
  emitFocusOut(): void;
  /** Fire `window.pageshow`. */
  emitPageShow(): void;
  /** Fire `document.visibilitychange` with the given state. */
  emitVisibility(state: "visible" | "hidden"): void;
  /** Remove the Visual Viewport API entirely, modelling an unsupporting browser. */
  removeVisualViewport(): void;
  /** Restore every patched global and reset the shared store. */
  restore(): void;
  readonly viewport: FakeVisualViewport;
}

function defineValue(target: object, key: string, value: unknown): PropertyDescriptor | undefined {
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  return previous;
}

/**
 * Install a controllable Visual Viewport plus document-first layout metrics.
 * Call `restore()` in `afterEach`; it also clears the shared subscription store.
 */
export function installMobileKeyboardViewport(
  initial: KeyboardViewportMetrics,
  { touch = true }: { touch?: boolean } = {},
): MobileKeyboardViewportHarness {
  _resetKeyboardViewportStore();

  const viewport = new FakeVisualViewport();
  const restores: Array<() => void> = [];

  const patch = (target: object, key: string, value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    defineValue(target, key, value);
    restores.push(() => {
      if (previous) Object.defineProperty(target, key, previous);
      else delete (target as Record<string, unknown>)[key];
    });
  };

  patch(window, "visualViewport", viewport);
  if (touch) {
    patch(window, "ontouchstart", null);
    patch(window.navigator, "maxTouchPoints", 5);
  }

  const applyMetrics = (metrics: KeyboardViewportMetrics) => {
    const layoutWidth = metrics.layoutWidth ?? metrics.visualWidth ?? window.innerWidth ?? 390;
    viewport.height = metrics.visualHeight;
    viewport.width = metrics.visualWidth ?? layoutWidth;
    viewport.offsetTop = metrics.offsetTop ?? 0;
    viewport.offsetLeft = metrics.offsetLeft ?? 0;
    viewport.scale = metrics.scale ?? 1;
    defineValue(document.documentElement, "clientHeight", metrics.layoutHeight);
    defineValue(document.documentElement, "clientWidth", layoutWidth);
    defineValue(window, "innerHeight", metrics.innerHeight ?? metrics.layoutHeight);
    defineValue(window, "innerWidth", metrics.innerWidth ?? layoutWidth);
  };

  // Snapshot the pre-harness layout metrics so restore() puts them back.
  for (const [target, key] of [
    [document.documentElement, "clientHeight"],
    [document.documentElement, "clientWidth"],
    [window, "innerHeight"],
    [window, "innerWidth"],
  ] as Array<[object, string]>) {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    restores.push(() => {
      if (previous) Object.defineProperty(target, key, previous);
      else delete (target as Record<string, unknown>)[key];
    });
  }

  applyMetrics(initial);

  const fire = (dispatch: () => void) => {
    // Every production writer commits inside React state or a layout effect.
    act(() => {
      dispatch();
    });
  };

  const dispatchOnViewport = (type: string) => viewport.dispatchEvent(new Event(type));

  const harness: MobileKeyboardViewportHarness = {
    viewport,
    set(metrics) {
      const previousOffsetTop = viewport.offsetTop;
      fire(() => {
        applyMetrics(metrics);
        dispatchOnViewport("resize");
        if (viewport.offsetTop !== previousOffsetTop) dispatchOnViewport("scroll");
      });
    },
    setSilently(metrics) {
      applyMetrics(metrics);
    },
    emitScroll() {
      fire(() => dispatchOnViewport("scroll"));
    },
    emitResize() {
      fire(() => dispatchOnViewport("resize"));
    },
    emitFocusIn() {
      fire(() => document.dispatchEvent(new Event("focusin")));
    },
    emitFocusOut() {
      fire(() => document.dispatchEvent(new Event("focusout")));
    },
    emitPageShow() {
      fire(() => window.dispatchEvent(new Event("pageshow")));
    },
    emitVisibility(state) {
      fire(() => {
        defineValue(document, "visibilityState", state);
        document.dispatchEvent(new Event("visibilitychange"));
      });
    },
    removeVisualViewport() {
      defineValue(window, "visualViewport", undefined);
    },
    restore() {
      _resetKeyboardViewportStore();
      while (restores.length > 0) restores.pop()?.();
    },
  };

  return harness;
}

/** Drain queued animation frames so the shared store's batched sample and poll commit. */
export function flushAnimationFrames(count = 3): void {
  for (let index = 0; index < count; index += 1) {
    act(() => {
      vitestAdvanceFrame();
    });
  }
}

/**
 * jsdom implements `requestAnimationFrame` on a ~16ms timer. Tests using fake timers advance it
 * themselves; this helper exists so non-fake-timer tests can still settle a frame deterministically.
 */
function vitestAdvanceFrame(): void {
  const pending = pendingFrameCallbacks.splice(0, pendingFrameCallbacks.length);
  for (const callback of pending) callback(performance.now());
}

const pendingFrameCallbacks: Array<FrameRequestCallback> = [];

/**
 * Replace `requestAnimationFrame` with a queue drained by {@link flushAnimationFrames}. Returns a
 * restore function. Use this when a test must control exactly how many stabilization frames run.
 */
export function installManualAnimationFrames(): () => void {
  const previousRequest = Object.getOwnPropertyDescriptor(window, "requestAnimationFrame");
  const previousCancel = Object.getOwnPropertyDescriptor(window, "cancelAnimationFrame");
  let nextHandle = 1;
  const handles = new Map<number, FrameRequestCallback>();

  defineValue(window, "requestAnimationFrame", (callback: FrameRequestCallback) => {
    const handle = nextHandle++;
    handles.set(handle, callback);
    pendingFrameCallbacks.push((time) => {
      if (handles.delete(handle)) callback(time);
    });
    return handle;
  });
  defineValue(window, "cancelAnimationFrame", (handle: number) => {
    handles.delete(handle);
  });

  return () => {
    pendingFrameCallbacks.length = 0;
    handles.clear();
    if (previousRequest) Object.defineProperty(window, "requestAnimationFrame", previousRequest);
    if (previousCancel) Object.defineProperty(window, "cancelAnimationFrame", previousCancel);
  };
}

/**
 * Give an element a deterministic bounding rectangle. jsdom reports an all-zero rect, so any
 * container-geometry assertion must provide the rect it is pretending to measure.
 */
export function stubBoundingRect(
  element: HTMLElement,
  rect: { top: number; height: number; left?: number; width?: number },
): void {
  const left = rect.left ?? 0;
  const width = rect.width ?? 390;
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      top: rect.top,
      bottom: rect.top + rect.height,
      height: rect.height,
      left,
      right: left + width,
      width,
      x: left,
      y: rect.top,
      toJSON: () => ({}),
    }),
  });
}
