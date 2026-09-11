import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

interface UseDrawerDismissGestureOptions {
  enabled: boolean;
  open?: boolean;
  panelRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}

interface DrawerDismissHandleProps {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => void;
}

const DISTANCE_RATIO = 0.25;
const VELOCITY_THRESHOLD = 0.6;

/*
FNXC:AlphaMobileDrawerGesture 2026-09-11-01:40:
An Alpha drawer gesture has exactly one pointer owner and begins only on its real handle. Downward distance follows the pointer directly; dismissal requires one quarter of the panel height or an explicit 0.6 CSS-pixel-per-millisecond flick so horizontal, upward, and body scrolling remain inert.

FNXC:AlphaMobileDrawerGesture 2026-09-11-01:40:
Every terminal path clears pointer capture, animation work, and inline transform before notifying the panel owner. External close, disable, cancel, lost capture, and unmount reset without dismissal so retained drawers cannot reopen translated or call onClose twice.
*/
export function useDrawerDismissGesture({
  enabled,
  open = true,
  panelRef,
  onDismiss,
}: UseDrawerDismissGestureOptions): DrawerDismissHandleProps {
  const onDismissRef = useRef(onDismiss);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startedAt: number;
    offset: number;
    frame: number | null;
    handle: HTMLElement;
  } | null>(null);
  onDismissRef.current = onDismiss;

  const clearPanelStyle = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.removeProperty("transform");
    panel.style.removeProperty("transition");
    panel.style.removeProperty("will-change");
  }, [panelRef]);

  const reset = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.frame !== null && drag?.frame !== undefined) cancelAnimationFrame(drag.frame);
    if (drag) {
      try {
        if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
      } catch {
        // A detached or browser-cancelled handle has already released ownership.
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
    if (!drag) return;
    drag.frame = null;
    panelRef.current?.style.setProperty("transform", `translate3d(0, ${drag.offset}px, 0)`, "important");
  }, [panelRef]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || !open || dragRef.current || !event.isPrimary || event.button !== 0) return;
    const handle = event.currentTarget;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startedAt: event.timeStamp,
      offset: 0,
      frame: null,
      handle,
    };
    panelRef.current?.style.setProperty("will-change", "transform");
    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is an enhancement; React's pointer stream still owns cleanup.
    }
  }, [enabled, open, panelRef]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.offset = Math.max(0, event.clientY - drag.startY);
    if (drag.frame === null) drag.frame = requestAnimationFrame(paint);
  }, [paint]);

  const finish = useCallback((event: ReactPointerEvent<HTMLElement>, allowDismiss: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const elapsed = Math.max(1, event.timeStamp - drag.startedAt);
    const panelHeight = panelRef.current?.getBoundingClientRect().height ?? 0;
    const shouldDismiss = allowDismiss
      && drag.offset > 0
      && (drag.offset >= panelHeight * DISTANCE_RATIO || drag.offset / elapsed >= VELOCITY_THRESHOLD);
    reset();
    if (shouldDismiss) onDismissRef.current();
  }, [panelRef, reset]);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (event) => finish(event, true),
    onPointerCancel: (event) => finish(event, false),
    onLostPointerCapture: (event) => finish(event, false),
  };
}
