import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

interface UseDrawerDismissGestureOptions {
  enabled: boolean;
  open?: boolean;
  panelRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}

export interface DrawerDismissSurfaceProps {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
}

interface DrawerDrag {
  input: "pointer" | "touch";
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
  offset: number;
  frame: number | null;
  surface: HTMLElement;
  claimed: boolean;
}

const DISTANCE_RATIO = 0.25;
const VELOCITY_THRESHOLD = 0.6;
const INTENT_THRESHOLD = 6;
const HANDLE_SELECTOR = ".alpha-mobile-drawer__handle-target, .floating-window__drawer-handle-target, .terminal-drawer-handle-target";
const INTERACTIVE_SELECTOR = "button, input, select, textarea, a[href], [contenteditable='true'], [role='button'], [role='slider'], [role='textbox']";
const EXCLUDED_GESTURE_SELECTOR = ".xterm, .xterm-screen, .xterm-viewport";

function hasTextSelection(): boolean {
  const selection = typeof window === "undefined" ? null : window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed);
}

function scrollOwnersAreAtTop(target: Element, panel: HTMLElement): boolean {
  let current: Element | null = target;
  while (current && panel.contains(current)) {
    if (current instanceof HTMLElement && current.scrollTop > 0) return false;
    if (current === panel) break;
    current = current.parentElement;
  }
  return true;
}

function isEligibleStart(target: Element, panel: HTMLElement): boolean {
  const startedOnHandle = Boolean(target.closest(HANDLE_SELECTOR));
  return startedOnHandle || !(
    target.closest(INTERACTIVE_SELECTOR)
    || target.closest(EXCLUDED_GESTURE_SELECTOR)
    || hasTextSelection()
    || !scrollOwnersAreAtTop(target, panel)
  );
}

/*
FNXC:AlphaMobileDrawerGesture 2026-09-11-15:01:
An Alpha drawer handle is always eligible, while a body drag may claim dismissal only when every vertical scroll owner between the target and panel was already at its top edge on pointerdown. Interactive controls, selected text, xterm surfaces, and a body gesture that started while scrolled remain native for their entire pointer lifetime.

FNXC:AlphaMobileDrawerGesture 2026-09-11-15:01:
The gesture claims its sole pointer only after a downward, vertically dominant intent threshold. Every terminal path releases capture, cancels paint, and clears inline motion before the one possible dismissal callback; external close, disable, cancel, lost capture, and unmount clean up without dismissing.

FNXC:AlphaMobileDrawerGesture 2026-09-11-15:35:
Touch body drags require a native non-passive touchmove listener because the mobile shell deliberately permits pan-y and the browser may cancel a deferred Pointer Event claim. Keep touchstart passive and preserve native scrolling for ineligible, upward, horizontal, or initially scrolled gestures; prevent the downward top-edge move only once dismissal intent is established, then remove the document listeners before dismissal.
*/
export function useDrawerDismissGesture({
  enabled,
  open = true,
  panelRef,
  onDismiss,
}: UseDrawerDismissGestureOptions): DrawerDismissSurfaceProps {
  const onDismissRef = useRef(onDismiss);
  const dragRef = useRef<DrawerDrag | null>(null);
  const removeTouchListenersRef = useRef<(() => void) | null>(null);
  onDismissRef.current = onDismiss;

  const clearPanelStyle = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.removeProperty("transform");
    panel.style.removeProperty("transition");
    panel.style.removeProperty("will-change");
    panel.style.removeProperty("overscroll-behavior");
  }, [panelRef]);

  const reset = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    removeTouchListenersRef.current?.();
    removeTouchListenersRef.current = null;
    if (drag?.frame !== null && drag?.frame !== undefined) cancelAnimationFrame(drag.frame);
    if (drag?.input === "pointer") {
      try {
        if (drag.surface.hasPointerCapture?.(drag.pointerId)) drag.surface.releasePointerCapture(drag.pointerId);
      } catch {
        // A detached or browser-cancelled surface has already released ownership.
      }
    }
    clearPanelStyle();
  }, [clearPanelStyle]);

  useEffect(() => {
    if (!enabled || !open) reset();
    return reset;
  }, [enabled, open, reset]);

  const paint = useCallback(() => {
    const drag = dragRef.current;
    if (!drag || !drag.claimed) return;
    drag.frame = null;
    panelRef.current?.style.setProperty("transform", `translate3d(0, ${drag.offset}px, 0)`, "important");
  }, [panelRef]);

  const begin = useCallback((input: DrawerDrag["input"], pointerId: number, target: EventTarget | null, surface: HTMLElement, clientX: number, clientY: number, timeStamp: number) => {
    if (!enabled || !open || dragRef.current || !(target instanceof Element)) return false;
    const panel = panelRef.current;
    if (!panel || !isEligibleStart(target, panel)) return false;
    dragRef.current = {
      input,
      pointerId,
      startX: clientX,
      startY: clientY,
      startedAt: timeStamp,
      offset: 0,
      frame: null,
      surface,
      claimed: false,
    };
    return true;
  }, [enabled, open, panelRef]);

  const update = useCallback((pointerId: number, clientX: number, clientY: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return false;
    const deltaX = clientX - drag.startX;
    const deltaY = clientY - drag.startY;
    if (!drag.claimed) {
      if (deltaY < -INTENT_THRESHOLD || Math.abs(deltaX) > Math.max(INTENT_THRESHOLD, deltaY)) {
        reset();
        return false;
      }
      if (deltaY < INTENT_THRESHOLD) return false;
      drag.claimed = true;
      const panel = panelRef.current;
      panel?.style.setProperty("will-change", "transform");
      panel?.style.setProperty("overscroll-behavior", "none");
      if (drag.input === "pointer") {
        try {
          drag.surface.setPointerCapture?.(pointerId);
        } catch {
          // Pointer capture is an enhancement; React's pointer stream still owns cleanup.
        }
      }
    }
    drag.offset = Math.max(0, deltaY);
    if (drag.frame === null) drag.frame = requestAnimationFrame(paint);
    return true;
  }, [paint, panelRef, reset]);

  const finish = useCallback((pointerId: number, timeStamp: number, allowDismiss: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    const elapsed = Math.max(1, timeStamp - drag.startedAt);
    const panelHeight = panelRef.current?.getBoundingClientRect().height ?? 0;
    const shouldDismiss = allowDismiss
      && drag.claimed
      && drag.offset > 0
      && (drag.offset >= panelHeight * DISTANCE_RATIO || drag.offset / elapsed >= VELOCITY_THRESHOLD);
    reset();
    if (shouldDismiss) onDismissRef.current();
  }, [panelRef, reset]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!enabled || !open || !panel) return;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (!begin("touch", touch.identifier, event.target, panel, touch.clientX, touch.clientY, event.timeStamp)) return;

      const findTouch = (touches: TouchList) => Array.from(touches).find((candidate) => candidate.identifier === touch.identifier);
      const onTouchMove = (moveEvent: TouchEvent) => {
        const current = findTouch(moveEvent.touches);
        if (!current) return;
        if (update(current.identifier, current.clientX, current.clientY)) moveEvent.preventDefault();
      };
      const onTouchEnd = (endEvent: TouchEvent) => {
        const ended = findTouch(endEvent.changedTouches);
        if (ended) finish(ended.identifier, endEvent.timeStamp, true);
      };
      const onTouchCancel = (cancelEvent: TouchEvent) => {
        const cancelled = findTouch(cancelEvent.changedTouches);
        if (cancelled) finish(cancelled.identifier, cancelEvent.timeStamp, false);
        else reset();
      };
      const removeTouchListeners = () => {
        document.removeEventListener("touchmove", onTouchMove);
        document.removeEventListener("touchend", onTouchEnd);
        document.removeEventListener("touchcancel", onTouchCancel);
      };
      removeTouchListenersRef.current = removeTouchListeners;
      document.addEventListener("touchmove", onTouchMove, { passive: false });
      document.addEventListener("touchend", onTouchEnd);
      document.addEventListener("touchcancel", onTouchCancel);
    };

    panel.addEventListener("touchstart", onTouchStart, { passive: true });
    return () => {
      panel.removeEventListener("touchstart", onTouchStart);
      reset();
    };
  }, [begin, enabled, finish, open, panelRef, reset, update]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch" || !event.isPrimary || event.button !== 0) return;
    begin("pointer", event.pointerId, event.target, event.currentTarget, event.clientX, event.clientY, event.timeStamp);
  }, [begin]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.input === "touch") return;
    if (update(event.pointerId, event.clientX, event.clientY)) event.preventDefault();
  }, [update]);

  const finishPointer = useCallback((event: ReactPointerEvent<HTMLElement>, allowDismiss: boolean) => {
    if (dragRef.current?.input === "touch") return;
    finish(event.pointerId, event.timeStamp, allowDismiss);
  }, [finish]);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (event) => finishPointer(event, true),
    onPointerCancel: (event) => finishPointer(event, false),
    onLostPointerCapture: (event) => finishPointer(event, false),
  };
}
